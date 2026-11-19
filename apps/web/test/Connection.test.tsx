import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionBanner } from '../src/components/ConnectionBanner';
import { EndpointList } from '../src/components/EndpointList';
import { setLocale, translate } from '../src/lib/i18n';
import { realtime } from '../src/lib/realtime';
import { outbox } from '../src/state/outbox';
import { FakeNet } from './fakeNet';

const A = 'https://main.test';
const B = 'https://relay-b.test';

// the components talk to the module-level pool: give it one wired to the scripted network
const h = vi.hoisted(() => ({ net: null as unknown as import('./fakeNet').FakeNet, pool: null as unknown as import('../src/lib/endpointPool').EndpointPool, builtin: [] as string[] }));
vi.mock('../src/lib/endpointPool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/endpointPool')>();
  const { FakeNet: Net } = await import('./fakeNet');
  h.net = new Net();
  const mem = new Map<string, string>();
  h.pool = new actual.EndpointPool({
    storage: { get: (k) => mem.get(k) ?? null, set: (k, v) => void mem.set(k, v) },
    fetchFn: h.net.fetch as unknown as typeof fetch,
    now: () => Date.now(),
    primary: () => 'https://main.test',
    pageOrigin: () => 'https://page.test',
    builtin: () => h.builtin,
    probeTimeoutMs: 4000,
    recheckMs: 120_000,
  });
  return { ...actual, pool: h.pool };
});

const T = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('en', key, vars);
const entry = (n: number) => ({ clientId: `client-id-${n}0000000`, conversationId: 'c', body: 'x', queuedAt: n, attempts: 0, state: 'pending' as const });

function resetWorld() {
  for (const c of h.pool.candidates()) if (c.source !== 'primary') h.pool.remove(c.base);
  h.net.behaviors.clear();
  h.net.log.length = 0;
  h.net.advertised = [];
  h.builtin = [];
  realtime.state.set('idle');
  outbox.state.set({ entries: [], flushing: false });
}

describe('ConnectionBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setLocale('en');
    resetWorld();
    window.location.hash = '#/';
  });
  afterEach(() => vi.useRealTimers());

  it('says nothing while all is well', () => {
    realtime.state.set('open');
    render(<ConnectionBanner />);
    act(() => void vi.advanceTimersByTime(10_000));
    expect(screen.queryByTestId('connection-banner')).toBeNull();
  });

  it('waits a moment before complaining, so a brief reconnect does not flash a banner', () => {
    realtime.state.set('open');
    render(<ConnectionBanner />);
    act(() => realtime.state.set('reconnecting'));
    act(() => void vi.advanceTimersByTime(1500));
    expect(screen.queryByTestId('connection-banner')).toBeNull();
    act(() => realtime.state.set('open')); // it came back in time
    act(() => void vi.advanceTimersByTime(5000));
    expect(screen.queryByTestId('connection-banner')).toBeNull();

    act(() => realtime.state.set('reconnecting'));
    act(() => void vi.advanceTimersByTime(2600));
    expect(screen.getByTestId('connection-banner')).toHaveTextContent(T('conn.reconnecting'));
    act(() => realtime.state.set('open'));
    expect(screen.queryByTestId('connection-banner')).toBeNull(); // and goes away as soon as it is fixed
  });

  it('tells the truth about the fallback transport: slower, no typing indicators', () => {
    realtime.state.set('polling');
    render(<ConnectionBanner />);
    act(() => void vi.advanceTimersByTime(2600));
    expect(screen.getByTestId('connection-banner')).toHaveTextContent(T('conn.polling'));
  });

  it('names the alternative address in use and the number of unsent messages', async () => {
    realtime.state.set('open');
    h.pool.learn([B]);
    h.net.set(A, 'down').set(B, 'ok');
    render(<ConnectionBanner />);
    await act(async () => {
      void h.pool.failover(A);
      await vi.advanceTimersByTimeAsync(50);
    });
    act(() => outbox.state.set({ entries: [entry(1), entry(2)], flushing: false }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2600);
    });
    const banner = screen.getByTestId('connection-banner');
    expect(banner).toHaveTextContent('relay-b.test');
    expect(banner).toHaveTextContent(T('conn.queued', { n: 2 }));
  });

  it('links to the connection settings', async () => {
    vi.useRealTimers();
    realtime.state.set('reconnecting');
    render(<ConnectionBanner />);
    const link = await screen.findByRole('button', { name: T('conn.settings') }, { timeout: 4000 });
    await userEvent.click(link);
    expect(window.location.hash).toBe('#/settings');
  });
});

describe('EndpointList', () => {
  beforeEach(() => {
    setLocale('en');
    resetWorld();
  });

  it('shows the main address first, which one is in use, and whether each answers', async () => {
    h.net.set(A, 'ok').set(B, 'down');
    h.pool.addCustom(B); // adding an address checks it right away
    render(<EndpointList />);
    const check = await screen.findByRole('button', { name: T('conn.test') });
    await userEvent.click(check);
    await waitFor(() => expect(screen.getAllByTestId('endpoint')[0]).toHaveTextContent(T('conn.health.ok')));
    const items = screen.getAllByTestId('endpoint');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('main.test');
    expect(items[0]).toHaveTextContent(T('conn.source.primary'));
    expect(items[0]).toHaveTextContent(T('conn.active'));
    expect(items[1]).toHaveTextContent('relay-b.test');
    expect(items[1]).toHaveTextContent(T('conn.source.custom'));
    expect(items[1]).toHaveTextContent(T('conn.health.down'));
    expect(items[1]).not.toHaveTextContent(T('conn.active'));
    // the main address cannot be removed from here; added ones can
    expect(within(items[0]!).queryByRole('button', { name: T('conn.remove') })).toBeNull();
    await userEvent.click(within(items[1]!).getByRole('button', { name: T('conn.remove') }));
    expect(screen.getAllByTestId('endpoint')).toHaveLength(1);
  });

  it('shows addresses that ship with the app as such, and does not let them be removed', async () => {
    h.builtin = ['https://relay-built-in.test'];
    h.net.set(A, 'down').set('https://relay-built-in.test', 'ok');
    h.pool.addCustom(B);
    render(<EndpointList />);
    const items = await screen.findAllByTestId('endpoint');
    expect(items.map((i) => i.textContent)).toEqual([expect.stringContaining('main.test'), expect.stringContaining('relay-b.test'), expect.stringContaining('relay-built-in.test')]);
    expect(items[2]).toHaveTextContent(T('conn.source.builtin'));
    expect(within(items[2]!).queryByRole('button', { name: T('conn.remove') })).toBeNull();
    expect(within(items[1]!).getByRole('button', { name: T('conn.remove') })).toBeInTheDocument();
  });

  it('adds an address, and says what is wrong with one that cannot be used', async () => {
    render(<EndpointList />);
    const input = screen.getByLabelText(T('conn.addLabel'));
    const add = screen.getByRole('button', { name: T('conn.add') });
    expect(add).toBeDisabled();

    await userEvent.type(input, 'not an address');
    await userEvent.click(add);
    expect(screen.getByText(T('conn.err.invalid'))).toBeInTheDocument();

    await userEvent.clear(input);
    await userEvent.type(input, A);
    await userEvent.click(add);
    expect(screen.getByText(T('conn.err.duplicate'))).toBeInTheDocument();

    await userEvent.clear(input);
    await userEvent.type(input, 'relay-b.test');
    await userEvent.click(add);
    expect(screen.queryByText(T('conn.err.duplicate'))).toBeNull();
    expect(screen.getAllByTestId('endpoint')).toHaveLength(2);
    expect(input).toHaveValue('');
  });

  it('shows which transport carries live updates', () => {
    realtime.state.set('open');
    const { rerender } = render(<EndpointList />);
    expect(screen.getByTestId('transport')).toHaveTextContent(T('conn.transport.websocket'));
    act(() => realtime.state.set('polling'));
    rerender(<EndpointList />);
    expect(screen.getByTestId('transport')).toHaveTextContent(T('conn.transport.poll'));
    act(() => realtime.state.set('reconnecting'));
    expect(screen.getByTestId('transport')).toHaveTextContent(T('conn.transport.none'));
  });

  it('keeps address text left-to-right inside right-to-left pages', () => {
    setLocale('fa');
    h.pool.addCustom(B);
    render(<EndpointList />);
    const hosts = document.querySelectorAll('.endpoint-host');
    expect(hosts.length).toBe(2);
    for (const el of hosts) expect(el).toHaveAttribute('dir', 'ltr');
    setLocale('en');
  });
});
