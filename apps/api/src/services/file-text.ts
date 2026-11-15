import { LIMITS } from '@aminchat/shared';
import { first } from '../db/helpers';
import type { Env } from '../env';
import { AppError } from '../lib/errors';
import { AiClient, bytesToBase64 } from '../ai/client';
import { computeAccess, getConversation, getMember } from './conversations';
import { fileStore } from '../storage/file-store';
import type { FileRow } from './dto';

export type FileContent =
  | { type: 'text'; text: string; truncated: boolean; source: 'raw' | 'converted' | 'transcript' }
  | { type: 'image'; dataUri: string }
  | { type: 'unsupported'; reason: string };

export const FILE_TEXT_MAX_CHARS = 30_000;

export const getFileRow = (env: Env, id: string) => first<FileRow>(env.DB.prepare('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL').bind(id));

/**
 * May the assistant read this file on behalf of `userId`?
 *  - own files: yes
 *  - files attached to a conversation: only for members whose AI-access policy for that conversation allows context reading
 */
export async function canAiReadFile(env: Env, userId: string, file: FileRow): Promise<boolean> {
  if (file.owner_id === userId) return true;
  if (!file.conversation_id) return false;
  const [conv, member] = await Promise.all([getConversation(env, file.conversation_id), getMember(env, file.conversation_id, userId)]);
  if (!conv || !member) return false;
  const decision = await computeAccess(env, conv, member);
  return decision.allowed && decision.level === 'context';
}

async function derivative(env: Env, fileId: string, kind: 'text' | 'transcript') {
  return first<{ content: string }>(env.DB.prepare('SELECT content FROM file_derivatives WHERE file_id = ? AND kind = ?').bind(fileId, kind));
}

async function saveDerivative(env: Env, fileId: string, kind: 'text' | 'transcript', content: string, modelId: string | null) {
  await env.DB.prepare('INSERT OR REPLACE INTO file_derivatives (file_id, kind, content, model_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(fileId, kind, content, modelId, Date.now())
    .run();
}

/** The bytes of a file, from whichever tier holds them. A cold file that cannot be fetched right now is reported as unreadable, not as an error. */
async function readBytes(env: Env, file: FileRow): Promise<Uint8Array | { unreadable: string }> {
  try {
    return (await fileStore(env).bytes(file)) ?? { unreadable: 'The file content is missing from storage.' };
  } catch (err) {
    if (err instanceof AppError && err.code === 'FILE_STORAGE_UNAVAILABLE') return { unreadable: 'The file is kept in Google Drive, which cannot be reached right now. Try again later.' };
    throw err;
  }
}

/** Turns a stored file into something a model can consume. Never throws for "cannot read" situations — returns `unsupported` with the reason. */
export async function readFileForAi(
  env: Env,
  ai: AiClient,
  userId: string,
  file: FileRow,
  opts: { maxChars?: number; runId?: string | null; signal?: AbortSignal } = {},
): Promise<FileContent> {
  const max = opts.maxChars ?? FILE_TEXT_MAX_CHARS;
  const clip = (text: string, source: 'raw' | 'converted' | 'transcript'): FileContent => ({
    type: 'text',
    text: text.length > max ? text.slice(0, max) : text,
    truncated: text.length > max,
    source,
  });
  if (file.size > LIMITS.aiFileMaxBytes) return { type: 'unsupported', reason: `The file is larger than ${Math.round(LIMITS.aiFileMaxBytes / 1048576)} MB, the limit for AI processing.` };

  if (file.kind === 'text') {
    const bytes = await readBytes(env, file);
    if ('unreadable' in bytes) return { type: 'unsupported', reason: bytes.unreadable };
    return clip(new TextDecoder('utf-8').decode(bytes), 'raw');
  }

  if (file.kind === 'document') {
    const cached = await derivative(env, file.id, 'text');
    if (cached) return clip(cached.content, 'converted');
    const bytes = await readBytes(env, file);
    if ('unreadable' in bytes) return { type: 'unsupported', reason: bytes.unreadable };
    try {
      const md = await ai.toMarkdown(file.name, new Blob([bytes], { type: file.mime }));
      if (!md.text.trim()) return { type: 'unsupported', reason: 'No readable text was found in this document.' };
      await saveDerivative(env, file.id, 'text', md.text.slice(0, 400_000), null);
      return clip(md.text, 'converted');
    } catch (err) {
      const reason = err instanceof AppError ? err.message : 'The document could not be converted.';
      return { type: 'unsupported', reason };
    }
  }

  if (file.kind === 'audio') {
    const cached = await derivative(env, file.id, 'transcript');
    if (cached) return clip(cached.content, 'transcript');
    const bytes = await readBytes(env, file);
    if ('unreadable' in bytes) return { type: 'unsupported', reason: bytes.unreadable };
    try {
      const res = await ai.transcribe(userId, bytes, { runId: opts.runId, signal: opts.signal });
      await saveDerivative(env, file.id, 'transcript', res.text, res.modelId);
      return clip(res.text, 'transcript');
    } catch (err) {
      return { type: 'unsupported', reason: err instanceof AppError ? err.message : 'The audio could not be transcribed.' };
    }
  }

  if (file.kind === 'image') {
    const bytes = await readBytes(env, file);
    if ('unreadable' in bytes) return { type: 'unsupported', reason: bytes.unreadable };
    return { type: 'image', dataUri: `data:${file.mime};base64,${bytesToBase64(bytes)}` };
  }

  return { type: 'unsupported', reason: `Files of type "${file.kind}" cannot be read by the assistant.` };
}
