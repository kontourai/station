import {
  lazy,
  memo,
  type ReactNode,
  Suspense,
  useEffect,
  useState,
} from 'react';
import type { Options } from 'react-markdown';

const LazyMarkdownRenderer = lazy(() => import('./MarkdownRenderer'));

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
  // Let a newly loaded parent capability commit its readable source before
  // this nested lazy renderer can suspend. Without this first-commit gate,
  // React may retain the parent's conversation-level fallback until the
  // markdown chunk resolves even though this boundary has its own fallback.
  const [rendererEnabled, setRendererEnabled] = useState(false);
  useEffect(() => setRendererEnabled(true), []);
  if (!rendererEnabled) return loadingProjection;

  return (
    <Suspense fallback={loadingProjection}>
      <LazyMarkdownRenderer {...options}>{children}</LazyMarkdownRenderer>
    </Suspense>
  );
}

export const LazyMarkdown = memo(LazyMarkdownComponent);
