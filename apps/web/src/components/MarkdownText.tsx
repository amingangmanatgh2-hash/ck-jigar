import { lazy, Suspense } from 'react';

// The Markdown library is a large part of the app and is only needed once an answer has to be shown, so it is loaded on demand.
const MarkdownImpl = lazy(() => import('./Markdown').then((m) => ({ default: m.Markdown })));

/**
 * Renders Markdown. Until the renderer has loaded (slow or unreliable networks) the text itself is shown as plain paragraphs —
 * the user can read the answer immediately, and it is replaced by the formatted version as soon as that is ready.
 */
export function MarkdownText({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <Suspense
      fallback={
        <div className={`md md-plain${streaming ? ' md-streaming' : ''}`}>
          <p dir="auto" style={{ whiteSpace: 'pre-wrap' }}>
            {text}
          </p>
        </div>
      }
    >
      <MarkdownImpl text={text} streaming={streaming} />
    </Suspense>
  );
}
