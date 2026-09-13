import type { ComponentType, ReactNode } from 'react';
import { LazyBoundary } from '../LazyBoundary';
import type { ToolCallBatchProps } from './ToolCallBatch';
import type { ToolCallLike, ToolCallRun } from './tool-call-runs';

const loadToolCallBatch = () =>
  import('./ToolCallBatch').then((module) => ({
    default: module.ToolCallBatch,
  }));

/**
 * Shared retry-capable mount for the generic ToolCallBatch chunk. Keeping the
 * one generic cast here preserves both message renderers' exact part types and
 * prevents either eager caller from rebuilding its own lazy/import boundary.
 */
export function ToolCallBatchBoundary<P extends ToolCallLike>({
  run,
  renderCall,
  pending,
}: {
  run: ToolCallRun<P>;
  renderCall: (part: P, index: number, expanded?: boolean) => ReactNode;
  /** Inline rows shown until the batch chunk mounts — without this the
   * 2nd consecutive call flashes an empty gap (`pending={null}`). */
  pending: ReactNode;
}) {
  const load = loadToolCallBatch as unknown as () => Promise<{
    default: ComponentType<ToolCallBatchProps<P>>;
  }>;

  return (
    <LazyBoundary
      load={load}
      componentProps={{ run, renderCall }}
      pending={pending}
    />
  );
}
