import type { SelfDto } from '@aminchat/shared';
import { ApiError, getToken, setToken, setUnauthorizedHandler } from '../lib/api';
import { Auth } from '../lib/endpoints';
import { localeStore, setLocale, type Locale } from '../lib/i18n';
import { realtime } from '../lib/realtime';
import { attachStreamFeed, streams } from '../lib/streams';
import { createStore, useStore } from '../lib/store';
import { resetConversations } from './conversations';

export interface SessionState {
  status: 'loading' | 'anonymous' | 'authenticated';
  user: SelfDto | null;
  /** Set when the session ended because the server rejected the token. */
  expired?: boolean;
}

export const sessionStore = createStore<SessionState>({ status: 'loading', user: null });

const LOCALE_KEY = 'aminchat.locale';
const hasLocalLocaleChoice = (): boolean => {
  try {
    return localStorage.getItem(LOCALE_KEY) !== null;
  } catch {
    return false;
  }
};

let detachFeed: (() => void) | null = null;
function attachFeed(): void {
  detachFeed ??= attachStreamFeed(realtime);
}

function enter(user: SelfDto): void {
  sessionStore.set({ status: 'authenticated', user });
  // The profile language wins only when this device has never been told which language to use.
  if (!hasLocalLocaleChoice() && (user.locale === 'fa' || user.locale === 'en')) setLocale(user.locale);
  attachFeed();
  realtime.start();
}

function leave(expired = false): void {
  realtime.stop();
  detachFeed?.();
  detachFeed = null;
  streams.clear();
  setToken(null);
  resetConversations();
  sessionStore.set({ status: 'anonymous', user: null, expired });
}

export async function bootstrapSession(): Promise<void> {
  setUnauthorizedHandler(() => leave(true));
  if (!getToken()) {
    sessionStore.set({ status: 'anonymous', user: null });
    return;
  }
  try {
    enter((await Auth.me()).user);
  } catch (err) {
    // A network failure must not log the user out; only a rejected token does (handled by the 401 hook).
    if (err instanceof ApiError && err.status !== 0 && err.status !== 401) leave();
    else if (err instanceof ApiError && err.status === 0) sessionStore.set({ status: 'anonymous', user: null });
    else leave(true);
  }
}

export async function signIn(username: string, password: string): Promise<void> {
  const res = await Auth.login({ username: username.trim(), password });
  setToken(res.token);
  enter(res.user);
}

export async function signUp(input: { username: string; password: string; displayName?: string }): Promise<void> {
  const locale: Locale = localeStore.get();
  let timezone: string | undefined;
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    timezone = undefined;
  }
  const res = await Auth.register({ ...input, username: input.username.trim(), displayName: input.displayName?.trim() || undefined, locale, timezone });
  setToken(res.token);
  enter(res.user);
}

export async function signOut(): Promise<void> {
  try {
    await Auth.logout();
  } catch {
    // the token is dropped locally either way
  }
  leave();
}

export function updateSelf(user: SelfDto): void {
  sessionStore.set((s) => (s.status === 'authenticated' ? { ...s, user } : s));
}

export const useSession = (): SessionState => useStore(sessionStore, (s) => s);

/** The signed-in user. Only call inside the authenticated shell. */
export function useUser(): SelfDto {
  const user = useStore(sessionStore, (s) => s.user);
  if (!user) throw new Error('useUser() outside an authenticated session');
  return user;
}
