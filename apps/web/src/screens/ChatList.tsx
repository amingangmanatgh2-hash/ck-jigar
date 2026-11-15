import { AMIN_AI_USER_ID as AMIN_AI_ID, type ConversationDto, type UserDto } from '@aminchat/shared';
import { useMemo, useState } from 'react';
import { AiAvatar, Avatar, NameWithBadge, UserAvatar, VerifiedBadge } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { Button, Dialog, EmptyState, ErrorBanner, IconButton, Segmented, Spinner } from '../components/ui';
import { conversationTitle } from '../lib/conv';
import { Convs, Users } from '../lib/endpoints';
import { fmtListTime } from '../lib/format';
import { useErrorText, useLocale, useT } from '../lib/i18n';
import { navigate } from '../lib/router';
import { renderPlain, stripMarkdown } from '../lib/text';
import { loadConversations, upsertConversation, useConversations } from '../state/conversations';
import { ensureOwnKeyPublished, wouldReplaceKey } from '../state/e2ee';
import { useUser } from '../state/session';
import { toast } from '../state/toast';
import { useEffect } from 'react';

export const chatHref = (c: Pick<ConversationDto, 'id' | 'type'>): string => (c.type === 'ai' ? '#/ai' : `#/c/${c.id}`);

function lastLine(c: ConversationDto, meId: string, t: ReturnType<typeof useT>): string {
  const m = c.lastMessage;
  if (!m) return c.type === 'ai' ? t('ai.tagline') : t('chat.noMessages');
  if (m.encrypted) return `🔒 ${t('e2ee.encryptedMessage')}`;
  const prefix = m.senderId === meId ? `${t('chat.you')}: ` : '';
  return `${prefix}${c.type === 'ai' || m.senderId === AMIN_AI_ID ? stripMarkdown(m.preview) : m.preview}`;
}

export function ChatRow({ c, active }: { c: ConversationDto; active: boolean }) {
  const t = useT();
  const locale = useLocale();
  const me = useUser();
  const title = conversationTitle(c, t);
  const time = c.lastMessageAt ?? null;
  return (
    <li>
      <a href={chatHref(c)} className={`chat-row${active ? ' active' : ''}${c.type === 'ai' ? ' is-ai' : ''}`} aria-current={active ? 'page' : undefined} data-testid="chat-row" data-type={c.type}>
        {c.type === 'ai' ? <AiAvatar size={52} /> : c.type === 'group' ? <Avatar name={title} size={52} group /> : <UserAvatar user={c.peer ?? { displayName: title, kind: 'human' }} size={52} />}
        <span className="chat-row-main">
          <span className="chat-row-top">
            <span className="chat-row-title">
              <NameWithBadge user={c.type === 'ai' ? { displayName: title, verified: true, kind: 'ai' } : (c.peer ?? undefined)} name={title} />
              {c.e2ee && <Icon name="lock" size={13} />}
              {c.muted && <Icon name="bellOff" size={13} />}
            </span>
            {time && <time className="muted small">{fmtListTime(time, locale)}</time>}
          </span>
          <span className="chat-row-bottom">
            <span className="chat-row-preview muted" dir="auto">
              {renderPlain(lastLine(c, me.id, t))}
            </span>
            {c.pinned && c.type !== 'ai' && <Icon name="pin" size={13} />}
            {c.unread > 0 && (
              <span className="badge" aria-label={t('chat.unread', { n: c.unread })}>
                {c.unread > 99 ? '99+' : c.unread}
              </span>
            )}
          </span>
        </span>
      </a>
    </li>
  );
}

function NewChatDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const me = useUser();
  const errText = useErrorText();
  const [mode, setMode] = useState<'direct' | 'group'>('direct');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<UserDto[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<UserDto[]>([]);
  const [secret, setSecret] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmKey, setConfirmKey] = useState<UserDto | null>(null);

  useEffect(() => {
    if (!open) {
      setQ('');
      setResults([]);
      setPicked([]);
      setSecret(false);
      setTitle('');
      setMode('direct');
    }
  }, [open]);
  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setResults([]);
      return;
    }
    let alive = true;
    setSearching(true);
    const id = setTimeout(() => {
      Users.search(query)
        .then((r) => alive && setResults(r.users.filter((u) => u.id !== me.id && u.kind === 'human')))
        .catch(() => alive && setResults([]))
        .finally(() => alive && setSearching(false));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [q, me.id]);

  async function startDirect(user: UserDto, replaceKey = false) {
    setBusy(true);
    try {
      if (secret) {
        if (!replaceKey && wouldReplaceKey(me)) {
          setConfirmKey(user);
          return;
        }
        await ensureOwnKeyPublished(me);
      }
      const { conversation } = await Convs.direct(user.id, secret);
      upsertConversation(conversation);
      onClose();
      navigate(`/c/${conversation.id}`);
    } catch (err) {
      toast(errText(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function createGroup() {
    setBusy(true);
    try {
      const { conversation } = await Convs.group(title.trim(), picked.map((u) => u.id));
      upsertConversation(conversation);
      onClose();
      navigate(`/c/${conversation.id}`);
    } catch (err) {
      toast(errText(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        title={t('chat.new')}
        footer={
          mode === 'group' ? (
            <Button variant="primary" busy={busy} disabled={!title.trim() || picked.length === 0} onClick={() => void createGroup()}>
              {t('group.create')}
            </Button>
          ) : undefined
        }
      >
        <Segmented
          label={t('chat.new')}
          value={mode}
          onChange={setMode}
          options={[
            { value: 'direct', label: t('chat.direct') },
            { value: 'group', label: t('chat.group') },
          ]}
        />
        {mode === 'group' && (
          <div className="field">
            <label htmlFor="new-group-title">{t('group.title')}</label>
            <input id="new-group-title" dir="auto" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
          </div>
        )}
        {mode === 'group' && picked.length > 0 && (
          <ul className="chips">
            {picked.map((u) => (
              <li key={u.id} className="chip">
                <span dir="auto">{u.displayName}</span>
                <button type="button" className="icon-btn small" aria-label={t('common.remove')} onClick={() => setPicked((p) => p.filter((x) => x.id !== u.id))}>
                  <Icon name="x" size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="search-box">
          <Icon name="search" size={18} />
          <input type="search" dir="auto" value={q} placeholder={t('users.search')} aria-label={t('users.search')} onChange={(e) => setQ(e.target.value)} />
        </div>
        {mode === 'direct' && (
          <label className="ack">
            <input type="checkbox" checked={secret} onChange={(e) => setSecret(e.target.checked)} />
            <span>
              <Icon name="lock" size={14} /> {t('chat.secret')} <span className="muted small">— {t('chat.secretHint')}</span>
            </span>
          </label>
        )}
        {searching && <Spinner />}
        <ul className="list" aria-label={t('users.results')}>
          {results.map((u) => {
            const disabled = mode === 'direct' && secret && !u.hasE2eeKey;
            return (
              <li key={u.id}>
                <button
                  type="button"
                  className="list-item"
                  disabled={busy || disabled}
                  title={disabled ? t('chat.noKey') : undefined}
                  onClick={() => (mode === 'direct' ? void startDirect(u) : setPicked((p) => (p.some((x) => x.id === u.id) ? p : [...p, u])))}
                >
                  <Avatar name={u.displayName} size={36} />
                  <span className="list-main">
                    <strong dir="auto">{u.displayName}</strong>
                    <span className="muted small">@{u.username}{disabled ? ` · ${t('chat.noKey')}` : ''}</span>
                  </span>
                  <Icon name={mode === 'group' ? 'plus' : 'chevron'} size={16} flip={mode === 'direct'} />
                </button>
              </li>
            );
          })}
          {q.trim().length >= 2 && !searching && results.length === 0 && <li className="muted pad">{t('users.none')}</li>}
        </ul>
      </Dialog>
      <Dialog
        open={confirmKey !== null}
        onClose={() => setConfirmKey(null)}
        title={t('e2ee.replaceKeyTitle')}
        footer={
          <>
            <Button onClick={() => setConfirmKey(null)}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              onClick={() => {
                const u = confirmKey;
                setConfirmKey(null);
                if (u) void startDirect(u, true);
              }}
            >
              {t('e2ee.replaceKey')}
            </Button>
          </>
        }
      >
        <p>{t('e2ee.replaceKeyText')}</p>
      </Dialog>
    </>
  );
}

export function ChatList({ activeId }: { activeId: string | null }) {
  const t = useT();
  const errText = useErrorText();
  const { items, loaded, error } = useConversations();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);

  const shown = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return items;
    return items.filter((c) => conversationTitle(c, t).toLowerCase().includes(query) || c.peer?.username.toLowerCase().includes(query));
  }, [items, q, t]);

  return (
    <section className="chat-list" aria-label={t('nav.chats')}>
      <header className="list-head">
        <h1>
          {t('app.name')} <VerifiedBadge size={0} />
        </h1>
        <IconButton icon="plus" label={t('chat.new')} onClick={() => setCreating(true)} />
      </header>
      <div className="search-box">
        <Icon name="search" size={18} />
        <input type="search" dir="auto" value={q} placeholder={t('chat.search')} aria-label={t('chat.search')} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error && items.length === 0 ? <ErrorBanner text={errText(error)} onRetry={() => void loadConversations()} /> : null}
      {!loaded && items.length === 0 && (
        <div className="center pad">
          <Spinner label={t('common.loading')} />
        </div>
      )}
      <ul className="chat-rows">
        {shown.map((c) => (
          <ChatRow key={c.id} c={c} active={c.id === activeId || (c.type === 'ai' && activeId === 'ai')} />
        ))}
      </ul>
      {loaded && shown.length === 0 && q && <EmptyState icon="search" title={t('chat.noResults')} />}
      <NewChatDialog open={creating} onClose={() => setCreating(false)} />
    </section>
  );
}
