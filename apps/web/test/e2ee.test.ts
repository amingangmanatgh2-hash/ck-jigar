// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { decryptText, deriveConversationKey, encryptText, fromB64, hasLocalKeys, loadOrCreateKeys, publicJwkForServer, toB64 } from '../src/lib/e2ee';

// Node has WebCrypto, btoa/atob and TextEncoder; it has no localStorage, so provide a minimal one.
const memory = new Map<string, string>();
beforeEach(() => {
  memory.clear();
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => void memory.set(k, v),
    removeItem: (k: string) => void memory.delete(k),
    clear: () => memory.clear(),
    key: () => null,
    length: 0,
  } as Storage;
});

describe('end-to-end encryption', () => {
  it('two devices derive the same key and read each other', async () => {
    const alice = await loadOrCreateKeys('alice');
    const bob = await loadOrCreateKeys('bob');
    const aliceKey = await deriveConversationKey(alice.privateJwk, bob.publicJwk);
    const bobKey = await deriveConversationKey(bob.privateJwk, alice.publicJwk);
    const payload = await encryptText(aliceKey, 'سلام، قرار فردا ساعت ۱۰ — hello 👋');
    expect(await decryptText(bobKey, payload)).toBe('سلام، قرار فردا ساعت ۱۰ — hello 👋');
  });

  it('the server only ever sees an opaque payload', async () => {
    const a = await loadOrCreateKeys('a');
    const b = await loadOrCreateKeys('b');
    const key = await deriveConversationKey(a.privateJwk, b.publicJwk);
    const p = await encryptText(key, 'top secret');
    expect(Object.keys(p).sort()).toEqual(['ct', 'iv', 'v']);
    expect(JSON.stringify(p)).not.toContain('top secret');
    expect(fromB64(p.iv)).toHaveLength(12);
  });

  it('uses a fresh IV for every message, so equal texts give different ciphertexts', async () => {
    const a = await loadOrCreateKeys('a');
    const b = await loadOrCreateKeys('b');
    const key = await deriveConversationKey(a.privateJwk, b.publicJwk);
    const p1 = await encryptText(key, 'same');
    const p2 = await encryptText(key, 'same');
    expect(p1.iv).not.toBe(p2.iv);
    expect(p1.ct).not.toBe(p2.ct);
  });

  it('refuses a third party, a tampered message and a wrong key (returns null, never garbage)', async () => {
    const a = await loadOrCreateKeys('a');
    const b = await loadOrCreateKeys('b');
    const eve = await loadOrCreateKeys('eve');
    const key = await deriveConversationKey(a.privateJwk, b.publicJwk);
    const eveKey = await deriveConversationKey(eve.privateJwk, b.publicJwk);
    const p = await encryptText(key, 'hello');
    expect(await decryptText(eveKey, p)).toBeNull();
    const bytes = fromB64(p.ct);
    bytes[0] = bytes[0]! ^ 1;
    expect(await decryptText(key, { ...p, ct: toB64(bytes) })).toBeNull();
    expect(await decryptText(key, { ...p, iv: toB64(new Uint8Array(12)) })).toBeNull();
  });

  it('keeps the private key on the device and publishes only the public part', async () => {
    const keys = await loadOrCreateKeys('u1');
    expect(keys.privateJwk.d).toBeTruthy();
    expect(Object.keys(publicJwkForServer(keys.privateJwk)).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    expect(keys.publicJwk).not.toHaveProperty('d');
  });

  it('creates keys once per user and reuses them; a corrupted store is replaced', async () => {
    expect(hasLocalKeys('u1')).toBe(false);
    const first = await loadOrCreateKeys('u1');
    expect(hasLocalKeys('u1')).toBe(true);
    expect(await loadOrCreateKeys('u1')).toEqual(first);
    memory.set('aminchat.e2ee.u1', '{not json');
    const replaced = await loadOrCreateKeys('u1');
    expect(replaced.privateJwk.d).toBeTruthy();
    expect(replaced).not.toEqual(first);
  });

  it('base64 helpers round-trip arbitrary bytes, including large buffers', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 31) % 256);
    expect(fromB64(toB64(bytes))).toEqual(bytes);
  });
});
