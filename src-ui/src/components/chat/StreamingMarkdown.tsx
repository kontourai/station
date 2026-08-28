import { lazy, memo, Suspense, useMemo } from 'react';
import { LazyMarkdown } from './LazyMarkdown';
import { splitOpenFence } from './open-fence';

// The framed chrome (shared with the async code-block renderer) loads on
// demand; until it arrives the raw code still renders as a plain <pre>.
const StreamingOpenFence = lazy(() => import('./StreamingOpenFence'));

function PlainPre({ code }: { code: string }) {
  return (
    <pre
      style={{
        margin: '8px 0 0',
        padding: '12px',
        background: '#0d1117',
        borderRadius: '6px',
        overflowX: 'auto',
      }}
    >
      <code
        style={{ fontFamily: 'monospace', fontSize: '12px', color: '#e6edf3' }}
      >
        {code}
      </code>
    </pre>
  );
}

/**
 * archive#3354 — markdown for text that is still growing.
 *
 * The unclosed trailing code fence (if any) is split out BEFORE rendering and
 * rendered as a plain <pre>: react-markdown cannot tell an unterminated fence
 * from a closed one (remark parses both as code nodes), so highlighting "in
 * the renderer" would re-tokenize a growing block on every flush, thrash the
 * highlight LRU with a fresh key per flush, and evict stable blocks earlier
 * in the transcript. Only closed blocks reach the highlighter; the in-progress
 * block highlights once, when its fence closes (or when the message persists).
 */
function StreamingMarkdownComponent({ content }: { content: string }) {
  const { closed, openTail } = useMemo(
    () => splitOpenFence(content),
    [content],
  );
  return (
    <>
      {closed ? <LazyMarkdown>{closed}</LazyMarkdown> : null}
      {openTail ? (
        <Suspense fallback={<PlainPre code={openTail.code} />}>
          <StreamingOpenFence code={openTail.code} lang={openTail.lang} />
        </Suspense>
      ) : null}
    </>
  );
}

export const StreamingMarkdown = memo(StreamingMarkdownComponent);
