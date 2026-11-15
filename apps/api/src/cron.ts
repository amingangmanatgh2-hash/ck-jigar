import { AMIN_AI_USER_ID } from '@aminchat/shared';
import { settleFailed } from './agents/executor';
import { RUN_LIMITS } from './config/limits';
import { all, isUniqueViolation } from './db/helpers';
import type { Env } from './env';
import { clipForLog } from './lib/text';
import { insertMessage } from './services/messages';
import { resumeRun } from './services/run-control';
import { ensureRemindersThread } from './services/threads';
import { dropTombstones, offloadFiles } from './storage/offload';
import { alertAdminsIfNeeded } from './storage/notify';

export interface CronReport {
  reminders: number;
  resumed: number;
  stalled: number;
  expiredApprovals: number;
  lostResumes: number;
  /** Files moved from R2 to Google Drive in this run. */
  offloaded: number;
}

interface ReminderRow {
  id: string;
  user_id: string;
  text: string;
  remind_at: number;
  status: string;
  attempts: number;
  source_run_id: string | null;
}

const MAX_DELIVERY_ATTEMPTS = 5;
const reminderText = (locale: string, text: string) => (locale === 'en' ? `⏰ Reminder: ${text}` : `⏰ یادآوری: ${text}`);

/**
 * Delivers due reminders as messages from AMIN AI in the user's "Reminders" conversation.
 * Exactly-once: the message id is derived from the reminder id (a retry hits the primary key instead of posting twice).
 */
export async function deliverDueReminders(env: Env, now = Date.now()): Promise<number> {
  const due = await all<ReminderRow>(
    env.DB.prepare(
      `SELECT id, user_id, text, remind_at, status, attempts, source_run_id FROM reminders
       WHERE (status = 'scheduled' AND remind_at <= ?1) OR (status = 'delivering' AND remind_at <= ?2)
       ORDER BY remind_at LIMIT 50`,
    ).bind(now, now - 2 * 60_000),
  );
  let delivered = 0;
  for (const r of due) {
    const claim = await env.DB.prepare(`UPDATE reminders SET status = 'delivering', attempts = attempts + 1 WHERE id = ? AND status = ?`).bind(r.id, r.status).run();
    if (!claim.meta.changes) continue; // another invocation took it
    try {
      const user = await env.DB.prepare('SELECT locale FROM users WHERE id = ? AND disabled_at IS NULL').bind(r.user_id).first<{ locale: string }>();
      if (!user) {
        await env.DB.prepare(`UPDATE reminders SET status = 'cancelled' WHERE id = ?`).bind(r.id).run();
        continue;
      }
      const thread = await ensureRemindersThread(env, r.user_id);
      const messageId = `msg_${r.id.slice(4)}`;
      try {
        await insertMessage(env, {
          id: messageId,
          conversationId: thread.conversation_id,
          threadId: thread.id,
          senderId: AMIN_AI_USER_ID,
          body: reminderText(user.locale, r.text),
          meta: { reminderId: r.id, ai: { agentId: 'personal', modelId: null, runId: r.source_run_id } },
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
      await env.DB.prepare(`UPDATE reminders SET status = 'delivered', delivered_at = ?, delivery_message_id = ? WHERE id = ?`).bind(Date.now(), messageId, r.id).run();
      delivered++;
    } catch (err) {
      console.error('reminder delivery failed', r.id, clipForLog(err));
      const next = r.attempts + 1 >= MAX_DELIVERY_ATTEMPTS ? 'failed' : 'scheduled';
      await env.DB.prepare('UPDATE reminders SET status = ? WHERE id = ?').bind(next, r.id).run();
    }
  }
  return delivered;
}

/** Runs that stopped heart-beating (the isolate died) are resumed; after too many resumes they fail instead of looping. */
export async function recoverStaleRuns(env: Env, now = Date.now()): Promise<{ resumed: number; stalled: number }> {
  const stale = await all<{ id: string; resumes: number; heartbeat_at: number | null }>(
    env.DB.prepare(
      `SELECT id, resumes, heartbeat_at FROM runs WHERE status IN ('pending', 'planning', 'running') AND COALESCE(heartbeat_at, created_at) < ? LIMIT 20`,
    ).bind(now - RUN_LIMITS.staleAfterMs),
  );
  let resumed = 0;
  let stalled = 0;
  for (const r of stale) {
    if (r.resumes >= RUN_LIMITS.maxResumes) {
      await settleFailed(env, r.id, 'RUN_STALLED', 'The task stopped responding and could not be recovered.');
      stalled++;
      continue;
    }
    // compare-and-set on the old heartbeat so two overlapping cron invocations never resume the same run twice
    const claim = await env.DB.prepare(`UPDATE runs SET resumes = resumes + 1, heartbeat_at = ? WHERE id = ? AND COALESCE(heartbeat_at, created_at) = ?`)
      .bind(now, r.id, r.heartbeat_at ?? (await env.DB.prepare('SELECT created_at FROM runs WHERE id = ?').bind(r.id).first<{ created_at: number }>())?.created_at ?? 0)
      .run();
    if (!claim.meta.changes) continue;
    try {
      await resumeRun(env, r.id);
      resumed++;
    } catch (err) {
      console.error('resume failed', r.id, clipForLog(err));
    }
  }
  return { resumed, stalled };
}

/** Approvals nobody answered within their lifetime expire; the parked run is then resumed so it can finish honestly. */
export async function expireApprovals(env: Env, now = Date.now()): Promise<number> {
  const rows = await all<{ id: string; run_id: string }>(env.DB.prepare(`SELECT id, run_id FROM approvals WHERE status = 'pending' AND expires_at < ? LIMIT 50`).bind(now));
  let n = 0;
  for (const a of rows) {
    const res = await env.DB.prepare(`UPDATE approvals SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'`).bind(now, a.id).run();
    if (!res.meta.changes) continue;
    n++;
    await resumeRun(env, a.run_id).catch((err) => console.error('resume after expiry failed', a.run_id, clipForLog(err)));
  }
  return n;
}

/**
 * Safety net: an approval was decided but the run still waits on that very step (the resume signal got lost, for example
 * because the coordinator was restarted at that moment). Resume it so the user's decision always takes effect.
 */
export async function resumeLostDecisions(env: Env, now = Date.now()): Promise<number> {
  const rows = await all<{ run_id: string }>(
    env.DB.prepare(
      `SELECT DISTINCT r.id AS run_id FROM runs r
         JOIN approvals a ON a.run_id = r.id
         JOIN run_steps s ON s.id = a.step_id
        WHERE r.status = 'awaiting_approval' AND s.status = 'awaiting_approval'
          AND a.status IN ('approved', 'rejected', 'expired') AND a.decided_at < ? LIMIT 20`,
    ).bind(now - 45_000),
  );
  let n = 0;
  for (const r of rows) {
    try {
      await resumeRun(env, r.run_id);
      n++;
    } catch (err) {
      console.error('resume of decided approval failed', r.run_id, clipForLog(err));
    }
  }
  return n;
}

/** Hourly housekeeping of data that only matters for a limited time. */
export async function housekeeping(env: Env, now = Date.now()): Promise<void> {
  const day = 86_400_000;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)').bind(now - 7 * day, now - 7 * day),
    env.DB.prepare('DELETE FROM run_events WHERE ts < ?').bind(now - 30 * day),
    env.DB.prepare('DELETE FROM ai_usage WHERE created_at < ?').bind(now - 120 * day),
    env.DB.prepare("DELETE FROM memory_suggestions WHERE status != 'pending' AND decided_at < ?").bind(now - 30 * day),
  ]);
  await dropTombstones(env, now);
}

export async function runScheduled(env: Env, now = Date.now()): Promise<CronReport> {
  const report: CronReport = { reminders: 0, resumed: 0, stalled: 0, expiredApprovals: 0, lostResumes: 0, offloaded: 0 };
  const guard = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      console.error(`cron task "${name}" failed`, clipForLog(err));
    }
  };
  await guard('reminders', async () => void (report.reminders = await deliverDueReminders(env, now)));
  await guard('stale runs', async () => {
    const r = await recoverStaleRuns(env, now);
    report.resumed = r.resumed;
    report.stalled = r.stalled;
  });
  await guard('approvals', async () => void (report.expiredApprovals = await expireApprovals(env, now)));
  await guard('lost decisions', async () => void (report.lostResumes = await resumeLostDecisions(env, now)));
  // cold file tier: move old/large files to Google Drive, finish pending deletes, warn the admins when Drive stops working
  await guard('file offload', async () => void (report.offloaded = (await offloadFiles(env, { now })).moved));
  await guard('storage alerts', async () => void (await alertAdminsIfNeeded(env)));
  if (new Date(now).getUTCMinutes() === 0) await guard('housekeeping', () => housekeeping(env, now));
  return report;
}
