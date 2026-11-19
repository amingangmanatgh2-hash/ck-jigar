import type { SharedInput } from '../lib/endpoints';
import { createStore, useStore } from '../lib/store';

/**
 * Chat content the user consciously selected for AMIN AI ("select messages for AI"). It lives only in memory until it is
 * sent with the next AI message (or discarded); nothing is uploaded when it is selected.
 */
export interface PendingShare {
  input: SharedInput;
  conversationTitle: string;
  e2ee: boolean;
  count: number;
  /** Short preview lines so the user sees exactly what is about to be sent. */
  preview: string[];
}

export const shareStore = createStore<PendingShare | null>(null);
export const useShare = (): PendingShare | null => useStore(shareStore, (s) => s);
