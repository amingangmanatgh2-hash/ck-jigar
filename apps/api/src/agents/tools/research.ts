import { z } from 'zod';
import { ToolError, clip, type Availability, type ToolDef } from './types';

/* ------------------------------------------------------------------------------------------------ compose (LLM glue between steps) */

const compose = z.object({ instruction: z.string().trim().min(1).max(3000), material: z.string().max(24_000).optional() });

export const composeTool: ToolDef<z.infer<typeof compose>> = {
  id: 'compose',
  title: { fa: 'نگارش متن', en: 'Write text' },
  description:
    'Write or transform text with the language model (summary, translation, draft, announcement). Pass the material to work on via {{step.N.text}} references. Use it to produce text that a later step (like message_send) needs.',
  argsHint: '{"instruction": string, "material"?: string (may contain {{step.N.text}})}',
  timeoutMs: 100_000,
  risk: 'read',
  schema: compose,
  runKinds: ['chat', 'task', 'assist'],
  async run(ctx, a) {
    const out = await ctx.chat({
      role: 'chat',
      purpose: 'tool',
      modelId: ctx.run.model_id,
      maxTokens: 1500,
      messages: [
        {
          role: 'system',
          content:
            'You write text for the user exactly as instructed. Output ONLY the requested text (no preface, no explanations). Use the language of the instruction unless another language is requested. Use only facts from the material; never invent details.',
        },
        { role: 'user', content: `Instruction: ${a.instruction}${a.material ? `\n\nMaterial:\n${a.material}` : ''}` },
      ],
    });
    return { text: clip(out.text, 6000), data: { model: out.modelId } };
  },
};

/* ------------------------------------------------------------------------------------------------ web_search (only when a provider is configured) */

const webSearch = z.object({ query: z.string().trim().min(2).max(200), limit: z.coerce.number().int().min(1).max(8).optional() });

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export function searchProvider(env: { SEARCH_PROVIDER?: string; SEARCH_API_KEY?: string }): 'brave' | 'tavily' | null {
  const p = (env.SEARCH_PROVIDER ?? '').toLowerCase();
  if (!env.SEARCH_API_KEY) return null;
  return p === 'brave' || p === 'tavily' ? p : null;
}

export const webSearchTool: ToolDef<z.infer<typeof webSearch>> = {
  id: 'web_search',
  title: { fa: 'جستجوی وب', en: 'Web search' },
  description: 'Search the web and return numbered sources (title, URL, snippet). Cite them as [n] in the answer.',
  argsHint: '{"query": string, "limit"?: number (default 5)}',
  risk: 'read',
  schema: webSearch,
  async available(env): Promise<Availability> {
    return searchProvider(env) ? { ok: true } : { ok: false, reason: 'No web-search provider is connected (set SEARCH_PROVIDER and SEARCH_API_KEY)' };
  },
  async run(ctx, a) {
    const provider = searchProvider(ctx.env);
    if (!provider) throw new ToolError('SEARCH_NOT_CONNECTED', 'Web search is not connected.');
    const limit = a.limit ?? 5;
    let hits: SearchHit[] = [];
    try {
      if (provider === 'brave') {
        const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(a.query)}&count=${limit}`;
        const res = await ctx.fetch(url, { headers: { Accept: 'application/json', 'X-Subscription-Token': ctx.env.SEARCH_API_KEY! }, signal: ctx.signal });
        if (!res.ok) throw new ToolError('SEARCH_FAILED', `The search provider answered ${res.status}.`, { retryable: res.status >= 500 || res.status === 429 });
        const json = (await res.json()) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
        hits = (json.web?.results ?? []).map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: (r.description ?? '').replace(/<[^>]+>/g, '') }));
      } else {
        const res = await ctx.fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.env.SEARCH_API_KEY}` },
          body: JSON.stringify({ query: a.query, max_results: limit, search_depth: 'basic' }),
          signal: ctx.signal,
        });
        if (!res.ok) throw new ToolError('SEARCH_FAILED', `The search provider answered ${res.status}.`, { retryable: res.status >= 500 || res.status === 429 });
        const json = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
        hits = (json.results ?? []).map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: r.content ?? '' }));
      }
    } catch (err) {
      if (err instanceof ToolError) throw err;
      throw new ToolError('SEARCH_FAILED', 'The web search request failed.', { retryable: true });
    }
    hits = hits.filter((h) => /^https?:\/\//.test(h.url)).slice(0, limit);
    if (hits.length === 0) return { text: 'The search returned no results.', data: [] };
    return {
      text: hits.map((h, i) => `[${i + 1}] ${h.title} — ${h.url}\n${clip(h.snippet, 400)}`).join('\n\n'),
      data: hits.map((h, i) => ({ n: i + 1, title: h.title, url: h.url })),
    };
  },
};
