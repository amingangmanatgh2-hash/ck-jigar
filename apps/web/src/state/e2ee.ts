import type { ConversationDto, SelfDto } from '@aminchat/shared';
import { useEffect, useState } from 'react';
import { deriveConversationKey, e2eeSupported, hasLocalKeys, loadOrCreateKeys, publicJwkForServer } from '../lib/e2ee';
import { Users } from '../lib/endpoints';

export type E2eeStatus =
  | { state: 'none' }
  | { state: 'loading' }
  | { state: 'ready'; key: CryptoKey }
  | { state: 'error'; reason: 'unsupported' | 'no-local-key' | 'peer-key-missing' | 'failed' };

const keyCache = new Map<string, CryptoKey>();

export function clearE2eeCache(): void {
  keyCache.clear();
}

/**
 * Publishes this device's public key (creating the key pair if needed). The server holds ONE public key per account, so publishing a
 * different key replaces the old one: callers must confirm with the user first when `me.hasE2eeKey` is true but this device has no key.
 */
export async function ensureOwnKeyPublished(me: SelfDto): Promise<void> {
  if (!e2eeSupported()) throw Object.assign(new Error('E2EE not supported'), { code: 'E2EE_UNSUPPORTED' });
  const keys = await loadOrCreateKeys(me.id);
  // Idempotent: it also repairs a server copy that differs from the key this device holds.
  await Users.setE2eeKey(publicJwkForServer(keys.publicJwk));
}

/** True when starting a secret chat would replace a key published from another device. */
export const wouldReplaceKey = (me: SelfDto): boolean => !!me.hasE2eeKey && !hasLocalKeys(me.id);

export function useE2eeKey(conv: ConversationDto | undefined, meId: string): E2eeStatus {
  const [status, setStatus] = useState<E2eeStatus>({ state: 'none' });
  const convId = conv?.id;
  const e2ee = !!conv?.e2ee;
  const peerId = conv?.peer?.id;
  useEffect(() => {
    if (!convId || !e2ee) {
      setStatus({ state: 'none' });
      return;
    }
    const cached = keyCache.get(convId);
    if (cached) {
      setStatus({ state: 'ready', key: cached });
      return;
    }
    if (!e2eeSupported()) {
      setStatus({ state: 'error', reason: 'unsupported' });
      return;
    }
    if (!hasLocalKeys(meId)) {
      setStatus({ state: 'error', reason: 'no-local-key' });
      return;
    }
    if (!peerId) {
      setStatus({ state: 'error', reason: 'peer-key-missing' });
      return;
    }
    let alive = true;
    setStatus({ state: 'loading' });
    (async () => {
      try {
        const [mine, peer] = await Promise.all([loadOrCreateKeys(meId), Users.e2eeKey(peerId)]);
        const key = await deriveConversationKey(mine.privateJwk, peer.jwk);
        keyCache.set(convId, key);
        if (alive) setStatus({ state: 'ready', key });
      } catch (err) {
        if (alive) setStatus({ state: 'error', reason: (err as { status?: number })?.status === 404 ? 'peer-key-missing' : 'failed' });
      }
    })();
    return () => {
      alive = false;
    };
  }, [convId, e2ee, peerId, meId]);
  return status;
}
