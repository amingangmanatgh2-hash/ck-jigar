/**
 * A short, in-memory "do not call this model for a moment" list. When a provider answers 429 (rate limited) with a Retry-After, the
 * next requests would only repeat the refusal and add its round trip to the user's wait, so the model is skipped until then and the
 * next one in the priority list answers at once.
 *
 * It lives in the isolate: another isolate may still try once and learn the same thing. That is acceptable — it is an optimisation,
 * the fallback in AiClient is what guarantees an answer. A cooling model is still tried when it is the only one left.
 */
const until = new Map<string, number>();

const MIN_MS = 1_000;
const MAX_MS = 120_000;

export function coolDown(modelId: string, ms: number, now = Date.now()): void {
  until.set(modelId, now + Math.min(Math.max(ms, MIN_MS), MAX_MS));
}

export function isCoolingDown(modelId: string, now = Date.now()): boolean {
  const t = until.get(modelId);
  if (t === undefined) return false;
  if (t <= now) {
    until.delete(modelId);
    return false;
  }
  return true;
}

/** Tests only. */
export function resetCooldowns(): void {
  until.clear();
}
