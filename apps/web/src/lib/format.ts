import type { Locale } from './i18n';

/** Persian uses the Jalali calendar and Persian digits; English uses the Gregorian calendar. */
const tag = (l: Locale) => (l === 'fa' ? 'fa-IR-u-ca-persian' : 'en-US');
const numTag = (l: Locale) => (l === 'fa' ? 'fa-IR' : 'en-US');

export const fmtNumber = (n: number, l: Locale): string => new Intl.NumberFormat(numTag(l)).format(n);

export function fmtCompact(n: number, l: Locale): string {
  return new Intl.NumberFormat(numTag(l), { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export const fmtTime = (ts: number, l: Locale): string => new Intl.DateTimeFormat(tag(l), { hour: '2-digit', minute: '2-digit', hour12: false }).format(ts);

export const fmtDate = (ts: number, l: Locale): string => new Intl.DateTimeFormat(tag(l), { year: 'numeric', month: 'long', day: 'numeric' }).format(ts);

export const fmtDateTime = (ts: number, l: Locale): string => `${fmtDate(ts, l)} ${fmtTime(ts, l)}`;

const startOfDay = (ts: number) => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** "14:05" today, weekday within the last week, otherwise the date. Used in the chat list. */
export function fmtListTime(ts: number, l: Locale, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000);
  if (days <= 0) return fmtTime(ts, l);
  if (days < 7) return new Intl.DateTimeFormat(tag(l), { weekday: 'short' }).format(ts);
  return new Intl.DateTimeFormat(tag(l), { month: 'short', day: 'numeric' }).format(ts);
}

export function fmtDayLabel(ts: number, l: Locale, labels: { today: string; yesterday: string }, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000);
  if (days === 0) return labels.today;
  if (days === 1) return labels.yesterday;
  return fmtDate(ts, l);
}

export function fmtBytes(n: number, l: Locale): string {
  const units = l === 'fa' ? ['بایت', 'کیلوبایت', 'مگابایت', 'گیگابایت'] : ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${new Intl.NumberFormat(numTag(l), { maximumFractionDigits: v < 10 && i > 0 ? 1 : 0 }).format(v)} ${units[i]}`;
}

export const dayKey = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};
