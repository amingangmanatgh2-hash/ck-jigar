import { useEffect, useMemo, useState } from 'react';
import { pool, type PoolState } from '../lib/endpointPool';
import { realtime, type ConnectionState } from '../lib/realtime';
import { useStore } from '../lib/store';
import { outbox } from './outbox';

export interface ConnectionView {
  state: ConnectionState;
  transport: 'websocket' | 'poll' | null;
  /** The address in use ('' = this site). */
  active: string;
  usingFallback: boolean;
  /** Messages not yet delivered (waiting or failed). */
  queued: number;
}

/** One place for everything the UI shows about the connection. */
export function useConnection(): ConnectionView {
  const state = useStore(realtime.state, (s) => s);
  const active = useStore(pool.state, (s) => s.active);
  const usingFallback = useStore(pool.state, (s) => s.usingFallback);
  const queued = useStore(outbox.state, (s) => s.entries.length);
  return useMemo(() => ({ state, transport: state === 'open' ? 'websocket' : state === 'polling' ? 'poll' : null, active, usingFallback, queued }), [state, active, usingFallback, queued]);
}

export const usePool = (): PoolState => useStore(pool.state, (s) => s);

/** `true` once `value` has been true for `ms` without interruption — so a blip of reconnecting does not flash a banner. */
export function useAfterDelay(value: boolean, ms: number): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!value) {
      setReady(false);
      return;
    }
    const timer = setTimeout(() => setReady(true), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return value && ready;
}

export const hostOf = (base: string): string => {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
};
