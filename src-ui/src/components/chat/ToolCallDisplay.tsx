import { approvalDecisionBody } from '@kontourai/station-shared/input-request';
import {
  type ToolRequestSessionGrant,
  toolRequestGrantLabel,
  toolRequestSessionGrant,
} from '@kontourai/station-shared/tool-request-preview';
import { memo, type ReactNode, useMemo, useState } from 'react';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useRevealOnce } from '../../hooks/useRevealOnce';
import { attentionWord } from '../../views/home/work-status';
import {
  DiscardGlyph,
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
import { DecisionActionRow, DecisionButtons } from './InputRequestDecision';
import {
  RequestSheet,
  RequestSheetTrigger,
  useRequestSheet,
} from './RequestSheet';
import {
  callLabel,
  classifyToolCall,
  isToolCallAwaitingApproval,
  type ToolCallKind,
  toolCallPhase,
} from './tool-call-labels';
import { toolDisplayView } from './tool-display-view';

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
  /** The engine's own category (ACP `ToolKind`), when it reported one. */
  toolKind?: string;
  server?: string;
  originalName?: string;
  purpose?: string;
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
  /** #2316: the thread of the request that set `approvalId`. */
  approvalThreadId?: string;
  /** See `MessagePart.approvalToolName` — what the session grant names. */
  approvalToolName?: string;
  /** #2915/#2916: what a session answer grants; see `MessagePart`. */
  approvalSessionGrant?: ToolRequestSessionGrant;
  cancelled?: boolean;
  approvalStatus?:
    | 'auto-approved'
    | 'user-approved'
    | 'user-denied'
    | 'policy-denied';
}

/**
 * #2316: how an approval decision landed. `already-settled` means Station
 * refused it because the request is no longer open (answered elsewhere,
 * closed by the engine, cancelled, or expired) — verified against the
 * request itself, not inferred from an error.
 */
export type ToolApprovalOutcome = 'answered' | 'already-settled';

type ToolApprovalHandler = (
  action: 'once' | 'trust' | 'deny',
) => void | Promise<ToolApprovalOutcome | void>;

interface ToolCallDisplayProps {
  toolCall: ToolCallData;
  /**
   * #2316: resolves when Station accepted the decision (or found it already
   * settled), rejects when it did not. The card stays actionable and says so
   * on rejection.
   */
  onApprove?: ToolApprovalHandler;
  showDetails?: boolean;
}

export const KIND_GLYPH: Record<
  ToolCallKind,
  React.ComponentType<{ className?: string }>
> = {
  read: DocumentGlyph,
  write: EditGlyph,
  delete: DiscardGlyph,
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
  const display = toolDisplayView(toolCall);
  const toolName = display.toolName;
  const originalName = toolCall.originalName;
  const args = display.args;
  const result = display.result;
  const error = display.error;
  const cancelled = toolCall.cancelled || toolCall.state === 'cancelled';
  // station#1558: a call whose SESSION ended before any result arrived. Both
  // write paths stamp the same state — `runtime-event-projection.ts` on
  // rehydration and `streamHandlers.ts` live — and the engine's own
  // explanation rides along as the result text.
  const unresolved = toolCall.state === 'unresolved';
  const approvalStatus = toolCall.approvalStatus;
  const state = toolCall.state;
  const progressMessage = toolCall.progressMessage;
  const outputTruncated = toolCall.outputTruncated === true;
  const purpose = display.purpose;

  const failed = Boolean(error) || state === 'error';
  const awaitingApproval = isToolCallAwaitingApproval(toolCall);

  const kind = classifyToolCall({
    toolName,
    toolKind: toolCall.toolKind,
    args,
  });
  const denied =
    approvalStatus === 'user-denied' || approvalStatus === 'policy-denied';
  const phase = toolCallPhase(toolCall);
  const running = phase === 'running';
  // Every other unresolved outcome already carries a badge below (Cancelled,
  // User denied, Blocked by Station; a plain failure is its own `failed`
  // phase with a Failed badge). This is the one that does not: dispatched,
  // and no completion event ever arrived.
  const unresolvedWithoutOutcome =
    phase === 'unresolved' && !failed && !cancelled && !denied && !unresolved;
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
  const allowDetails = showDetails || (awaitingApproval && Boolean(onApprove));

  const Glyph = KIND_GLYPH[kind];
  const lineContent = (
    <>
      <span className="tool-call__glyph" aria-hidden="true">
        <Glyph />
      </span>
      <span className="tool-call__label">{label}</span>
      {purpose && <span className="tool-call__purpose">Why: {purpose}</span>}
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
      {unresolved && !failed && !cancelled && (
        // station#1558: distinct from "No result recorded" below, which is
        // inferred from a start with no terminal event at all. This one is
        // REPORTED: the engine session ended with the call open, so the
        // absence is a fact Station observed rather than one it noticed.
        <span className="tool-call__status-badge">No result was reported</span>
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
          aria-label={attentionWord('approval')}
          title={attentionWord('approval')}
        >
          <PauseGlyph />
        </span>
      )}
    </>
  );

  // What a session grant would be for: the tool name the REQUEST reported
  // (projected as `approvalToolName`), never the row's `toolName`, which for a
  // nameless ACP or Codex call is display text — a whole command line. A
  // registry-route part carries no request binding and names its own tool.
  const grantToolName = toolCall.approvalThreadId
    ? toolCall.approvalToolName
    : toolCall.toolName;
  // The header "Approval needed" pill brings the user here: an answerable
  // card names the request it answers.
  const answerable = awaitingApproval && Boolean(onApprove);
  return (
    <div
      className={revealClass ? `tool-call ${revealClass}` : 'tool-call'}
      data-approval-thread={
        answerable ? (toolCall.approvalThreadId ?? undefined) : undefined
      }
      data-approval-id={answerable ? toolCall.approvalId : undefined}
    >
      <div className="tool-call__row">
        {hasDetail && allowDetails ? (
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
            <ToolApprovalControls
              onApprove={onApprove}
              grantToolName={grantToolName}
              sessionGrant={
                // A part without the projected grant (a registry-route
                // request) is judged by its tool name alone.
                toolCall.approvalSessionGrant ??
                toolRequestSessionGrant({ toolName: grantToolName })
              }
              summary={label}
              details={
                hasDetail ? (
                  <ToolCallDetails
                    id={id}
                    server={server}
                    toolName={toolName}
                    originalName={originalName}
                    args={args}
                    result={result}
                    error={error}
                    cancelled={cancelled}
                    unresolved={unresolved}
                    approvalStatus={approvalStatus}
                  />
                ) : null
              }
            />
          </div>
        )}
      </div>
      {/* Collapsed-visible only while genuinely running — a settled row
          repeating its last progress line would read as ongoing activity.
          The final message is retained in the expanded detail instead. */}
      {progressMessage && running && (
        <div className="tool-call__progress">{progressMessage}</div>
      )}
      {isExpanded && hasDetail && allowDetails && (
        <ToolCallDetails
          id={id}
          server={server}
          toolName={toolName}
          originalName={originalName}
          args={args}
          result={result}
          error={error}
          cancelled={cancelled}
          unresolved={unresolved}
          approvalStatus={approvalStatus}
          lastProgress={running ? undefined : progressMessage}
        />
      )}
    </div>
  );
}

/**
 * #2316: a decision is not done until Station accepts it. While it is in
 * flight the buttons are disabled (a second click would answer a request the
 * first may already have settled); a rejected decision re-enables them and
 * names the failure, because the request is still open and still waiting on
 * the user. After success they stay disabled until the durable
 * `request.resolved` settles the row and unmounts this control.
 */
type ApprovalPhase = 'idle' | 'sending' | 'sent' | 'already-settled';

/** The decision lifecycle above, shared by the inline buttons and the sheet. */
function useApprovalDecision(onApprove: ToolApprovalHandler) {
  const [phase, setPhase] = useState<ApprovalPhase>('idle');
  const [failure, setFailure] = useState<string | null>(null);
  const [chosen, setChosen] = useState<'once' | 'trust' | 'deny'>();
  const decide = (action: 'once' | 'trust' | 'deny') => {
    if (phase !== 'idle') return;
    setChosen(action);
    setPhase('sending');
    setFailure(null);
    // The handler is called in the click, and the buttons are disabled before
    // it returns, so a second click cannot race it. The request itself may
    // leave a tick later: the answer path is loaded on demand
    // (`useToolApproval`). Only the outcome is awaited here.
    let sent: ReturnType<ToolApprovalHandler>;
    try {
      sent = onApprove(action);
    } catch (error) {
      sent = Promise.reject(error);
    }
    Promise.resolve(sent).then(
      (outcome) =>
        setPhase(outcome === 'already-settled' ? 'already-settled' : 'sent'),
      (error: unknown) => {
        setPhase('idle');
        setFailure(
          error instanceof Error && error.message
            ? error.message
            : 'Station did not accept this decision.',
        );
      },
    );
  };
  return { phase, failure, decide, chosen, busy: phase !== 'idle' };
}

function ApprovalDecisionStatus({
  phase,
  failure,
}: {
  phase: ApprovalPhase;
  failure: string | null;
}) {
  return (
    <>
      {phase === 'already-settled' && (
        <p className="tool-call__approve-status" role="status">
          This request is no longer open.
        </p>
      )}
      {failure && (
        <p className="tool-call__approve-error" role="alert">
          Your decision was not delivered: {failure}
        </p>
      )}
    </>
  );
}

interface ToolApprovalControlProps {
  onApprove: ToolApprovalHandler;
  /** The request's reported tool name — never the row's display name. */
  grantToolName?: string;
  sessionGrant: ToolRequestSessionGrant;
}

/**
 * #3331: a desktop answers in the row; a phone answers in the shared request
 * sheet, with the row itself as the persistent card. Only an awaiting row
 * mounts this, so the viewport subscription is per open request, not per
 * transcript row — and a request that settles unmounts it, closing any open
 * sheet with it.
 */
function ToolApprovalControls({
  summary,
  details,
  ...props
}: ToolApprovalControlProps & { summary: ReactNode; details: ReactNode }) {
  const isMobile = useIsMobile();
  return isMobile ? (
    <ToolApprovalSheet {...props} summary={summary} details={details} />
  ) : (
    <ToolApprovalButtons {...props} />
  );
}

function ToolApprovalSheet({
  onApprove,
  grantToolName,
  sessionGrant,
  summary,
  details,
}: ToolApprovalControlProps & { summary: ReactNode; details: ReactNode }) {
  const { phase, failure, decide, chosen, busy } =
    useApprovalDecision(onApprove);
  const sheet = useRequestSheet(true);
  // Accepted but not yet settled reads as in progress, not as a frozen
  // sheet: the row stays until the durable `request.resolved` removes it.
  const inFlight = phase === 'sending' || phase === 'sent';
  const grantLabel = toolRequestGrantLabel(grantToolName, sessionGrant);
  const status = <ApprovalDecisionStatus phase={phase} failure={failure} />;
  return (
    <>
      <RequestSheetTrigger
        ref={sheet.triggerRef}
        onClick={sheet.show}
        compact
      />
      {!sheet.open && status}
      {sheet.open && (
        <RequestSheet
          title="Approval needed"
          subtitle={summary}
          onDismiss={sheet.dismiss}
          returnFocusTarget={sheet.triggerRef.current}
          actions={
            <DecisionActionRow
              body={approvalDecisionBody(grantLabel)}
              busy={busy}
              inFlight={inFlight}
              chosen={chosen}
              onChoose={decide}
            />
          }
        >
          {details ?? <p className="request-sheet__status">{summary}</p>}
          {status}
        </RequestSheet>
      )}
    </>
  );
}

function ToolApprovalButtons({
  onApprove,
  grantToolName,
  sessionGrant,
}: ToolApprovalControlProps) {
  const { phase, failure, decide } = useApprovalDecision(onApprove);
  const busy = phase !== 'idle';
  // #2915/#2916: undefined where no session grant is offered.
  const grantLabel = toolRequestGrantLabel(grantToolName, sessionGrant);
  // #3390: the options come from the approval's decision body. #2316: the
  // session option's label is the same words as the toast and the inbox
  // card for the same grant, and names the REQUEST's tool, never the row's
  // `toolName`, which can be an ACP title — a whole command line.
  return (
    <>
      <DecisionButtons
        body={approvalDecisionBody(grantLabel)}
        busy={busy}
        onChoose={decide}
      />
      <ApprovalDecisionStatus phase={phase} failure={failure} />
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
  unresolved,
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
  /** station#1558 — the session ended with this call still open. */
  unresolved?: boolean;
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
      : // station#1558: checked BEFORE the `result` arm — the unresolved
        // row's `result` is the sentence explaining that there is no
        // result, and reading it as one would print "Success".
        unresolved
        ? 'No result was reported'
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
