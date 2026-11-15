import type { E2eePayload } from '@aminchat/shared';

/**
 * End-to-end encryption for secret chats (WebCrypto only, no dependency):
 *   - every device creates an ECDH P-256 key pair; the PRIVATE key never leaves this device (localStorage);
 *   - the public key is published (PUT /api/users/me/e2ee-key) so a peer can derive the same secret;
 *   - key = HKDF-SHA256(ECDH shared secret, info "aminchat-e2ee-v1") → AES-256-GCM; each message uses a fresh 12-byte IV.
 * The server only stores {v, iv, ct}. Limitation (documented): keys are per device, so a secret chat is readable only on
 * the device that holds the private key.
 */
export interface StoredKeys {
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const storageKey = (userId: string) => `aminchat.e2ee.${userId}`;
const subtle = () => globalThis.crypto.subtle;

export function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The server accepts only {kty, crv, x, y}. */
export const publicJwkForServer = (jwk: JsonWebKey): JsonWebKey => ({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });

export function e2eeSupported(): boolean {
  return typeof globalThis.crypto?.subtle !== 'undefined';
}

export function hasLocalKeys(userId: string): boolean {
  return !!localStorage.getItem(storageKey(userId));
}

export async function loadOrCreateKeys(userId: string): Promise<StoredKeys> {
  const saved = localStorage.getItem(storageKey(userId));
  if (saved) {
    try {
      const parsed = JSON.parse(saved) as StoredKeys;
      if (parsed.privateJwk?.d && parsed.publicJwk?.x) return parsed;
    } catch {
      // corrupted: fall through and create a new pair
    }
  }
  const pair = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const keys: StoredKeys = {
    privateJwk: await subtle().exportKey('jwk', pair.privateKey),
    publicJwk: publicJwkForServer(await subtle().exportKey('jwk', pair.publicKey)),
  };
  localStorage.setItem(storageKey(userId), JSON.stringify(keys));
  return keys;
}

export async function deriveConversationKey(privateJwk: JsonWebKey, peerPublicJwk: JsonWebKey): Promise<CryptoKey> {
  const priv = await subtle().importKey('jwk', { ...privateJwk, key_ops: ['deriveBits'] }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const pub = await subtle().importKey('jwk', publicJwkForServer(peerPublicJwk), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await subtle().deriveBits({ name: 'ECDH', public: pub }, priv, 256);
  const hkdf = await subtle().importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode('aminchat-e2ee-v1') },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptText(key: CryptoKey, text: string): Promise<E2eePayload> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text)));
  return { v: 1, iv: toB64(iv), ct: toB64(ct) };
}

/** Returns null when the message cannot be decrypted with this key (wrong device, tampering). */
export async function decryptText(key: CryptoKey, payload: E2eePayload): Promise<string | null> {
  try {
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(payload.iv) }, key, fromB64(payload.ct));
    return dec.decode(plain);
  } catch {
    return null;
  }
}
