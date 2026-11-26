import type { HealthDto } from '@aminchat/shared';
import { Server } from '../lib/endpoints';
import { createStore, useStore } from '../lib/store';

/**
 * What the server we talk to can do, from its public GET /api/health. Today: whether it can keep files. A deployment without R2 (an account
 * that has not switched it on) says `storage.files: false`; the composer then shows attaching as unavailable, with the reason, instead
 * of offering something that fails.
 *
 * Unknown counts as "yes": only an explicit "no" switches something off, so a slow answer, a failed request or an older server that does
 * not send the field never takes a working feature away. (If it matters after all, the upload itself answers FILE_STORAGE_NOT_CONNECTED.)
 */
export interface Capabilities {
  files: boolean;
  /** True once the server has told us. */
  known: boolean;
}

export const UNKNOWN_CAPABILITIES: Capabilities = { files: true, known: false };
export const capabilitiesStore = createStore<Capabilities>(UNKNOWN_CAPABILITIES);

export const capabilitiesFrom = (health: Partial<Pick<HealthDto, 'storage'>> | null | undefined): Capabilities => ({ files: health?.storage?.files !== false, known: true });

export async function refreshCapabilities(): Promise<void> {
  try {
    capabilitiesStore.set(capabilitiesFrom(await Server.health()));
  } catch {
    // keep what is known; nothing is switched off because a request failed
  }
}

export const resetCapabilities = (): void => capabilitiesStore.set(UNKNOWN_CAPABILITIES);

/** False only when the server said it cannot keep files. */
export const useFilesAvailable = (): boolean => useStore(capabilitiesStore, (s) => s.files);
