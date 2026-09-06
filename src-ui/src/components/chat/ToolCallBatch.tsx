import {
  type ComponentType,
  type ReactNode,
  useId,
  useMemo,
  useState,
} from 'react';
import { LazyBoundary } from '../LazyBoundary';
import type { ToolCallBatchSheetProps } from './ToolCallBatchSheet';
import { classifyToolCallRun } from './tool-call-groups';
import type { ToolCallLike, ToolCallRun } from './tool-call-runs';
import './chat.css';

// The sheet body (ResponsiveDialogSurface + per-row ToolCallDisplay detail)
// loads on first open rather than riding this chunk's own load — mirrors the
// ConversationStatsModal / NewChatModal lazy-mount pattern
// (`components/conversation-stats/ConversationStats.tsx`).
const loadToolCallBatchSheet = () =>
  import('./ToolCallBatchSheet').then((m) => ({
    default: m.ToolCallBatchSheet,
  }));

/**
 * A lazy loader cannot preserve a wrapped component's own generic type
 * parameter — `loadToolCallBatchSheet` collapses to a concrete component
 * typed over the `ToolCallLike` constraint, not this module's actual `P`.
 * That erasure (not a real type-safety gap: the same `group`/`renderCall`
 * pair below is always genuinely `ToolCallGroup<P>`/`(part: P,...) =>...`
 * at runtime) is what a bare `(part: P) => ReactNode` can't satisfy a
 * `(part: ToolCallLike) => ReactNode`-shaped prop for. This thin, still-lazy
 * wrapper restores the generic at the one call site that needs it, instead
 * of loosening either component's real signature or asserting per call.
 */
function ToolCallBatchSheetBoundary<P extends ToolCallLike>(
  props: ToolCallBatchSheetProps<P>,
) {
  const load = loadToolCallBatchSheet as unknown as () => Promise<{
    default: ComponentType<ToolCallBatchSheetProps<P>>;
  }>;
  return <LazyBoundary load={load} componentProps={props} pending={null} />;
}

export interface ToolCallBatchProps<P extends ToolCallLike> {
  run: ToolCallRun<P>;
  /**
   * Renders a single call's full detail — callers pass their existing
   * per-part `ToolCallDisplay` renderer (including its `onApprove` wiring)
   * so this component never builds a second detail renderer.
   */
  renderCall: (part: P, index: number) => ReactNode;
}

/**
 * Renders a run produced by `tool-call-runs.ts#splitToolCallRuns`. This
 * component itself is lazy-loaded (see `MessageContent.tsx`/
 * `StreamingMessage.tsx`) — a run of exactly one call never reaches it (the
 * caller renders that case inline, no extra tap layer, no chunk load), so
 * by the time this module is on the wire there is always something worth
 * collapsing.
 *
 * Classification (`classifyToolCallRun` — the verb taxonomy, target
 * extraction, batch summary) happens here, inside the lazy chunk, rather
 * than in the eager split — see `tool-call-groups.ts`'s module doc.
 */
export function ToolCallBatch<P extends ToolCallLike>({
  run,
  renderCall,
}: ToolCallBatchProps<P>) {
  const [isOpen, setIsOpen] = useState(false);
  const titleId = useId();
  const group = useMemo(() => classifyToolCallRun(run), [run]);

  if (group.calls.length === 1) {
    const only = group.calls[0];
    return <>{renderCall(only.part, only.index)}</>;
  }

  return (
    <div className="tool-call-batch">
      <button
        type="button"
        className="tool-call-batch__summary"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        onClick={() => setIsOpen(true)}
      >
        {group.inProgress && (
          <span className="tool-call-batch__pulse" aria-hidden="true" />
        )}
        <span className="tool-call-batch__label">{group.summary}</span>
        {/* A collapsed batch must disclose failure without being opened
            (station#2652 redesign) — the summary alone would bury it. */}
        {group.failedCount > 0 && (
          <span className="tool-call-batch__failed">
            {group.failedCount === 1
              ? '1 failed'
              : `${group.failedCount} failed`}
          </span>
        )}
        {/* station#1569 (item 3): the verb alone can only decline to claim
            completion — it cannot say HOW MANY of these calls may never have
            run. Same disclosure duty as the failure count beside it. */}
        {group.unresolvedCount > 0 && (
          <span className="tool-call-batch__unresolved">
            {group.unresolvedCount === 1
              ? '1 with no result'
              : `${group.unresolvedCount} with no result`}
          </span>
        )}
        <span className="tool-call-batch__chevron" aria-hidden="true">
          ›
        </span>
      </button>
      {isOpen && (
        <ToolCallBatchSheetBoundary
          group={group}
          renderCall={renderCall}
          titleId={titleId}
          onClose={() => setIsOpen(false)}
        />
      )}
    </div>
  );
}
