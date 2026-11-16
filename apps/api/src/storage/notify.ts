import { AMIN_AI_USER_ID } from '@aminchat/shared';
import { all } from '../db/helpers';
import type { Env } from '../env';
import { clipForLog } from '../lib/text';
import { insertMessage } from '../services/messages';
import { ensureRemindersThread } from '../services/threads';
import { allState, credentialFingerprint, getState, setState } from './state';

const TEXT = {
  auth_failed: {
    fa: '⚠️ اتصال Google Drive قطع شده است (توکن باطل یا منقضی شده؛ اگر این اتفاق هر هفته تکرار می‌شود، صفحهٔ رضایت Google هنوز در حالت «Testing» است و باید «In production» شود). تا برطرف شدن، فایل‌های جدید فقط در R2 نگه‌داری می‌شوند و فضای Cloudflare ممکن است پر شود. برای رفع: با دستور «npm run drive:token» توکن جدید بگیرید و مقدار GOOGLE_REFRESH_TOKEN را عوض کنید. جزئیات: docs/storage-drive.md',
    en: '⚠️ The Google Drive connection is broken (the token was revoked or has expired; if this happens every week, the Google consent screen is still in "Testing" and must be set to "In production"). Until it is fixed, files stay in R2 and Cloudflare storage may fill up. Fix: create a new token with "npm run drive:token" and update the GOOGLE_REFRESH_TOKEN secret. Details: docs/storage-drive.md',
  },
  quota_full: {
    fa: '⚠️ فضای حساب Google Drive پر شده است. تا خالی شدن فضا، فایل‌ها فقط در R2 نگه‌داری می‌شوند و فضای Cloudflare ممکن است پر شود.',
    en: '⚠️ The connected Google Drive account is full. Until space is freed, files stay in R2 and Cloudflare storage may fill up.',
  },
} as const;

/**
 * Tells every administrator — once per failure, not every minute — that the cold tier stopped working.
 * The message arrives from AMIN AI in the admin's "Reminders" conversation (an ordinary, live-delivered message),
 * and the admin storage screen shows the same state permanently.
 */
export async function alertAdminsIfNeeded(env: Env): Promise<number> {
  const state = await allState(env);
  const health = state['drive.health'];
  if (health !== 'auth_failed' && health !== 'quota_full') {
    if (state['drive.notified']) await setState(env, 'drive.notified', null); // healthy again: the next failure alerts again
    return 0;
  }
  const key = `${health}:${state['drive.failed_fp'] ?? ''}`;
  if (state['drive.notified'] === key) return 0;
  // new credentials after a failure mean the failure is stale: nothing to say until they fail too
  if (state['drive.failed_fp'] !== (await credentialFingerprint(env))) return 0;

  const admins = await all<{ id: string; locale: string }>(env.DB.prepare(`SELECT id, locale FROM users WHERE role = 'admin' AND kind = 'human' AND disabled_at IS NULL LIMIT 20`));
  let sent = 0;
  for (const admin of admins) {
    try {
      const thread = await ensureRemindersThread(env, admin.id);
      await insertMessage(env, {
        conversationId: thread.conversation_id,
        threadId: thread.id,
        senderId: AMIN_AI_USER_ID,
        body: TEXT[health][admin.locale === 'en' ? 'en' : 'fa'],
        meta: { ai: { agentId: 'personal', modelId: null, runId: null }, notice: `storage.${health}` },
      });
      sent++;
    } catch (err) {
      console.error('could not alert the admin', admin.id, clipForLog(err));
    }
  }
  // remember the alert even when there is no admin yet; otherwise the first registered admin would be told about old news
  await setState(env, 'drive.notified', key);
  return sent;
}

export const lastNotified = (env: Env) => getState(env, 'drive.notified');
