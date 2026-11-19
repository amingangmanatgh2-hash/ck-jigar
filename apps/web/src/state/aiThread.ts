import type { ApprovalDto, MessageDto, RealtimeEvent, RunDto, RunStepDto } from '@aminchat/shared';
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { Ai, type TurnResult } from '../lib/endpoints';
import { newerRun, mergeApproval, mergeStep, isActiveRun } from '../lib/runs';
import { realtime } from '../lib/realtime';

export interface ThreadState {
  threadId: string | null;
  messages: MessageDto[];
  hasMore: boolean;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: unknown;
  loadingMore: boolean;
  runs: Record<string, RunDto>;
  activeRunId: string | null;
}

export type ThreadAction =
  | { type: 'reset'; threadId: string | null }
  | { type: 'loaded'; threadId: string; messages: MessageDto[]; hasMore: boolean; activeRunId: string | null }
  | { type: 'failed'; error: unknown }
  | { type: 'loadingMore' }
  | { type: 'older'; messages: MessageDto[]; hasMore: boolean }
  | { type: 'upsert'; message: MessageDto }
  | { type: 'remove'; messageId: string }
  | { type: 'run'; run: RunDto }
  | { type: 'runs'; runs: RunDto[] }
  | { type: 'step'; runId: string; step: RunStepDto }
  | { type: 'approval'; approval: ApprovalDto }
  | { type: 'turn'; result: TurnResult }
  | { type: 'event'; ev: RealtimeEvent; conv: string | null };

export const initialThreadState: ThreadState = { threadId: null, messages: [], hasMore: false, status: 'idle', error: null, loadingMore: false, runs: {}, activeRunId: null };

const byTime = (a: MessageDto, b: MessageDto) => a.createdAt - b.createdAt;

export function upsertMessage(list: MessageDto[], incoming: MessageDto): MessageDto[] {
  const i = list.findIndex((m) => m.id === incoming.id);
  if (i < 0) return [...list, incoming].sort(byTime);
  const current = list[i]!;
  // A streaming snapshot from the server can be older than the text already received through run.delta: never go backwards.
  const keepLocalText = incoming.status === 'streaming' && current.status === 'streaming' && (current.body ?? '').length > (incoming.body ?? '').length;
  const next = keepLocalText ? { ...incoming, body: current.body } : incoming;
  const copy = list.slice();
  copy[i] = next;
  return copy;
}

/** Statuses in the order a message moves through them; a message never goes backwards. */
const MESSAGE_RANK: Record<MessageDto['status'], number> = { streaming: 0, sent: 1, failed: 1, cancelled: 1 };

/**
 * The first page of a thread replaces the (empty) list — except that live events may already have delivered something
 * newer than the page, because the request was in flight (a message created, or finished): keep those. A later reload
 * does NOT use this: then the server is the truth, and a message it no longer has was deleted.
 */
export function mergeLoaded(local: MessageDto[], server: MessageDto[]): MessageDto[] {
  if (!local.length) return server;
  const byId = new Map(server.map((m) => [m.id, m]));
  const newest = server[server.length - 1]?.createdAt ?? 0;
  for (const m of local) {
    const theirs = byId.get(m.id);
    if (theirs) {
      if (MESSAGE_RANK[m.status] > MESSAGE_RANK[theirs.status]) byId.set(m.id, m);
    } else if (m.createdAt > newest) {
      byId.set(m.id, m);
    }
  }
  return [...byId.values()].sort(byTime);
}

export function threadReducer(state: ThreadState, action: ThreadAction): ThreadState {
  switch (action.type) {
    case 'reset':
      return { ...initialThreadState, threadId: action.threadId, status: action.threadId ? 'loading' : 'idle' };
    case 'loaded':
      if (action.threadId !== state.threadId) return state;
      return { ...state, status: 'ready', error: null, messages: state.status === 'loading' ? mergeLoaded(state.messages, action.messages) : action.messages, hasMore: action.hasMore, activeRunId: action.activeRunId };
    case 'failed':
      return { ...state, status: 'error', error: action.error };
    case 'loadingMore':
      return { ...state, loadingMore: true };
    case 'older': {
      const known = new Set(state.messages.map((m) => m.id));
      return { ...state, loadingMore: false, hasMore: action.hasMore, messages: [...action.messages.filter((m) => !known.has(m.id)), ...state.messages] };
    }
    case 'upsert':
      return { ...state, messages: upsertMessage(state.messages, action.message) };
    case 'remove':
      return { ...state, messages: state.messages.filter((m) => m.id !== action.messageId) };
    case 'run': {
      const run = newerRun(state.runs[action.run.id], action.run);
      const activeRunId = isActiveRun(run) ? run.id : state.activeRunId === run.id ? null : state.activeRunId;
      return { ...state, runs: { ...state.runs, [run.id]: run }, activeRunId };
    }
    case 'runs': {
      const runs = { ...state.runs };
      for (const r of action.runs) runs[r.id] = newerRun(runs[r.id], r);
      return { ...state, runs };
    }
    case 'step': {
      const run = state.runs[action.runId];
      return run ? { ...state, runs: { ...state.runs, [run.id]: mergeStep(run, action.step) } } : state;
    }
    case 'approval': {
      const run = state.runs[action.approval.runId];
      return run ? { ...state, runs: { ...state.runs, [run.id]: mergeApproval(run, action.approval) } } : state;
    }
    case 'turn': {
      const messages = upsertMessage(upsertMessage(state.messages, action.result.userMessage), action.result.assistantMessage);
      const run = newerRun(state.runs[action.result.run.id], action.result.run);
      return { ...state, messages, runs: { ...state.runs, [run.id]: run }, activeRunId: isActiveRun(run) ? run.id : state.activeRunId };
    }
    case 'event':
      return reduceEvent(state, action.ev, action.conv);
  }
}

/** Folds one realtime event into the thread state. Exported for tests. */
export function reduceEvent(state: ThreadState, ev: RealtimeEvent, aiConversationId: string | null): ThreadState {
  if (!state.threadId) return state;
  switch (ev.type) {
    case 'message.created':
    case 'message.updated':
      return ev.message.threadId === state.threadId ? threadReducer(state, { type: 'upsert', message: ev.message }) : state;
    case 'message.deleted':
      return ev.conversationId === aiConversationId ? threadReducer(state, { type: 'remove', messageId: ev.messageId }) : state;
    case 'run.updated':
      return ev.run.threadId === state.threadId ? threadReducer(state, { type: 'run', run: ev.run }) : state;
    case 'run.step':
      return threadReducer(state, { type: 'step', runId: ev.runId, step: ev.step });
    case 'run.approval':
      return threadReducer(state, { type: 'approval', approval: ev.approval });
    default:
      return state;
  }
}

export function useAiThread(threadId: string | null, aiConversationId: string | null) {
  const [state, dispatch] = useReducer(threadReducer, initialThreadState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const convRef = useRef(aiConversationId);
  convRef.current = aiConversationId;

  const load = useCallback(async () => {
    if (!threadId) return;
    try {
      const [page, runs] = await Promise.all([Ai.messages(threadId, { limit: 40 }), Ai.runs('all', 50).catch(() => ({ runs: [] as RunDto[] }))]);
      let all = runs.runs.filter((r) => r.threadId === threadId);
      if (page.activeRunId && !all.some((r) => r.id === page.activeRunId)) {
        const one = await Ai.run(page.activeRunId).catch(() => null);
        if (one) all = [...all, one.run];
      }
      dispatch({ type: 'loaded', threadId, messages: page.messages, hasMore: page.hasMore, activeRunId: page.activeRunId ?? null });
      dispatch({ type: 'runs', runs: all });
    } catch (error) {
      dispatch({ type: 'failed', error });
    }
  }, [threadId]);

  useEffect(() => {
    dispatch({ type: 'reset', threadId });
    if (threadId) void load();
  }, [threadId, load]);

  useEffect(() => {
    if (!threadId) return;
    // Events are folded one by one through the reducer, so no snapshot of `state` is needed here.
    const off = realtime.on((ev) => dispatch({ type: 'event', ev, conv: convRef.current }));
    const offResync = realtime.onResync(() => void load());
    return () => {
      off();
      offResync();
    };
  }, [threadId, load]);

  const loadOlder = useCallback(async () => {
    const s = stateRef.current;
    const first = s.messages[0];
    if (!threadId || !first || !s.hasMore || s.loadingMore) return;
    dispatch({ type: 'loadingMore' });
    try {
      const page = await Ai.messages(threadId, { before: first.id, limit: 40 });
      dispatch({ type: 'older', messages: page.messages, hasMore: page.hasMore });
    } catch (error) {
      dispatch({ type: 'failed', error });
    }
  }, [threadId]);

  const act = useCallback((a: ThreadAction) => dispatch(a), []);
  return { state, dispatch: act, reload: load, loadOlder };
}
