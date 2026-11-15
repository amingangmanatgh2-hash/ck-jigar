import { Hono } from 'hono';
import type { Context } from 'hono';
import { AGENT_IDS, LIMITS, type AgentDto, type ToolInfoDto } from '@aminchat/shared';
import { z } from 'zod';
import { AUTO_AGENT, AGENTS } from '../agents/registry';
import { TOOLS } from '../agents/tools';
import { AiClient } from '../ai/client';
import { ensureFreshHealth, modelsResponse, refreshHealth } from '../ai/health';
import { usageSummary } from '../ai/usage';
import { all } from '../db/helpers';
import { badRequest, conflict, tooLarge, unsupportedMedia } from '../lib/errors';
import { clientIdField } from '../lib/fields';
import { parseJson, parseQuery } from '../lib/validate';
import { requireAdmin, requireAuth, type AppEnv } from '../middleware/auth';
import { userLimit } from '../middleware/rate-limit';
import { requireAiBackend, editAndResend, regenerateTurn, startAiTurn, validateAgentAndModel } from '../services/ai-chat';
import { requireMember } from '../services/conversations';
import { listMessages } from '../services/messages';
import { cancelRun } from '../services/run-control';
import { createThread, deleteThread, listThreads, requireThread, searchMessages, threadToDto, touchThread } from '../services/threads';
import { aiMemoryRoutes } from './ai-memory';
import { aiPersonalRoutes } from './ai-personal';
import { aiRunRoutes } from './ai-runs';

export const aiRoutes = new Hono<AppEnv>();
aiRoutes.use('*', requireAuth, userLimit('api'));

function waitUntilOf(c: Context<AppEnv>): { waitUntil(p: Promise<unknown>): void } | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

const agentField = z.enum(AGENT_IDS);
const modelField = z.string().trim().min(1).max(120).nullable();
const idField = z.string().trim().min(1).max(64);

const sharedSchema = z.object({
  conversationId: idField,
  messageIds: z.array(idField).max(LIMITS.sharedExcerptsMax).optional(),
  excerpts: z
    .array(z.object({ sender: z.string().trim().max(60), text: z.string().trim().min(1).max(LIMITS.sharedExcerptChars * 2), at: z.number().int().nullable().optional() }))
    .max(LIMITS.sharedExcerptsMax)
    .optional(),
});

const sendSchema = z.object({
  body: z.string().max(LIMITS.aiPromptMaxChars * 2).nullish(),
  fileIds: z.array(idField).max(LIMITS.attachmentsPerMessage).optional(),
  agentId: agentField.optional(),
  modelId: modelField.optional(),
  shared: sharedSchema.optional(),
  clientId: clientIdField.optional(),
});

/* ------------------------------------------------------------------------------------------------ agents, models, usage */

aiRoutes.get('/agents', async (c) => {
  const user = c.get('user');
  const out: AgentDto[] = [{ id: 'auto', name: AUTO_AGENT.name, description: AUTO_AGENT.description, icon: AUTO_AGENT.icon, tools: [], mode: 'router' }];
  for (const def of Object.values(AGENTS)) {
    const tools: ToolInfoDto[] = [];
    for (const id of def.tools) {
      const tool = TOOLS[id];
      if (!tool) continue;
      const avail = tool.available ? await tool.available(c.env, user.id) : ({ ok: true } as const);
      tools.push({ id, title: tool.title[user.locale], risk: tool.risk, available: avail.ok, reason: avail.ok ? null : avail.reason });
    }
    out.push({ id: def.id, name: def.name, description: def.description, icon: def.icon, tools, mode: def.tools.length > 0 ? 'plan' : 'direct' });
  }
  return c.json({ agents: out });
});

aiRoutes.get('/models', async (c) => {
  await ensureFreshHealth(c.env, waitUntilOf(c));
  return c.json(await modelsResponse(c.env));
});

/** Forces a real availability probe of every model (admins only: it spends a little of the Workers AI allocation). */
aiRoutes.post('/models/refresh', requireAdmin, userLimit('aiHeavy'), async (c) => {
  requireAiBackend(c.env);
  await refreshHealth(c.env);
  return c.json(await modelsResponse(c.env));
});

aiRoutes.get('/usage', async (c) => c.json(await usageSummary(c.env, c.get('user').id)));

/* ------------------------------------------------------------------------------------------------ threads */

const MAX_THREADS = 500;

aiRoutes.get('/threads', async (c) => c.json({ threads: await listThreads(c.env, c.get('user').id) }));

aiRoutes.post('/threads', async (c) => {
  const user = c.get('user');
  const body = await parseJson(c, z.object({ title: z.string().trim().max(LIMITS.titleMax).nullish(), agentId: agentField.optional(), modelId: modelField.optional() }));
  await validateAgentAndModel(c.env, body.agentId, body.modelId);
  const count = (await listThreads(c.env, user.id, MAX_THREADS + 1)).length;
  if (count > MAX_THREADS) throw conflict(`You can keep at most ${MAX_THREADS} conversations. Delete old ones first.`, 'THREAD_LIMIT');
  const thread = await createThread(c.env, user.id, { title: body.title, agentId: body.agentId, modelId: body.modelId });
  return c.json({ thread: threadToDto(thread, 0) }, 201);
});

aiRoutes.get('/threads/:id', async (c) => {
  const thread = await requireThread(c.env, c.get('user').id, c.req.param('id'));
  return c.json({ thread: threadToDto(thread) });
});

aiRoutes.patch('/threads/:id', async (c) => {
  const user = c.get('user');
  const thread = await requireThread(c.env, user.id, c.req.param('id'));
  const body = await parseJson(c, z.object({ title: z.string().trim().min(1).max(LIMITS.titleMax).optional(), agentId: agentField.optional(), modelId: modelField.optional() }));
  await validateAgentAndModel(c.env, body.agentId, body.modelId);
  await touchThread(c.env, thread.id, { title: body.title, agentId: body.agentId, modelId: body.modelId });
  return c.json({ thread: threadToDto(await requireThread(c.env, user.id, thread.id)) });
});

aiRoutes.delete('/threads/:id', async (c) => {
  const user = c.get('user');
  const thread = await requireThread(c.env, user.id, c.req.param('id'));
  const active = await all<{ id: string }>(c.env.DB.prepare("SELECT id FROM runs WHERE thread_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')").bind(thread.id));
  for (const r of active) await cancelRun(c.env, user.id, r.id).catch(() => undefined);
  await deleteThread(c.env, user.id, thread.id);
  return c.json({ ok: true });
});

aiRoutes.get('/threads/:id/messages', async (c) => {
  const user = c.get('user');
  const thread = await requireThread(c.env, user.id, c.req.param('id'));
  const q = parseQuery(c, z.object({ before: idField.optional(), limit: z.coerce.number().int().min(1).max(100).default(40) }));
  const page = await listMessages(c.env, { conversationId: thread.conversation_id, threadId: thread.id, before: q.before, limit: q.limit, viewerId: user.id });
  const active = await c.env.DB.prepare("SELECT id FROM runs WHERE thread_id = ? AND status NOT IN ('completed', 'failed', 'cancelled') ORDER BY created_at DESC LIMIT 1").bind(thread.id).first<{ id: string }>();
  return c.json({ ...page, activeRunId: active?.id ?? null });
});

aiRoutes.post('/threads/:id/messages', userLimit('ai'), async (c) => {
  const user = c.get('user');
  const thread = await requireThread(c.env, user.id, c.req.param('id'));
  const body = await parseJson(c, sendSchema);
  const result = await startAiTurn(c.env, user, thread, body);
  return c.json(result, result.duplicate ? 200 : 201);
});

aiRoutes.post('/threads/:id/regenerate', userLimit('ai'), async (c) => {
  const user = c.get('user');
  const thread = await requireThread(c.env, user.id, c.req.param('id'));
  const body = await parseJson(c, z.object({ agentId: agentField.optional(), modelId: modelField.optional() }));
  return c.json(await regenerateTurn(c.env, user, thread, body), 202);
});

aiRoutes.put('/threads/:id/messages/:messageId', userLimit('ai'), async (c) => {
  const user = c.get('user');
  const thread = await requireThread(c.env, user.id, c.req.param('id'));
  const body = await parseJson(c, z.object({ body: z.string().min(1).max(LIMITS.aiPromptMaxChars * 2), agentId: agentField.optional(), modelId: modelField.optional() }));
  return c.json(await editAndResend(c.env, user, thread, c.req.param('messageId'), body.body, body), 202);
});

/** Starts a task from the tasks panel: a new conversation whose first message is the goal. */
aiRoutes.post('/tasks', userLimit('ai'), async (c) => {
  const user = c.get('user');
  const body = await parseJson(c, z.object({ goal: z.string().trim().min(1).max(LIMITS.aiPromptMaxChars), agentId: agentField.default('auto'), modelId: modelField.optional(), fileIds: z.array(idField).max(LIMITS.attachmentsPerMessage).optional() }));
  await validateAgentAndModel(c.env, body.agentId, body.modelId);
  requireAiBackend(c.env);
  const thread = await createThread(c.env, user.id, { agentId: body.agentId, modelId: body.modelId });
  const result = await startAiTurn(c.env, user, thread, { body: body.goal, agentId: body.agentId, modelId: body.modelId, fileIds: body.fileIds, kind: 'task' });
  return c.json({ thread: threadToDto(thread, 2), ...result }, 201);
});

/* ------------------------------------------------------------------------------------------------ search */

aiRoutes.get('/search', async (c) => {
  const user = c.get('user');
  const q = parseQuery(
    c,
    z.object({
      q: z.string().trim().min(1).max(200),
      scope: z.enum(['ai', 'all']).default('ai'),
      limit: z.coerce.number().int().min(1).max(50).default(20),
      conversationId: idField.optional(),
    }),
  );
  if (q.conversationId) await requireMember(c.env, q.conversationId, user.id);
  const hits = await searchMessages(c.env, user.id, q.q, { scope: q.scope, limit: q.limit, conversationId: q.conversationId });
  return c.json({ hits });
});

/* ------------------------------------------------------------------------------------------------ voice input */

const AUDIO_MAX_BYTES = 10 * 1024 * 1024;

function looksLikeAudio(b: Uint8Array): boolean {
  const ascii = (s: string, off = 0) => [...s].every((ch, i) => b[off + i] === ch.charCodeAt(0));
  return (
    (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) || // webm / matroska
    ascii('OggS') ||
    ascii('RIFF') ||
    ascii('fLaC') ||
    ascii('ID3') ||
    (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0) || // mp3 / aac frame
    ascii('ftyp', 4) || // m4a / mp4
    ascii('#!AMR')
  );
}

/** Speech to text for the microphone button. The audio is sent to the model and is not stored. */
aiRoutes.post('/transcribe', userLimit('aiHeavy'), async (c) => {
  requireAiBackend(c.env);
  const type = (c.req.header('Content-Type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!(type.startsWith('audio/') || type === 'video/webm' || type === 'application/octet-stream')) throw unsupportedMedia('Send the recording as audio/* data');
  const declared = Number(c.req.header('Content-Length') ?? 0);
  if (declared > AUDIO_MAX_BYTES) throw tooLarge('Recordings can be at most 10 MB');
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength > AUDIO_MAX_BYTES) throw tooLarge('Recordings can be at most 10 MB');
  if (bytes.byteLength < 200 || !looksLikeAudio(bytes)) throw badRequest('This does not look like an audio recording', undefined, 'INVALID_AUDIO');
  const lang = c.req.query('lang');
  const res = await new AiClient(c.env).transcribe(c.get('user').id, bytes, { language: lang === 'fa' || lang === 'en' ? lang : undefined });
  return c.json({ text: res.text, modelId: res.modelId });
});

/* ------------------------------------------------------------------------------------------------ sub-routers */

aiRoutes.route('/', aiRunRoutes);
aiRoutes.route('/memory', aiMemoryRoutes);
aiRoutes.route('/', aiPersonalRoutes);
