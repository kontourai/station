import {
  type ComponentType,
  type ReactNode,
  useId,
  useMemo,
  useState,
} from 'react';
import { attentionWord } from '../../views/home/work-status';
import { PlugGlyph } from '../icons/Glyph';
import { LazyBoundary } from '../LazyBoundary';
import type { ToolCallBatchSheetProps } from './ToolCallBatchSheet';
import { KIND_GLYPH } from './ToolCallDisplay';
import { ToolCallElapsed } from './ToolCallElapsed';
import { classifyToolCallRun, type ToolCallGroup } from './tool-call-groups';
import { runningCallLabelParts } from './tool-call-labels';
import type { ToolCallLike, ToolCallRun } from './tool-call-runs';
import { toolDisplayView } from './tool-display-view';
import './chat.css';
import './ToolCallBatch.css';

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
  renderCall: (part: P, index: number, expanded?: boolean) => ReactNode;
  /** Renders narration folded into the run (`run.interludes`) inside the
   * sheet, between the calls it originally sat between. */
  renderInterlude?: (part: P, index: number) => ReactNode;
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
  renderInterlude,
}: ToolCallBatchProps<P>) {
  const [isOpen, setIsOpen] = useState(false);
  const titleId = useId();
  const group = useMemo(() => classifyToolCallRun(run), [run]);

  if (group.calls.length === 1) {
    const only = group.calls[0];
    return <>{renderCall(only.part, only.index)}</>;
  }
  // The same anatomy as a single row — kind glyph, label, chevron — so a
  // solo call that gains a sibling changes its words, not its shape.
  const kinds = new Set(group.calls.map((call) => call.kind));
  const Glyph = kinds.size === 1 ? KIND_GLYPH[group.calls[0]!.kind] : PlugGlyph;

  return (
    <div className="tool-call-batch">
      <button
        type="button"
        className="tool-call-batch__summary"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        onClick={() => setIsOpen(true)}
      >
        <span className="tool-call__glyph" aria-hidden="true">
          <Glyph />
        </span>
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
        {/* A failure a later identical call recovered is history, not the
            outcome: named neutrally so it is not read as still broken. */}
        {group.recoveredCount > 0 && (
          <span className="tool-call-batch__retried">
            {`${group.recoveredCount} retried`}
          </span>
        )}
        {group.unresolvedCount > 0 && (
          <span className="tool-call-batch__unresolved">
            {group.unresolvedCount === 1
              ? '1 with no result'
              : `${group.unresolvedCount} with no result`}
          </span>
        )}
        {group.awaitingApprovalCount > 0 && (
          <span className="tool-call-batch__awaiting">
            {group.awaitingApprovalCount === 1
              ? attentionWord('approval')
              : `${group.awaitingApprovalCount} need approval`}
          </span>
        )}
        {group.deniedCount > 0 && (
          <span className="tool-call-batch__failed">
            {group.deniedCount === 1
              ? '1 denied'
              : `${group.deniedCount} denied`}
          </span>
        )}
        {group.cancelledCount > 0 && (
          <span className="tool-call-batch__unresolved">
            {group.cancelledCount === 1
              ? '1 cancelled'
              : `${group.cancelledCount} cancelled`}
          </span>
        )}
        <span className="tool-call-batch__chevron" aria-hidden="true">
          ›
        </span>
      </button>
      <LiveCallRows group={group} />
      {!isOpen &&
        group.calls
          .filter(
            (call) =>
              call.awaitingApproval ||
              (group.awaitingApprovalCount > 0 && call.inProgress),
          )
          .map((call) => (
            <div
              key={call.part.toolCallId ?? `awaiting:${call.index}`}
              className="tool-call-batch__pending-grant"
            >
              {renderCall(call.part, call.index, true)}
            </div>
          ))}
      {isOpen && (
        <ToolCallBatchSheetBoundary
          group={group}
          renderCall={renderCall}
          renderInterlude={renderInterlude}
          titleId={titleId}
          onClose={() => setIsOpen(false)}
        />
      )}
    </div>
  );
}

type LiveCall = ToolCallGroup['calls'][number];

/** Live child rows shown under a running batch's summary before overflow. */
export const MAX_LIVE_CALL_ROWS = 2;

const liveCallKey = (call: LiveCall) =>
  call.part.toolCallId ?? `call:${call.index}`;

/**
 * The calls a running batch is executing right now, each on its own row
 * under the stable summary: at most {@link MAX_LIVE_CALL_ROWS}, then
 * "+N more". Empty (and collapsed to no height) once nothing runs.
 * A call awaiting a grant elsewhere in the batch already renders its running
 * siblings in full below, so they are not repeated here.
 */
function LiveCallRows({ group }: { group: ToolCallGroup }) {
  const live = group.awaitingApprovalCount > 0 ? [] : group.activeCalls;
  const overflow = Math.max(0, live.length - MAX_LIVE_CALL_ROWS);
  return (
    <div className="tool-call-batch__live">
      {Array.from({ length: MAX_LIVE_CALL_ROWS }, (_, slot) => (
        // Slots are positional on purpose: a slot whose call finishes and is
        // followed by the next one crossfades in place instead of the row
        // leaving and another arriving.
        <LiveCallSlot key={slot} call={live[slot]} />
      ))}
      <OverflowSlot count={overflow} />
    </div>
  );
}

function LiveCallSlot({ call }: { call?: LiveCall }) {
  const key = call ? liveCallKey(call) : undefined;
  // What the slot shows while it closes (its last call) and the row fading
  // out beneath a successor. Adjusted during render only when the key
  // changes, the documented React pattern for state derived from props.
  const [shown, setShown] = useState<{ key?: string; call?: LiveCall }>({
    key,
    call,
  });
  const [leaving, setLeaving] = useState<
    { key: string; call: LiveCall } | undefined
  >();
  if (key !== shown.key) {
    if (key !== undefined && shown.key !== undefined && shown.call) {
      setLeaving({ key: shown.key, call: shown.call });
    } else if (key === undefined && leaving) {
      // Closing before an outgoing row's fade ended: that row is no longer
      // rendered, so its animationend never comes. Dropped now, it cannot
      // reappear as a ghost under the slot's next call.
      setLeaving(undefined);
    }
    setShown({ key, call: call ?? shown.call });
  }
  const open = call !== undefined;
  const current = call ?? shown.call;
  return (
    <div
      className="tool-call-batch__slot"
      data-open={open ? 'true' : 'false'}
      aria-hidden={open ? undefined : true}
    >
      <div className="tool-call-batch__slot-inner">
        {open && leaving && (
          <LiveCallRow
            key={`leaving:${leaving.key}`}
            call={leaving.call}
            live={false}
            className="tool-call-batch__child--leaving"
            onAnimationEnd={() => setLeaving(undefined)}
          />
        )}
        {current && (
          <LiveCallRow
            key={liveCallKey(current)}
            call={current}
            live={open}
            className={
              open && leaving ? 'tool-call-batch__child--entering' : undefined
            }
          />
        )}
      </div>
    </div>
  );
}

function LiveCallRow({
  call,
  live,
  className,
  onAnimationEnd,
}: {
  call: LiveCall;
  /** False for a retained snapshot (a closing slot, an outgoing row): it
   * neither animates nor keeps a clock running. */
  live: boolean;
  className?: string;
  onAnimationEnd?: () => void;
}) {
  const Glyph = KIND_GLYPH[call.kind];
  const active = live && call.inProgress;
  const leaving = onAnimationEnd !== undefined;
  const progress =
    typeof call.part.progressMessage === 'string'
      ? call.part.progressMessage.trim()
      : '';
  // The pulse already says it is running, so the row spends its width on
  // what is running; the verb stays for screen readers and the tooltip.
  const parts = call.inProgress
    ? runningCallLabelParts(
        call.kind,
        toolDisplayView(call.part).args,
        call.label,
      )
    : undefined;
  return (
    <div
      className={
        className
          ? `tool-call-batch__child ${className}`
          : 'tool-call-batch__child'
      }
      data-tool-call-id={call.part.toolCallId}
      aria-hidden={leaving ? true : undefined}
      onAnimationEnd={
        onAnimationEnd
          ? (event) => {
              if (event.target === event.currentTarget) onAnimationEnd();
            }
          : undefined
      }
    >
      <span className="tool-call__glyph" aria-hidden="true">
        <Glyph />
      </span>
      <span
        className={
          active
            ? 'tool-call__label tool-call__label--active'
            : 'tool-call__label'
        }
        title={call.label}
      >
        {parts ? (
          <>
            <span className="sr-only">{parts.verb} </span>
            {parts.target}
          </>
        ) : (
          call.label
        )}
      </span>
      {progress && (
        <span className="tool-call-batch__child-progress">{progress}</span>
      )}
      {active && (
        <ToolCallElapsed
          startedAt={
            typeof call.part.startedAt === 'string'
              ? call.part.startedAt
              : undefined
          }
        />
      )}
    </div>
  );
}

function OverflowSlot({ count }: { count: number }) {
  // The last non-zero count stays on screen while the slot closes.
  const [lastCount, setLastCount] = useState(count);
  if (count > 0 && count !== lastCount) setLastCount(count);
  const open = count > 0;
  return (
    <div
      className="tool-call-batch__slot"
      data-open={open ? 'true' : 'false'}
      aria-hidden={open ? undefined : true}
    >
      <div className="tool-call-batch__slot-inner">
        {lastCount > 0 && (
          <div className="tool-call-batch__child tool-call-batch__child--more">
            {`+${lastCount} more`}
          </div>
        )}
      </div>
    </div>
  );
}
