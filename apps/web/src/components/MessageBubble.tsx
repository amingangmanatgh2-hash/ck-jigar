import type { MessageDto, PollDto, RunDto, UserDto } from '@aminchat/shared';
import { memo, useState } from 'react';
import { fmtTime } from '../lib/format';
import { useCodeText, useLocale, useT, type Key } from '../lib/i18n';
import { Msgs } from '../lib/endpoints';
import { useErrorText } from '../lib/i18n';
import { toast } from '../state/toast';
import { AttachmentList } from './Attachment';
import { AiAvatar, Avatar, NameWithBadge } from './Avatar';
import { Icon } from './Icon';
import { useLiveBody } from '../lib/streams';
import { renderPlain } from '../lib/text';
import { copyText } from '../lib/clipboard';
import { MarkdownText } from './MarkdownText';
import { RunPanel } from './RunPanel';
import { IconButton } from './ui';

export interface BubbleProps {
  message: MessageDto;
  mine: boolean;
  sender?: UserDto | null;
  /** Show the sender's name above the bubble (group chats). */
  showSender?: boolean;
  /** Plain text of an end-to-end encrypted message (decrypted on this device); null = could not be decrypted. */
  decrypted?: string | null;
  run?: RunDto;
  /** Only the newest answer of a thread can be regenerated. */
  canRegenerate?: boolean;
  canEdit?: boolean;
  onEdit?: (m: MessageDto) => void;
  onRegenerate?: () => void;
  onRunChanged?: () => void;
  selectMode?: boolean;
  selected?: boolean;
  selectable?: boolean;
  onToggleSelect?: (m: MessageDto) => void;
  /** Name of the user who invoked the assistant in a shared chat. */
  invokerName?: string | null;
  /** Set for a message that is not on the server yet (written offline): shows its state and what the user can do about it. */
  outbox?: { state: 'pending' | 'failed'; errorText?: string; onRetry: () => void; onDiscard: () => void };
}

const bodyText = (m: MessageDto, decrypted?: string | null): string | null => (m.cipher ? (decrypted ?? null) : m.body);

function PollView({ message, poll }: { message: MessageDto; poll: PollDto }) {
  const t = useT();
  const errText = useErrorText();
  const [busy, setBusy] = useState(false);
  const total = Math.max(1, Object.values(poll.counts).reduce((a, b) => a + b, 0));
  async function vote(optionId: string) {
    const mine = new Set(poll.myVotes);
    if (poll.multiple) mine.has(optionId) ? mine.delete(optionId) : mine.add(optionId);
    else {
      mine.clear();
      mine.add(optionId);
    }
    setBusy(true);
    try {
      await Msgs.vote(message.id, [...mine]);
    } catch (err) {
      toast(errText(err), 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="poll" role="group" aria-label={poll.question}>
      <strong dir="auto">{poll.question}</strong>
      <span className="muted small">{poll.multiple ? t('poll.multiple') : t('poll.single')}</span>
      {poll.options.map((o) => {
        const count = poll.counts[o.id] ?? 0;
        const picked = poll.myVotes.includes(o.id);
        return (
          <button key={o.id} type="button" className={`poll-option${picked ? ' picked' : ''}`} disabled={busy} aria-pressed={picked} onClick={() => vote(o.id)}>
            <span className="poll-bar" style={{ width: `${Math.round((count / total) * 100)}%` }} />
            <span className="poll-text" dir="auto">
              {o.text}
            </span>
            <span className="poll-count">{count}</span>
          </button>
        );
      })}
      <span className="muted small">{t('poll.voters', { n: poll.totalVoters })}</span>
    </div>
  );
}

const AI_LEVELS = ['off', 'mention', 'context', 'assist'] as const;

/** The only system message the server writes is the AI access policy change of a group. */
function systemText(m: MessageDto, t: ReturnType<typeof useT>): string {
  const sys = m.meta?.system;
  if (sys?.code === 'ai_policy_changed') {
    const level = AI_LEVELS.find((l) => l === sys.level);
    return t('system.ai_policy_changed', {
      by: String(sys.by ?? ''),
      level: level ? t(`ai.level.${level}` as Key) : String(sys.level ?? ''),
      roles: t(sys.invokeRoles === 'admins' ? 'ai.who.admins' : 'ai.who.all'),
    });
  }
  return m.body ?? '';
}

export const MessageBubble = memo(function MessageBubble(props: BubbleProps) {
  const { message: m, mine, sender, showSender, decrypted, run, canRegenerate, canEdit, selectMode, selected, selectable } = props;
  const t = useT();
  const locale = useLocale();
  const codeText = useCodeText();
  const isAi = sender?.kind === 'ai' || m.viaAi === true && !mine;
  const streaming = m.status === 'streaming';
  const liveBody = useLiveBody(m);
  const text = streaming ? liveBody : bodyText(m, decrypted);
  const ai = m.meta?.ai;

  if (m.kind === 'system') {
    return (
      <div className="system-msg" role="note" data-testid="system-message">
        <span>{systemText(m, t)}</span>
      </div>
    );
  }

  const failed = m.status === 'failed' || (!!ai?.error && !streaming);
  const cancelled = m.status === 'cancelled';
  const copyable = !!text && !streaming;

  return (
    <article
      className={`msg ${mine ? 'msg-mine' : 'msg-other'}${isAi ? ' msg-ai' : ''}${selected ? ' selected' : ''}`}
      data-testid="message"
      data-message-id={m.id}
      data-status={m.status}
      onClick={selectMode && selectable ? () => props.onToggleSelect?.(m) : undefined}
    >
      {selectMode && (
        <span className={`select-box${selected ? ' on' : ''}${selectable ? '' : ' disabled'}`} role="checkbox" aria-checked={!!selected} aria-disabled={!selectable} tabIndex={selectable ? 0 : -1} onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && selectable && props.onToggleSelect?.(m)}>
          {selected && <Icon name="check" size={14} />}
        </span>
      )}
      {!mine && (
        <span className="msg-avatar">
          {isAi ? <AiAvatar size={32} busy={streaming} /> : <Avatar name={sender?.displayName ?? '?'} size={32} />}
        </span>
      )}
      <div className="msg-col">
        {showSender && !mine && sender && (
          <div className="msg-sender">
            <NameWithBadge user={sender} />
          </div>
        )}
        <div className="bubble">
          {m.replyToId && ai?.invokedBy && props.invokerName && <div className="muted small msg-invoked">{t('msg.invokedBy', { name: props.invokerName })}</div>}

          {m.meta?.shared && (
            <details className="shared-chip">
              <summary>
                <Icon name={m.meta.shared.e2ee ? 'lock' : 'select'} size={14} /> {t('share.sharedFrom', { chat: m.meta.shared.conversationTitle ?? '', n: m.meta.shared.count })}
              </summary>
              {m.meta.shared.excerpts.length > 0 && (
                <ul>
                  {m.meta.shared.excerpts.map((x, i) => (
                    <li key={i} dir="auto">
                      <strong>{x.sender}:</strong> {x.text}
                    </li>
                  ))}
                </ul>
              )}
            </details>
          )}

          {m.kind === 'poll' && m.poll ? (
            <PollView message={m} poll={m.poll} />
          ) : m.cipher && text === null ? (
            <p className="muted italic">
              <Icon name="lock" size={14} /> {t('e2ee.undecryptable')}
            </p>
          ) : isAi ? (
            streaming && !text ? (
              <p className="thinking" role="status" aria-live="polite">
                {ai?.waiting === 'approval' ? t('status.awaiting_approval') : t('ai.thinking')}
                <span className="typing-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              </p>
            ) : (
              text && <MarkdownText text={text} streaming={streaming} />
            )
          ) : (
            text && (
              <p className="plain" dir="auto">
                {renderPlain(text)}
              </p>
            )
          )}

          {streaming && text && ai?.waiting === 'approval' && <p className="muted small">{t('status.awaiting_approval')}</p>}
          {cancelled && <p className="muted small italic">{t('status.cancelled')}</p>}
          {failed && ai?.error && (
            <p className="error-text small" role="alert" dir="auto">
              <Icon name="alert" size={14} /> {codeText(ai.error.code, ai.error.message)}
            </p>
          )}

          <AttachmentList files={m.attachments} />

          {run && <RunPanel run={run} compact onChanged={props.onRunChanged} />}

          <div className="msg-foot">
            {!selectMode && !streaming && (copyable || canEdit || canRegenerate) && (
              <span className="msg-actions" role="toolbar" aria-label={t('msg.actions')}>
                {copyable && (
                  <IconButton
                    icon="copy"
                    size={16}
                    label={t('common.copy')}
                    onClick={async () => {
                      const ok = await copyText(text!);
                      toast(ok ? t('common.copied') : t('common.copyFailed'), ok ? 'success' : 'error', 2000);
                    }}
                  />
                )}
                {canEdit && <IconButton icon="edit" size={16} label={t('msg.edit')} onClick={() => props.onEdit?.(m)} />}
                {canRegenerate && <IconButton icon="refresh" size={16} label={t('msg.regenerate')} onClick={() => props.onRegenerate?.()} />}
              </span>
            )}
            {isAi && ai?.modelId && !streaming && (
              <span className="muted small" title={ai.modelId}>
                {ai.modelId.split('/').pop()}
                {ai.fallbackFrom ? ` · ${t('msg.fallback')}` : ''}
              </span>
            )}
            {!!ai?.regenerations && <span className="muted small">{t('msg.regenerated', { n: ai.regenerations })}</span>}
            {m.editedAt && <span className="muted small">{t('msg.edited')}</span>}
            {m.cipher && <Icon name="lock" size={12} />}
            {props.outbox?.state === 'pending' && (
              <span className="outbox-state" data-testid="outbox-pending">
                <Icon name="clock" size={12} /> {t('outbox.waiting')}
              </span>
            )}
            {props.outbox?.state === 'failed' && (
              <span className="outbox-state outbox-failed" role="alert" data-testid="outbox-failed">
                <Icon name="alert" size={12} /> {t('outbox.failed')}
                {props.outbox.errorText ? ` — ${props.outbox.errorText}` : ''}
                <button type="button" className="link-btn" onClick={props.outbox.onRetry}>
                  {t('outbox.retry')}
                </button>
                <button type="button" className="link-btn" onClick={props.outbox.onDiscard}>
                  {t('outbox.discard')}
                </button>
              </span>
            )}
            <time className="muted small" dateTime={new Date(m.createdAt).toISOString()}>
              {fmtTime(m.createdAt, locale)}
            </time>
          </div>
        </div>

      </div>
    </article>
  );
});
