import { LIMITS, type ConversationDto, type MessageDto, type UserDto } from '@aminchat/shared';
import { useEffect, useMemo, useState } from 'react';
import { decryptText } from '../lib/e2ee';
import { Convs } from '../lib/endpoints';
import { fmtTime } from '../lib/format';
import { useErrorText, useLocale, useT } from '../lib/i18n';
import { useConversations } from '../state/conversations';
import { useE2eeKey } from '../state/e2ee';
import { shareStore, type PendingShare } from '../state/share';
import { useUser } from '../state/session';
import { toast } from '../state/toast';
import { conversationTitle } from '../lib/conv';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { Button, Dialog, EmptyState, ErrorBanner } from './ui';

interface Row {
  message: MessageDto;
  sender: UserDto | undefined;
  text: string | null;
}

/**
 * "Select messages for AI": the user ticks exactly the messages AMIN AI may see.
 *  - normal chats: only the message ids travel; the server re-checks every permission and reads the text itself;
 *  - end-to-end encrypted chats: the server cannot read anything, so the selected messages are decrypted ON THIS DEVICE and only
 *    that text is sent. This requires an explicit confirmation and nothing is sent before the user presses send in the AI chat.
 */
export function ShareDialog({ open, onClose, conversationId, onAttached }: { open: boolean; onClose: () => void; conversationId?: string; onAttached?: (s: PendingShare) => void }) {
  const t = useT();
  const me = useUser();
  const { items } = useConversations();
  const [chosen, setChosen] = useState<string | undefined>(conversationId);
  const conv = items.find((c) => c.id === chosen);
  useEffect(() => {
    if (open) setChosen(conversationId);
  }, [open, conversationId]);
  const candidates = items.filter((c) => c.type !== 'ai');

  return (
    <Dialog open={open} onClose={onClose} title={t('share.title')} wide>
      {!conv ? (
        candidates.length === 0 ? (
          <EmptyState icon="chat" title={t('share.noChats')} />
        ) : (
          <>
            <p className="muted">{t('share.pickChat')}</p>
            <ul className="list">
              {candidates.map((c) => (
                <li key={c.id}>
                  <button type="button" className="list-item" onClick={() => setChosen(c.id)}>
                    <Avatar name={conversationTitle(c, t)} size={36} group={c.type === 'group'} />
                    <span className="list-main">
                      <strong dir="auto">{conversationTitle(c, t)}</strong>
                      {c.e2ee && (
                        <span className="muted small">
                          <Icon name="lock" size={12} /> {t('e2ee.secret')}
                        </span>
                      )}
                    </span>
                    <Icon name="chevron" size={16} flip />
                  </button>
                </li>
              ))}
            </ul>
          </>
        )
      ) : (
        <Picker key={conv.id} conv={conv} meId={me.id} onBack={conversationId ? undefined : () => setChosen(undefined)} onDone={(s) => { shareStore.set(s); onAttached?.(s); onClose(); }} />
      )}
    </Dialog>
  );
}

function Picker({ conv, meId, onBack, onDone }: { conv: ConversationDto; meId: string; onBack?: () => void; onDone: (s: PendingShare) => void }) {
  const t = useT();
  const locale = useLocale();
  const errText = useErrorText();
  const e2ee = useE2eeKey(conv, meId);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [ack, setAck] = useState(false);
  const members = useMemo(() => new Map<string, UserDto>([...(conv.members ?? []).map((m) => [m.user.id, m.user] as const), ...(conv.peer ? [[conv.peer.id, conv.peer] as const] : [])]), [conv]);
  const title = conversationTitle(conv, t);

  useEffect(() => {
    if (conv.e2ee && e2ee.state !== 'ready') return;
    let alive = true;
    (async () => {
      try {
        const page = await Convs.messages(conv.id, { limit: 50 });
        const list = page.messages.filter((m) => m.kind !== 'system' && !m.deleted);
        const out: Row[] = [];
        for (const m of list) {
          let text: string | null = m.body;
          if (m.cipher) text = e2ee.state === 'ready' ? await decryptText(e2ee.key, m.cipher) : null;
          out.push({ message: m, sender: members.get(m.senderId), text: text ?? null });
        }
        if (alive) setRows(out);
      } catch (err) {
        if (alive) setError(err);
      }
    })();
    return () => {
      alive = false;
    };
  }, [conv.id, conv.e2ee, e2ee, members]);

  const selectable = (r: Row) => !!r.text?.trim() || r.message.attachments.length > 0;
  const toggle = (id: string) => setPicked((cur) => (cur.has(id) ? new Set([...cur].filter((x) => x !== id)) : cur.size >= LIMITS.sharedExcerptsMax ? (toast(t('share.max', { n: LIMITS.sharedExcerptsMax }), 'error'), cur) : new Set(cur).add(id)));

  if (conv.e2ee && e2ee.state === 'error') {
    return <ErrorBanner text={t(`e2ee.err.${e2ee.reason}` as never)} />;
  }
  if (error) return <ErrorBanner text={errText(error)} />;
  if (!rows) return <p className="muted pad">{t('common.loading')}</p>;

  const chosenRows = rows.filter((r) => picked.has(r.message.id));
  const name = (r: Row) => (r.message.senderId === meId ? t('share.me') : (r.sender?.displayName ?? '?'));
  const canAttach = chosenRows.length > 0 && (!conv.e2ee || ack);

  function attach() {
    const preview = chosenRows.slice(0, 3).map((r) => `${name(r)}: ${(r.text ?? '📎').replace(/\s+/g, ' ').slice(0, 80)}`);
    const base = { conversationTitle: title, e2ee: conv.e2ee, count: chosenRows.length, preview };
    if (conv.e2ee) {
      const excerpts = chosenRows
        .filter((r) => r.text?.trim())
        .map((r) => ({ sender: name(r), text: r.text!.trim().slice(0, LIMITS.sharedExcerptChars), at: r.message.createdAt }));
      if (excerpts.length === 0) return toast(t('share.nothingText'), 'error');
      onDone({ ...base, count: excerpts.length, input: { conversationId: conv.id, excerpts } });
    } else {
      onDone({ ...base, input: { conversationId: conv.id, messageIds: chosenRows.map((r) => r.message.id) } });
    }
  }

  return (
    <div className="share-picker">
      <div className="share-head">
        {onBack && (
          <button type="button" className="link-btn" onClick={onBack}>
            {t('common.back')}
          </button>
        )}
        <strong dir="auto">{title}</strong>
        {conv.e2ee && (
          <span className="chip chip-warn">
            <Icon name="lock" size={12} /> {t('e2ee.secret')}
          </span>
        )}
      </div>
      <p className="muted small">{conv.e2ee ? t('share.e2eeNotice') : t('share.normalNotice')}</p>
      {rows.length === 0 ? (
        <EmptyState icon="chat" title={t('share.noMessages')} />
      ) : (
        <ul className="share-list" aria-label={t('share.messages')}>
          {rows.map((r) => {
            const ok = selectable(r);
            const on = picked.has(r.message.id);
            return (
              <li key={r.message.id}>
                <label className={`share-row${on ? ' on' : ''}${ok ? '' : ' disabled'}`}>
                  <input type="checkbox" checked={on} disabled={!ok} onChange={() => toggle(r.message.id)} aria-label={`${name(r)}: ${r.text?.slice(0, 40) ?? ''}`} />
                  <span className="share-body">
                    <span className="small">
                      <strong dir="auto">{name(r)}</strong> <time className="muted">{fmtTime(r.message.createdAt, locale)}</time>
                    </span>
                    <span dir="auto" className="clamp-3">
                      {r.text ?? (r.message.cipher ? t('e2ee.undecryptable') : r.message.attachments.length ? `📎 ${r.message.attachments.map((a) => a.name).join(', ')}` : '')}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {conv.e2ee && chosenRows.length > 0 && (
        <label className="ack">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          <span>{t('share.e2eeConfirm', { n: chosenRows.length })}</span>
        </label>
      )}
      <div className="dialog-foot inline">
        <span className="muted small">{t('share.selected', { n: chosenRows.length })}</span>
        <Button variant="primary" icon="check" disabled={!canAttach} onClick={attach}>
          {t('share.attach')}
        </Button>
      </div>
    </div>
  );
}
