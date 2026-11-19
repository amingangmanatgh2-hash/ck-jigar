/** One streamed piece of an answer. `offset` is how many characters of the answer precede it (older servers omit it). */
export interface Delta {
  offset?: number;
  text: string;
}

/**
 * Applies a delta to the text received so far.
 *  - returns the new text when the delta continues (or overlaps) what we have — replaying a piece is harmless;
 *  - returns null when it starts beyond the end (an earlier piece is still missing), so the caller parks it.
 */
export function applyDelta(body: string, d: Delta): string | null {
  if (d.offset === undefined) return body + d.text;
  if (d.offset > body.length) return null;
  const seen = body.length - d.offset;
  return seen >= d.text.length ? body : body + d.text.slice(seen);
}
