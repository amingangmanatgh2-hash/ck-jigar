/**
 * Time-ordered, monotonic identifiers: `<prefix>_<10 chars time><10 chars random>` (Crockford base32, lowercase).
 * Lexicographic order == creation order (within one isolate ids are strictly increasing, even in the same millisecond).
 */
const B32 = '0123456789abcdefghjkmnpqrstvwxyz';

let lastTime = 0;
let lastRandom = new Uint8Array(10);

function incrementRandom(buf: Uint8Array): void {
  for (let i = buf.length - 1; i >= 0; i--) {
    const next = ((buf[i] ?? 0) + 1) & 31;
    buf[i] = next;
    if (next !== 0) return;
  }
}

export function newId(prefix: string, now: number = Date.now()): string {
  let time = now;
  if (now <= lastTime) {
    time = lastTime;
    incrementRandom(lastRandom);
  } else {
    lastTime = now;
    lastRandom = new Uint8Array(10);
    crypto.getRandomValues(lastRandom);
    for (let i = 0; i < lastRandom.length; i++) lastRandom[i] = (lastRandom[i] ?? 0) & 31;
  }
  let ts = '';
  let t = time;
  for (let i = 0; i < 10; i++) {
    ts = B32[t % 32]! + ts;
    t = Math.floor(t / 32);
  }
  let rnd = '';
  for (const b of lastRandom) rnd += B32[b & 31];
  return `${prefix}_${ts}${rnd}`;
}

export const ID_PREFIX = {
  user: 'usr',
  session: 'ses',
  conversation: 'cnv',
  message: 'msg',
  file: 'fil',
  thread: 'thr',
  run: 'run',
  step: 'stp',
  approval: 'apr',
  memory: 'mem',
  suggestion: 'sug',
  todo: 'tdo',
  reminder: 'rem',
  project: 'prj',
} as const;
