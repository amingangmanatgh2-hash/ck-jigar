import type { AgentDto, ModelsResponse, ThreadDto } from '@aminchat/shared';
import { useCallback, useEffect } from 'react';
import { Ai } from '../lib/endpoints';
import { createStore, useStore } from '../lib/store';

interface Loadable<T> {
  data: T | null;
  loading: boolean;
  error: unknown;
}

const make = <T,>() => createStore<Loadable<T>>({ data: null, loading: false, error: null });

export const agentsStore = make<AgentDto[]>();
export const modelsStore = make<ModelsResponse>();
export const threadsStore = make<ThreadDto[]>();

async function refresh<T>(store: ReturnType<typeof make<T>>, fetcher: () => Promise<T>): Promise<void> {
  store.set((s) => ({ ...s, loading: true }));
  try {
    store.set({ data: await fetcher(), loading: false, error: null });
  } catch (error) {
    store.set((s) => ({ ...s, loading: false, error }));
  }
}

export const refreshAgents = () => refresh(agentsStore, async () => (await Ai.agents()).agents);
export const refreshModels = () => refresh(modelsStore, () => Ai.models());
export const refreshThreads = () => refresh(threadsStore, async () => (await Ai.threads()).threads);

export function resetAiState(): void {
  for (const s of [agentsStore, modelsStore, threadsStore]) s.set({ data: null, loading: false, error: null });
}

/** Loads on first use, then serves the cached value (call `reload` to refresh). */
function useLoaded<T>(store: ReturnType<typeof make<T>>, load: () => Promise<void>) {
  const state = useStore(store, (s) => s);
  useEffect(() => {
    if (!store.get().data && !store.get().loading) void load();
  }, [store, load]);
  const reload = useCallback(() => load(), [load]);
  return { ...state, reload };
}

export const useAgents = () => useLoaded(agentsStore, refreshAgents);
export const useModels = () => useLoaded(modelsStore, refreshModels);
export const useThreads = () => useLoaded(threadsStore, refreshThreads);

export function upsertThread(thread: ThreadDto): void {
  threadsStore.set((s) => {
    const list = s.data ?? [];
    const next = list.some((t) => t.id === thread.id) ? list.map((t) => (t.id === thread.id ? { ...t, ...thread } : t)) : [thread, ...list];
    return { ...s, data: next.sort((a, b) => b.updatedAt - a.updatedAt) };
  });
}

export function dropThread(id: string): void {
  threadsStore.set((s) => ({ ...s, data: (s.data ?? []).filter((t) => t.id !== id) }));
}
