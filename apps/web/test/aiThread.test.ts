import { describe, expect, it } from 'vitest';
import { initialThreadState, mergeLoaded, reduceEvent, threadReducer, upsertMessage, type ThreadState } from '../src/state/aiThread';
import { message, run } from './fixtures';

const ready = (o: Partial<ThreadState> = {}): ThreadState => ({ ...initialThreadState, threadId: 't1', status: 'ready', ...o });

describe('upsertMessage', () => {
  it('inserts in time order and replaces by id', () => {
    const a = message({ id: 'a', createdAt: 1 });
    const c = message({ id: 'c', createdAt: 3 });
    const b = message({ id: 'b', createdAt: 2 });
    expect(upsertMessage([a, c], b).map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(upsertMessage([a, c], { ...c, body: 'edited' })[1]!.body).toBe('edited');
  });

  it('does not let an older streaming snapshot shorten a streaming message', () => {
    const live = message({ id: 'a', status: 'streaming', body: 'Hello world' });
    expect(upsertMessage([live], message({ id: 'a', status: 'streaming', body: 'Hel' }))[0]!.body).toBe('Hello world');
  });

  it('lets the final message replace the streaming one', () => {
    const live = message({ id: 'a', status: 'streaming', body: 'Hello world' });
    const done = upsertMessage([live], message({ id: 'a', status: 'sent', body: 'Hello world!' }))[0]!;
    expect(done).toMatchObject({ status: 'sent', body: 'Hello world!' });
  });
});

describe('mergeLoaded (first page of a thread)', () => {
  it('keeps what live events delivered while the request was in flight', () => {
    const server = [message({ id: 'u1', createdAt: 1 }), message({ id: 'a1', createdAt: 2, status: 'streaming' })];
    const local = [message({ id: 'a1', createdAt: 2, status: 'sent', body: 'finished' }), message({ id: 'u2', createdAt: 3, body: 'newer than the page' })];
    const merged = mergeLoaded(local, server);
    expect(merged.map((m) => m.id)).toEqual(['u1', 'a1', 'u2']);
    expect(merged.find((m) => m.id === 'a1')).toMatchObject({ status: 'sent', body: 'finished' });
  });

  it('prefers the server copy when both are final', () => {
    const merged = mergeLoaded([message({ id: 'a', body: 'old', status: 'sent' })], [message({ id: 'a', body: 'edited', status: 'sent' })]);
    expect(merged[0]!.body).toBe('edited');
  });

  it('returns the page as is when nothing arrived meanwhile', () => {
    const page = [message({ id: 'a' })];
    expect(mergeLoaded([], page)).toBe(page);
  });
});

describe('threadReducer', () => {
  it('merges on the first load but replaces on a reload (a message gone from the server was deleted)', () => {
    const loading: ThreadState = { ...initialThreadState, threadId: 't1', status: 'loading', messages: [message({ id: 'live', createdAt: 9 })] };
    const afterFirst = threadReducer(loading, { type: 'loaded', threadId: 't1', messages: [message({ id: 'a', createdAt: 1 })], hasMore: false, activeRunId: null });
    expect(afterFirst.messages.map((m) => m.id)).toEqual(['a', 'live']);
    const afterReload = threadReducer(afterFirst, { type: 'loaded', threadId: 't1', messages: [message({ id: 'a', createdAt: 1 })], hasMore: false, activeRunId: null });
    expect(afterReload.messages.map((m) => m.id)).toEqual(['a']);
  });

  it('ignores a load that belongs to another thread', () => {
    const s = ready({ threadId: 't2' });
    expect(threadReducer(s, { type: 'loaded', threadId: 't1', messages: [message()], hasMore: false, activeRunId: null })).toBe(s);
  });

  it('records a turn (user message + streaming answer + run) and marks the run active', () => {
    const user = message({ id: 'u', senderId: 'me', createdAt: 1, body: 'Q' });
    const answer = message({ id: 'a', createdAt: 2, status: 'streaming' });
    const r = run({ id: 'r', status: 'pending' });
    const s = threadReducer(ready(), { type: 'turn', result: { userMessage: user, assistantMessage: answer, run: r } });
    expect(s.messages.map((m) => m.id)).toEqual(['u', 'a']);
    expect(s.activeRunId).toBe('r');
  });

  it('does not let the POST response (pending) override a live "running" state', () => {
    const live = ready({ runs: { r: run({ id: 'r', status: 'running' }) }, activeRunId: 'r' });
    const s = threadReducer(live, { type: 'turn', result: { userMessage: message({ id: 'u', createdAt: 1 }), assistantMessage: message({ id: 'a', createdAt: 2, status: 'streaming' }), run: run({ id: 'r', status: 'pending' }) } });
    expect(s.runs.r!.status).toBe('running');
  });

  it('clears the active run when it completes', () => {
    const s0 = ready({ runs: { r: run({ id: 'r', status: 'running' }) }, activeRunId: 'r' });
    const s1 = threadReducer(s0, { type: 'run', run: run({ id: 'r', status: 'completed' }) });
    expect(s1.activeRunId).toBeNull();
  });
});

describe('reduceEvent', () => {
  it('applies message events of this thread only', () => {
    const s = ready();
    expect(reduceEvent(s, { type: 'message.created', message: message({ id: 'x', threadId: 't1' }) }, 'c1').messages).toHaveLength(1);
    expect(reduceEvent(s, { type: 'message.created', message: message({ id: 'y', threadId: 'other' }) }, 'c1').messages).toHaveLength(0);
  });

  it('removes a deleted message of the AI conversation', () => {
    const s = ready({ messages: [message({ id: 'x' })] });
    expect(reduceEvent(s, { type: 'message.deleted', conversationId: 'c1', messageId: 'x' }, 'c1').messages).toHaveLength(0);
    expect(reduceEvent(s, { type: 'message.deleted', conversationId: 'zzz', messageId: 'x' }, 'c1').messages).toHaveLength(1);
  });

  it('leaves streamed text alone (the stream store owns it)', () => {
    const s = ready({ messages: [message({ id: 'x', status: 'streaming', body: '' })] });
    expect(reduceEvent(s, { type: 'run.delta', runId: 'r', messageId: 'x', text: 'hi', offset: 0 }, 'c1')).toBe(s);
  });

  it('ignores everything before a thread is open', () => {
    const s = { ...initialThreadState };
    expect(reduceEvent(s, { type: 'run.updated', run: run() }, null)).toBe(s);
  });
});
