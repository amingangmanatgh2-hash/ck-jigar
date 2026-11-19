import type { ReactNode } from 'react';

const MENTION = /(@[A-Za-z][A-Za-z0-9_]{1,31})/g;

/**
 * Plain message text with @mentions isolated as left-to-right runs. Without this, the neutral "@" of "@AMINAI" inside a Persian
 * sentence is reordered by the bidi algorithm and shows up as "AMINAI@".
 */
export function renderPlain(text: string): ReactNode[] {
  return text.split(MENTION).map((part, i) =>
    i % 2 === 1 ? (
      <bdi key={i} dir="ltr" className="mention">
        {part}
      </bdi>
    ) : (
      part
    ),
  );
}

/** One-line preview of a message that may contain Markdown (AI answers): no code blocks, emphasis marks, headings or link syntax. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,!?؟،؛]|$)/g, '$1$2')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
