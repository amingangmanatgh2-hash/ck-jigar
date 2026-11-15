import { LIMITS, hasAiMention, type ConversationDto, type MessageDto, type RunDto, type UserDto, type AiTriggerResult } from '@aminchat/shared';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Avatar, NameWithBadge, UserAvatar } from '../components/Avatar';
import { Composer } from '../components/Composer';
import { Icon } from '../components/Icon';
import { MessageBubble } from '../components/MessageBubble';
import { RunPanel } from '../components/RunPanel';
import { ShareDialog } from '../components/ShareDialog';
import { Button, ErrorBanner, IconButton, Spinner } from '../components/ui';
import { conversationTitle } from '../lib/conv';
import { encryptText, decryptText } from '../lib/e2ee';
import { Ai, Convs } from '../lib/endpoints';
import { dayKey, fmtDayLabel } from '../lib/format';
import { useErrorText, useLocale, useT, type Key } from '../lib/i18n';
import { realtime } from '../lib/realtime';
import { back, navigate } from '../lib/router';
import { isActiveRun, newerRun, mergeApproval, mergeStep } from '../lib/runs';
import { activeConversation, markRead, upsertConversation, useConversation } from '../state/conversations';
import { useStickToBottom } from '../lib/useStickToBottom';
import { useE2eeKey } from '../state/e2ee';
import { useUser } from '../state/session';
import { toast } from '../state/toast';
import { mergeLoaded, upsertMessage } from '../state/aiThread';
import { AiAccessSummary } from './AiAccess';

interface State {
  messages: MessageDto[];
  hasMore: boolean;
  status: 'loading' | 'ready' | 'error';
  error: unknown;
  loadingMore: boolean;
}
type Action =
  | { type: 'reset' }
  | { type: 'loaded'; messages: MessageDto[]; hasMore: boolean }
  | { type: 'failed'; error: unknown }
  | { type: 'older'; messages: MessageDto[]; hasMore: boolean }
  | { type: 'loadingMore' }
  | { type: 'upsert'; message: MessageDto }
  | { type: 'remove'; id: string }
  | { type: 'poll'; id: string; poll: NonNullable<MessageDto['poll']> };

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'reset':
      return { messages: [], hasMore: false, status: 'loading', error: null, loadingMore: false };
    case 'loaded':
      // live events can have delivered something newer than the page while the request was in flight (first load only)
      return { ...s, status: 'ready', error: null, messages: s.status === 'loading' ? mergeLoaded(s.messages, a.messages) : a.messages, hasMore: a.hasMore };
    case 'failed':
      return { ...s, status: 'error', error: a.error, loadingMore: false };
    case 'loadingMore':
      return { ...s, loadingMore: true };
    case 'older': {
      const known = new Set(s.messages.map((m) => m.id));
      return { ...s, loadingMore: false, hasMore: a.hasMore, messages: [...a.messages.filter((m) => !known.has(m.id)), ...s.messages] };
    }
    case 'upsert':
      return { ...s, messages: upsertMessage(s.messages, a.message) };
    case 'remove':
      return { ...s, messages: s.messages.filter((m) => m.id !== a.id) };
    case 'poll':
      return { ...s, messages: s.messages.map((m) => (m.id === a.id ? { ...m, poll: a.poll } : m)) };
  }
}

const TYPING_MS = 4500;
let lastTypingSent = 0;

/** Chat with another person or a group. AMIN AI can be summoned here with @AMINAI — but only as far as this chat's AI access allows. */
export function ChatScreen({ conversationId }: { conversationId: string }) {
  const t = useT();
  const locale = useLocale();
  const me = useUser();
  const errText = useErrorText();
  const conv = useConversation(conversationId);
  const [state, dispatch] = useReducer(reducer, { messages: [], hasMore: false, status: 'loading', error: null, loadingMore: false });
  const [detail, setDetail] = useState<ConversationDto | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [sending, setSending] = useState(false);
  const [decrypted, setDecrypted] = useState<Map<string, string | null>>(new Map());
  const [typing, setTyping] = useState<Record<string, number>>({});
  const [denied, setDenied] = useState<AiTriggerResult['denied'] | null>(null);
  const [assist, setAssist] = useState<Record<string, RunDto>>({});
  const [reply, setReply] = useState<MessageDto | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [insert, setInsert] = useState<{ id: number; text: string } | null>(null);
  const [draft, setDraft] = useState('');
  const { scroller, inner, stick, showJump, onScroll: onStickScroll, toBottom } = useStickToBottom(conversationId);

  const full = detail && detail.id === conversationId ? detail : conv;
  const e2ee = useE2eeKey(full ?? undefined, me.id);

  // ---- load conversation (with members) + first page of messages
  const load = useCallback(async () => {
    try {
      const [c, page] = await Promise.all([Convs.get(conversationId), Convs.messages(conversationId, { limit: 50 })]);
      setDetail(c.conversation);
      upsertConversation(c.conversation);
      dispatch({ type: 'loaded', messages: page.messages, hasMore: page.hasMore });
      const active = await Ai.runs('active', 20).catch(() => ({ runs: [] as RunDto[] }));
      setAssist(Object.fromEntries(active.runs.filter((r) => r.kind === 'assist' && r.conversationId === conversationId).map((r) => [r.id, r])));
      setLoadError(null);
      void Convs.read(conversationId).then(() => markRead(conversationId)).catch(() => undefined);
    } catch (error) {
      setLoadError(error);
      dispatch({ type: 'failed', error });
    }
  }, [conversationId]);

  useEffect(() => {
    dispatch({ type: 'reset' });
    setDecrypted(new Map());
    setDenied(null);
    setReply(null);
    setAssist({});
    activeConversation.set(conversationId);
    void load();
    return () => {
      if (activeConversation.get() === conversationId) activeConversation.set(null);
    };
  }, [conversationId, load]);

  // ---- realtime
  useEffect(() => {
    const off = realtime.on((ev) => {
      switch (ev.type) {
        case 'message.created':
        case 'message.updated':
          if (ev.message.conversationId !== conversationId) return;
          dispatch({ type: 'upsert', message: ev.message });
          if (ev.type === 'message.created' && ev.message.senderId !== me.id) void Convs.read(conversationId).then(() => markRead(conversationId)).catch(() => undefined);
          break;
        case 'message.deleted':
          if (ev.conversationId === conversationId) dispatch({ type: 'remove', id: ev.messageId });
          break;
        case 'poll.updated':
          if (ev.conversationId === conversationId) dispatch({ type: 'poll', id: ev.messageId, poll: ev.poll });
          break;
        case 'typing':
          if (ev.conversationId === conversationId && ev.userId !== me.id) {
            setTyping((cur) => ({ ...cur, [ev.ai ? 'ai' : ev.userId]: Date.now() + TYPING_MS }));
          }
          break;
        case 'conversation.updated':
          if (ev.conversationId === conversationId) void Convs.get(conversationId).then((r) => (setDetail(r.conversation), upsertConversation(r.conversation))).catch(() => undefined);
          break;
        case 'run.updated':
          if (ev.run.kind === 'assist' && ev.run.conversationId === conversationId) setAssist((cur) => ({ ...cur, [ev.run.id]: newerRun(cur[ev.run.id], ev.run) }));
          break;
        case 'run.step':
          setAssist((cur) => (cur[ev.runId] ? { ...cur, [ev.runId]: mergeStep(cur[ev.runId]!, ev.step) } : cur));
          break;
        case 'run.approval':
          setAssist((cur) => (cur[ev.approval.runId] ? { ...cur, [ev.approval.runId]: mergeApproval(cur[ev.approval.runId]!, ev.approval) } : cur));
          break;
        default:
      }
    });
    const offResync = realtime.onResync(() => void load());
    return () => {
      off();
      offResync();
    };
  }, [conversationId, me.id, load]);

  // expire typing indicators
  useEffect(() => {
    if (Object.keys(typing).length === 0) return;
    const id = setInterval(() => setTyping((cur) => Object.fromEntries(Object.entries(cur).filter(([, until]) => until > Date.now()))), 1000);
    return () => clearInterval(id);
  }, [typing]);

  // ---- decrypt secret-chat messages on this device
  useEffect(() => {
    if (e2ee.state !== 'ready') return;
    let alive = true;
    const pending = state.messages.filter((m) => m.cipher && !decrypted.has(m.id));
    if (pending.length === 0) return;
    (async () => {
      const entries = await Promise.all(pending.map(async (m) => [m.id, await decryptText(e2ee.key, m.cipher!)] as const));
      if (alive) setDecrypted((cur) => new Map([...cur, ...entries]));
    })();
    return () => {
      alive = false;
    };
  }, [e2ee, state.messages, decrypted]);

  // ---- scrolling (the hook keeps the newest content in view; this adds paging towards older messages)
  const onScroll = () => {
    onStickScroll();
    const el = scroller.current;
    if (el && el.scrollTop < 40 && state.hasMore && !state.loadingMore) {
      const first = state.messages[0];
      if (!first) return;
      dispatch({ type: 'loadingMore' });
      Convs.messages(conversationId, { before: first.id, limit: 50 })
        .then((p) => dispatch({ type: 'older', messages: p.messages, hasMore: p.hasMore }))
        .catch((error) => dispatch({ type: 'failed', error }));
    }
  };

  const members = useMemo(() => {
    const map = new Map<string, UserDto>();
    for (const m of full?.members ?? []) map.set(m.user.id, m.user);
    if (full?.peer) map.set(full.peer.id, full.peer);
    map.set(me.id, me);
    return map;
  }, [full?.members, full?.peer, me]);

  async function send(text: string, fileIds: string[]): Promise<boolean> {
    if (!full) return false;
    setSending(true);
    setDenied(null);
    try {
      let body: { body?: string; cipher?: Awaited<ReturnType<typeof encryptText>>; replyToId?: string; fileIds?: string[] };
      if (full.e2ee) {
        if (e2ee.state !== 'ready') throw Object.assign(new Error('no key'), { code: 'E2EE_NO_ACCESS' });
        body = { cipher: await encryptText(e2ee.key, text) };
      } else body = { body: text, ...(fileIds.length ? { fileIds } : {}) };
      if (reply) body.replyToId = reply.id;
      const res = await Convs.send(conversationId, body);
      dispatch({ type: 'upsert', message: res.message });
      if (full.e2ee) setDecrypted((cur) => new Map(cur).set(res.message.id, text));
      setReply(null);
      stick.current = true;
      if (res.ai?.denied) setDenied(res.ai.denied);
      else if (res.ai?.triggered && res.ai.runId) {
        void Ai.run(res.ai.runId).then((r) => setAssist((cur) => ({ ...cur, [r.run.id]: newerRun(cur[r.run.id], r.run) }))).catch(() => undefined);
      }
      return true;
    } catch (err) {
      toast(errText(err), 'error');
      return false;
    } finally {
      setSending(false);
    }
  }

  async function enableAi() {
    try {
      const { conversation } = await Convs.setAi(conversationId, { access: 'mention' });
      setDetail(conversation);
      upsertConversation(conversation);
      setDenied(null);
      toast(t('ai.access.enabled'), 'success');
    } catch (err) {
      toast(errText(err), 'error');
    }
  }

  if (loadError && !full) {
    return (
      <section className="chat-screen">
        <header className="chat-head">
          <IconButton className="only-narrow" icon="back" flip label={t('common.back')} onClick={() => back('#/')} />
        </header>
        <ErrorBanner text={errText(loadError)} onRetry={() => void load()} />
      </section>
    );
  }
  if (!full) {
    return (
      <section className="chat-screen">
        <div className="center pad">
          <Spinner label={t('common.loading')} />
        </div>
      </section>
    );
  }

  const title = conversationTitle(full, t);
  const typers = Object.keys(typing).map((k) => (k === 'ai' ? t('ai.name') : (members.get(k)?.displayName ?? '?')));
  const assistRuns = Object.values(assist).filter((r) => isActiveRun(r));
  const aiAccess = full.ai.effective;
  const blockedE2ee = full.e2ee && e2ee.state === 'error';
  const lastMsg = state.messages[state.messages.length - 1];

  let lastDay = '';
  return (
    <section className="chat-screen" aria-label={title}>
      <header className="chat-head">
        <IconButton className="only-narrow" icon="back" flip label={t('common.back')} onClick={() => back('#/')} />
        {full.type === 'direct' && full.peer ? <UserAvatar user={full.peer} size={40} /> : <Avatar name={title} size={40} group />}
        <button type="button" className="chat-head-main as-button" onClick={() => navigate(`/c/${conversationId}/info`)} aria-label={t('chat.info')}>
          <div className="chat-title">
            <NameWithBadge user={full.peer ?? undefined} name={title} />
            {full.e2ee && <Icon name="lock" size={14} />}
          </div>
          <div className="status-line" role="status" aria-live="polite">
            {typers.length > 0 ? (
              <span className="typing-line">{t('chat.typing', { names: typers.join(', ') })}</span>
            ) : full.type === 'group' ? (
              <span>{t('chat.members', { n: full.memberCount })}</span>
            ) : full.e2ee ? (
              <span>{t('e2ee.secret')}</span>
            ) : null}
          </div>
        </button>
        <AiAccessSummary conv={full} compact />
        <IconButton icon="select" label={t('share.title')} onClick={() => setShareOpen(true)} />
        <IconButton icon="settings" label={t('chat.info')} onClick={() => navigate(`/c/${conversationId}/info`)} />
      </header>

      <div className="messages" ref={scroller} onScroll={onScroll} data-testid="messages">
        <div ref={inner} className="messages-inner">
        {state.loadingMore && (
          <div className="center pad">
            <Spinner />
          </div>
        )}
        {state.status === 'loading' && (
          <div className="center pad">
            <Spinner label={t('common.loading')} />
          </div>
        )}
        {state.status === 'error' && <ErrorBanner text={errText(state.error)} onRetry={() => void load()} />}
        {full.e2ee && (
          <div className="banner banner-info">
            <Icon name="lock" size={18} />
            <span>{blockedE2ee ? t(`e2ee.err.${(e2ee as { reason: string }).reason}` as Key) : t('e2ee.banner')}</span>
          </div>
        )}
        {state.messages.map((m) => {
          const key = dayKey(m.createdAt);
          const sep = key !== lastDay ? fmtDayLabel(m.createdAt, locale, { today: t('common.today'), yesterday: t('common.yesterday') }) : null;
          lastDay = key;
          const sender = members.get(m.senderId);
          const mine = m.senderId === me.id;
          return (
            <div key={m.id}>
              {sep && (
                <div className="day-sep">
                  <span>{sep}</span>
                </div>
              )}
              <MessageBubble
                message={m}
                mine={mine}
                sender={sender}
                showSender={full.type === 'group'}
                decrypted={decrypted.get(m.id)}
                invokerName={m.meta?.ai?.invokedBy ? (members.get(m.meta.ai.invokedBy)?.displayName ?? null) : null}
                onRunChanged={() => void load()}
              />
            </div>
          );
        })}
        {typers.length > 0 && (
          <div className="typing-bubble" aria-hidden="true">
            <span className="typing-dots">
              <i />
              <i />
              <i />
            </span>
          </div>
        )}
        </div>
      </div>

      {showJump && (
        <button type="button" className="jump-btn" onClick={() => toBottom(true)} aria-label={t('chat.jumpLatest')}>
          <Icon name="down" size={18} />
        </button>
      )}

      {assistRuns.length > 0 && (
        <div className="assist-runs" aria-label={t('run.task')}>
          {assistRuns.map((r) => (
            <RunPanel key={r.id} run={r} compact={false} defaultOpen onChanged={() => void load()} />
          ))}
        </div>
      )}

      {denied && (
        <div className="banner banner-warn" role="alert" data-testid="ai-denied">
          <Icon name="lock" size={18} />
          <span>{t(`err.${denied.code}` as Key) === `err.${denied.code}` ? denied.message : t(`err.${denied.code}` as Key)}</span>
          {denied.canEnable && (
            <Button onClick={() => void enableAi()} icon="check">
              {t('ai.access.enable')}
            </Button>
          )}
          <IconButton icon="x" size={14} label={t('common.close')} onClick={() => setDenied(null)} />
        </div>
      )}

      {typeof lastMsg === 'undefined' && state.status === 'ready' && <p className="muted center pad">{t('chat.noMessages')}</p>}

      <Composer
        draftKey={`chat:${conversationId}`}
        placeholder={blockedE2ee ? t('e2ee.cannotWrite') : t('chat.composer')}
        maxChars={full.e2ee ? LIMITS.messageMaxChars : LIMITS.messageMaxChars}
        disabled={blockedE2ee || (full.e2ee && e2ee.state === 'loading')}
        sending={sending}
        onSend={send}
        allowFiles={!full.e2ee}
        mention={!full.e2ee}
        insert={insert}
        onTyping={() => {
          const now = Date.now();
          if (now - lastTypingSent > 3000) {
            lastTypingSent = now;
            realtime.send({ type: 'typing', conversationId });
          }
        }}
        onTextChange={setDraft}
        top={
          <>
            {reply && (
              <div className="chip chip-edit" role="status">
                <Icon name="chat" size={14} />
                <span className="clamp-1" dir="auto">
                  {reply.body ?? ''}
                </span>
                <button type="button" className="icon-btn small" aria-label={t('common.cancel')} onClick={() => setReply(null)}>
                  <Icon name="x" size={12} />
                </button>
              </div>
            )}
            {hasAiMention(draft) && !aiAccess.allowed && <p className="muted small">{t('ai.access.offHint')}</p>}
          </>
        }
        tools={
          !full.e2ee ? (
            <IconButton
              icon="sparkles"
              label={t('mention.button')}
              onClick={() => setInsert({ id: Date.now(), text: '@AMINAI ' })}
              title={aiAccess.allowed ? t('mention.button') : t('mention.buttonOff')}
            />
          ) : undefined
        }
      />
      <ShareDialog open={shareOpen} onClose={() => setShareOpen(false)} conversationId={conversationId} onAttached={() => navigate('/ai/new')} />
    </section>
  );
}
