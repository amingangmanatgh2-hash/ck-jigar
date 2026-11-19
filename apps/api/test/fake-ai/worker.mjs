/**
 * TEST DOUBLE for the Cloudflare Workers AI binding — used ONLY by the Vitest integration tests
 * (wired as the `AI` service binding in vitest.config.ts). It is never part of the Worker bundle,
 * never deployed, and never reachable from the dev server or the production configuration.
 *
 * Behaviour is scripted per test through rules, so tests can assert exactly what the application
 * sent to the model (prompts, parameters, model ids) and how it reacts to answers and failures.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';

let rules = [];
let calls = [];
let catalog = null;

const enc = new TextEncoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const textOf = (content) =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => (p.type === 'text' ? p.text : '[image]')).join(' ') : '';

function describe(model, inputs, options) {
  const messages = Array.isArray(inputs?.messages) ? inputs.messages : [];
  const tag = (options?.tags ?? []).find((t) => t.startsWith('purpose:'));
  const system = messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n');
  const users = messages.filter((m) => m.role === 'user');
  const user = users.length ? textOf(users[users.length - 1].content) : '';
  const all = messages.map((m) => textOf(m.content)).join('\n');
  const hasImage = messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
  return { model, purpose: tag ? tag.slice(8) : null, system, user, all, hasImage, messages, inputs, options };
}

function matches(when, d) {
  if (!when) return true;
  if (when.model && d.model !== when.model) return false;
  if (when.notModel && d.model === when.notModel) return false;
  if (when.purpose && d.purpose !== when.purpose) return false;
  if (when.system && !d.system.includes(when.system)) return false;
  if (when.user && !d.user.includes(when.user)) return false;
  if (when.any && !d.all.includes(when.any)) return false;
  if (when.hasImage !== undefined && d.hasImage !== when.hasImage) return false;
  return true;
}

function sse(obj) {
  return enc.encode('data: ' + (typeof obj === 'string' ? obj : JSON.stringify(obj)) + '\n\n');
}

function pieces(text) {
  const chars = Array.from(text);
  const out = [];
  for (let i = 0; i < chars.length; i += 4) out.push(chars.slice(i, i + 4).join(''));
  return out;
}

export class FakeAI extends WorkerEntrypoint {
  async setRules(newRules) {
    rules = (newRules ?? []).map((r) => ({ ...r, used: 0 }));
    calls = [];
    return true;
  }
  async getCalls() {
    return calls.map(({ model, purpose, system, user, all, hasImage, inputs }) => ({ model, purpose, system, user, all, hasImage, inputs }));
  }
  async clearCalls() {
    calls = [];
    return true;
  }
  async setCatalog(names) {
    catalog = names;
    return true;
  }
  async models(params) {
    if (catalog === null) throw new Error('catalog unsupported');
    const page = params?.page ?? 1;
    const per = params?.per_page ?? 100;
    return catalog.slice((page - 1) * per, page * per).map((name, i) => ({ id: 'uuid-' + i, name, task: { name: 'Text Generation' } }));
  }

  async toMarkdown(files) {
    return Promise.all(
      files.map(async (f) => {
        if (f.name.endsWith('.fail')) return { id: 'x', name: f.name, mimeType: f.blob.type, format: 'error', error: 'unsupported format' };
        const body = await f.blob.text();
        return { id: 'x', name: f.name, mimeType: f.blob.type, format: 'markdown', tokens: Math.ceil(body.length / 4), data: '# ' + f.name + '\n\n' + body };
      }),
    );
  }

  async run(model, inputs, options) {
    const d = describe(model, inputs, options);
    calls.push(d);

    // ---- speech to text / image generation
    if (model.includes('whisper')) {
      const r = rules.find((x) => x.respond?.asr !== undefined && matches(x.when, d));
      if (r?.respond.error) throw new Error(r.respond.error);
      return { text: r?.respond.asr ?? '', word_count: 1 };
    }
    if (model.includes('flux')) {
      const r = rules.find((x) => x.respond?.image !== undefined && matches(x.when, d));
      if (r?.respond.error) throw new Error(r.respond.error);
      // PNG signature followed by padding, so that it is recognised as an image and passes the size check
      const bytes = new Uint8Array(300);
      bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      return { image: btoa(bin) };
    }

    // ---- chat
    const rule = rules.find((x) => (x.times === undefined || x.used < x.times) && x.respond?.asr === undefined && x.respond?.image === undefined && matches(x.when, d));
    if (rule) rule.used++;
    const resp = rule?.respond ?? { text: 'default fake answer' };
    if (resp.delayMs) await sleep(resp.delayMs);
    if (resp.error && !resp.failAfterChunks) throw new Error(resp.error);

    const text = resp.json !== undefined ? JSON.stringify(resp.json) : (resp.text ?? '');
    const usage = resp.noUsage ? undefined : { prompt_tokens: resp.usage?.prompt ?? 11, completion_tokens: resp.usage?.completion ?? Math.max(1, Math.ceil(text.length / 4)), total_tokens: 0 };
    const legacy = resp.legacy === true || (resp.legacy === undefined && model.includes('llama'));

    if (inputs?.stream && !resp.noStream) {
      let cancelled = false;
      return new ReadableStream({
        async start(c) {
          const send = (obj) => {
            if (!cancelled) c.enqueue(sse(obj));
          };
          const parts = pieces(text);
          let n = 0;
          for (const p of parts) {
            if (cancelled) return;
            if (resp.failAfterChunks !== undefined && n >= resp.failAfterChunks) {
              send({ error: { message: resp.error } });
              c.close();
              return;
            }
            send(legacy ? { response: p } : { choices: [{ index: 0, delta: { content: p } }] });
            n++;
            if (resp.chunkDelayMs) await sleep(resp.chunkDelayMs);
          }
          if (cancelled) return;
          if (resp.failAfterChunks !== undefined) {
            send({ error: { message: resp.error } });
            c.close();
            return;
          }
          if (usage && !legacy) send({ choices: [], usage });
          if (usage && legacy) send({ response: '', usage });
          send('[DONE]');
          c.close();
        },
        cancel() {
          cancelled = true;
        },
      });
    }
    return legacy ? { response: text, ...(usage ? { usage } : {}) } : { choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], ...(usage ? { usage } : {}) };
  }
}

export default { fetch: () => new Response('fake workers ai') };
