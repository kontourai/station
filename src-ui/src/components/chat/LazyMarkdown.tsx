import { lazy, memo, type ReactNode, Suspense } from 'react';
import type { Options } from 'react-markdown';

const LazyMarkdownRenderer = lazy(() =>
  import('./MarkdownRenderer').then(({ MarkdownRenderer }) => ({
    default: MarkdownRenderer,
  })),
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
}: Options & { loadingProjection?: ReactNode }) {
  return (
    <Suspense fallback={loadingProjection}>
      <LazyMarkdownRenderer {...options}>{children}</LazyMarkdownRenderer>
    </Suspense>
  );
}

export const LazyMarkdown = memo(LazyMarkdownComponent);
