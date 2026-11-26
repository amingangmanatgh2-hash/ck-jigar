import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, getToken, setToken } from '../src/lib/api';
import { Auth, Convs, Server } from '../src/lib/endpoints';
import { setLocale, translate } from '../src/lib/i18n';
import { OfflineScreen } from '../src/screens/Offline';
import { capabilitiesStore, resetCapabilities } from '../src/state/capabilities';
import { outbox } from '../src/state/outbox';
import { bootstrapSession, sessionStore, signOut } from '../src/state/session';

const rt = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let state = 'idle';
  return {
    start: vi.fn(),
    stop: vi.fn(),
    state: { get: () => state, set: (s: string) => ((state = s), listeners.forEach((l) => l())), subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)) },
    on: () => () => undefined,
    onResync: () => () => undefined,
  };
});
vi.mock('../src/lib/realtime', () => ({ realtime: rt }));
vi.mock('../src/lib/endpointPool', () => {
  const active = new Set<(a: string) => void>();
  const snapshot = { active: '', endpoints: [], probing: false, usingFallback: false }; // a stable reference, like the real store
  const state = { get: () => snapshot, set: () => undefined, subscribe: () => () => undefined };
  return { pool: { start: vi.fn(), stop: vi.fn(), state, active: () => '', onActiveChange: (fn: (a: string) => void) => (active.add(fn), () => active.delete(fn)), candidates: () => [], addCustom: vi.fn(), remove: vi.fn(), probeAll: vi.fn(), failover: vi.fn(), learn: vi.fn(), reportSuccess: vi.fn(), reportFailure: vi.fn() } };
});
vi.mock('../src/lib/endpoints', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/endpoints')>();
  return { ...actual, Auth: { ...actual.Auth, me: vi.fn(), logout: vi.fn() }, Convs: { ...actual.Convs, send: vi.fn(), list: vi.fn(async () => ({ conversations: [] })) }, Server: { health: vi.fn() } };
});

const T = (key: Parameters<typeof translate>[1]) => translate('en', key);
const me = { user: { id: 'u1', username: 'amin', displayName: 'Amin', kind: 'human', role: 'member', locale: 'en' } as never };
const authMe = vi.mocked(Auth.me);
const send = vi.mocked(Convs.send);
const health = vi.mocked(Server.health);
const NETWORK = () => new ApiError(0, 'NETWORK', 'down');
const OUTBOX_KEY = 'aminchat.outbox.u1';
const queuedEntry = { clientId: 'client-id-00000001', conversationId: 'c1', body: 'kept while offline', queuedAt: 1, attempts: 0, state: 'pending' };

describe('session with an unreliable network', () => {
  beforeEach(() => {
    setLocale('en');
    authMe.mockReset();
    send.mockReset();
    vi.mocked(Auth.logout).mockReset().mockResolvedValue({ ok: true } as never);
    health.mockReset().mockResolvedValue({ ok: true, service: 'amin-chat', time: 1, environment: 'test', endpoints: [], ai: { 'workers-ai': true, groq: false }, storage: { files: true } });
    resetCapabilities();
    rt.start.mockClear();
    rt.stop.mockClear();
    sessionStore.set({ status: 'loading', user: null });
    outbox.unbind();
  });
  afterEach(() => {
    outbox.unbind();
  });

  it('without a saved session the user simply sees the sign-in screen', async () => {
    await bootstrapSession();
    expect(sessionStore.get().status).toBe('anonymous');
    expect(authMe).not.toHaveBeenCalled();
  });

  it('with a saved session and no connection the user is NOT signed out: the app waits and offers a way in', async () => {
    setToken('tok');
    authMe.mockRejectedValue(NETWORK());
    await bootstrapSession();
    expect(sessionStore.get().status).toBe('offline');
    expect(getToken()).toBe('tok'); // the session is kept
    expect(rt.start).not.toHaveBeenCalled();
  });

  it('continues as soon as the server can be reached, and sends what was written before', async () => {
    setToken('tok');
    localStorage.setItem(OUTBOX_KEY, JSON.stringify([queuedEntry]));
    authMe.mockRejectedValueOnce(NETWORK());
    await bootstrapSession();
    expect(sessionStore.get().status).toBe('offline');

    authMe.mockResolvedValue(me as never);
    send.mockResolvedValue({ message: { id: 'srv1' } as never, ai: { triggered: false } });
    await bootstrapSession();
    expect(sessionStore.get().status).toBe('authenticated');
    expect(rt.start).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(send).toHaveBeenCalledWith('c1', { clientId: 'client-id-00000001', body: 'kept while offline' }));
    await waitFor(() => expect(localStorage.getItem(OUTBOX_KEY)).toBeNull());
  });

  it('an ended session (the server rejected the token) keeps unsent text for the same user; an explicit sign-out discards it', async () => {
    setToken('tok');
    localStorage.setItem(OUTBOX_KEY, JSON.stringify([queuedEntry]));
    authMe.mockResolvedValue(me as never);
    send.mockRejectedValue(NETWORK());
    await bootstrapSession();
    expect(sessionStore.get().status).toBe('authenticated');
    await waitFor(() => expect(send).toHaveBeenCalled());

    await act(async () => {
      await signOut();
    });
    expect(sessionStore.get().status).toBe('anonymous');
    expect(localStorage.getItem(OUTBOX_KEY)).toBeNull(); // sign-out: the unsent text does not stay on the device
    expect(getToken()).toBeNull();
    expect(rt.stop).toHaveBeenCalled();

    // expired session: the entry stays
    localStorage.setItem(OUTBOX_KEY, JSON.stringify([queuedEntry]));
    setToken('tok2');
    authMe.mockRejectedValueOnce(new ApiError(401, 'UNAUTHORIZED', 'expired'));
    await bootstrapSession();
    expect(sessionStore.get()).toMatchObject({ status: 'anonymous', expired: true });
    expect(localStorage.getItem(OUTBOX_KEY)).toContain('kept while offline');
  });
});

describe('what the server can keep is learned when a session starts', () => {
  beforeEach(() => {
    setLocale('en');
    authMe.mockReset().mockResolvedValue(me as never);
    vi.mocked(Auth.logout).mockReset().mockResolvedValue({ ok: true } as never);
    health.mockReset();
    resetCapabilities();
    sessionStore.set({ status: 'loading', user: null });
    outbox.unbind();
    setToken('tok');
  });
  afterEach(() => outbox.unbind());

  it('a server without file storage switches attaching off for this session, and signing out forgets it (the next sign-in may be elsewhere)', async () => {
    health.mockResolvedValue({ ok: true, service: 'amin-chat', time: 1, environment: 'production', endpoints: [], ai: { 'workers-ai': true, groq: true }, storage: { files: false } });
    await bootstrapSession();
    expect(sessionStore.get().status).toBe('authenticated');
    await waitFor(() => expect(capabilitiesStore.get()).toEqual({ files: false, known: true }));
    expect(health).toHaveBeenCalledTimes(1);
    await act(async () => {
      await signOut();
    });
    expect(capabilitiesStore.get()).toEqual({ files: true, known: false });
  });

  it('a server that cannot be asked, or that predates the field, leaves attaching on', async () => {
    health.mockRejectedValue(new ApiError(0, 'NETWORK', 'down'));
    await bootstrapSession();
    expect(sessionStore.get().status).toBe('authenticated');
    await waitFor(() => expect(health).toHaveBeenCalled());
    expect(capabilitiesStore.get().files).toBe(true);
    resetCapabilities();
    health.mockResolvedValue({ ok: true, service: 'amin-chat', time: 1, environment: 'test', endpoints: [] } as never);
    await bootstrapSession();
    await waitFor(() => expect(capabilitiesStore.get()).toEqual({ files: true, known: true }));
  });

  it('nothing is asked while nobody is signed in', async () => {
    localStorage.clear();
    await bootstrapSession();
    expect(sessionStore.get().status).toBe('anonymous');
    expect(health).not.toHaveBeenCalled();
  });
});

describe('OfflineScreen', () => {
  beforeEach(() => {
    setLocale('en');
    authMe.mockReset();
    sessionStore.set({ status: 'offline', user: null });
    setToken('tok');
  });

  it('explains the situation, keeps the user signed in, and retries on demand', async () => {
    authMe.mockRejectedValue(NETWORK());
    render(<OfflineScreen />);
    expect(screen.getByTestId('offline-screen')).toHaveTextContent(T('conn.offline.title'));
    expect(screen.getByRole('button', { name: T('conn.offline.retry') })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: T('conn.offline.retry') }));
    await waitFor(() => expect(authMe).toHaveBeenCalledTimes(1));
    expect(sessionStore.get().status).toBe('offline');

    authMe.mockResolvedValue(me as never);
    await userEvent.click(await screen.findByRole('button', { name: T('conn.offline.retry') }));
    await waitFor(() => expect(sessionStore.get().status).toBe('authenticated'));
  });

  it('retries by itself on a timer and when the browser reports it is online again', async () => {
    vi.useFakeTimers();
    authMe.mockRejectedValue(NETWORK());
    render(<OfflineScreen />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_100);
    });
    expect(authMe).toHaveBeenCalledTimes(1);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(authMe).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
