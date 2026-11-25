import { LIMITS, type MessageDto, type RunDto } from '@aminchat/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AiAvatar, VerifiedBadge } from '../components/Avatar';
import { Composer } from '../components/Composer';
import { Icon } from '../components/Icon';
import { MessageBubble } from '../components/MessageBubble';
import { AgentPicker, ModelPicker } from '../components/pickers';
import { ShareDialog } from '../components/ShareDialog';
import { ThreadDrawer } from '../components/ThreadDrawer';
import { Button, ConfirmDialog, EmptyState, ErrorBanner, IconButton, Spinner } from '../components/ui';
import { createSendTokens } from '../lib/api';
import { Ai, Convs } from '../lib/endpoints';
import { dayKey, fmtDayLabel } from '../lib/format';
import { useCodeText, useErrorText, useLocale, useT, type Key } from '../lib/i18n';
import { back, navigate } from '../lib/router';
import { RUN_STATUS_KEY, isActiveRun, pendingApprovals } from '../lib/runs';
import { streams, useLiveBody } from '../lib/streams';
import { useStickToBottom } from '../lib/useStickToBottom';
import { upsertThread, useAgents, useModels, useThreads, refreshThreads } from '../state/ai';
import { activeConversation, markRead, useAiConversation } from '../state/conversations';
import { useAiThread } from '../state/aiThread';
import { shareStore, useShare } from '../state/share';
import { useUser } from '../state/session';
import { toast } from '../state/toast';

const AGENT_KEY = 'aminchat.agent';
const MODEL_KEY = 'aminchat.model';
const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    // ignore
  }
};

const STARTERS: { key: Key; agent: string }[] = [
  { key: 'ai.starter.plan', agent: 'personal' },
  { key: 'ai.starter.research', agent: 'research' },
  { key: 'ai.starter.code', agent: 'coder' },
  { key: 'ai.starter.message', agent: 'messenger' },
  { key: 'ai.starter.story', agent: 'creative' },
  { key: 'ai.starter.files', agent: 'file' },
];

/**
 * `#/ai`        → the most recent conversation (or an empty one when there is none yet)
 * `#/ai/new`    → a new, empty conversation (created on the first message)
 * `#/ai/<id>`   → that conversation
 */
export function AiChatScreen({ param }: { param: string | undefined }) {
  const threads = useThreads();
  const latest = threads.data?.find((x) => x.kind === 'chat')?.id ?? null;
  const threadId = param === 'new' ? null : (param ?? latest);
  return <AiChat threadId={threadId} resolving={param === undefined && !threads.data && !threads.error} />;
}

function AiChat({ threadId, resolving }: { threadId: string | null; resolving: boolean }) {
  const t = useT();
  const locale = useLocale();
  const me = useUser();
  const errText = useErrorText();
  const aiConv = useAiConversation();
  const { data: agents } = useAgents();
  const { data: models, reload: reloadModels } = useModels();
  const threads = useThreads();
  const share = useShare();
  const { state, dispatch, reload, loadOlder } = useAiThread(threadId, aiConv?.id ?? null);

  const thread = threads.data?.find((x) => x.id === threadId) ?? null;
  const [agentId, setAgentId] = useState<string>(() => read(AGENT_KEY) ?? 'auto');
  const [modelId, setModelId] = useState<string | null>(() => read(MODEL_KEY));
  const [sending, setSending] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [editing, setEditing] = useState<MessageDto | null>(null);
  const [confirmEdit, setConfirmEdit] = useState<{ message: MessageDto; text: string } | null>(null);
  const [prefill, setPrefill] = useState<string | undefined>();
  const { scroller, inner, stick, showJump, onScroll: onStickScroll, toBottom } = useStickToBottom(threadId);

  // The thread remembers its agent/model; a new thread uses the last choice.
  useEffect(() => {
    if (thread) {
      setAgentId(thread.agentId || 'auto');
      setModelId(thread.modelId);
    }
  }, [thread?.id, thread?.agentId, thread?.modelId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!threads.data && !threads.loading) void threads.reload();
  }, [threads]);

  const activeRun: RunDto | null = state.activeRunId ? (state.runs[state.activeRunId] ?? null) : null;
  const running = isActiveRun(activeRun) || state.messages.some((m) => m.status === 'streaming' && m.senderId !== me.id);
  const streamingMessage = state.messages.find((m) => m.status === 'streaming');
  const liveText = useLiveBody(streamingMessage);
  const backendDown = models ? !models.providers.some((p) => p.connected) : false;

  // refresh the thread list once a run finishes (the server generates the title after the first answer)
  const lastActive = useRef<string | null>(null);
  const sendTokens = useRef(createSendTokens());
  /** A thread created for a first message whose send then failed: the next attempt reuses it instead of leaving an empty one behind. */
  const orphanThread = useRef<string | null>(null);
  useEffect(() => {
    if (state.activeRunId) lastActive.current = state.activeRunId;
    else if (lastActive.current) {
      lastActive.current = null;
      void refreshThreads();
      void reloadModels();
    }
  }, [state.activeRunId, reloadModels]);

  // pieces of the answer arrived beyond what the server snapshot has: ask for a fresher snapshot (with back-off)
  useEffect(() => streams.onGap(() => void reload()), [reload]);

  // ---- scrolling: follow the stream (and any growing content) unless the user scrolled up
  const onScroll = () => {
    onStickScroll();
    const el = scroller.current;
    if (el && el.scrollTop < 40 && state.hasMore) void loadOlder();
  };

  // The AI conversation is "open" while this screen is shown: nothing in it counts as unread, here or on the server.
  const aiConvId = aiConv?.id;
  useEffect(() => {
    if (!aiConvId) return;
    activeConversation.set(aiConvId);
    return () => {
      if (activeConversation.get() === aiConvId) activeConversation.set(null);
    };
  }, [aiConvId]);
  // Tell the server (debounced) whenever something new arrives while the conversation is open.
  const newestId = state.messages[state.messages.length - 1]?.id;
  useEffect(() => {
    if (!aiConvId || state.status !== 'ready') return;
    markRead(aiConvId);
    const timer = setTimeout(() => void Convs.read(aiConvId).catch(() => undefined), 400);
    return () => clearTimeout(timer);
  }, [aiConvId, state.status, newestId, state.activeRunId]);

  const statusKey = useMemo((): { key: Key; detail?: string } => {
    if (backendDown) return { key: 'ai.notConnected' };
    if (activeRun && isActiveRun(activeRun)) {
      // the answer is already appearing: say so (a plain answer is written while the run still reads "planning")
      if ((activeRun.status === 'running' || activeRun.status === 'planning') && liveText.length > 0) return { key: 'ai.writing' };
      const stepRunning = activeRun.steps.find((s) => s.status === 'running');
      return { key: RUN_STATUS_KEY[activeRun.status], detail: stepRunning?.title };
    }
    if (running) return { key: 'status.running' };
    return { key: 'ai.ready' };
  }, [activeRun, running, liveText.length, backendDown]);

  const changeAgent = useCallback(
    async (id: string) => {
      setAgentId(id);
      write(AGENT_KEY, id);
      if (threadId) {
        try {
          upsertThread((await Ai.patchThread(threadId, { agentId: id })).thread);
        } catch (err) {
          toast(errText(err), 'error');
        }
      }
    },
    [threadId, errText],
  );
  const changeModel = useCallback(
    async (id: string | null) => {
      setModelId(id);
      write(MODEL_KEY, id);
      if (threadId) {
        try {
          upsertThread((await Ai.patchThread(threadId, { modelId: id })).thread);
        } catch (err) {
          toast(errText(err), 'error');
        }
      }
    },
    [threadId, errText],
  );

  async function send(text: string, fileIds: string[]): Promise<boolean> {
    if (editing) {
      setConfirmEdit({ message: editing, text });
      return false;
    }
    setSending(true);
    try {
      const clientId = sendTokens.current.next(JSON.stringify([threadId, text, fileIds, agentId, modelId, share?.input ?? null]));
      const body = { body: text || null, fileIds, agentId, modelId: modelId ?? undefined, clientId, ...(share ? { shared: share.input } : {}) };
      if (!threadId) {
        let id = orphanThread.current;
        if (!id) {
          const { thread: created } = await Ai.createThread({ agentId, modelId });
          upsertThread(created);
          id = orphanThread.current = created.id;
        }
        await Ai.send(id, body);
        orphanThread.current = null;
        shareStore.set(null);
        navigate(`/ai/${id}`, { replace: true });
      } else {
        const result = await Ai.send(threadId, body);
        shareStore.set(null);
        dispatch({ type: 'turn', result });
      }
      sendTokens.current.done();
      stick.current = true;
      return true;
    } catch (err) {
      toast(errText(err), 'error');
      return false;
    } finally {
      setSending(false);
    }
  }

  async function doEdit() {
    const c = confirmEdit;
    if (!c || !threadId) return;
    setConfirmEdit(null);
    setSending(true);
    try {
      const result = await Ai.edit(threadId, c.message.id, { body: c.text, agentId, modelId: modelId ?? undefined });
      setEditing(null);
      setPrefill(undefined);
      dispatch({ type: 'turn', result });
      await reload();
    } catch (err) {
      toast(errText(err), 'error');
    } finally {
      setSending(false);
    }
  }

  async function regenerate() {
    if (!threadId) return;
    try {
      dispatch({ type: 'turn', result: await Ai.regenerate(threadId, { agentId, modelId: modelId ?? undefined }) });
    } catch (err) {
      toast(errText(err), 'error');
    }
  }

  async function stop() {
    const id = state.activeRunId ?? streamingMessage?.runId;
    if (!id) return;
    try {
      await Ai.cancelRun(id);
    } catch (err) {
      toast(errText(err), 'error');
    }
  }

  const lastAiId = useMemo(() => [...state.messages].reverse().find((m) => m.senderId !== me.id)?.id, [state.messages, me.id]);
  const lastMessageId = state.messages[state.messages.length - 1]?.id;
  const runFor = useCallback(
    (m: MessageDto): RunDto | undefined => {
      const id = m.runId ?? m.meta?.ai?.runId;
      return id ? state.runs[id] : undefined;
    },
    [state.runs],
  );

  const agentsList = agents ?? [];
  const busyApprovals = pendingApprovals(activeRun);
  const empty = state.status === 'ready' && state.messages.length === 0;
  const title = thread?.title ?? (threadId ? t('thread.untitled') : t('thread.new'));

  let lastDay = '';
  return (
    <section className="chat-screen ai-screen" aria-label={t('ai.name')}>
      <header className="chat-head">
        <IconButton className="only-narrow" icon="back" flip label={t('common.back')} onClick={() => back('#/')} />
        <AiAvatar size={40} busy={running} />
        <div className="chat-head-main">
          <div className="chat-title">
            <strong>{t('ai.name')}</strong>
            <VerifiedBadge />
          </div>
          <div className={`status-line${running ? ' busy' : ''}`} role="status" aria-live="polite" data-testid="ai-status">
            {running && <span className="dot-pulse" aria-hidden="true" />}
            <span>
              {t(statusKey.key)}
              {statusKey.detail ? `: ${statusKey.detail}` : ''}
            </span>
          </div>
        </div>
        <IconButton icon="plus" label={t('thread.new')} onClick={() => navigate('/ai/new')} />
        <IconButton icon="menu" label={t('thread.history')} onClick={() => setDrawer(true)} />
      </header>

      <div className="chat-toolbar">
        <AgentPicker agents={agentsList} value={agentId} onChange={changeAgent} disabled={running} />
        <ModelPicker models={models} value={modelId} onChange={changeModel} />
        <span className="toolbar-title muted small" dir="auto">
          {title}
        </span>
      </div>

      {backendDown && (
        <div className="banner banner-warn" role="alert">
          <Icon name="alert" size={18} />
          <span>{t('ai.notConnectedLong')}</span>
        </div>
      )}

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
        {state.status === 'error' && <ErrorBanner text={errText(state.error)} onRetry={() => void reload()} />}

        {(empty || (!threadId && state.status !== 'error' && !resolving)) && (
          <div className="ai-welcome">
            <AiAvatar size={84} busy={sending} />
            <h2>
              {t('ai.welcome.title')} <VerifiedBadge size={20} />
            </h2>
            <p className="muted">{t('ai.welcome.text')}</p>
            <div className="starters" role="list">
              {STARTERS.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  role="listitem"
                  className="starter"
                  onClick={() => {
                    void changeAgent(s.agent);
                    setPrefill(t(s.key));
                  }}
                >
                  <Icon name="sparkles" size={14} /> {t(s.key)}
                </button>
              ))}
            </div>
          </div>
        )}

        {state.messages.map((m) => {
          const key = dayKey(m.createdAt);
          const sep = key !== lastDay ? fmtDayLabel(m.createdAt, locale, { today: t('common.today'), yesterday: t('common.yesterday') }) : null;
          lastDay = key;
          const mine = m.senderId === me.id;
          const run = runFor(m);
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
                sender={mine ? me : { id: m.senderId, username: 'amin_ai', displayName: t('ai.name'), kind: 'ai', verified: true, bio: null }}
                run={run}
                canEdit={mine && !running}
                canRegenerate={!mine && m.id === lastAiId && m.id === lastMessageId && !running && m.status !== 'streaming'}
                onEdit={(msg) => {
                  setEditing(msg);
                  setPrefill(msg.body ?? '');
                }}
                onRegenerate={regenerate}
                onRunChanged={() => void reload()}
              />
            </div>
          );
        })}

        {busyApprovals.length > 0 && <p className="muted small center">{t('approval.waiting')}</p>}
        </div>
      </div>

      {showJump && (
        <button
          type="button"
          className="jump-btn"
          onClick={() => toBottom(true)}
          aria-label={t('chat.jumpLatest')}
        >
          <Icon name="down" size={18} />
        </button>
      )}

      <Composer
        draftKey={`ai:${threadId ?? 'new'}`}
        placeholder={backendDown ? t('ai.notConnected') : t('ai.composer')}
        maxChars={LIMITS.aiPromptMaxChars}
        disabled={backendDown}
        running={running}
        sending={sending}
        onSend={send}
        onStop={stop}
        allowFiles
        allowVoice
        allowEmpty={!!share}
        initialText={prefill}
        top={
          <>
            {editing && (
              <div className="chip chip-edit" role="status">
                <Icon name="edit" size={14} />
                <span>{t('msg.editing')}</span>
                <button
                  type="button"
                  className="icon-btn small"
                  aria-label={t('common.cancel')}
                  onClick={() => {
                    setEditing(null);
                    setPrefill('');
                  }}
                >
                  <Icon name="x" size={12} />
                </button>
              </div>
            )}
            {share && (
              <div className="share-chip-bar" data-testid="pending-share">
                <Icon name={share.e2ee ? 'lock' : 'select'} size={16} />
                <div className="share-chip-text">
                  <strong dir="auto">{t('share.sharedFrom', { chat: share.conversationTitle, n: share.count })}</strong>
                  <span className="muted small clamp-2" dir="auto">
                    {share.preview.join(' · ')}
                  </span>
                </div>
                <button type="button" className="icon-btn small" aria-label={t('share.discard')} onClick={() => shareStore.set(null)}>
                  <Icon name="x" size={14} />
                </button>
              </div>
            )}
          </>
        }
        tools={<IconButton icon="select" label={t('share.title')} onClick={() => setShareOpen(true)} disabled={backendDown} />}
      />

      <ThreadDrawer
        open={drawer}
        onClose={() => setDrawer(false)}
        threads={(threads.data ?? []).filter((x) => x.kind === 'chat')}
        loading={threads.loading}
        currentId={threadId}
        onOpen={(id) => navigate(`/ai/${id}`)}
        onNew={() => navigate('/ai/new')}
        onDeleted={(id) => id === threadId && navigate('/ai/new', { replace: true })}
      />
      <ShareDialog open={shareOpen} onClose={() => setShareOpen(false)} />
      <ConfirmDialog
        open={confirmEdit !== null}
        title={t('msg.editConfirmTitle')}
        text={t('msg.editConfirm')}
        confirmLabel={t('msg.editResend')}
        onClose={() => setConfirmEdit(null)}
        onConfirm={() => void doEdit()}
      />
    </section>
  );
}

