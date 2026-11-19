/** Text utilities: Persian-aware normalisation, token estimation, JSON extraction. */

const PERSIAN_RE = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/g;
const LATIN_RE = /[A-Za-z]/g;

/**
 * Normalises text for full-text search (index time AND query time must use the same function):
 * Arabic → Persian letters, strips diacritics/tatweel, ZWNJ → space, Persian/Arabic digits → ASCII, lower-case.
 */
export function normalizeForSearch(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, '')
    .replace(/[يىئ]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[ةۀ]/g, 'ه')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ؤ/g, 'و')
    .replace(/[\u200c\u200d\u200e\u200f]/g, ' ')
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .toLowerCase();
}

/** Builds a safe FTS5 MATCH expression (prefix search, AND semantics) or null if there is nothing to search. */
export function buildFtsQuery(query: string, maxTokens = 8): string | null {
  const tokens = normalizeForSearch(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
    .slice(0, maxTokens);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
}

export function truncate(text: string, max: number, ellipsis = '…'): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - ellipsis.length)) + ellipsis;
}

/** Rough token estimate (Persian/Arabic script tokenises worse than Latin). Used only for budgeting & when a model reports no usage. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const persian = (text.match(PERSIAN_RE) ?? []).length;
  const latin = (text.match(LATIN_RE) ?? []).length;
  const other = Math.max(0, text.length - persian - latin);
  return Math.ceil(persian / 2.2 + latin / 4 + other / 3);
}

export function isMostlyPersian(text: string): boolean {
  const persian = (text.match(PERSIAN_RE) ?? []).length;
  const latin = (text.match(LATIN_RE) ?? []).length;
  return persian > latin;
}

/** Removes <think>…</think> reasoning blocks some models emit inline (also an unterminated leading block). */
export function stripThinking(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const open = out.search(/<think>/i);
  if (open !== -1) out = out.slice(0, open);
  return out.replace(/^\s+/, '');
}

/** Removes control characters (except \n \t) which could confuse prompts or logs. */
export function stripControl(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

/**
 * Extracts the first JSON object/array from model output (handles ``` fences, leading prose, trailing text).
 * Returns undefined when nothing parseable is found.
 */
export function extractJson(text: string): unknown | undefined {
  const cleaned = stripThinking(text).replace(/```(?:json|JSON)?/g, '');
  for (let start = 0; start < cleaned.length; start++) {
    const ch = cleaned[start];
    if (ch !== '{' && ch !== '[') continue;
    const end = findJsonEnd(cleaned, start);
    if (end === -1) continue;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      // keep scanning: the first brace may belong to prose
    }
  }
  return undefined;
}

function findJsonEnd(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function safeJsonParse<T = unknown>(text: string | null | undefined, fallback: T | null = null): T | null {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** First non-empty line, trimmed to `max` chars — used for previews and fallbacks for titles. */
export function firstLine(text: string, max = 60): string {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return truncate(line ?? '', max);
}

export function isoOrNull(ts: number | null | undefined): string | null {
  return ts ? new Date(ts).toISOString() : null;
}

/** One-line, bounded description of an unknown error for logs (never includes request bodies or secrets). */
export function clipForLog(err: unknown, max = 500): string {
  const e = err as { name?: string; message?: string } | undefined;
  return truncate(`${e?.name ?? 'Error'}: ${e?.message ?? String(err)}`, max, '…');
}
