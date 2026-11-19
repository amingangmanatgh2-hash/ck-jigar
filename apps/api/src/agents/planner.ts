import { z } from 'zod';
import type { ChatRequest, ChatOutcome } from '../ai/client';
import { RUN_LIMITS } from '../config/limits';
import { extractJson, truncate } from '../lib/text';
import { UNTRUSTED_CONTENT_RULE, nowBlock, type PromptUser } from './prompts';
import { AGENTS, CONCRETE_AGENT_IDS, type AgentDef, type ConcreteAgentId } from './registry';
import type { ToolDef } from './tools/types';

export type ChatFn = (req: Omit<ChatRequest, 'userId' | 'runId' | 'signal'>) => Promise<ChatOutcome>;

/* ------------------------------------------------------------------------------------------------ router */

const RULES: [ConcreteAgentId, RegExp][] = [
  ['personal', /remind|reminder|todo|to-do|task|schedule|deadline|plan my|milestone|یادآور|یادم\s*بنداز|یادآوری|کارها|وظیفه|لیست\s*کار|فهرست\s*کار|برنامه‌?ریزی|پروژه|مهلت/i],
  ['coder', /```|function\b|stack\s*trace|exception|compile|refactor|\bbug\b|\bapi\b|regex|typescript|javascript|python|sql\b|کد\b|برنامه‌?نویس|باگ|خطا.*(کد|برنامه)|الگوریتم/i],
  ['messenger', /send (a )?message|text (him|her|them)|announce|poll\b|reply to|draft (a )?(message|reply)|پیام\s*(بده|بفرست|ارسال)|ارسال|اطلاعیه|نظرسنجی|پاسخ\s*پیشنهاد|گروه|چت/i],
  ['file', /\bfile\b|\bpdf\b|spreadsheet|document|attachment|categori[sz]e|فایل|سند|پیوست|دسته‌?بندی/i],
  ['creative', /\bimage\b|\bpicture\b|draw|story|poem|slogan|lyrics|logo|عکس|تصویر|نقاشی|داستان|شعر|شعار|خلاق/i],
  ['research', /research|compare|comparison|sources?|citation|report|literature|پژوهش|تحقیق|مقایسه|منبع|گزارش/i],
];

export function heuristicAgent(text: string): ConcreteAgentId {
  for (const [id, re] of RULES) if (re.test(text)) return id;
  return 'general';
}

export async function routeAgent(
  chat: ChatFn,
  o: { text: string; hasAttachments: boolean; recent: string },
): Promise<{ agent: ConcreteAgentId; reason: string; viaLlm: boolean }> {
  const catalog = CONCRETE_AGENT_IDS.map((id) => `- ${id}: ${AGENTS[id].description.en}`).join('\n');
  try {
    const out = await chat({
      role: 'fast',
      purpose: 'route',
      maxTokens: 120,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            `You route requests inside the AMIN AI assistant to the best specialist agent.\nAgents:\n${catalog}\n` +
            'Reply with ONLY a JSON object: {"agent": "<agent id>", "reason": "<max 12 words>"}. Choose "general" for ordinary questions, chat, translation and writing.',
        },
        { role: 'user', content: `${o.recent ? `Recent conversation:\n${o.recent}\n\n` : ''}Latest request${o.hasAttachments ? ' (the user attached files)' : ''}:\n${truncate(o.text, 1500)}` },
      ],
    });
    const json = extractJson(out.text) as { agent?: string; reason?: string } | undefined;
    const agent = json?.agent && (CONCRETE_AGENT_IDS as string[]).includes(json.agent) ? (json.agent as ConcreteAgentId) : null;
    if (agent) return { agent, reason: String(json?.reason ?? '').slice(0, 120), viaLlm: true };
  } catch {
    // fall through to the heuristic: routing must never block an answer
  }
  return { agent: heuristicAgent(o.text), reason: 'keyword routing', viaLlm: false };
}

/* ------------------------------------------------------------------------------------------------ planner */

const planSchema = z.object({
  summary: z.string().max(400).optional().default(''),
  steps: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        tool: z.string().trim().min(1).max(60),
        args: z.record(z.string(), z.unknown()).optional().default({}),
        deferred: z.boolean().optional().default(false),
      }),
    )
    .max(RUN_LIMITS.maxSteps),
});

export interface PlannedStep {
  title: string;
  tool: string;
  args: Record<string, unknown>;
  /** Arguments depend on the output of earlier steps (ids, lists): they are generated right before the step runs. */
  deferred: boolean;
}
export interface Plan {
  summary: string;
  steps: PlannedStep[];
}

const TEMPLATE_RE = /\{\{\s*step\.(\d+)\.text\s*\}\}/g;

function collectRefs(value: unknown, out: number[]): void {
  if (typeof value === 'string') for (const m of value.matchAll(TEMPLATE_RE)) out.push(Number(m[1]));
  else if (Array.isArray(value)) value.forEach((v) => collectRefs(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectRefs(v, out));
}

/** Returns a list of problems that make a plan unusable (empty = valid). */
export function validatePlan(plan: Plan, tools: ToolDef[]): string[] {
  const problems: string[] = [];
  const ids = new Set(tools.map((t) => t.id));
  plan.steps.forEach((s, i) => {
    if (!ids.has(s.tool)) problems.push(`Step ${i + 1} uses the unknown or unavailable tool "${s.tool}". Allowed tools: ${[...ids].join(', ')}.`);
    const refs: number[] = [];
    collectRefs(s.args, refs);
    for (const r of refs) if (r < 1 || r > i) problems.push(`Step ${i + 1} references {{step.${r}.text}} but may only reference earlier steps (1..${i}).`);
  });
  return problems;
}

/** Replaces {{step.K.text}} with the (bounded) text output of step K (1-based). */
export function resolveTemplates(value: unknown, outputs: Map<number, string>, maxLen = 12_000): unknown {
  if (typeof value === 'string') return value.replace(TEMPLATE_RE, (_, k: string) => (outputs.get(Number(k)) ?? '').slice(0, maxLen));
  if (Array.isArray(value)) return value.map((v) => resolveTemplates(v, outputs, maxLen));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveTemplates(v, outputs, maxLen)]));
  return value;
}

export async function planSteps(
  chat: ChatFn,
  o: { agent: AgentDef; tools: ToolDef[]; user: PromptUser; text: string; recent: string; attachments: string; assist?: boolean },
): Promise<Plan> {
  const catalog = o.tools
    .map((t) => `- ${t.id}${t.risk === 'sensitive' ? ' [needs user approval]' : ''}: ${t.description}\n  args: ${t.argsHint}`)
    .join('\n');
  const system = [
    `You are the planning module of AMIN AI (agent: ${o.agent.id}). Decide whether the user's latest request needs tools, and if so write a short plan.`,
    nowBlock(o.user),
    `Available tools:\n${catalog}`,
    'Reply with ONLY a JSON object: {"summary": "<one sentence>", "steps": [{"title": "<short title in the user\'s language>", "tool": "<tool id>", "args": { ... }, "deferred": false}]}',
    'Rules:',
    '- "steps" MUST be [] when the request is ordinary conversation or can be answered directly from knowledge, or when a required detail is missing (the assistant will ask the user).',
    `- At most ${RUN_LIMITS.maxSteps} steps, executed in order. Use only the listed tools and their argument names.`,
    '- To pass the text result of an earlier step into a later argument, write {{step.K.text}} where K is the 1-based number of that step.',
    '- If a step needs values you can only know after an earlier step ran (for example an id from a list), set "args": {} and "deferred": true; its arguments are then generated from the earlier results.',
    '- Tools marked [needs user approval] are planned only when the user explicitly asked for that action; the user always reviews them before they run.',
    '- Dates and times are the user\'s local time, written YYYY-MM-DD or YYYY-MM-DD HH:mm, computed from the current date above.',
    o.assist ? '- This is a shared chat: actions always target this chat; never plan anything else.' : '',
    `- ${UNTRUSTED_CONTENT_RULE}`,
  ].filter(Boolean).join('\n');

  const userMsg = `${o.recent ? `Recent conversation:\n${o.recent}\n\n` : ''}${o.attachments ? `Attached files:\n${o.attachments}\n\n` : ''}Latest request:\n${truncate(o.text, 3000)}`;

  let feedback = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await chat({
      role: 'fast',
      purpose: 'plan',
      maxTokens: 1400,
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userMsg + feedback },
      ],
    });
    const json = extractJson(out.text);
    const parsed = planSchema.safeParse(json);
    if (!parsed.success) {
      feedback = `\n\nYour previous reply was not a valid plan (${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}). Reply with ONLY the JSON object.`;
      continue;
    }
    const problems = validatePlan(parsed.data, o.tools);
    if (problems.length === 0) return { summary: parsed.data.summary, steps: parsed.data.steps };
    feedback = `\n\nYour previous plan was rejected: ${problems.join(' ')} Fix it and reply with ONLY the JSON object.`;
  }
  throw new Error('PLAN_INVALID');
}


/* ------------------------------------------------------------------------------------------------ argument derivation / repair */

export interface PriorStep {
  idx: number;
  title: string;
  tool: string;
  text: string;
}

/**
 * Produces the arguments of one tool call. Used (a) for steps the planner marked as deferred and
 * (b) as a single repair attempt when planned arguments fail validation.
 */
export async function deriveArgs(
  chat: ChatFn,
  o: { tool: ToolDef; user: PromptUser; request: string; title: string; planned: unknown; previous: PriorStep[]; issues?: string },
): Promise<Record<string, unknown>> {
  const previous = o.previous.length
    ? o.previous.map((p) => `Step ${p.idx + 1} (${p.tool}) "${p.title}" result:\n${truncate(p.text, 3500)}`).join('\n\n')
    : '(no earlier steps)';
  const out = await chat({
    role: 'fast',
    purpose: 'args',
    maxTokens: 900,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content:
          `You produce the JSON arguments for ONE tool call of the AMIN AI assistant.\n${nowBlock(o.user)}\n` +
          `Tool: ${o.tool.id} — ${o.tool.description}\nArguments: ${o.tool.argsHint}\n` +
          'Reply with ONLY a JSON object containing the arguments. Use ids exactly as they appear in the earlier results; never invent ids. Dates are the user\'s local time (YYYY-MM-DD or YYYY-MM-DD HH:mm).\n' +
          UNTRUSTED_CONTENT_RULE,
      },
      {
        role: 'user',
        content:
          `User request:\n${truncate(o.request, 2500)}\n\nThis step: ${o.title}\nPlanned arguments (may be empty or wrong): ${truncate(JSON.stringify(o.planned ?? {}), 1500)}\n\nEarlier results:\n${previous}` +
          (o.issues ? `\n\nThe previous arguments were rejected: ${o.issues}\nFix them.` : ''),
      },
    ],
  });
  const json = extractJson(out.text);
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('ARGS_INVALID');
  return json as Record<string, unknown>;
}
