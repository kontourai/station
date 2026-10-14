import {
  lazy,
  memo,
  type ReactNode,
  Suspense,
  useLayoutEffect,
  useState,
} from 'react';
import type { Options } from 'react-markdown';
import { markTranscriptPhase } from './transcriptLayoutTrace';

type RendererModule = typeof import('./MarkdownRenderer');
let rendererModule: RendererModule | null = null;
let rendererLoad: Promise<RendererModule> | null = null;
function loadRenderer(): Promise<RendererModule> {
  rendererLoad ??= import('./MarkdownRenderer').then(
    (module) => {
      rendererModule = module;
      markTranscriptPhase('markdown-renderer-resolved');
      return module;
    },
    (error: unknown) => {
      // A failed chunk is fetched again on the next attempt.
      rendererLoad = null;
      throw error;
    },
  );
  return rendererLoad;
}
const LazyMarkdownRenderer = lazy(loadRenderer);

/**
 * Starts fetching the renderer before any Markdown mounts (the chat dock
 * calls this when it opens a conversation), so a transcript read that lands
 * after the chunk paints parsed rows first instead of their source, which
 * then grew into place.
 */
export function preloadMarkdownRenderer(): void {
  void loadRenderer().catch(() => {});
}

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
  // the chunk has resolved, the loaded module skips the gate entirely — a
  // warm mount renders parsed output on its first commit with no extra pass.
  // act() flushes effects before assertions, so unit suites cannot observe
  // the cold-mount frame either way.
  const [rendererEnabled, setRendererEnabled] = useState(
    rendererModule !== null,
  );
  useLayoutEffect(() => setRendererEnabled(true), []);
  // Loaded already (preloaded, or an earlier row): render it directly, so the
  // first commit is the parsed output with no suspension in between.
  if (rendererModule) {
    const Renderer = rendererModule.default;
    return <Renderer {...options}>{children}</Renderer>;
  }
  if (!rendererEnabled) return loadingProjection;

  return (
    <Suspense fallback={loadingProjection}>
      <LazyMarkdownRenderer {...options}>{children}</LazyMarkdownRenderer>
    </Suspense>
  );
}

export const LazyMarkdown = memo(LazyMarkdownComponent);
