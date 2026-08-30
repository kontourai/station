import { memo, useMemo, useState } from 'react';
import { useRevealOnce } from '../../hooks/useRevealOnce';
import {
  DocumentGlyph,
  EditGlyph,
  PauseGlyph,
  PlugGlyph,
  SearchGlyph,
  TerminalGlyph,
} from '../icons/Glyph';
import {
  boundedToolResultText,
  formatWithheldBytes,
  fullToolResultText,
} from './bounded-tool-result';
import {
  callLabel,
  classifyToolName,
  type ToolCallKind,
  type ToolCallPhase,
} from './tool-call-labels';

/**
 * Flat `tool-invocation` shape — the single chat tool-part vocabulary shared by
 * the orchestration live path, the AI-SDK streaming path, the SDK refresh path
 * (`mapConversationMessages`), and the durable runtime-event projection. The
 * `input`/`output`/`errorText` fields cover the SDK refresh part naming; the
 * `args`/`result`/`error` fields cover the live + projection naming.
 */
export interface ToolCallData {
  type: string;
  toolCallId?: string;
  name?: string;
  toolName?: string;
  server?: string;
  originalName?: string;
  args?: any;
  input?: any;
  result?: any;
  output?: any;
  error?: string;
  errorText?: string;
  state?: string;
  progressMessage?: string;
  outputTruncated?: boolean;
  needsApproval?: boolean;
  approvalId?: string;
  cancelled?: boolean;
  approvalStatus?:
    | 'auto-approved'
    | 'user-approved'
    | 'user-denied'
    | 'policy-denied';
}

interface ToolCallDisplayProps {
  toolCall: ToolCallData;
  onApprove?: (action: 'once' | 'trust' | 'deny') => void;
  showDetails?: boolean;
}

const KIND_GLYPH: Record<
  ToolCallKind,
  React.ComponentType<{ className?: string }>
> = {
  read: DocumentGlyph,
  write: EditGlyph,
  exec: TerminalGlyph,
  search: SearchGlyph,
  other: PlugGlyph,
};

/**
 * One work activity as a quiet, single-line row (archive#2652 redesign):
 * a small kind glyph, a verb-first label ("Read app.tsx", "Ran npm run
 * build:ui"), and — only when something went wrong — a visible outcome flag.
 * The prose leads; the activity recedes.
 *
 * Honesty rules this row holds:
 *
 * - **A failure is visible without expanding.** `error`/`state: 'error'`
 *   renders a collapsed "Failed" flag; a denial renders its own badge
 *   ("User denied" / "Blocked by Station" — the archive#3091/#3117
 *   distinction is preserved verbatim). A reader never has to open a row to
 *   learn the call went wrong.
 * - **No expand affordance over nothing.** A call with no arguments, no
 *   result, and no error renders as static text — no chevron, no button,
 *   no tab stop — rather than a disclosure that opens an empty panel.
 * - **No raw internal state strings.** The old row printed `state` verbatim
 *   ("call", "result") as a badge — an internal enum in the UI. Outcome is
 *   now derived: running → progressive verb + pulse; failure/cancellation →
 *   a flag; success → the past-tense verb alone, with the explicit
 *   "Success" confirmation in the expanded status footer.
 */
function ToolCallDisplayComponent({
  toolCall,
  onApprove,
  showDetails = true,
}: ToolCallDisplayProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const id = toolCall.toolCallId || '';
  // Identity-keyed one-shot entrance (archive#2651): keyed to the tool call
  // id, never to mount, so virtualizer recycling, stream→history promotion,
  // and expand/collapse cannot replay it. A call without a stable id gets no
  // entrance rather than a replaying one.
  const revealClass = useRevealOnce(id ? `tool:${id}` : undefined);
  const server = toolCall.server;
  const toolName =
    toolCall.toolName ||
    toolCall.name ||
    toolCall.type?.replace('tool-', '') ||
    '';
  const originalName = toolCall.originalName;
  const args = toolCall.args ?? toolCall.input;
  const result = toolCall.result ?? toolCall.output;
  const error = toolCall.error ?? toolCall.errorText;
  const needsApproval = toolCall.needsApproval;
  const cancelled = toolCall.cancelled || toolCall.state === 'cancelled';
  const approvalStatus = toolCall.approvalStatus;
  const state = toolCall.state;
  const progressMessage = toolCall.progressMessage;
  const outputTruncated = toolCall.outputTruncated === true;

  const failed = Boolean(error) || state === 'error';
  const running = state === 'running' && !failed && !cancelled;
  const awaitingApproval =
    Boolean(needsApproval) && !error && result === undefined && !cancelled;

  const kind = classifyToolName(toolName);
  const denied =
    approvalStatus === 'user-denied' || approvalStatus === 'policy-denied';
  // The live path stamps `completed` on success (`streamHandlers.ts`) and the
  // durable projection stamps `result` (`runtime-event-projection.ts`) — both
  // are the same observation, so both count. A `state: 'call'` that survived a
  // reconnect is a START with no observed end, and must not count.
  const completedSuccessfully =
    !failed &&
    !cancelled &&
    !denied &&
    (state === 'completed' || state === 'result' || result !== undefined);
  // Verb tense is the honest one for the call's actual phase: past ONLY for
  // work observed to have completed, progressive only while running, bare
  // infinitive for a proposed call and for anything unresolved. `done` is
  // derived, never a fallback — a denied `write_file` reading "Edited file"
  // claims an edit that never landed.
  const phase: ToolCallPhase = awaitingApproval
    ? 'proposed'
    : running
      ? 'running'
      : completedSuccessfully
        ? 'done'
        : 'unresolved';
  // Every other unresolved outcome already carries a badge below (Failed,
  // Cancelled, User denied, Blocked by Station). This is the one that does
  // not: dispatched, and no completion event ever arrived.
  const unresolvedWithoutOutcome =
    phase === 'unresolved' && !failed && !cancelled && !denied;
  const label = useMemo(
    () => callLabel(kind, toolName, args, phase),
    [kind, toolName, args, phase],
  );

  const hasArgs =
    typeof args === 'string'
      ? args.length > 0
      : args && typeof args === 'object'
        ? Object.keys(args).length > 0
        : Boolean(args);
  // The disclosure's whole contract: it only exists when it has something to
  // show. A chevron over an empty panel is a promise nothing derives.
  const hasDetail = Boolean(hasArgs) || result !== undefined || Boolean(error);

  if (!showDetails) return null;

  const Glyph = KIND_GLYPH[kind];
  const lineContent = (
    <>
      <span className="tool-call__glyph" aria-hidden="true">
        <Glyph />
      </span>
      <span className="tool-call__label">{label}</span>
      {running && <span className="tool-call__pulse" aria-hidden="true" />}
      {failed &&
        approvalStatus !== 'policy-denied' &&
        approvalStatus !== 'user-denied' && (
          <span className="tool-call__status-badge tool-call__status-badge--error">
            Failed
          </span>
        )}
      {cancelled && !failed && (
        <span className="tool-call__status-badge">Cancelled</span>
      )}
      {approvalStatus === 'user-denied' && (
        <span className="tool-call__status-badge tool-call__status-badge--error">
          User denied
        </span>
      )}
      {approvalStatus === 'policy-denied' && (
        // archive#3117: worded for the AUTHORITY that refused the call, not
        // the verdict — `deny` (pre-tool-policy.ts) stamps this same
        // marker on all eight `ToolDenialReason` values, and two of them (a
        // stale-generation race, a fail-closed evaluator crash) are not a
        // deliberate policy verdict. "Blocked by Station" is true for every
        // one of the eight; "Policy denied" was not.
        <span className="tool-call__status-badge tool-call__status-badge--warning">
          Blocked by Station
        </span>
      )}
      {unresolvedWithoutOutcome && (
        // A call the transcript saw START and never saw end — a turn
        // interrupted by a disconnect leaves `state: 'call'` in the durable
        // events. Without this the row would read as a proposal that was
        // never acted on, which is a different (and equally untrue) claim
        // from the one the past tense used to make.
        <span className="tool-call__status-badge">No result recorded</span>
      )}
      {outputTruncated && (
        <span className="tool-call__status-badge tool-call__status-badge--warning">
          Output truncated
        </span>
      )}
      {awaitingApproval && (
        <span
          className="tool-call__awaiting"
          role="img"
          aria-label="Awaiting approval"
          title="Awaiting approval"
        >
          <PauseGlyph />
        </span>
      )}
    </>
  );

  return (
    <div className={revealClass ? `tool-call ${revealClass}` : 'tool-call'}>
      <div className="tool-call__row">
        {hasDetail ? (
          <button
            type="button"
            className="tool-call__line"
            aria-expanded={isExpanded}
            onClick={() => setIsExpanded((expanded) => !expanded)}
          >
            {lineContent}
            <span className="tool-call__chevron" aria-hidden="true">
              {isExpanded ? '⌄' : '›'}
            </span>
          </button>
        ) : (
          <div className="tool-call__line tool-call__line--static">
            {lineContent}
          </div>
        )}
        {awaitingApproval && onApprove && (
          <div className="tool-call__actions">
            <ToolApprovalButtons onApprove={onApprove} />
          </div>
        )}
      </div>
      {/* Collapsed-visible only while genuinely running — a settled row
          repeating its last progress line would read as ongoing activity.
          The final message is retained in the expanded detail instead. */}
      {progressMessage && running && (
        <div className="tool-call__progress">{progressMessage}</div>
      )}
      {isExpanded && hasDetail && (
        <ToolCallDetails
          id={id}
          server={server}
          toolName={toolName}
          originalName={originalName}
          args={args}
          result={result}
          error={error}
          cancelled={cancelled}
          approvalStatus={approvalStatus}
          lastProgress={running ? undefined : progressMessage}
        />
      )}
    </div>
  );
}

function ToolApprovalButtons({
  onApprove,
}: {
  onApprove: (action: 'once' | 'trust' | 'deny') => void;
}) {
  return (
    <>
      <button
        type="button"
        onClick={() => onApprove('once')}
        className="tool-call__approve-btn tool-call__approve-btn--primary"
      >
        Allow Once
      </button>
      <button
        type="button"
        onClick={() => onApprove('trust')}
        className="tool-call__approve-btn tool-call__approve-btn--secondary"
      >
        Always Allow
      </button>
      <button
        type="button"
        onClick={() => onApprove('deny')}
        className="tool-call__approve-btn tool-call__approve-btn--danger"
      >
        Deny
      </button>
    </>
  );
}

function ToolCallDetails({
  id,
  server,
  toolName,
  originalName,
  args,
  result,
  error,
  cancelled,
  approvalStatus,
  lastProgress,
}: {
  id: string;
  server?: string;
  toolName: string;
  originalName?: string;
  args: any;
  result?: any;
  error?: string;
  cancelled?: boolean;
  approvalStatus?: ToolCallData['approvalStatus'];
  /** The final tool.progress message of a settled call — historical record,
   * shown here rather than as a collapsed line that would read as live. */
  lastProgress?: string;
}) {
  const [showFullResult, setShowFullResult] = useState(false);
  // A shell-style `command` argument renders as its own readable, wrapped
  // monospace block instead of going through the generic JSON dump — inside
  // `JSON.stringify`, a command containing quotes (`git commit -m "fix"`)
  // becomes an unreadable escaped string (`"git commit -m \"fix\""`). The
  // raw string, printed as-is, keeps its quotes literal.
  const isArgsObject = args && typeof args === 'object';
  const commandValue =
    isArgsObject && typeof args.command === 'string' ? args.command : undefined;
  const remainingArgs =
    commandValue === undefined || !isArgsObject
      ? args
      : Object.fromEntries(
          Object.entries(args).filter(([key]) => key !== 'command'),
        );
  const hasRemainingArgs =
    remainingArgs && typeof remainingArgs === 'object'
      ? Object.keys(remainingArgs).length > 0
      : Boolean(remainingArgs);
  // archive#3507: `remainingArgs` can already be a string, the
  // same way `result` below can — `ToolStartedEvent.arguments` is `unknown`,
  // `runtime-event-projection.ts` passes it through unchanged (`args:
  // ev.arguments`), and an ACP-connected engine's `resolveToolArguments` can
  // hand back a raw, unstringified string (`stringifyRawValue`'s own
  // docblock: "Strings pass through."). `isArgsObject` is false for a
  // string, so it reaches here as `remainingArgs` untouched — the same
  // double-encode the `command` special case above this function exists to
  // avoid, just on the generic path that special case doesn't cover.
  // `buildToolInputDisplay` (`event-entry/utils.ts`) already guards this
  // exact shape for the monitoring surface's args display.
  const argsJson = useMemo(
    () =>
      typeof remainingArgs === 'string'
        ? remainingArgs
        : JSON.stringify(remainingArgs, null, 2),
    [remainingArgs],
  );
  // Restored results are already strings while the live path can carry raw
  // objects (archive#3507). The bounded collector preserves that distinction
  // without eagerly allocating a complete JSON rendering for the live shape.
  const boundedResult = useMemo(() => boundedToolResultText(result), [result]);
  const fullResult = useMemo(
    () => (showFullResult ? fullToolResultText(result) : undefined),
    [result, showFullResult],
  );

  // The truthful terminal status — claimed only when a terminal outcome was
  // actually observed (a result or an error); an unresolved call gets no
  // status line rather than an invented one.
  const status = error
    ? 'Failed'
    : cancelled
      ? 'Cancelled'
      : result !== undefined
        ? 'Success'
        : null;

  return (
    <div className="tool-call__details">
      {commandValue !== undefined && (
        <div className="tool-call__section">
          <strong>Command:</strong>
          <pre className="tool-call__code tool-call__code--command">
            {commandValue}
          </pre>
        </div>
      )}
      {(commandValue === undefined || hasRemainingArgs) && (
        <div className="tool-call__section">
          <strong>Arguments:</strong>
          <pre className="tool-call__code">{argsJson}</pre>
        </div>
      )}
      {result !== undefined && (
        <div className="tool-call__section">
          <strong>Response:</strong>
          <pre className="tool-call__code tool-call__code--scrollable">
            {fullResult ?? boundedResult.head}
            {!showFullResult && boundedResult.truncated && (
              <>
                <span className="tool-call__status-badge tool-call__status-badge--warning">
                  {/* Names its subject: a row can also carry the upstream
                      "Output truncated" badge, which says the engine withheld
                      data before it ever arrived. This one says only that the
                      preview is showing part of what DID arrive. */}
                  {'\n'}… {formatWithheldBytes(boundedResult.withheldBytes)}
                  {' not shown in this preview — '}
                  <button
                    type="button"
                    className="tool-call__approve-btn tool-call__approve-btn--secondary"
                    onClick={() => setShowFullResult(true)}
                  >
                    Show full result
                  </button>
                  {'\n'}
                </span>
                {boundedResult.tail}
              </>
            )}
          </pre>
        </div>
      )}
      {error && (
        <div className="tool-call__section tool-call__section--error">
          <strong>Error:</strong>
          <pre className="tool-call__code tool-call__code--error">{error}</pre>
        </div>
      )}
      {status && (
        <div
          className={`tool-call__status-footer${
            status === 'Failed' ? ' tool-call__status-footer--error' : ''
          }`}
        >
          {status === 'Success' ? '✓ ' : status === 'Failed' ? '✕ ' : ''}
          {status}
        </div>
      )}
      <div className="tool-call__meta">
        <span>
          <strong>ID:</strong> <code>{id}</code>
        </span>
        {server && (
          <span>
            <strong>Server:</strong> <code>{server}</code>
          </span>
        )}
        {toolName && (
          <span>
            <strong>Tool:</strong> <code>{toolName}</code>
          </span>
        )}
        {originalName && originalName !== `${server}_${toolName}` && (
          <span>
            <strong>Original Name:</strong> <code>{originalName}</code>
          </span>
        )}
        {approvalStatus === 'auto-approved' && (
          <span>
            <strong>Approval:</strong> Auto-approved
          </span>
        )}
        {approvalStatus === 'user-approved' && (
          <span>
            <strong>Approval:</strong> User approved
          </span>
        )}
        {lastProgress && (
          <em className="tool-call__last-progress">{lastProgress}</em>
        )}
      </div>
    </div>
  );
}

export const ToolCallDisplay = memo(ToolCallDisplayComponent);
