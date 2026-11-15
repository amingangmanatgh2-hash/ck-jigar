import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useT } from '../lib/i18n';
import { toast } from '../state/toast';

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export { copyText };

function textOf(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'props' in node) return textOf((node as { props: { children?: unknown } }).props.children);
  return '';
}

function CodeBlock({ children }: { children?: unknown }) {
  const t = useT();
  return (
    <div className="codeblock" dir="ltr">
      <button
        type="button"
        className="codeblock-copy"
        onClick={async () => {
          const ok = await copyText(textOf(children).replace(/\n$/, ''));
          toast(ok ? t('common.copied') : t('common.copyFailed'), ok ? 'success' : 'error', 2000);
        }}
      >
        {t('common.copy')}
      </button>
      <pre>{children as never}</pre>
    </div>
  );
}

/**
 * Renders the assistant's Markdown (GitHub flavoured). Raw HTML is never rendered (react-markdown escapes it) and links open in a
 * new tab with rel="noopener noreferrer". Every block has dir="auto", so a Persian paragraph is RTL and an English one LTR even
 * inside the same message; code is always LTR.
 */
export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className={`md${streaming ? ' md-streaming' : ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ node: _n, ...p }) => <p dir="auto" {...p} />,
          li: ({ node: _n, ...p }) => <li dir="auto" {...p} />,
          h1: ({ node: _n, ...p }) => <h3 dir="auto" {...p} />,
          h2: ({ node: _n, ...p }) => <h3 dir="auto" {...p} />,
          h3: ({ node: _n, ...p }) => <h4 dir="auto" {...p} />,
          h4: ({ node: _n, ...p }) => <h4 dir="auto" {...p} />,
          blockquote: ({ node: _n, ...p }) => <blockquote dir="auto" {...p} />,
          a: ({ node: _n, href, ...p }) => <a href={href} target="_blank" rel="noopener noreferrer" {...p} />,
          pre: ({ node: _n, children }) => <CodeBlock>{children}</CodeBlock>,
          table: ({ node: _n, ...p }) => (
            <div className="table-wrap">
              <table {...p} />
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
