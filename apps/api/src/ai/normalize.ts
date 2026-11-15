/**
 * Normalisation of Workers AI responses.
 *
 * Workers AI has (at least) two chat response families:
 *  - OpenAI chat-completions shape (newer models):  { choices: [{ message: { content, tool_calls }, finish_reason }], usage }
 *  - legacy shape:                                  { response: string | object, tool_calls: [...], usage }  (or a bare string)
 * Streaming responses are SSE with the corresponding chunk shapes. Everything is converted into one internal format,
 * so the rest of the system never has to care which model answered.
 */

export interface Usage {
  input: number;
  output: number;
}

export interface NormalizedToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface NormalizedChat {
  text: string;
  reasoning: string;
  toolCalls: NormalizedToolCall[];
  finishReason: string | null;
  usage: Usage | null;
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null;

function usageOf(raw: unknown): Usage | null {
  if (!isObj(raw)) return null;
  const u = raw.usage;
  if (!isObj(u)) return null;
  const input = Number(u.prompt_tokens ?? u.input_tokens ?? 0);
  const output = Number(u.completion_tokens ?? u.output_tokens ?? 0);
  if (!Number.isFinite(input) || !Number.isFinite(output) || input + output === 0) return null;
  return { input, output };
}

function parseArgs(args: unknown): unknown {
  if (typeof args !== 'string') return args ?? {};
  try {
    return JSON.parse(args);
  } catch {
    return { _raw: args };
  }
}

function toolCallsOf(list: unknown): NormalizedToolCall[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((tc, i) => {
      if (!isObj(tc)) return null;
      const fn = isObj(tc.function) ? tc.function : tc;
      const name = typeof fn.name === 'string' ? fn.name : '';
      if (!name) return null;
      return { id: typeof tc.id === 'string' ? tc.id : `call_${i}`, name, args: parseArgs(fn.arguments) };
    })
    .filter((x): x is NormalizedToolCall => !!x);
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : isObj(p) && typeof p.text === 'string' ? p.text : ''))
      .join('');
  }
  return '';
}

export function normalizeChatResult(raw: unknown): NormalizedChat {
  if (typeof raw === 'string') return { text: raw, reasoning: '', toolCalls: [], finishReason: null, usage: null };
  if (!isObj(raw)) return { text: '', reasoning: '', toolCalls: [], finishReason: null, usage: null };
  // Some runtimes wrap the payload in { result: ... }.
  if (isObj(raw.result) && !('choices' in raw) && !('response' in raw)) return normalizeChatResult(raw.result);

  const usage = usageOf(raw);
  const choice = Array.isArray(raw.choices) ? raw.choices[0] : undefined;
  if (isObj(choice)) {
    const message = isObj(choice.message) ? choice.message : {};
    return {
      text: contentToText(message.content),
      reasoning: String(message.reasoning_content ?? message.reasoning ?? ''),
      toolCalls: toolCallsOf(message.tool_calls),
      finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
      usage,
    };
  }
  // Responses-API style output (gpt-oss)
  if (Array.isArray(raw.output)) {
    const text = raw.output
      .filter((o: any) => isObj(o) && o.type === 'message')
      .map((o: any) => contentToText(o.content))
      .join('');
    if (text) return { text, reasoning: '', toolCalls: [], finishReason: null, usage };
  }
  // legacy
  let text = '';
  if (typeof raw.response === 'string') text = raw.response;
  else if (isObj(raw.response)) text = JSON.stringify(raw.response); // JSON-mode legacy responses may already be parsed
  else if (typeof raw.output_text === 'string') text = raw.output_text;
  else if (typeof raw.text === 'string') text = raw.text;
  return { text, reasoning: '', toolCalls: toolCallsOf(raw.tool_calls), finishReason: null, usage };
}

/* ------------------------------------------------------------------------------------------------ streaming */

export interface StreamPiece {
  text?: string;
  reasoning?: string;
  toolCallDeltas?: { index: number; id?: string; name?: string; arguments?: string }[];
  usage?: Usage;
  finishReason?: string;
  error?: string;
  done?: boolean;
}

/** Parses one SSE `data:` payload from either response family. Returns null for chunks that carry nothing useful. */
export function parseStreamData(data: string): StreamPiece | null {
  const trimmed = data.trim();
  if (trimmed === '') return null;
  if (trimmed === '[DONE]') return { done: true };
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return null; // partial / keep-alive garbage
  }
  if (!isObj(json)) return null;
  if (isObj(json.error)) return { error: String(json.error.message ?? JSON.stringify(json.error)) };
  if (typeof json.error === 'string') return { error: json.error };

  const piece: StreamPiece = {};
  const usage = usageOf(json);
  if (usage) piece.usage = usage;

  const choice = Array.isArray(json.choices) ? json.choices[0] : undefined;
  if (isObj(choice)) {
    const delta = isObj(choice.delta) ? choice.delta : isObj(choice.message) ? choice.message : {};
    const text = contentToText(delta.content);
    if (text) piece.text = text;
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === 'string' && reasoning) piece.reasoning = reasoning;
    if (Array.isArray(delta.tool_calls)) {
      piece.toolCallDeltas = delta.tool_calls
        .filter(isObj)
        .map((tc: any, i: number) => ({
          index: typeof tc.index === 'number' ? tc.index : i,
          id: typeof tc.id === 'string' ? tc.id : undefined,
          name: isObj(tc.function) && typeof tc.function.name === 'string' ? tc.function.name : undefined,
          arguments: isObj(tc.function) && typeof tc.function.arguments === 'string' ? tc.function.arguments : undefined,
        }));
    }
    if (typeof choice.finish_reason === 'string') piece.finishReason = choice.finish_reason;
  } else if (typeof json.response === 'string') {
    if (json.response) piece.text = json.response;
  }
  return Object.keys(piece).length > 0 ? piece : null;
}

/**
 * Removes <think>…</think> blocks from a token stream. Tags can be split across chunks, so a trailing
 * partial tag is held back until the next chunk decides what it is.
 */
export class ThinkFilter {
  private buf = '';
  private inThink = false;
  /** Reasoning text that was removed (not shown to users). */
  removed = '';

  push(chunk: string): string {
    this.buf += chunk;
    let out = '';
    for (;;) {
      if (this.inThink) {
        const end = this.buf.search(/<\/think>/i);
        if (end === -1) {
          // Keep a possible partial closing tag; discard the rest.
          const keep = this.partialSuffix(this.buf, '</think>');
          this.removed += this.buf.slice(0, this.buf.length - keep);
          this.buf = this.buf.slice(this.buf.length - keep);
          return out;
        }
        this.removed += this.buf.slice(0, end);
        this.buf = this.buf.slice(end + '</think>'.length).replace(/^\s+/, '');
        this.inThink = false;
        continue;
      }
      const start = this.buf.search(/<think>/i);
      if (start === -1) {
        const keep = this.partialSuffix(this.buf, '<think>');
        out += this.buf.slice(0, this.buf.length - keep);
        this.buf = this.buf.slice(this.buf.length - keep);
        return out;
      }
      out += this.buf.slice(0, start);
      this.buf = this.buf.slice(start + '<think>'.length);
      this.inThink = true;
    }
  }

  /** Flush at end of stream (an unterminated <think> block is dropped, a held-back partial tag is plain text). */
  end(): string {
    const rest = this.inThink ? '' : this.buf;
    this.buf = '';
    return rest;
  }

  private partialSuffix(s: string, tag: string): number {
    const lower = s.toLowerCase();
    for (let len = Math.min(tag.length - 1, s.length); len > 0; len--) {
      if (tag.startsWith(lower.slice(lower.length - len))) return len;
    }
    return 0;
  }
}
