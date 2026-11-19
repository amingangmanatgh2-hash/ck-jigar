/** Time-zone aware helpers. All timestamps in the database are UTC epoch milliseconds. */

export function safeZone(tz: string | null | undefined): string {
  const zone = tz || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return 'UTC';
  }
}

function zoneOffsetMs(ts: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ts));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** Converts a wall-clock time in `tz` to UTC epoch ms (handles DST by iterating once). */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const zone = safeZone(tz);
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const off1 = zoneOffsetMs(guess, zone);
  let t = guess - off1;
  const off2 = zoneOffsetMs(t, zone);
  if (off2 !== off1) t = guess - off2;
  return t;
}

/**
 * Parses a date/time produced by the planner or typed by a user:
 *  - ISO-8601 with `Z` or an explicit offset      → exact instant
 *  - `YYYY-MM-DD` / `YYYY-MM-DD HH:mm[:ss]` / `…THH:mm` without offset → wall-clock time in the user's zone
 * Returns null when the text is not a valid date.
 */
export function parseUserDateTime(input: string, tz: string): number | null {
  const s = input.trim();
  if (!s) return null;
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s) && /^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h = '09', mi = '00', sec = '00'] = m;
  const nums = [y, mo, d, h, mi, sec].map(Number) as [number, number, number, number, number, number];
  const [Y, M, D, H, MI, S] = nums;
  if (M < 1 || M > 12 || D < 1 || D > 31 || H > 23 || MI > 59 || S > 59) return null;
  const probe = new Date(Date.UTC(Y, M - 1, D));
  if (probe.getUTCMonth() !== M - 1) return null; // e.g. 2026-02-31
  return zonedToUtc(Y, M, D, H, MI, S, tz);
}

/** "2026-11-15 18:30" in the given zone. */
export function formatLocal(ts: number, tz: string): string {
  const zone = safeZone(tz);
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ts));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
}

/** Today's date in the Persian (Jalali) calendar, e.g. "1405/08/24" — helps models resolve Jalali dates. */
export function jalaliDate(ts: number, tz: string): string | null {
  try {
    const p = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', {
      timeZone: safeZone(tz),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(ts));
    const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
    const y = g('relatedYear') || g('year');
    return `${y}/${g('month')}/${g('day')}`;
  } catch {
    return null;
  }
}
