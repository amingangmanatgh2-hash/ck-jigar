export const now = () => Date.now();
export const dayKey = (ts: number = Date.now()) => new Date(ts).toISOString().slice(0, 10);
export const monthStartDay = (ts: number = Date.now()) => new Date(ts).toISOString().slice(0, 7) + '-01';
export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error('aborted'));
      },
      { once: true },
    );
  });

/** Formats a timestamp in the given IANA time zone, e.g. "2026-11-15 18:30 (Tuesday)". Falls back to UTC for invalid zones. */
export function formatInZone(ts: number, timeZone: string): { date: string; time: string; weekday: string; zone: string } {
  let zone = timeZone;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    zone = 'UTC';
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'long',
  }).formatToParts(new Date(ts));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
    weekday: get('weekday'),
    zone,
  };
}
