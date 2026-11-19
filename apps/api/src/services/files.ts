import { LIMITS, type FileKind } from '@aminchat/shared';
import type { Env } from '../env';
import { sha256Hex } from '../lib/crypto';
import { ID_PREFIX, newId } from '../lib/ids';
import { badRequest, tooLarge, unsupportedMedia } from '../lib/errors';
import { fileStore } from '../storage/file-store';
import { fileToDto, type FileRow } from './dto';

interface TypeRule {
  kind: FileKind;
  mime: string;
  /** Magic-byte check; undefined = content is validated as UTF-8 text instead. */
  sniff?: (b: Uint8Array) => boolean;
  /** May be rendered inline by browsers (safe types only). */
  inline: boolean;
}

const startsWith = (b: Uint8Array, sig: number[], offset = 0) => sig.every((v, i) => b[offset + i] === v);
const ascii = (b: Uint8Array, s: string, offset = 0) => [...s].every((ch, i) => b[offset + i] === ch.charCodeAt(0));

const sniffers = {
  png: (b: Uint8Array) => startsWith(b, [0x89, 0x50, 0x4e, 0x47]),
  jpeg: (b: Uint8Array) => startsWith(b, [0xff, 0xd8, 0xff]),
  gif: (b: Uint8Array) => ascii(b, 'GIF8'),
  webp: (b: Uint8Array) => ascii(b, 'RIFF') && ascii(b, 'WEBP', 8),
  pdf: (b: Uint8Array) => ascii(b, '%PDF'),
  zip: (b: Uint8Array) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06]),
  mp3: (b: Uint8Array) => ascii(b, 'ID3') || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0),
  wav: (b: Uint8Array) => ascii(b, 'RIFF') && ascii(b, 'WAVE', 8),
  ogg: (b: Uint8Array) => ascii(b, 'OggS'),
  flac: (b: Uint8Array) => ascii(b, 'fLaC'),
  matroska: (b: Uint8Array) => startsWith(b, [0x1a, 0x45, 0xdf, 0xa3]),
  mp4: (b: Uint8Array) => ascii(b, 'ftyp', 4),
  ole: (b: Uint8Array) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0]),
};

const OFFICE = (mime: string): TypeRule => ({ kind: 'document', mime, sniff: sniffers.zip, inline: false });
const TEXT = (mime: string): TypeRule => ({ kind: 'text', mime, inline: false });

/** Allow-list by extension. Anything not listed (executables, scripts that run on the device, …) is rejected. */
export const TYPE_RULES: Record<string, TypeRule> = {
  png: { kind: 'image', mime: 'image/png', sniff: sniffers.png, inline: true },
  jpg: { kind: 'image', mime: 'image/jpeg', sniff: sniffers.jpeg, inline: true },
  jpeg: { kind: 'image', mime: 'image/jpeg', sniff: sniffers.jpeg, inline: true },
  gif: { kind: 'image', mime: 'image/gif', sniff: sniffers.gif, inline: true },
  webp: { kind: 'image', mime: 'image/webp', sniff: sniffers.webp, inline: true },
  pdf: { kind: 'document', mime: 'application/pdf', sniff: sniffers.pdf, inline: false },
  docx: OFFICE('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
  xlsx: OFFICE('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
  pptx: OFFICE('application/vnd.openxmlformats-officedocument.presentationml.presentation'),
  odt: OFFICE('application/vnd.oasis.opendocument.text'),
  ods: OFFICE('application/vnd.oasis.opendocument.spreadsheet'),
  xls: { kind: 'document', mime: 'application/vnd.ms-excel', sniff: sniffers.ole, inline: false },
  doc: { kind: 'document', mime: 'application/msword', sniff: sniffers.ole, inline: false },
  zip: { kind: 'archive', mime: 'application/zip', sniff: sniffers.zip, inline: false },
  mp3: { kind: 'audio', mime: 'audio/mpeg', sniff: sniffers.mp3, inline: true },
  wav: { kind: 'audio', mime: 'audio/wav', sniff: sniffers.wav, inline: true },
  ogg: { kind: 'audio', mime: 'audio/ogg', sniff: sniffers.ogg, inline: true },
  oga: { kind: 'audio', mime: 'audio/ogg', sniff: sniffers.ogg, inline: true },
  opus: { kind: 'audio', mime: 'audio/ogg', sniff: sniffers.ogg, inline: true },
  flac: { kind: 'audio', mime: 'audio/flac', sniff: sniffers.flac, inline: true },
  m4a: { kind: 'audio', mime: 'audio/mp4', sniff: sniffers.mp4, inline: true },
  aac: { kind: 'audio', mime: 'audio/aac', inline: true },
  webm: { kind: 'audio', mime: 'audio/webm', sniff: sniffers.matroska, inline: true },
  mp4: { kind: 'video', mime: 'video/mp4', sniff: sniffers.mp4, inline: true },
  txt: TEXT('text/plain'),
  md: TEXT('text/markdown'),
  csv: TEXT('text/csv'),
  tsv: TEXT('text/tab-separated-values'),
  json: TEXT('application/json'),
  xml: TEXT('application/xml'),
  yaml: TEXT('text/yaml'),
  yml: TEXT('text/yaml'),
  html: TEXT('text/plain'),
  css: TEXT('text/plain'),
  js: TEXT('text/plain'),
  mjs: TEXT('text/plain'),
  ts: TEXT('text/plain'),
  tsx: TEXT('text/plain'),
  jsx: TEXT('text/plain'),
  py: TEXT('text/plain'),
  java: TEXT('text/plain'),
  kt: TEXT('text/plain'),
  go: TEXT('text/plain'),
  rs: TEXT('text/plain'),
  c: TEXT('text/plain'),
  h: TEXT('text/plain'),
  cpp: TEXT('text/plain'),
  cs: TEXT('text/plain'),
  php: TEXT('text/plain'),
  rb: TEXT('text/plain'),
  swift: TEXT('text/plain'),
  sql: TEXT('text/plain'),
  sh: TEXT('text/plain'),
  toml: TEXT('text/plain'),
  ini: TEXT('text/plain'),
  log: TEXT('text/plain'),
  svg: TEXT('text/plain'), // treated as text: never rendered as an image (XSS)
};

export function extensionOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name.trim());
  return m ? m[1]!.toLowerCase() : '';
}

export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return cleaned || 'file';
}

export interface ValidatedUpload {
  name: string;
  mime: string;
  kind: FileKind;
  inline: boolean;
}

export function validateUpload(name: string, bytes: Uint8Array): ValidatedUpload {
  const safeName = sanitizeFileName(name);
  const rule = TYPE_RULES[extensionOf(safeName)];
  if (!rule) throw unsupportedMedia(`Files of this type are not supported (${extensionOf(safeName) || 'no extension'})`);
  if (bytes.byteLength === 0) throw badRequest('The file is empty', undefined, 'EMPTY_FILE');
  if (bytes.byteLength > LIMITS.fileMaxBytes) throw tooLarge(`Files can be at most ${Math.round(LIMITS.fileMaxBytes / 1048576)} MB`);
  if (rule.sniff) {
    if (!rule.sniff(bytes)) throw unsupportedMedia('The file content does not match its extension');
  } else if (rule.kind === 'text') {
    try {
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, 65536));
    } catch {
      // A multi-byte character may have been cut at the 64 KB boundary: tolerate up to 3 trailing bytes.
      try {
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, Math.min(bytes.byteLength, 65536) - 3));
      } catch {
        throw unsupportedMedia('Text files must be UTF-8 encoded');
      }
    }
  }
  return { name: safeName, mime: rule.mime, kind: rule.kind, inline: rule.inline };
}

export async function storeFile(
  env: Env,
  ownerId: string,
  name: string,
  bytes: Uint8Array,
  opts: { source?: 'upload' | 'ai'; forceMime?: string; kind?: FileKind } = {},
): Promise<FileRow> {
  const v = opts.source === 'ai' ? { name: sanitizeFileName(name), mime: opts.forceMime ?? 'application/octet-stream', kind: opts.kind ?? 'other' } : validateUpload(name, bytes);
  const id = newId(ID_PREFIX.file);
  const key = `u/${ownerId}/${id}`;
  const now = Date.now();
  const sha = await sha256Hex(bytes);
  const store = fileStore(env);
  await store.put(key, bytes, { mime: v.mime, owner: ownerId }); // every upload lands in the hot tier
  try {
    await env.DB.prepare(
      `INSERT INTO files (id, owner_id, r2_key, name, mime, size, sha256, kind, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, ownerId, key, v.name, v.mime, bytes.byteLength, sha, v.kind, opts.source ?? 'upload', now)
      .run();
  } catch (err) {
    await env.FILES.delete(key).catch(() => undefined);
    throw err;
  }
  return {
    id,
    owner_id: ownerId,
    r2_key: key,
    name: v.name,
    mime: v.mime,
    size: bytes.byteLength,
    sha256: sha,
    kind: v.kind,
    category: null,
    conversation_id: null,
    message_id: null,
    source: opts.source ?? 'upload',
    created_at: now,
    deleted_at: null,
    tier: 'r2',
    drive_id: null,
    tier_changed_at: null,
    purged_at: null,
  };
}

export { fileToDto };
