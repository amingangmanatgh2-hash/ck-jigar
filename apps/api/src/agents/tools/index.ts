import type { Env } from '../../env';
import type { RunRow } from '../../services/runs';
import { getAgent } from '../registry';
import { fileCategorizeTool, fileListTool, fileReadTool, imageGenerateTool } from './files';
import { announcePostTool, chatListTool, chatReadTool, messageSendTool, pollCreateTool } from './messaging';
import { chatOpenTool } from './navigation';
import {
  historySearchTool,
  memoryProposeTool,
  projectListTool,
  projectSaveTool,
  reminderCancelTool,
  reminderListTool,
  reminderSetTool,
  todoAddTool,
  todoCompleteTool,
  todoListTool,
} from './personal';
import { composeTool, webSearchTool } from './research';
import { DEFAULT_RUN_KINDS, type ToolDef } from './types';

export const TOOLS: Record<string, ToolDef> = Object.fromEntries(
  [
    composeTool,
    todoAddTool, todoListTool, todoCompleteTool,
    reminderSetTool, reminderListTool, reminderCancelTool,
    projectSaveTool, projectListTool,
    memoryProposeTool, historySearchTool,
    webSearchTool,
    fileListTool, fileReadTool, fileCategorizeTool, imageGenerateTool,
    chatListTool, chatReadTool, chatOpenTool, messageSendTool, pollCreateTool, announcePostTool,
  ].map((t) => [t.id, t as ToolDef]),
);

export const getTool = (id: string): ToolDef | undefined => TOOLS[id];

/** Tools of an agent that may run in this kind of run right now (availability is checked live). */
export async function toolsFor(env: Env, userId: string, agentId: string, runKind: RunRow['kind'], allowOverride?: readonly string[]): Promise<{ tools: ToolDef[]; unavailable: { id: string; reason: string }[] }> {
  const ids = allowOverride ?? getAgent(agentId).tools;
  const tools: ToolDef[] = [];
  const unavailable: { id: string; reason: string }[] = [];
  for (const id of ids) {
    const t = TOOLS[id];
    if (!t || !(t.runKinds ?? DEFAULT_RUN_KINDS).includes(runKind)) continue;
    const a = t.available ? await t.available(env, userId) : ({ ok: true } as const);
    if (a.ok) tools.push(t);
    else unavailable.push({ id, reason: a.reason });
  }
  return { tools, unavailable };
}

/** Tools that actually do something (compose alone is just text generation and does not justify a planning step). */
export const hasActionTools = (tools: ToolDef[]) => tools.some((t) => t.id !== 'compose');
