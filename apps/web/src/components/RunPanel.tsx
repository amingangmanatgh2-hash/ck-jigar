import type { RunDto, RunStepDto } from '@aminchat/shared';
import { useEffect, useState } from 'react';
import { Ai } from '../lib/endpoints';
import { fmtDateTime, fmtNumber, fmtTime } from '../lib/format';
import { useCodeText, useErrorText, useLocale, useT, type Key } from '../lib/i18n';
import { RUN_STATUS_KEY, STEP_STATUS_KEY, isActiveRun, pendingApprovals, statusTone } from '../lib/runs';
import { navigate } from '../lib/router';
import { toast } from '../state/toast';
import { upsertConversation } from '../state/conversations';
import { Convs } from '../lib/endpoints';
import { ApprovalCard } from './ApprovalCard';
import { Icon, type IconName } from './Icon';
import { Button } from './ui';

export function StatusChip({ status, step }: { status: RunDto['status'] | RunStepDto['status']; step?: boolean }) {
  const t = useT();
  const key = (step ? STEP_STATUS_KEY : RUN_STATUS_KEY)[status as never] as Key;
  return (
    <span className={`chip chip-${statusTone(status as never)}`} data-status={status}>
      {(status === 'running' || status === 'planning') && <span className="dot-pulse" aria-hidden="true" />}
      {t(key)}
    </span>
  );
}

const STEP_ICON: Record<RunStepDto['status'], IconName> = {
  pending: 'clock',
  running: 'refresh',
  awaiting_approval: 'shield',
  completed: 'check',
  failed: 'alert',
  skipped: 'x',
  cancelled: 'x',
};

function toolLabel(t: ReturnType<typeof useT>, tool: string): string {
  const key = `tool.${tool}` as Key;
  const label = t(key);
  return label === key ? tool : label;
}

function StepRow({ step }: { step: RunStepDto }) {
  const t = useT();
  const locale = useLocale();
  const codeText = useCodeText();
  const [open, setOpen] = useState(false);
  const detail = step.output?.text ?? null;
  const duration = step.startedAt && step.finishedAt ? Math.max(0, Math.round((step.finishedAt - step.startedAt) / 100) / 10) : null;
  return (
    <li className={`step step-${step.status}`} data-testid="run-step" data-status={step.status}>
      <span className={`step-icon tone-${statusTone(step.status)}`}>
        <Icon name={STEP_ICON[step.status]} size={15} className={step.status === 'running' ? 'spin' : undefined} />
      </span>
      <div className="step-main">
        <div className="step-title" dir="auto">
          {step.title}
        </div>
        <div className="step-meta">
          <span className="chip chip-tool">
            <Icon name="tool" size={12} /> {toolLabel(t, step.tool)}
          </span>
          <StatusChip status={step.status} step />
          {step.risk === 'sensitive' && <span className="chip chip-warn">{t('run.sensitive')}</span>}
          {step.attempts > 1 && <span className="muted small">{t('run.attempt', { n: step.attempts })}</span>}
          {step.status === 'completed' && step.risk !== 'read' && (step.verified ? <span className="chip chip-ok">{t('run.verified')}</span> : <span className="chip chip-warn">{t('run.notVerified')}</span>)}
          {duration !== null && <span className="muted small">{t('run.seconds', { n: fmtNumber(duration, locale) })}</span>}
        </div>
        {step.error && (
          <p className="error-text small" role="alert" dir="auto">
            {codeText(step.errorCode, step.error)}
          </p>
        )}
        {step.action?.type === 'enable_ai_access' && <EnableAccess conversationId={step.action.conversationId} title={step.action.conversationTitle} />}
        {step.action?.type === 'open_chat' && <OpenChat action={step.action} />}
        {detail && (
          <>
            <button type="button" className="link-btn small" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? t('run.hideOutput') : t('run.showOutput')}
            </button>
            {open && (
              <pre className="step-output" dir="auto">
                {detail}
              </pre>
            )}
          </>
        )}
      </div>
    </li>
  );
}

/**
 * The chat the Quick agent found. Only the user's tap opens it — or, for a person there is no chat with yet, starts it: the assistant
 * itself never navigates and never creates a chat.
 */
function OpenChat({ action }: { action: Extract<NonNullable<RunStepDto['action']>, { type: 'open_chat' }> }) {
  const t = useT();
  const errText = useErrorText();
  const [busy, setBusy] = useState(false);
  const existing = action.conversationId !== null;
  return (
    <Button
      busy={busy}
      icon={existing ? 'chat' : 'plus'}
      data-testid="open-chat-action"
      onClick={async () => {
        if (action.conversationId) {
          navigate(`/c/${action.conversationId}`);
          return;
        }
        if (!action.userId) return;
        setBusy(true);
        try {
          const { conversation } = await Convs.direct(action.userId, false);
          upsertConversation(conversation);
          navigate(`/c/${conversation.id}`);
        } catch (err) {
          toast(errText(err), 'error');
        } finally {
          setBusy(false);
        }
      }}
    >
      {t(existing ? 'run.openChat' : 'run.startChat', { chat: action.title })}
    </Button>
  );
}

/** One-click fix offered by a failed step: allow AMIN AI to read the chat the task needs (only the user can do this). */
function EnableAccess({ conversationId, title }: { conversationId: string; title: string | null }) {
  const t = useT();
  const errText = useErrorText();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      busy={busy}
      icon="lock"
      onClick={async () => {
        setBusy(true);
        try {
          const { conversation } = await Convs.setAi(conversationId, { access: 'context' });
          upsertConversation(conversation);
          toast(t('run.accessEnabled'), 'success');
        } catch (err) {
          toast(errText(err), 'error');
        } finally {
          setBusy(false);
        }
      }}
    >
      {t('run.enableAccess', { chat: title ?? '' })}
    </Button>
  );
}

interface LogEvent {
  id: number;
  ts: number;
  level: string;
  type: string;
  data: unknown;
}

function OperationLog({ runId }: { runId: string }) {
  const t = useT();
  const locale = useLocale();
  const [events, setEvents] = useState<LogEvent[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    Ai.runLog(runId)
      .then((r) => alive && setEvents(r.events))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [runId]);
  if (failed) return <p className="error-text small">{t('err.generic')}</p>;
  if (!events) return <p className="muted small">{t('common.loading')}</p>;
  return (
    <ol className="oplog" aria-label={t('run.log')} dir="ltr">
      {events.map((e) => (
        <li key={e.id} className={`oplog-${e.level}`}>
          <time>{fmtTime(e.ts, locale)}</time> <code>{e.type}</code>
          {e.data != null && <span className="muted small"> {typeof e.data === 'string' ? e.data : JSON.stringify(e.data).slice(0, 160)}</span>}
        </li>
      ))}
      {events.length === 0 && <li className="muted">—</li>}
    </ol>
  );
}

interface Props {
  run: RunDto;
  /** Embedded in a chat bubble (compact) or shown as a card on the tasks page. */
  compact?: boolean;
  onChanged?: () => void;
  defaultOpen?: boolean;
}

export function RunPanel({ run, compact, onChanged, defaultOpen }: Props) {
  const t = useT();
  const locale = useLocale();
  const errText = useErrorText();
  const codeText = useCodeText();
  const active = isActiveRun(run);
  const [open, setOpen] = useState(defaultOpen ?? active);
  const [showLog, setShowLog] = useState(false);
  const [busy, setBusy] = useState(false);
  const approvals = pendingApprovals(run);
  const hasContent = run.steps.length > 0 || approvals.length > 0 || !!run.planSummary;

  // Active tasks stay expanded; finished ones collapse (the user can reopen them).
  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);

  if (!hasContent && !(compact === false)) return null;

  const done = run.steps.filter((s) => s.status === 'completed').length;
  async function cancel() {
    setBusy(true);
    try {
      await Ai.cancelRun(run.id);
      onChanged?.();
    } catch (err) {
      toast(errText(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`runpanel${compact ? ' compact' : ''}`} aria-label={t('run.task')} data-testid="run-panel" data-status={run.status}>
      <header className="runpanel-head">
        <button type="button" className="runpanel-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name="list" size={16} />
          <span className="runpanel-title" dir="auto">
            {compact ? t('run.steps', { done, total: run.steps.length }) : run.goal}
          </span>
          <Icon name="down" size={14} className={open ? 'rot' : undefined} />
        </button>
        <StatusChip status={run.status} />
        {active && (
          <Button variant="ghost" icon="stop" busy={busy} onClick={cancel}>
            {t('run.cancel')}
          </Button>
        )}
      </header>
      {open && (
        <div className="runpanel-body">
          {run.planSummary && (
            <p className="plan-summary" dir="auto">
              <Icon name="sparkles" size={14} /> {run.planSummary}
            </p>
          )}
          <ol className="steps">
            {run.steps.map((s) => (
              <StepRow key={s.id} step={s} />
            ))}
          </ol>
          {approvals.map((a) => (
            <ApprovalCard key={a.id} approval={a} onDecided={() => onChanged?.()} />
          ))}
          {run.error && run.status === 'failed' && (
            <p className="error-text small" role="alert" dir="auto">
              {codeText(run.errorCode, run.error)}
            </p>
          )}
          <footer className="runpanel-foot muted small">
            <span>
              {run.modelId ? `${run.modelId.split('/').pop()} · ` : ''}
              {fmtDateTime(run.createdAt, locale)}
            </span>
            <button type="button" className="link-btn small" aria-expanded={showLog} onClick={() => setShowLog(!showLog)}>
              {showLog ? t('run.hideLog') : t('run.log')}
            </button>
          </footer>
          {showLog && <OperationLog runId={run.id} />}
        </div>
      )}
    </section>
  );
}

/** Used by the tasks page: jump to the thread that produced a task. */
export function openRunThread(run: RunDto, aiConversationId: string | undefined): void {
  if (run.threadId && aiConversationId) navigate(`/c/${aiConversationId}/t/${run.threadId}`);
  else if (run.conversationId) navigate(`/c/${run.conversationId}`);
}
