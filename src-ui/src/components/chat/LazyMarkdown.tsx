import {
  lazy,
  memo,
  type ReactNode,
  Suspense,
  useLayoutEffect,
  useState,
} from 'react';
import type { Options } from 'react-markdown';

let rendererWarm = false;
const LazyMarkdownRenderer = lazy(() =>
  import('./MarkdownRenderer').then((module) => {
    rendererWarm = true;
    return module;
  }),
);

/**
 * Keeps Markdown parsing out of the initial application payload.  The plain
 * source is still readable while the renderer chunk arrives, so chat and
 * document views do not briefly collapse their content.
 */
function LazyMarkdownComponent({
  children,
  loadingProjection = children,
  ...options
}: Options & { loadingProjection?: ReactNode; incremental?: boolean }) {
  // Cold chunk only: let a lazily-loaded PARENT commit its own content before
  // this nested renderer can suspend (otherwise React can hold the parent's
  // conversation-level fallback despite this local boundary). useLayoutEffect
  // flips before paint, so the readable-source frame is never visible; once
  // the chunk has resolved, the warm flag skips the gate entirely — a warm
  // mount renders parsed output on its first commit with no extra pass.
  // act() flushes effects before assertions, so unit suites cannot observe
  // the cold-mount frame either way.
  const [rendererEnabled, setRendererEnabled] = useState(rendererWarm);
  useLayoutEffect(() => setRendererEnabled(true), []);
  if (!rendererEnabled) return loadingProjection;

  return (
    <Suspense fallback={loadingProjection}>
      <LazyMarkdownRenderer {...options}>{children}</LazyMarkdownRenderer>
    </Suspense>
  );
}

export const LazyMarkdown = memo(LazyMarkdownComponent);
