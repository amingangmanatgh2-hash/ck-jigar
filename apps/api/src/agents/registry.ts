import type { AgentDto, AgentId, ModelRole } from '@aminchat/shared';

export type ConcreteAgentId = Exclude<AgentId, 'auto'>;

export interface AgentDef {
  id: ConcreteAgentId;
  name: { fa: string; en: string };
  description: { fa: string; en: string };
  /** Icon key understood by the web client. */
  icon: string;
  modelRole: ModelRole;
  /** Tool ids this agent may use. An agent never gets a tool that is not listed here. */
  tools: readonly string[];
  /** English instructions (the model answers in the user's language). */
  instructions: string;
}

export const AGENTS: Record<ConcreteAgentId, AgentDef> = {
  general: {
    id: 'general',
    name: { fa: 'عمومی', en: 'General' },
    description: { fa: 'پرسش و پاسخ، توضیح، ترجمه و نوشتن', en: 'Questions, explanations, translation and writing' },
    icon: 'sparkles',
    modelRole: 'chat',
    tools: [],
    instructions:
      'You are the general assistant: answer questions, explain, translate, rewrite and brainstorm. Be accurate and say when you are unsure.',
  },
  personal: {
    id: 'personal',
    name: { fa: 'شخصی', en: 'Personal' },
    description: { fa: 'کارهای روزانه، فهرست کارها، یادآوری و برنامه‌ریزی پروژه', en: 'Daily tasks, to-do lists, reminders and project planning' },
    icon: 'check-square',
    modelRole: 'chat',
    tools: ['todo_add', 'todo_list', 'todo_complete', 'reminder_set', 'reminder_list', 'reminder_cancel', 'project_save', 'project_list', 'memory_propose', 'history_search', 'compose'],
    instructions:
      'You are the personal assistant: daily tasks, to-do lists, reminders and project planning. Use the tools to really create or change tasks, reminders and projects. ' +
      'If an essential detail is missing (for example the time of a reminder), ask one short question instead of guessing. ' +
      'Only propose a memory (memory_propose) for durable facts or preferences the user stated explicitly.',
  },
  research: {
    id: 'research',
    name: { fa: 'پژوهشگر', en: 'Research' },
    description: { fa: 'پژوهش، بررسی سند، مقایسه و گزارش با منبع', en: 'Research, document review, comparisons and cited reports' },
    icon: 'search',
    modelRole: 'chat',
    tools: ['web_search', 'file_read', 'file_list', 'history_search', 'compose'],
    instructions:
      'You are the research analyst: break the question down, compare options, structure reports with headings and flag uncertainty. ' +
      'Cite sources ONLY from web_search results, using [n] markers that match the numbered sources. If no search tool is connected, say plainly that sources cannot be verified and present the answer as general knowledge. ' +
      'For documents the user attached, quote precisely and never invent content that is not in the document.',
  },
  coder: {
    id: 'coder',
    name: { fa: 'برنامه‌نویس', en: 'Coding' },
    description: { fa: 'تولید کد، رفع باگ، بازبینی، توضیح و بهینه‌سازی', en: 'Generate, debug, review, explain and optimize code' },
    icon: 'code',
    modelRole: 'code',
    tools: [],
    instructions:
      'You are a senior software engineer. Write correct, idiomatic, well-explained code. When debugging, find the root cause and show a minimal fix. When reviewing, list issues by severity with concrete fixes. ' +
      'Always put code in fenced blocks with a language tag. Keep identifiers and code in English even when explaining in Persian. State your assumptions and how to test the result.',
  },
  messenger: {
    id: 'messenger',
    name: { fa: 'پیام‌رسان', en: 'Messenger' },
    description: { fa: 'نوشتن پیام، خلاصه‌سازی، اطلاعیه و پیشنهاد پاسخ — ارسال فقط با تأیید شما', en: 'Write messages, summarize, announce and suggest replies — sends only after your approval' },
    icon: 'send',
    modelRole: 'chat',
    tools: ['chat_list', 'chat_read', 'message_send', 'poll_create', 'announce_post', 'compose'],
    instructions:
      'You are the messaging assistant: draft messages, summarize conversations, write announcements and suggest replies. ' +
      'You can NEVER send anything on your own: sending or publishing happens only through tools that ask the user for explicit approval first. Show draft texts to the user. ' +
      'You can only read a conversation when the tools allow it; if access is denied, tell the user how to enable it instead of guessing the content.',
  },
  file: {
    id: 'file',
    name: { fa: 'فایل', en: 'File' },
    description: { fa: 'خواندن فایل‌های پشتیبانی‌شده، استخراج اطلاعات، خلاصه و دسته‌بندی با اجازه', en: 'Read supported files, extract information, summarize and categorize with permission' },
    icon: 'folder',
    modelRole: 'chat',
    tools: ['file_list', 'file_read', 'file_categorize', 'compose'],
    instructions:
      'You are the file assistant: read supported files with file_read, extract the requested information (tables, dates, amounts, names), summarize and categorize. ' +
      'Report exactly what the file contains; if a file cannot be read, say so. Categorization (file_categorize) only happens when the user asked for it and always needs approval.',
  },
  creative: {
    id: 'creative',
    name: { fa: 'خلاق', en: 'Creative' },
    description: { fa: 'ایده، داستان، تولید محتوا و تصویرسازی', en: 'Ideas, stories, content and image generation' },
    icon: 'palette',
    modelRole: 'chat',
    tools: ['image_generate', 'compose'],
    instructions:
      'You are the creative partner: ideas, stories, slogans and content in the requested tone and voice. Offer a few distinct options when brainstorming. ' +
      'Use image_generate only when the user asks for an image, and write the image prompt in English with concrete visual detail.',
  },
};

export const AUTO_AGENT = {
  id: 'auto' as const,
  name: { fa: 'خودکار', en: 'Auto' },
  description: { fa: 'دستیار مناسب را خودکار انتخاب می‌کند', en: 'Picks the right agent for each request' },
  icon: 'wand',
};

export const CONCRETE_AGENT_IDS = Object.keys(AGENTS) as ConcreteAgentId[];
export const isConcreteAgent = (id: string): id is ConcreteAgentId => id in AGENTS;
export const getAgent = (id: string): AgentDef => (isConcreteAgent(id) ? AGENTS[id] : AGENTS.general);

export function agentToDto(def: AgentDef, tools: AgentDto['tools']): AgentDto {
  return { id: def.id, name: def.name, description: def.description, icon: def.icon, tools, mode: def.tools.length > 0 ? 'plan' : 'direct' };
}
