import { z } from 'zod';
import { all, first } from '../../db/helpers';
import { escapeLike } from '../../db/helpers';
import { formatLocal } from '../../lib/datetime';
import { AppError } from '../../lib/errors';
import { canAiReadFile, getFileRow, readFileForAi } from '../../services/file-text';
import { storeFile } from '../../services/files';
import type { FileRow } from '../../services/dto';
import { loadHealth } from '../../ai/health';
import { rolePriority } from '../../ai/models';
import { ToolError, clip, type ToolDef } from './types';

const fileList = z.object({
  kind: z.enum(['image', 'audio', 'video', 'document', 'text', 'archive', 'other']).optional(),
  query: z.string().trim().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export const fileListTool: ToolDef<z.infer<typeof fileList>> = {
  id: 'file_list',
  title: { fa: 'فهرست فایل‌ها', en: 'List files' },
  description: "List the user's uploaded files (name, type, size, category, id).",
  argsHint: '{"kind"?: "image"|"audio"|"video"|"document"|"text"|"archive"|"other", "query"?: string (name contains), "limit"?: number}',
  risk: 'read',
  schema: fileList,
  async run(ctx, a) {
    const binds: unknown[] = [ctx.user.id];
    let where = "owner_id = ? AND deleted_at IS NULL AND source = 'upload'";
    if (a.kind) {
      where += ' AND kind = ?';
      binds.push(a.kind);
    }
    if (a.query) {
      where += " AND name LIKE ? ESCAPE '\\'";
      binds.push(`%${escapeLike(a.query)}%`);
    }
    const rows = await all<FileRow>(ctx.env.DB.prepare(`SELECT * FROM files WHERE ${where} ORDER BY created_at DESC LIMIT ?`).bind(...binds, a.limit ?? 30));
    return {
      text: rows.length
        ? rows.map((f) => `- ${f.name} (${f.kind}, ${Math.max(1, Math.round(f.size / 1024))} KB, uploaded ${formatLocal(f.created_at, ctx.user.timezone)}${f.category ? `, category: ${f.category}` : ''}) (id: ${f.id})`).join('\n')
        : 'No files found.',
      data: rows.map((f) => ({ id: f.id, name: f.name, kind: f.kind, category: f.category })),
    };
  },
};

const fileRead = z.object({ fileId: z.string().trim().min(1).max(64), maxChars: z.coerce.number().int().min(500).max(30_000).optional() });

export const fileReadTool: ToolDef<z.infer<typeof fileRead>> = {
  id: 'file_read',
  title: { fa: 'خواندن فایل', en: 'Read file' },
  description: 'Read the text of a supported file (text/code, PDF, Office documents, audio transcript). Images are described only when attached to the message.',
  argsHint: '{"fileId": string (from file_list or the attachment list), "maxChars"?: number}',
  timeoutMs: 100_000,
  risk: 'read',
  schema: fileRead,
  async run(ctx, a) {
    const file = await getFileRow(ctx.env, a.fileId);
    if (!file || !(await canAiReadFile(ctx.env, ctx.user.id, file))) throw new ToolError('FILE_NOT_FOUND', 'No readable file with this id was found among your files.');
    if (file.kind === 'image') throw new ToolError('IMAGE_NOT_TEXT', 'Images cannot be read as text. Ask the user to attach the image to a message so a vision model can look at it.');
    const content = await readFileForAi(ctx.env, ctx.ai, ctx.user.id, file, { maxChars: a.maxChars ?? 20_000, runId: ctx.run.id, signal: ctx.signal });
    if (content.type === 'unsupported') throw new ToolError('FILE_UNREADABLE', `"${file.name}" cannot be read: ${content.reason}`);
    if (content.type !== 'text') throw new ToolError('FILE_UNREADABLE', `"${file.name}" cannot be read as text.`);
    return {
      text: `Contents of "${file.name}"${content.truncated ? ' (truncated)' : ''}:\n${content.text}`,
      data: { fileId: file.id, name: file.name, chars: content.text.length, truncated: content.truncated },
    };
  },
};

const categorize = z.object({
  assignments: z.array(z.object({ fileId: z.string().trim().min(1).max(64), category: z.string().trim().min(1).max(40) })).min(1).max(20),
});

export const fileCategorizeTool: ToolDef<z.infer<typeof categorize>> = {
  id: 'file_categorize',
  title: { fa: 'دسته‌بندی فایل‌ها', en: 'Categorize files' },
  description: 'Assign a category label to files of the user. ALWAYS needs the user\'s approval (they can edit the categories). Only plan this when the user asked for categorization.',
  argsHint: '{"assignments": [{"fileId": string, "category": string}]}',
  risk: 'sensitive',
  schema: categorize,
  editable: ['assignments'],
  async prepare(ctx, a) {
    const names: string[] = [];
    for (const x of a.assignments) {
      const f = await first<{ name: string }>(ctx.env.DB.prepare('SELECT name FROM files WHERE id = ? AND owner_id = ? AND deleted_at IS NULL').bind(x.fileId, ctx.user.id));
      if (!f) throw new ToolError('FILE_NOT_FOUND', `File ${x.fileId} was not found among your files.`);
      names.push(`${f.name} → ${x.category}`);
    }
    return { args: a, summary: `Categorize ${a.assignments.length} file(s): ${clip(names.join('; '), 200)}`, context: { files: names } };
  },
  async run(ctx, a) {
    let done = 0;
    for (const x of a.assignments) {
      const res = await ctx.env.DB.prepare('UPDATE files SET category = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL').bind(x.category, x.fileId, ctx.user.id).run();
      if (res.meta.changes) done++;
    }
    const verify = await all<{ id: string; category: string | null }>(
      ctx.env.DB.prepare(`SELECT id, category FROM files WHERE owner_id = ? AND id IN (${a.assignments.map(() => '?').join(',')})`).bind(ctx.user.id, ...a.assignments.map((x) => x.fileId)),
    );
    const ok = a.assignments.every((x) => verify.find((v) => v.id === x.fileId)?.category === x.category);
    if (done === 0) throw new ToolError('NOT_FOUND', 'None of the files could be updated.');
    return { text: `Categorized ${done} of ${a.assignments.length} file(s).`, data: { updated: done }, verified: ok && done === a.assignments.length };
  },
};

/* ------------------------------------------------------------------------------------------------ images */

const imageGenerate = z.object({ prompt: z.string().trim().min(3).max(1000) });

export const imageGenerateTool: ToolDef<z.infer<typeof imageGenerate>> = {
  id: 'image_generate',
  title: { fa: 'تولید تصویر', en: 'Generate image' },
  description: 'Generate an image from an English text prompt with a Workers AI image model. The image is attached to the reply.',
  argsHint: '{"prompt": string (English, concrete visual details)}',
  timeoutMs: 100_000,
  risk: 'write',
  schema: imageGenerate,
  async available(env) {
    if (!env.AI) return { ok: false, reason: 'Workers AI is not connected' };
    const health = await loadHealth(env);
    const ok = rolePriority('image').some((m) => health.get(m.id)?.status === 'available');
    return ok ? { ok: true } : { ok: false, reason: 'No image model has been verified as available' };
  },
  async run(ctx, a) {
    const img = await ctx.ai.generateImage(ctx.user.id, a.prompt, { runId: ctx.run.id, signal: ctx.signal });
    const ext = img.mime === 'image/png' ? 'png' : img.mime === 'image/webp' ? 'webp' : 'jpg';
    const file = await storeFile(ctx.env, ctx.user.id, `amin-ai-${Date.now().toString(36)}.${ext}`, img.bytes, { source: 'ai', forceMime: img.mime, kind: 'image' });
    const stored = await ctx.env.FILES.head(file.r2_key);
    if (!stored) throw new ToolError('NOT_SAVED', 'The generated image could not be stored.', { retryable: true });
    return { text: 'Image generated and attached to the reply.', data: { fileId: file.id, model: img.modelId }, generatedFileIds: [file.id], verified: true };
  },
};

export { AppError };
