import { RESERVED_USERNAMES, USERNAME_REGEX, type AuthResponse } from '@aminchat/shared';
import { first, isUniqueViolation } from '../db/helpers';
import type { Env } from '../env';
import { SESSION_TTL_MS } from '../config/limits';
import { hashPassword, randomToken, sha256Hex, verifyPassword } from '../lib/crypto';
import { badRequest, conflict, unauthorized } from '../lib/errors';
import { ID_PREFIX, newId } from '../lib/ids';
import { userToSelfDto, type UserRow } from './dto';
import { ensureAiConversation } from './conversations';

export function validateUsername(username: string): void {
  if (!USERNAME_REGEX.test(username)) {
    throw badRequest('Username must be 3–32 characters: letters, digits and underscore, starting with a letter', undefined, 'INVALID_USERNAME');
  }
  if (RESERVED_USERNAMES.includes(username.toLowerCase())) throw conflict('This username is reserved', 'USERNAME_RESERVED');
}

export const getUserById = (env: Env, id: string) => first<UserRow>(env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id));
export const getUserByUsername = (env: Env, username: string) =>
  first<UserRow>(env.DB.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').bind(username));

export async function issueSession(env: Env, userId: string, userAgent: string | null): Promise<{ token: string; expiresAt: number; sessionId: string }> {
  const token = randomToken(32);
  const now = Date.now();
  const sessionId = newId(ID_PREFIX.session);
  const expiresAt = now + SESSION_TTL_MS;
  await env.DB.prepare(
    'INSERT INTO sessions (id, user_id, token_hash, created_at, last_used_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(sessionId, userId, await sha256Hex(token), now, now, expiresAt, userAgent?.slice(0, 200) ?? null)
    .run();
  return { token, expiresAt, sessionId };
}

function isAdminName(env: Env, username: string): boolean {
  return (env.ADMIN_USERNAMES ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(username.toLowerCase());
}

export async function register(
  env: Env,
  input: { username: string; password: string; displayName?: string; locale?: 'fa' | 'en'; timezone?: string },
  userAgent: string | null,
): Promise<AuthResponse> {
  validateUsername(input.username);
  const id = newId(ID_PREFIX.user);
  const now = Date.now();
  const hash = await hashPassword(input.password);
  try {
    await env.DB.prepare(
      `INSERT INTO users (id, username, display_name, password_hash, kind, role, verified, locale, timezone, created_at)
       VALUES (?, ?, ?, ?, 'human', ?, 0, ?, ?, ?)`,
    )
      .bind(id, input.username, (input.displayName?.trim() || input.username).slice(0, 60), hash, isAdminName(env, input.username) ? 'admin' : 'user', input.locale ?? 'fa', input.timezone ?? 'UTC', now)
      .run();
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('This username is already taken', 'USERNAME_TAKEN');
    throw err;
  }
  await ensureAiConversation(env, id);
  const session = await issueSession(env, id, userAgent);
  const user = (await getUserById(env, id))!;
  return { token: session.token, expiresAt: session.expiresAt, user: userToSelfDto(user) };
}

export async function login(env: Env, username: string, password: string, userAgent: string | null): Promise<AuthResponse> {
  const user = await getUserByUsername(env, username);
  const ok = await verifyPassword(password, user?.password_hash ?? null);
  if (!user || !ok || user.kind !== 'human' || user.disabled_at) throw unauthorized('Invalid username or password', 'INVALID_CREDENTIALS');
  if (isAdminName(env, user.username) && user.role !== 'admin') {
    await env.DB.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).bind(user.id).run();
    user.role = 'admin';
  }
  await ensureAiConversation(env, user.id);
  const session = await issueSession(env, user.id, userAgent);
  return { token: session.token, expiresAt: session.expiresAt, user: userToSelfDto(user) };
}
