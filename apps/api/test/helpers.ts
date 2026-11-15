import { exports } from 'cloudflare:workers';
import type { AuthResponse } from '@aminchat/shared';

export interface Call {
  token?: string;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
}

export async function api(method: string, path: string, opts: Call = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let body = opts.body;
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  return exports.default.fetch(`https://amin.test${path}`, { method, headers, body });
}

export async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

let counter = 0;
/** Every registration comes from its own address, like real edge traffic (the per-IP limiter keys on CF-Connecting-IP). */
export const freshIp = () => `10.${(counter >> 16) & 255}.${(counter >> 8) & 255}.${(counter++ & 255) || 1}`;
export const uniqueName = (prefix = 'user') => `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}`;

export interface TestUser {
  token: string;
  id: string;
  username: string;
  displayName: string;
}

export async function registerUser(prefix = 'user', extra: Record<string, unknown> = {}): Promise<TestUser> {
  const username = uniqueName(prefix);
  const res = await api('POST', '/api/auth/register', { headers: { 'CF-Connecting-IP': freshIp() }, json: { username, password: 'correct-horse-battery', displayName: username, ...extra } });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  const data = await json<AuthResponse>(res);
  return { token: data.token, id: data.user.id, username, displayName: data.user.displayName };
}

/** The administrator configured in wrangler.test.jsonc (ADMIN_USERNAMES). Registered once per test file, then logged in. */
export async function getAdmin(): Promise<TestUser> {
  const username = 'root_admin';
  const password = 'correct-horse-battery';
  const reg = await api('POST', '/api/auth/register', { headers: { 'CF-Connecting-IP': freshIp() }, json: { username, password, displayName: 'Root Admin' } });
  if (reg.status === 201) {
    const data = await json<AuthResponse>(reg);
    return { token: data.token, id: data.user.id, username, displayName: data.user.displayName };
  }
  const login = await api('POST', '/api/auth/login', { json: { username, password } });
  if (login.status !== 200) throw new Error(`admin login failed: ${login.status} ${await login.text()}`);
  const data = await json<AuthResponse>(login);
  return { token: data.token, id: data.user.id, username, displayName: data.user.displayName };
}

export async function directChat(a: TestUser, b: TestUser, e2ee = false): Promise<string> {
  const res = await api('POST', '/api/conversations/direct', { token: a.token, json: { userId: b.id, e2ee } });
  const data = await json(res);
  if (res.status !== 201) throw new Error(`direct failed: ${res.status} ${JSON.stringify(data)}`);
  return data.conversation.id as string;
}

export async function sendText(user: TestUser, conversationId: string, body: string, extra: Record<string, unknown> = {}) {
  const res = await api('POST', `/api/conversations/${conversationId}/messages`, { token: user.token, json: { body, ...extra } });
  const data = await json(res);
  if (res.status !== 201) throw new Error(`send failed: ${res.status} ${JSON.stringify(data)}`);
  return data as { message: any; ai: any };
}

/* ------------------------------------------------------------------------------------------------ AI / realtime helpers */

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 15_000, intervalMs = 30): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - started > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];

export async function getRunDto(user: TestUser, runId: string): Promise<any> {
  const res = await api('GET', `/api/ai/runs/${runId}`, { token: user.token });
  if (res.status !== 200) throw new Error(`run fetch failed: ${res.status} ${await res.text()}`);
  return (await json(res)).run;
}

export async function waitForRun(user: TestUser, runId: string, until: string[] = TERMINAL_STATUSES, timeoutMs = 20_000): Promise<any> {
  return waitFor(async () => {
    const run = await getRunDto(user, runId);
    return until.includes(run.status) ? run : null;
  }, timeoutMs);
}

export async function createThread(user: TestUser, body: Record<string, unknown> = {}): Promise<any> {
  const res = await api('POST', '/api/ai/threads', { token: user.token, json: body });
  if (res.status !== 201) throw new Error(`thread failed: ${res.status} ${await res.text()}`);
  return (await json(res)).thread;
}

export async function sendAi(user: TestUser, threadId: string, body: Record<string, unknown>): Promise<{ status: number; data: any }> {
  const res = await api('POST', `/api/ai/threads/${threadId}/messages`, { token: user.token, json: body });
  return { status: res.status, data: await json(res) };
}

export async function threadMessages(user: TestUser, threadId: string): Promise<any[]> {
  const res = await api('GET', `/api/ai/threads/${threadId}/messages?limit=100`, { token: user.token });
  return (await json(res)).messages;
}

/** Sends a message to AMIN AI and waits until the run is over. */
export async function ask(user: TestUser, threadId: string, body: Record<string, unknown>) {
  const { status, data } = await sendAi(user, threadId, body);
  if (status !== 201) throw new Error(`send failed: ${status} ${JSON.stringify(data)}`);
  const run = await waitForRun(user, data.run.id);
  return { ...data, finalRun: run };
}

export interface TestSocket {
  events: any[];
  waitFor(pred: (e: any) => boolean, timeoutMs?: number): Promise<any>;
  close(): void;
}

/** Opens the real-time WebSocket exactly like the web app does (ticket first, then upgrade). */
export async function openSocket(user: TestUser): Promise<TestSocket> {
  const t = await json(await api('POST', '/api/realtime/ticket', { token: user.token }));
  const res = await exports.default.fetch(`https://amin.test/api/realtime/ws?ticket=${encodeURIComponent(t.ticket)}`, { headers: { Upgrade: 'websocket' } });
  if (res.status !== 101 || !res.webSocket) throw new Error(`websocket upgrade failed: ${res.status}`);
  const ws = res.webSocket;
  ws.accept();
  const events: any[] = [];
  ws.addEventListener('message', (e) => {
    events.push(JSON.parse(String(e.data)));
  });
  return {
    events,
    waitFor: (pred, timeoutMs = 15_000) => waitFor(() => events.find(pred), timeoutMs),
    close: () => ws.close(1000, 'done'),
  };
}
