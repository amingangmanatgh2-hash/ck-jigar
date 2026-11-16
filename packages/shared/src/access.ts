/**
 * AI access policy — a PURE function shared by the API (enforcement) and the web app (explanation).
 *
 * Principles (see docs/SECURITY.md):
 *  - AMIN AI can never read the content of a conversation unless access was granted for that conversation.
 *  - Direct chats: the *invoking* user grants access for themselves; ANY participant can block AI for everybody.
 *  - Groups: owners/admins set the level for the whole group and decide who may invoke the assistant.
 *  - End-to-end encrypted chats: the server cannot read them, so access is always 'none'; the user must
 *    deliberately select the messages to share with the assistant (the `shared` field of POST /api/ai/threads/:id/messages: the
 *    client decrypts them and sends the chosen `excerpts`).
 */

export type AiAccessMode = 'off' | 'mention' | 'context';
export type GroupAiLevel = 'off' | 'mention' | 'context' | 'assist';
export type AiInvokeRoles = 'all' | 'admins';
export type MemberRole = 'owner' | 'admin' | 'member';
/** What the assistant is allowed to see once invoked. */
export type AccessLevel = 'none' | 'mention' | 'context';
export type AccessDenyReason = 'e2ee' | 'blocked' | 'off' | 'role' | 'not_member';

export interface AccessInput {
  type: 'direct' | 'group' | 'ai';
  e2ee: boolean;
  groupLevel: GroupAiLevel;
  invokeRoles: AiInvokeRoles;
  /** null when the invoker is not a member (always denied). */
  invoker: { role: MemberRole; access: AiAccessMode; blocked: boolean } | null;
  /** True when any participant of a direct chat has blocked AI processing. */
  anyBlocked: boolean;
}

export interface AccessDecision {
  allowed: boolean;
  /** 'mention' = only the invoking message (+ the message it replies to / explicitly selected ones). 'context' = recent history. */
  level: AccessLevel;
  /** Group admins may additionally use admin assistance (draft polls / announcements). */
  adminAssist: boolean;
  reason: AccessDenyReason | null;
}

const deny = (reason: AccessDenyReason): AccessDecision => ({ allowed: false, level: 'none', adminAssist: false, reason });

export function resolveAiAccess(input: AccessInput): AccessDecision {
  if (!input.invoker) return deny('not_member');
  // The private AMIN AI conversation is the user's own space.
  if (input.type === 'ai') return { allowed: true, level: 'context', adminAssist: false, reason: null };
  if (input.e2ee) return deny('e2ee');

  if (input.type === 'direct') {
    if (input.anyBlocked || input.invoker.blocked) return deny('blocked');
    if (input.invoker.access === 'off') return deny('off');
    return { allowed: true, level: input.invoker.access, adminAssist: false, reason: null };
  }

  // group
  if (input.groupLevel === 'off') return deny('off');
  const isAdmin = input.invoker.role === 'owner' || input.invoker.role === 'admin';
  if (input.invokeRoles === 'admins' && !isAdmin) return deny('role');
  return {
    allowed: true,
    level: input.groupLevel === 'mention' ? 'mention' : 'context',
    adminAssist: input.groupLevel === 'assist' && isAdmin,
    reason: null,
  };
}

/** Does the effective level allow reading history (needed by summaries etc.)? */
export function canReadHistory(decision: AccessDecision): boolean {
  return decision.allowed && decision.level === 'context';
}
