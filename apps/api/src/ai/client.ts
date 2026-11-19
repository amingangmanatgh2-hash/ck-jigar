import type { ModelRole } from '@aminchat/shared';
import type { Env } from '../env';
import { AppError, unavailable } from '../lib/errors';
import { SseParser } from '../lib/sse';
import { estimateTokens, stripThinking } from '../lib/text';
import { AiError, classifyAiError, shouldFallback, userFacingAiError } from './errors';
import { isBlocked, loadHealth, recordCallOutcome } from './health';
import {
  SELECTABLE_CHAT_MODELS,
  getModel,
  isDeprecated,
  rolePriority,
  type ModelSpec,
  type Purpose,
} from './models';
import { ThinkFilter, normalizeChatResult, parseStreamData, type Usage } from './normalize';
import { assertWithinQuota, recordUsage } from './usage';

export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

export interface ChatRequest {
  userId: string;
  runId?: string | null;
  role: ModelRole;
  purpose: Purpose;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Explicit user choice; only honoured if it is a registered, non-deprecated, non-unavailable chat model. */
  modelId?: string | null;
  needsVision?: boolean;
  signal?: AbortSignal;
  /** Overall deadline for a non-streaming call, or for the time to the first token when streaming. */
  timeoutMs?: number;
  /** When streaming: maximum silence between two chunks. */
  idleMs?: number;
}

export interface ChatOutcome {
  text: string;
  modelId: string;
  usage: Usage & { estimated: boolean };
  fallbackFrom: string | null;
  latencyMs: number;
}

const DEFAULT_MAX_TOKENS: Record<Purpose, number> = {
  chat: 3000,
  assist: 1800,
  plan: 1200,
  args: 900,
  route: 200,
  title: 48,
  memory: 500,
  tool: 1200,
  health: 24,
  vision: 600,
  asr: 0,
  image: 0,
  summary: 1500,
};

type RunFn = (id: string, input: unknown, options?: unknown) => Promise<unknown>;

function messagesText(messages: ChatMessage[]): string {
  return messages
    .map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '[image]')).join(' ')))
    .join('\n');
}

function linkSignals(signal: AbortSignal | undefined, timeoutMs: number | undefined): { signal: AbortSignal; dispose: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timeout = false;
  const onAbort = () => controller.abort(signal?.reason ?? new Error('aborted'));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  if (timeoutMs) {
    timer = setTimeout(() => {
      timeout = true;
      controller.abort(new Error('timeout: model did not answer in time'));
    }, timeoutMs);
  }
  return {
    signal: controller.signal,
    dispose: () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
    timedOut: () => timeout,
  };
}

/** Rejects as soon as `linked.signal` aborts, whichever way the underlying call ends up. */
function raceAbort<T>(p: Promise<T>, linked: { signal: AbortSignal; timedOut: () => boolean }, modelId: string): Promise<T> {
  const err = () => (linked.timedOut() ? new AiError('timeout', 'The model did not answer in time', modelId) : new AiError('aborted', 'cancelled', modelId));
  if (linked.signal.aborted) {
    p.catch(() => undefined);
    return Promise.reject(err());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      p.catch(() => undefined);
      reject(err());
    };
    linked.signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        linked.signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        linked.signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

export class AiClient {
  constructor(private readonly env: Env) {}

  get connected(): boolean {
    return !!this.env.AI;
  }

  private run(): RunFn {
    if (!this.env.AI) {
      throw unavailable(
        'Workers AI is not connected in this environment. Deploy to Cloudflare (or run `npm run dev:api:ai` after `wrangler login`) to use AMIN AI.',
        'AI_NOT_CONNECTED',
      );
    }
    return (id, input, options) => (this.env.AI as unknown as { run: RunFn }).run(id, input, options);
  }

  /**
   * Binding options. The AbortSignal is deliberately NOT forwarded: cancellation is implemented by racing the call
   * (and cancelling the response stream), which works identically for the real binding and for RPC-based test doubles.
   */
  private options(purpose: Purpose): Record<string, unknown> {
    const o: Record<string, unknown> = { tags: ['amin-chat', `purpose:${purpose}`] };
    if (this.env.AI_GATEWAY_ID) o.gateway = { id: this.env.AI_GATEWAY_ID };
    return o;
  }

  /** Ordered list of models to try for this request (explicit choice first, then the role's priority list). */
  async candidates(req: Pick<ChatRequest, 'role' | 'modelId' | 'needsVision'>): Promise<ModelSpec[]> {
    const health = await loadHealth(this.env);
    const usable = (m: ModelSpec) => !isDeprecated(m) && !isBlocked(health.get(m.id));
    let list = rolePriority(req.role);
    if (req.needsVision) {
      const vision = list.filter((m) => m.capabilities.vision);
      list = vision.length > 0 ? vision : rolePriority('vision');
    }
    const ordered: ModelSpec[] = [];
    if (req.modelId) {
      const chosen = getModel(req.modelId);
      if (chosen && SELECTABLE_CHAT_MODELS.includes(chosen.id) && usable(chosen) && (!req.needsVision || chosen.capabilities.vision)) ordered.push(chosen);
    }
    for (const m of list) if (!ordered.includes(m)) ordered.push(m);
    const filtered = ordered.filter(usable);
    // If every model was recently marked unavailable the verdicts may simply be stale: try them anyway rather than fail blind.
    return filtered.length > 0 ? filtered : ordered;
  }

  private buildInput(spec: ModelSpec, req: ChatRequest, tuned: boolean, stream: boolean): Record<string, unknown> {
    const input: Record<string, unknown> = {
      messages: req.messages,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS[req.purpose],
      temperature: req.temperature ?? (req.purpose === 'chat' || req.purpose === 'assist' ? 0.6 : 0.2),
    };
    if (tuned && spec.tune) Object.assign(input, spec.tune(req.purpose));
    if (stream) {
      input.stream = true;
      if (spec.api === 'chat') input.stream_options = { include_usage: true };
    }
    return input;
  }

  /* ------------------------------------------------------------------------------------------------ chat */

  async chat(req: ChatRequest): Promise<ChatOutcome> {
    return this.execute(req, false);
  }

  /** Streams visible text through `onDelta` and resolves with the complete outcome. */
  async chatStream(req: ChatRequest, onDelta: (text: string) => void | Promise<void>): Promise<ChatOutcome> {
    return this.execute(req, true, onDelta);
  }

  private async execute(req: ChatRequest, stream: boolean, onDelta?: (t: string) => void | Promise<void>): Promise<ChatOutcome> {
    const run = this.run();
    await assertWithinQuota(this.env, req.userId);
    const models = await this.candidates(req);
    if (models.length === 0) throw unavailable('No AI model is configured for this task.', 'AI_NO_MODEL');

    let firstChoice = models[0]!.id;
    let lastError: AiError | null = null;
    const promptTokensEstimate = estimateTokens(messagesText(req.messages));

    for (const spec of models) {
      let emitted = false;
      let streamed = '';
      let tuned = true;
      for (let attempt = 0; attempt < 2; attempt++) {
        streamed = '';
        const started = Date.now();
        const linked = linkSignals(req.signal, req.timeoutMs ?? (stream ? 60_000 : 90_000));
        try {
          const input = this.buildInput(spec, req, tuned, stream);
          const raw = await raceAbort(run(spec.id, input, this.options(req.purpose)), linked, spec.id);
          let text = '';
          let usage: Usage | null = null;
          if (stream && raw instanceof ReadableStream) {
            // First-token deadline is over once the stream object exists; from now on only idle time matters.
            linked.dispose();
            const res = await this.consumeStream(raw as ReadableStream<Uint8Array>, req, async (t) => {
              emitted = true;
              streamed += t;
              await onDelta?.(t);
            });
            text = res.text;
            usage = res.usage;
          } else {
            const norm = normalizeChatResult(raw);
            text = stripThinking(norm.text).trim();
            usage = norm.usage;
            if (stream && text) {
              emitted = true;
              await onDelta?.(text);
            }
          }
          linked.dispose();
          if (!text.trim()) throw new AiError('empty', 'The model returned an empty answer', spec.id);

          const latencyMs = Date.now() - started;
          const estimated = !usage;
          const finalUsage = usage ?? { input: promptTokensEstimate, output: estimateTokens(text) };
          const isFallback = spec.id !== firstChoice;
          await recordUsage(this.env, {
            userId: req.userId,
            runId: req.runId,
            modelId: spec.id,
            role: req.role,
            purpose: req.purpose,
            inputTokens: finalUsage.input,
            outputTokens: finalUsage.output,
            estimated,
            latencyMs,
            status: isFallback ? 'fallback' : 'ok',
          });
          await recordCallOutcome(this.env, spec, true, undefined, latencyMs);
          return { text, modelId: spec.id, usage: { ...finalUsage, estimated }, fallbackFrom: isFallback ? firstChoice : null, latencyMs };
        } catch (raw) {
          linked.dispose();
          let err = classifyAiError(raw, spec.id);
          if (linked.timedOut() && err.kind === 'aborted') err = new AiError('timeout', 'The model did not answer in time', spec.id);
          // Whatever shape the failure took (a cancelled stream rejects its pending read in different ways), a request the caller
          // cancelled is a cancellation — not a model error, and not a reason to try another model.
          if (req.signal?.aborted && !linked.timedOut()) err = new AiError('aborted', 'cancelled', spec.id);
          if (err.kind === 'aborted') {
            // The model may already have produced (and billed) part of the answer: count it, but never as an error.
            if (streamed.trim()) {
              await recordUsage(this.env, {
                userId: req.userId,
                runId: req.runId,
                modelId: spec.id,
                role: req.role,
                purpose: req.purpose,
                inputTokens: promptTokensEstimate,
                outputTokens: estimateTokens(streamed),
                estimated: true,
                latencyMs: Date.now() - started,
                status: spec.id !== firstChoice ? 'fallback' : 'ok',
              });
            }
            throw userFacingAiError(err);
          }
          await recordUsage(this.env, {
            userId: req.userId,
            runId: req.runId,
            modelId: spec.id,
            role: req.role,
            purpose: req.purpose,
            inputTokens: 0,
            outputTokens: 0,
            estimated: true,
            latencyMs: Date.now() - started,
            status: 'error',
            errorCode: err.kind,
          });
          // Tuning parameters (reasoning effort, thinking switch) are model-specific: if the model rejects them, retry plain.
          if (err.kind === 'bad_request' && tuned && spec.tune && attempt === 0) {
            tuned = false;
            continue;
          }
          await recordCallOutcome(this.env, spec, false, err);
          lastError = err;
          // Once text reached the user we cannot silently switch models.
          if (emitted) throw userFacingAiError(err);
          if (!shouldFallback(err.kind)) throw userFacingAiError(err);
          break;
        }
      }
    }
    throw userFacingAiError(lastError ?? new AiError('unknown', 'No model answered'));
  }

  private async consumeStream(
    stream: ReadableStream<Uint8Array>,
    req: ChatRequest,
    emit: (t: string) => Promise<void>,
  ): Promise<{ text: string; usage: Usage | null }> {
    const reader = stream.getReader();
    const parser = new SseParser();
    const filter = new ThinkFilter();
    const idleMs = req.idleMs ?? 45_000;
    let full = '';
    let usage: Usage | null = null;
    let finished = false;

    const onAbort = () => reader.cancel().catch(() => undefined);
    req.signal?.addEventListener('abort', onAbort, { once: true });

    const handle = async (data: string) => {
      const piece = parseStreamData(data);
      if (!piece) return;
      if (piece.error) throw classifyAiError(new Error(piece.error));
      if (piece.usage) usage = piece.usage;
      if (piece.done) finished = true;
      if (piece.text) {
        const visible = filter.push(piece.text);
        if (visible) {
          full += visible;
          await emit(visible);
        }
      }
    };

    try {
      while (!finished) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new AiError('timeout', 'The model stopped streaming')), idleMs);
          }),
        ]).finally(() => timer && clearTimeout(timer));
        if (req.signal?.aborted) throw new AiError('aborted', 'cancelled');
        if (result.done) break;
        for (const ev of parser.feed(result.value)) await handle(ev.data);
      }
      for (const ev of parser.end()) await handle(ev.data);
      const tail = filter.end();
      if (tail) {
        full += tail;
        await emit(tail);
      }
    } catch (err) {
      await reader.cancel().catch(() => undefined);
      throw req.signal?.aborted ? new AiError('aborted', 'cancelled') : err;
    } finally {
      req.signal?.removeEventListener('abort', onAbort);
      reader.releaseLock?.();
    }
    return { text: full.trim(), usage };
  }

  /* ------------------------------------------------------------------------------------------------ non-chat models */

  /** Speech to text. Returns the transcript. */
  async transcribe(userId: string, bytes: Uint8Array, opts: { language?: string; runId?: string | null; signal?: AbortSignal } = {}): Promise<{ text: string; modelId: string }> {
    const run = this.run();
    await assertWithinQuota(this.env, userId);
    const health = await loadHealth(this.env);
    const models = rolePriority('asr').filter((m) => !isDeprecated(m) && !isBlocked(health.get(m.id)));
    if (models.length === 0) throw unavailable('No speech-to-text model is available.', 'AI_NO_MODEL');
    let last: AiError | null = null;
    for (const spec of models) {
      const started = Date.now();
      const linked = linkSignals(opts.signal, 90_000);
      try {
        const input: Record<string, unknown> = { audio: bytesToBase64(bytes), task: 'transcribe', vad_filter: true };
        if (opts.language) input.language = opts.language;
        const raw = (await raceAbort(run(spec.id, input, this.options('asr')), linked, spec.id)) as { text?: string; transcription_info?: unknown };
        linked.dispose();
        const text = String(raw?.text ?? '').trim();
        if (!text) throw new AiError('empty', 'No speech was recognised in the audio', spec.id);
        await recordUsage(this.env, {
          userId, runId: opts.runId, modelId: spec.id, role: 'asr', purpose: 'asr', inputTokens: 0, outputTokens: estimateTokens(text), estimated: true,
          latencyMs: Date.now() - started, status: 'ok',
        });
        await recordCallOutcome(this.env, spec, true, undefined, Date.now() - started);
        return { text, modelId: spec.id };
      } catch (raw) {
        linked.dispose();
        const err = classifyAiError(raw, spec.id);
        await recordUsage(this.env, { userId, runId: opts.runId, modelId: spec.id, role: 'asr', purpose: 'asr', inputTokens: 0, outputTokens: 0, estimated: true, latencyMs: Date.now() - started, status: 'error', errorCode: err.kind });
        await recordCallOutcome(this.env, spec, false, err);
        last = err;
        if (err.kind === 'aborted' || err.kind === 'empty') throw err.kind === 'empty' ? new AppError(422, 'NO_SPEECH', err.message) : userFacingAiError(err);
      }
    }
    throw userFacingAiError(last ?? new AiError('unknown', 'No model answered'));
  }

  /** Text to image. Returns the image bytes. */
  async generateImage(userId: string, prompt: string, opts: { runId?: string | null; signal?: AbortSignal } = {}): Promise<{ bytes: Uint8Array; mime: string; modelId: string }> {
    const run = this.run();
    await assertWithinQuota(this.env, userId);
    const health = await loadHealth(this.env);
    const models = rolePriority('image').filter((m) => !isDeprecated(m) && !isBlocked(health.get(m.id)));
    if (models.length === 0) throw unavailable('No image-generation model is available.', 'AI_NO_MODEL');
    let last: AiError | null = null;
    for (const spec of models) {
      const started = Date.now();
      const linked = linkSignals(opts.signal, 90_000);
      try {
        const raw = (await raceAbort(run(spec.id, { prompt, steps: 6 }, this.options('image')), linked, spec.id)) as { image?: string } | ReadableStream | Uint8Array;
        linked.dispose();
        let bytes: Uint8Array;
        if (raw instanceof Uint8Array) bytes = raw;
        else if (raw instanceof ReadableStream) bytes = new Uint8Array(await new Response(raw).arrayBuffer());
        else if (typeof (raw as { image?: string })?.image === 'string') bytes = base64ToBytes((raw as { image: string }).image);
        else throw new AiError('empty', 'The image model returned no image', spec.id);
        if (bytes.byteLength < 100) throw new AiError('empty', 'The image model returned no image', spec.id);
        await recordUsage(this.env, { userId, runId: opts.runId, modelId: spec.id, role: 'image', purpose: 'image', inputTokens: estimateTokens(prompt), outputTokens: 0, estimated: true, latencyMs: Date.now() - started, status: 'ok' });
        await recordCallOutcome(this.env, spec, true, undefined, Date.now() - started);
        return { bytes, mime: sniffImageMime(bytes), modelId: spec.id };
      } catch (raw) {
        linked.dispose();
        const err = classifyAiError(raw, spec.id);
        await recordUsage(this.env, { userId, runId: opts.runId, modelId: spec.id, role: 'image', purpose: 'image', inputTokens: 0, outputTokens: 0, estimated: true, latencyMs: Date.now() - started, status: 'error', errorCode: err.kind });
        await recordCallOutcome(this.env, spec, false, err);
        last = err;
        if (err.kind === 'aborted') throw userFacingAiError(err);
      }
    }
    throw userFacingAiError(last ?? new AiError('unknown', 'No model answered'));
  }

  /** Converts documents (PDF, Office, HTML, images with text …) to Markdown with Workers AI `toMarkdown`. */
  async toMarkdown(name: string, blob: Blob): Promise<{ text: string; tokens: number }> {
    if (!this.env.AI) throw unavailable('Workers AI is not connected in this environment.', 'AI_NOT_CONNECTED');
    const ai = this.env.AI as unknown as { toMarkdown(files: { name: string; blob: Blob }[]): Promise<{ format: string; data?: string; error?: string; tokens?: number }[]> };
    const [res] = await ai.toMarkdown([{ name, blob }]);
    if (!res || res.format === 'error') throw new AppError(422, 'CONVERSION_FAILED', `The document could not be converted: ${res?.error ?? 'unknown error'}`);
    return { text: String(res.data ?? ''), tokens: Number(res.tokens ?? 0) };
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/^data:[^,]+,/, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function sniffImageMime(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x52 && b[1] === 0x49) return 'image/webp';
  return 'image/jpeg';
}
