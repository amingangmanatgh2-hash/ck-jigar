import type { ConversationDto, MemberDto, UserDto } from '@aminchat/shared';
import { useEffect, useState } from 'react';
import { Avatar, NameWithBadge, UserAvatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { Button, ConfirmDialog, Dialog, ErrorBanner, IconButton, Spinner, Switch } from '../components/ui';
import { conversationTitle } from '../lib/conv';
import { Convs, Users } from '../lib/endpoints';
import { useErrorText, useT } from '../lib/i18n';
import { back, navigate } from '../lib/router';
import { removeConversation, upsertConversation, useConversation } from '../state/conversations';
import { useUser } from '../state/session';
import { toast } from '../state/toast';
import { AiAccessPanel } from './AiAccess';

const roleKey = (r: string) => (r === 'owner' ? 'member.owner' : r === 'admin' ? 'member.admin' : 'member.member');

function AddMembers({ conv, open, onClose }: { conv: ConversationDto; open: boolean; onClose: () => void }) {
  const t = useT();
  const errText = useErrorText();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<UserDto[]>([]);
  const existing = new Set((conv.members ?? []).map((m) => m.user.id));
  useEffect(() => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    let alive = true;
    const id = setTimeout(() => Users.search(q.trim()).then((r) => alive && setResults(r.users.filter((u) => u.kind === 'human' && !existing.has(u.id)))).catch(() => alive && setResults([])), 250);
    return () => {
      alive = false;
      clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  return (
    <Dialog open={open} onClose={onClose} title={t('group.addMembers')}>
      <div className="search-box">
        <Icon name="search" size={18} />
        <input type="search" dir="auto" value={q} placeholder={t('users.search')} aria-label={t('users.search')} onChange={(e) => setQ(e.target.value)} />
      </div>
      <ul className="list">
        {results.map((u) => (
          <li key={u.id}>
            <button
              type="button"
              className="list-item"
              onClick={async () => {
                try {
                  const res = await Convs.addMembers(conv.id, [u.id]);
                  upsertConversation(res.conversation);
                  setResults((r) => r.filter((x) => x.id !== u.id));
                } catch (err) {
                  toast(errText(err), 'error');
                }
              }}
            >
              <Avatar name={u.displayName} size={36} />
              <span className="list-main">
                <strong dir="auto">{u.displayName}</strong>
                <span className="muted small">@{u.username}</span>
              </span>
              <Icon name="plus" size={18} />
            </button>
          </li>
        ))}
        {q.trim().length >= 2 && results.length === 0 && <li className="muted pad">{t('users.none')}</li>}
      </ul>
    </Dialog>
  );
}

/** Chat settings: mute / pin, the AI access controls for this chat, and (groups) members and roles. */
export function ChatInfoScreen({ conversationId }: { conversationId: string }) {
  const t = useT();
  const me = useUser();
  const errText = useErrorText();
  const stored = useConversation(conversationId);
  const [conv, setConv] = useState<ConversationDto | null>(stored ?? null);
  const [error, setError] = useState<unknown>(null);
  const [adding, setAdding] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [title, setTitle] = useState('');

  useEffect(() => {
    let alive = true;
    Convs.get(conversationId)
      .then((r) => {
        if (!alive) return;
        setConv(r.conversation);
        setTitle(r.conversation.title ?? '');
        upsertConversation(r.conversation);
      })
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [conversationId]);
  // keep in sync with changes made by the panels (they update the shared store)
  useEffect(() => {
    if (stored) setConv((c) => (c ? { ...stored, members: stored.members ?? c.members } : stored));
  }, [stored]);

  if (error && !conv) return <ErrorBanner text={errText(error)} />;
  if (!conv)
    return (
      <div className="center pad">
        <Spinner label={t('common.loading')} />
      </div>
    );

  const isAdmin = conv.myRole === 'owner' || conv.myRole === 'admin';
  const name = conversationTitle(conv, t);

  async function patch(b: Parameters<typeof Convs.patch>[1]) {
    try {
      const r = await Convs.patch(conversationId, b);
      upsertConversation(r.conversation);
      setConv(r.conversation);
    } catch (err) {
      toast(errText(err), 'error');
    }
  }

  async function memberAction(fn: () => Promise<unknown>) {
    try {
      await fn();
      const r = await Convs.get(conversationId);
      setConv(r.conversation);
      upsertConversation(r.conversation);
    } catch (err) {
      toast(errText(err), 'error');
    }
  }

  return (
    <section className="page" aria-label={t('chat.info')}>
      <header className="page-head">
        <IconButton icon="back" flip label={t('common.back')} onClick={() => back(`#/c/${conversationId}`)} />
        <h1>{t('chat.info')}</h1>
      </header>
      <div className="page-body">
        <div className="profile-card">
          {conv.type === 'direct' && conv.peer ? <UserAvatar user={conv.peer} size={72} /> : <Avatar name={name} size={72} group />}
          <h2>
            <NameWithBadge user={conv.peer ?? undefined} name={name} />
          </h2>
          {conv.type === 'direct' && conv.peer && <p className="muted">@{conv.peer.username}</p>}
          {conv.peer?.bio && (
            <p className="muted small" dir="auto">
              {conv.peer.bio}
            </p>
          )}
          {conv.e2ee && (
            <span className="chip chip-warn">
              <Icon name="lock" size={12} /> {t('e2ee.secret')}
            </span>
          )}
        </div>

        {conv.type === 'group' && isAdmin && (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (title.trim() && title.trim() !== conv.title) void patch({ title: title.trim() });
            }}
          >
            <label htmlFor="group-title">{t('group.title')}</label>
            <input id="group-title" dir="auto" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
            <Button type="submit" disabled={!title.trim() || title.trim() === conv.title}>
              {t('common.save')}
            </Button>
          </form>
        )}

        <section className="panel">
          <Switch checked={conv.pinned} onChange={(pinned) => void patch({ pinned })} label={t('chat.pin')} />
          <Switch checked={conv.muted} onChange={(muted) => void patch({ muted })} label={t('chat.mute')} />
        </section>

        <AiAccessPanel conv={conv} />

        {conv.type === 'group' && (
          <section className="panel" aria-label={t('group.members')}>
            <h3>
              <Icon name="users" size={18} /> {t('group.members')} ({conv.memberCount})
            </h3>
            {isAdmin && (
              <Button icon="plus" onClick={() => setAdding(true)}>
                {t('group.addMembers')}
              </Button>
            )}
            <ul className="list">
              {(conv.members ?? []).map((m: MemberDto) => (
                <li key={m.user.id} className="list-row">
                  <div className="list-item static">
                    <UserAvatar user={m.user} size={36} />
                    <span className="list-main">
                      <NameWithBadge user={m.user} />
                      <span className="muted small">{t(roleKey(m.role) as never)}</span>
                    </span>
                  </div>
                  {conv.myRole === 'owner' && m.role !== 'owner' && (
                    <Button variant="ghost" onClick={() => void memberAction(() => Convs.setRole(conversationId, m.user.id, m.role === 'admin' ? 'member' : 'admin'))}>
                      {m.role === 'admin' ? t('member.demote') : t('member.promote')}
                    </Button>
                  )}
                  {isAdmin && m.role !== 'owner' && m.user.id !== me.id && (
                    <IconButton icon="trash" size={16} label={t('member.remove')} onClick={() => void memberAction(() => Convs.removeMember(conversationId, m.user.id))} />
                  )}
                </li>
              ))}
            </ul>
            <Button variant="danger" icon="logout" onClick={() => setLeaving(true)}>
              {t('group.leave')}
            </Button>
          </section>
        )}
      </div>
      <AddMembers conv={conv} open={adding} onClose={() => setAdding(false)} />
      <ConfirmDialog
        open={leaving}
        danger
        title={t('group.leave')}
        text={t('group.leaveConfirm')}
        confirmLabel={t('group.leave')}
        onClose={() => setLeaving(false)}
        onConfirm={async () => {
          try {
            await Convs.removeMember(conversationId, me.id);
            removeConversation(conversationId);
            navigate('/', { replace: true });
          } catch (err) {
            toast(errText(err), 'error');
          }
          setLeaving(false);
        }}
      />
    </section>
  );
}
