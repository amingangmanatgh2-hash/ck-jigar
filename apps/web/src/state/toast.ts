import { createStore, useStore } from '../lib/store';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}

export const toastStore = createStore<Toast[]>([]);
let nextId = 1;

export function toast(text: string, kind: Toast['kind'] = 'info', ms = 5000): number {
  const id = nextId++;
  toastStore.set((list) => [...list.slice(-3), { id, kind, text }]);
  if (ms > 0 && typeof window !== 'undefined') window.setTimeout(() => dismissToast(id), ms);
  return id;
}

export function dismissToast(id: number): void {
  toastStore.set((list) => list.filter((x) => x.id !== id));
}

export const useToasts = (): Toast[] => useStore(toastStore, (l) => l);
