/**
 * @AMINAI mention detection.
 * Accepts @AMINAI / @aminai / @AMIN_AI (case-insensitive). The mention must start a token (so e-mail-like
 * strings such as "foo@aminai.com" do not trigger) and must not be followed by a word character.
 */
const MENTION_RE = /(^|[\s(\[{>«"'،؛:!?؟.\-–—])@(?:amin_?ai)(?![A-Za-z0-9_\u0600-\u06FF])/i;

export function hasAiMention(text: string | null | undefined): boolean {
  return !!text && MENTION_RE.test(text);
}

/** Text with the mention removed — used as the actual instruction for the assistant. */
export function stripAiMention(text: string): string {
  return text
    .replace(new RegExp(MENTION_RE.source, 'gi'), (_m, pre: string) => pre)
    .replace(/\s{2,}/g, ' ')
    .trim();
}
