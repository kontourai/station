import {
  type ComponentType,
  createElement,
  type ReactNode,
  useEffect,
  useState,
} from 'react';
import { LazyBoundary } from '../LazyBoundary';
import type { ToolCallBatchProps } from './ToolCallBatch';
import type { ToolCallLike, ToolCallRun } from './tool-call-runs';

type AnyToolCallBatch = ComponentType<ToolCallBatchProps<ToolCallLike>>;

/**
 * The batch chunk, once it has loaded. A lazy boundary suspends for at least
 * one commit on every NEW mount, even with the chunk long since loaded, and
 * its `pending` rows are every call of the run laid out standalone — so each
 * batch that formed (a second call arriving, the streaming shell handing the
 * turn to the transcript) flashed its rows one by one before snapping into
 * the collapsed line. Holding the resolved component lets every later mount
 * render the batch in its first commit.
 */
let loadedToolCallBatch: AnyToolCallBatch | undefined;
let toolCallBatchLoad: Promise<{ default: AnyToolCallBatch }> | undefined;

const loadToolCallBatch = (): Promise<{ default: AnyToolCallBatch }> => {
  toolCallBatchLoad ??= import('./ToolCallBatch').then(
    (module) => {
      loadedToolCallBatch = module.ToolCallBatch as AnyToolCallBatch;
      return { default: loadedToolCallBatch };
    },
    (error: unknown) => {
      // A failed import is retried on the next attempt, not replayed.
      toolCallBatchLoad = undefined;
      throw error;
    },
  );
  return toolCallBatchLoad;
};

/**
 * Warm the batch chunk as soon as a transcript shows a tool call, so the run
 * it may grow into has its final shape the moment the next call arrives.
 * Best effort: a failure here is the boundary's to report when it mounts.
 */
export function usePreloadToolCallBatch(hasToolCalls: boolean) {
  useEffect(() => {
    if (!hasToolCalls || loadedToolCallBatch) return;
    loadToolCallBatch().catch(() => undefined);
  }, [hasToolCalls]);
}

/** Resolves once the batch chunk is loaded (tests, and a warm-up caller). */
export function preloadToolCallBatch(): Promise<unknown> {
  return loadToolCallBatch();
}

/**
 * Shared retry-capable mount for the generic ToolCallBatch chunk. Keeping the
 * one generic cast here preserves both message renderers' exact part types and
 * prevents either eager caller from rebuilding its own lazy/import boundary.
 */
export function ToolCallBatchBoundary<P extends ToolCallLike>({
  run,
  renderCall,
  renderInterlude,
  pending,
}: {
  run: ToolCallRun<P>;
  renderCall: (part: P, index: number, expanded?: boolean) => ReactNode;
  renderInterlude?: (part: P, index: number) => ReactNode;
  /** Inline rows shown until the batch chunk first loads — without this the
   * 2nd consecutive call flashes an empty gap (`pending={null}`). */
  pending: ReactNode;
}) {
  // Read once per mount: a boundary that mounted before the chunk loaded
  // keeps its lazy path, so it is not unmounted and remounted (losing an open
  // sheet) the moment the chunk lands.
  const [loaded] = useState(
    () =>
      loadedToolCallBatch as ComponentType<ToolCallBatchProps<P>> | undefined,
  );
  if (loaded)
    return createElement(loaded, { run, renderCall, renderInterlude });
  const load = loadToolCallBatch as unknown as () => Promise<{
    default: ComponentType<ToolCallBatchProps<P>>;
  }>;

  return (
    <LazyBoundary
      load={load}
      componentProps={{ run, renderCall, renderInterlude }}
      pending={pending}
      // A chunk that cannot load leaves the run as its standalone rows —
      // every call, and any Allow/Deny, stays on screen — rather than
      // replacing the calls with an error.
      unavailable={() => pending}
    />
  );
}
