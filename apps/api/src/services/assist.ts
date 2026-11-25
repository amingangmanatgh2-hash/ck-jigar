import { hasAiMention, type AccessDecision, type AiTriggerResult, type MessageDto } from '@aminchat/shared';
import { anyProviderConnected } from '../ai/providers';
import { assertWithinQuota } from '../ai/usage';
import { RATE_LIMITS } from '../config/limits';
import type { Env } from '../env';
import { AppError } from '../lib/errors';
import { clipForLog } from '../lib/text';
import { consume } from './rate';
import type { AuthUser } from '../middleware/auth';
import type { ConvRow, MemberRow } from './conversations';
import { createAssistantPlaceholder, finalizeAssistantMessage, guardConcurrency } from './ai-chat';
import { startRun } from './run-control';
import { createRun } from './runs';

const DENIAL_TEXT: Record<string, { code: string; message: string; canEnable: boolean }> = {
  off: { code: 'AI_OFF', message: 'AI access is turned off in this chat.', canEnable: true },
  blocked: { code: 'AI_BLOCKED', message: 'Someone in this chat has blocked AI processing.', canEnable: false },
  role: { code: 'AI_ADMINS_ONLY', message: 'Only group admins can use AMIN AI in this group.', canEnable: false },
  e2ee: { code: 'AI_E2EE', message: 'This is a secret chat. Select the messages you want to share with AMIN AI instead.', canEnable: false },
  not_member: { code: 'AI_OFF', message: 'AI access is not available here.', canEnable: false },
};

/**
 * @AMINAI in a chat the user belongs to.
 *
 * The mention only ever starts work when the access policy of THIS conversation allows it for THIS invoker
 * (per-chat setting, any participant's block, group level and invoke roles — see `resolveAiAccess`). A denial is reported to the
 * sender only; nothing is posted into the chat. The reply is written as a message of AMIN AI replying to the mention.
 */
export async function triggerAssistIfMentioned(
  env: Env,
  user: AuthUser,
  args: { conv: ConvRow; member: MemberRow; message: MessageDto; decision: AccessDecision },
): Promise<AiTriggerResult> {
  const { conv, message, decision } = args;
  if (conv.type === 'ai' || message.kind !== 'text' || message.viaAi || !hasAiMention(message.body)) return { triggered: false };

  if (!decision.allowed) {
    const d = DENIAL_TEXT[decision.reason ?? 'off'] ?? DENIAL_TEXT.off!;
    return { triggered: false, denied: { code: d.code, message: d.message, canEnable: d.canEnable } };
  }
  if (!anyProviderConnected(env)) return { triggered: false, denied: { code: 'AI_NOT_CONNECTED', message: 'No AI provider is connected in this deployment.' } };

  try {
    await consume(env, 'ai', user.id, RATE_LIMITS.ai);
    await assertWithinQuota(env, user.id);
    await guardConcurrency(env, user.id, null);
  } catch (err) {
    if (err instanceof AppError) return { triggered: false, denied: { code: err.code, message: err.message } };
    throw err;
  }

  const placeholder = await createAssistantPlaceholder(env, { conversationId: conv.id, threadId: null, agentId: 'general', invokedBy: user.id, replyToId: message.id });
  const run = await createRun(env, {
    userId: user.id,
    kind: 'assist',
    agentId: 'general',
    goal: message.body ?? '',
    conversationId: conv.id,
    triggerMessageId: message.id,
    resultMessageId: placeholder.id,
    options: { locale: user.locale, access: { level: decision.level, adminAssist: decision.adminAssist } },
  });
  await env.DB.prepare('UPDATE messages SET meta = ? WHERE id = ?')
    .bind(JSON.stringify({ ai: { agentId: 'general', modelId: null, runId: run.id, invokedBy: user.id } }), placeholder.id)
    .run();
  try {
    await startRun(env, run.id);
  } catch (err) {
    console.error('assist start failed', run.id, clipForLog(err));
    await env.DB.prepare("UPDATE runs SET status = 'failed', error = ?, error_code = 'START_FAILED', finished_at = ? WHERE id = ?").bind('The task could not be started', Date.now(), run.id).run();
    await finalizeAssistantMessage(env, placeholder.id, { body: null, status: 'failed', ai: { error: { code: 'START_FAILED', message: 'The task could not be started' } } });
    return { triggered: false, denied: { code: 'RUN_START_FAILED', message: 'The AI task could not be started. Please try again.' } };
  }
  return { triggered: true, runId: run.id, messageId: placeholder.id };
}

