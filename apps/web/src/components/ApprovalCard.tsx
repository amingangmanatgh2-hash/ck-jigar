import type { ApprovalDto } from '@aminchat/shared';
import { useMemo, useState } from 'react';
import { Ai } from '../lib/endpoints';
import { fmtDateTime } from '../lib/format';
import { useErrorText, useLocale, useT, type Key } from '../lib/i18n';
import { toast } from '../state/toast';
import { Button } from './ui';
import { Icon } from './Icon';

type Assignment = { fileId: string; category: string };
const isAssignments = (v: unknown): v is Assignment[] => Array.isArray(v) && v.every((x) => x && typeof x === 'object' && 'fileId' in x && 'category' in x);

const ACTION_KEY: Record<string, Key> = {
  message_send: 'tool.message_send',
  poll_create: 'tool.poll_create',
  announce_post: 'tool.announce_post',
  file_categorize: 'tool.file_categorize',
};

/** What the AI wants to do, spelled out, with the editable parts as inputs. Nothing runs until the user presses "Approve". */
export function ApprovalCard({ approval, onDecided }: { approval: ApprovalDto; onDecided?: (a: ApprovalDto) => void }) {
  const t = useT();
  const locale = useLocale();
  const errText = useErrorText();
  const context = (approval.payload._context ?? {}) as Record<string, unknown>;
  const args = useMemo(() => {
    const { _context, ...rest } = approval.payload;
    void _context;
    return rest;
  }, [approval.payload]);
  const editable = approval.editable;

  const [draft, setDraft] = useState<Record<string, unknown>>(() => {
    const d: Record<string, unknown> = {};
    for (const k of editable) d[k] = Array.isArray(args[k]) && (args[k] as unknown[]).every((x) => typeof x === 'string') ? (args[k] as string[]).join('\n') : args[k];
    return d;
  });
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const pending = approval.status === 'pending';

  const edits = (): Record<string, unknown> | undefined => {
    const out: Record<string, unknown> = {};
    for (const k of editable) {
      const original = args[k];
      let value = draft[k];
      if (Array.isArray(original) && original.every((x) => typeof x === 'string')) {
        value = String(value ?? '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
      }
      if (JSON.stringify(value) !== JSON.stringify(original)) out[k] = value;
    }
    return Object.keys(out).length ? out : undefined;
  };

  async function decide(decision: 'approve' | 'reject') {
    setBusy(decision);
    try {
      const { approval: updated } = await Ai.decide(approval.id, decision, decision === 'approve' ? edits() : undefined);
      onDecided?.(updated);
    } catch (err) {
      toast(errText(err), 'error');
    } finally {
      setBusy(null);
    }
  }

  const target = typeof context.conversation === 'string' ? context.conversation : null;
  const actionLabel = ACTION_KEY[approval.action] ? t(ACTION_KEY[approval.action]!) : approval.action;

  return (
    <section className={`approval approval-${approval.status}`} aria-label={t('approval.title')} data-testid="approval-card">
      <header className="approval-head">
        <Icon name="shield" size={18} />
        <strong>{t('approval.title')}</strong>
        <span className="chip chip-warn">{actionLabel}</span>
      </header>
      <p className="approval-summary" dir="auto">
        {approval.summary}
      </p>
      {target && (
        <p className="small">
          <span className="muted">{t('approval.target')}: </span>
          <strong dir="auto">{target}</strong>
        </p>
      )}

      {pending &&
        editable.map((k) => {
          const value = draft[k];
          if (isAssignments(args[k]) && isAssignments(value)) {
            const names = Array.isArray(context.files) ? (context.files as string[]).map((s) => String(s).split(' → ')[0]) : [];
            return (
              <div className="field" key={k}>
                <span className="label">{t('approval.categories')}</span>
                {value.map((a, i) => (
                  <div className="assign-row" key={a.fileId}>
                    <span className="assign-name" dir="auto">
                      {names[i] ?? a.fileId}
                    </span>
                    <input
                      aria-label={`${t('approval.categoryFor')} ${names[i] ?? a.fileId}`}
                      value={a.category}
                      maxLength={40}
                      onChange={(e) => setDraft((d) => ({ ...d, [k]: value.map((x, j) => (j === i ? { ...x, category: e.target.value } : x)) }))}
                    />
                  </div>
                ))}
              </div>
            );
          }
          const multiline = typeof value === 'string' && (k === 'text' || k === 'options' || value.length > 60);
          const label = k === 'text' ? t('approval.text') : k === 'question' ? t('approval.question') : k === 'options' ? t('approval.options') : k;
          return (
            <div className="field" key={k}>
              <label htmlFor={`${approval.id}-${k}`}>
                {label}
                {k === 'options' && <span className="muted small"> — {t('approval.onePerLine')}</span>}
              </label>
              {multiline ? (
                <textarea id={`${approval.id}-${k}`} dir="auto" rows={k === 'options' ? 4 : 3} value={String(value ?? '')} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))} />
              ) : (
                <input id={`${approval.id}-${k}`} dir="auto" value={String(value ?? '')} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))} />
              )}
            </div>
          );
        })}

      {pending ? (
        <>
          <p className="muted small">
            {t('approval.expires', { time: fmtDateTime(approval.expiresAt, locale) })} · {t('approval.neverWithout')}
          </p>
          <div className="approval-actions">
            <Button variant="primary" icon="check" busy={busy === 'approve'} disabled={busy !== null} onClick={() => decide('approve')}>
              {t('approval.approve')}
            </Button>
            <Button variant="ghost" icon="x" busy={busy === 'reject'} disabled={busy !== null} onClick={() => decide('reject')}>
              {t('approval.reject')}
            </Button>
          </div>
        </>
      ) : (
        <p className={`small ${approval.status === 'approved' ? 'ok-text' : 'muted'}`}>{t(`approval.status.${approval.status}` as Key)}</p>
      )}
    </section>
  );
}
