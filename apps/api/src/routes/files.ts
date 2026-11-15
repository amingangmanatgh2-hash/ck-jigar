import { Hono } from 'hono';
import { LIMITS } from '@aminchat/shared';
import { z } from 'zod';
import { all, escapeLike, first } from '../db/helpers';
import { badRequest, forbidden, notFound, tooLarge } from '../lib/errors';
import { parseQuery } from '../lib/validate';
import { requireAuth, type AppEnv } from '../middleware/auth';
import { userLimit } from '../middleware/rate-limit';
import { getMember } from '../services/conversations';
import { fileToDto, type FileRow } from '../services/dto';
import { storeFile, TYPE_RULES, extensionOf } from '../services/files';
import { fileStore, purgeBlobs } from '../storage/file-store';

export const fileRoutes = new Hono<AppEnv>();
fileRoutes.use('*', requireAuth, userLimit('api'));

/**
 * Upload: multipart/form-data with a "file" field, or a raw body with `X-File-Name` (URI-encoded).
 * Content is checked against an extension allow-list AND magic bytes; the client-supplied Content-Type is never trusted.
 */
fileRoutes.post('/', userLimit('upload'), async (c) => {
  const user = c.get('user');
  const declared = Number(c.req.header('Content-Length') ?? '0');
  if (declared > LIMITS.fileMaxBytes + 64 * 1024) throw tooLarge(`Files can be at most ${Math.round(LIMITS.fileMaxBytes / 1048576)} MB`);

  let name = '';
  let bytes: Uint8Array;
  const type = c.req.header('Content-Type') ?? '';
  if (type.startsWith('multipart/form-data')) {
    const form = await c.req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw badRequest('Missing "file" field', undefined, 'MISSING_FILE');
    name = file.name;
    if (file.size > LIMITS.fileMaxBytes) throw tooLarge(`Files can be at most ${Math.round(LIMITS.fileMaxBytes / 1048576)} MB`);
    bytes = new Uint8Array(await file.arrayBuffer());
  } else {
    const header = c.req.header('X-File-Name');
    if (!header) throw badRequest('X-File-Name header is required for raw uploads', undefined, 'MISSING_FILE_NAME');
    try {
      name = decodeURIComponent(header);
    } catch {
      throw badRequest('X-File-Name must be URI-encoded', undefined, 'INVALID_FILE_NAME');
    }
    bytes = new Uint8Array(await c.req.arrayBuffer());
  }
  const row = await storeFile(c.env, user.id, name, bytes);
  return c.json({ file: fileToDto(row) }, 201);
});

fileRoutes.get('/', async (c) => {
  const user = c.get('user');
  const q = parseQuery(
    c,
    z.object({
      kind: z.enum(['image', 'audio', 'video', 'document', 'text', 'archive', 'other']).optional(),
      q: z.string().trim().max(60).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
  );
  const binds: unknown[] = [user.id];
  let where = 'owner_id = ? AND deleted_at IS NULL';
  if (q.kind) {
    where += ' AND kind = ?';
    binds.push(q.kind);
  }
  if (q.q) {
    where += " AND name LIKE ? ESCAPE '\\'";
    binds.push(`%${escapeLike(q.q)}%`);
  }
  const rows = await all<FileRow>(c.env.DB.prepare(`SELECT * FROM files WHERE ${where} ORDER BY created_at DESC LIMIT ?`).bind(...binds, q.limit));
  return c.json({ files: rows.map(fileToDto) });
});

async function authorize(c: { env: AppEnv['Bindings'] }, userId: string, fileId: string): Promise<FileRow> {
  const row = await first<FileRow>(c.env.DB.prepare('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL').bind(fileId));
  if (!row) throw notFound('File not found', 'FILE_NOT_FOUND');
  if (row.owner_id === userId) return row;
  // Files attached to a message are visible to the members of that conversation — and only to them.
  if (row.conversation_id && (await getMember(c.env, row.conversation_id, userId))) return row;
  throw notFound('File not found', 'FILE_NOT_FOUND');
}

fileRoutes.get('/:id', async (c) => {
  const row = await authorize(c, c.get('user').id, c.req.param('id'));
  // hot files come from R2, cold ones are fetched from Google Drive through this Worker — after the access check above
  const obj = await fileStore(c.env).open(row);
  if (!obj) throw notFound('File content is missing', 'FILE_CONTENT_MISSING');
  const rule = TYPE_RULES[extensionOf(row.name)];
  const inline = !!rule?.inline && c.req.query('download') !== '1';
  const filename = encodeURIComponent(row.name);
  return new Response(obj.body, {
    headers: {
      'Content-Type': row.mime,
      ...(obj.size >= 0 ? { 'Content-Length': String(obj.size) } : {}),
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${filename}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, max-age=3600',
    },
  });
});

fileRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const row = await authorize(c, user.id, c.req.param('id'));
  if (row.owner_id !== user.id) throw forbidden('Only the owner can delete a file', 'NOT_YOUR_FILE');
  await c.env.DB.prepare('UPDATE files SET deleted_at = ? WHERE id = ?').bind(Date.now(), row.id).run();
  await purgeBlobs(c.env, [row]); // whatever cannot be deleted right now is retried by the periodic sweep
  return c.json({ ok: true });
});
