/**
 * Pure fold helpers for `station operate` (#168 Wave 1, Task 1A). Every
 * function here operates on a per-session capped raw-event buffer (cap: 500
 * events/session, oldest-evicted — enforced by `state.ts`'s `event` reducer
 * branch, not here) and returns a plain view model; nothing in this file
 * performs I/O or imports `readline`/`node:tty`/`node:http`/`fetch`.
 */
import { normalizeRequestAnswerability } from '@kontourai/station-contracts/orchestration';
import type {
  FlowRunSnapshotInput,
  OperateApproval,
  OperateBoardRow,
  OperateGateState,
  OperateGateVerdict,
} from './types.js';

/**
 * Mirrors `approvals.ts`'s `derivePendingApprovals`
 * (`packages/cli/src/commands/approvals.ts:63-107`), which itself mirrors
 * the server's own pending-request projection
 * (`src-server/services/orchestration/orchestration-session-state.ts:174-184`, inlined
 * into `buildAgentRunSummary`'s `hasOpenRequest` computation there): a
 * `request.opened` event is pending unless a later `request.resolved` event
 * for the same `requestId` exists in the same buffer.
 *
 * Extended per run-003 friction (3)
 * (`.kontourai/flow-agents/s150-selfhosted/run-003-operator-log.md`) to also
 * carry `payload.toolInput` — confirmed present on the `request.opened`
 * event payload at `src-server/providers/adapters/claude-adapter.ts:361-363`
 * (`payload: {toolName, toolInput, blockedPath, displayName, suggestions}`).
 * This is a local, cited-not-forked derivation living entirely inside
 * `operate/` (per the plan's pull-work rollout note) — `approvals.ts`'s own
 * `PendingApproval` type/output is untouched.
 *
 * TRUE pure function (#168 iteration-2 review finding M1 fix): this used to
 * call `Date.now()` internally to precompute `ageMs`, which made identical
 * inputs (`events`) produce a different output on every call — a hidden
 * impurity that also froze the *displayed* age between ticks, since nothing
 * re-derived it. Fixed by carrying only `createdAt` (the event's own ISO
 * timestamp) on the returned `OperateApproval` and pushing the wall-clock
 * read entirely out to `render.ts`, which computes the displayed age from
 * `state.now` (updated once a second by the shell's `tick` action) at
 * render time. `derivePendingApprovalsForSession(events)` now reads nothing
 * but its `events` argument — same input, same output, always.
 */
export function derivePendingApprovalsForSession(
  events: Array<Record<string, unknown>>,
): OperateApproval[] {
  const resolvedRequestIds = new Set(
    events
      .filter((event) => event.method === 'request.resolved')
      .map((event) => event.requestId as string | undefined)
      .filter((id): id is string => typeof id === 'string'),
  );

  const pending: OperateApproval[] = [];
  for (const event of events) {
    if (event.method !== 'request.opened') {
      continue;
    }
    const requestId =
      typeof event.requestId === 'string' ? event.requestId : undefined;
    if (!requestId || resolvedRequestIds.has(requestId)) {
      continue;
    }
    const payload =
      event.payload && typeof event.payload === 'object'
        ? (event.payload as Record<string, unknown>)
        : undefined;
    const createdAt =
      typeof event.createdAt === 'string' ? event.createdAt : undefined;
    const threadId = typeof event.threadId === 'string' ? event.threadId : '';

    pending.push({
      threadId,
      requestId,
      requestType:
        typeof event.requestType === 'string' ? event.requestType : 'unknown',
      title: typeof event.title === 'string' ? event.title : '',
      toolName:
        typeof payload?.toolName === 'string' ? payload.toolName : undefined,
      toolInput: payload?.toolInput,
      createdAt,
    });
  }
  return pending;
}

const VALID_GATE_VERDICTS = new Set(['pass', 'route-back', 'block', 'wait']);

/**
 * Folds `flow.run-attached` (binding: `runId`, `definitionId`, `cwd` —
 * `packages/contracts/src/runtime-events.ts:216-223`) and
 * `flow.gate-verdict` (`verdict`, `gateId?`, `summary?`, `nextAction?`,
 * `missing?`, `attempt?`/`maxAttempts?` — `runtime-events.ts:225-252`)
 * events into "is this session Flow-bound" and "the latest known verdict",
 * latest-event-wins for each. The last `flow.run-attached` event in a
 * session's history is the authoritative binding (per that event's own
 * docblock); the last `flow.gate-verdict` event is the latest verdict.
 *
 * `pulled`, when provided, is the last `getSessionFlowRun` pull result
 * (`FlowRunSnapshotInput`, `undefined` = never pulled, `null` = pulled and
 * confirmed not Flow-bound via the route's 404) and overlays `openGates`/
 * `currentStep`/`status` on top of the event-sourced fold — gates that have
 * never been evaluated (`openGates`) have no event at all, so they can only
 * come from the pull.
 */
export function deriveGateStateForSession(
  events: Array<Record<string, unknown>>,
  pulled?: FlowRunSnapshotInput | null,
): OperateGateState {
  let bound = false;
  let runId: string | undefined;
  let definitionId: string | undefined;
  let latestVerdict: OperateGateVerdict | undefined;

  for (const event of events) {
    if (event.method === 'flow.run-attached') {
      bound = true;
      runId = typeof event.runId === 'string' ? event.runId : runId;
      definitionId =
        typeof event.definitionId === 'string'
          ? event.definitionId
          : definitionId;
      continue;
    }
    if (event.method === 'flow.gate-verdict') {
      const verdict = event.verdict;
      if (typeof verdict === 'string' && VALID_GATE_VERDICTS.has(verdict)) {
        latestVerdict = {
          verdict: verdict as OperateGateVerdict['verdict'],
          gateId: typeof event.gateId === 'string' ? event.gateId : undefined,
          summary:
            typeof event.summary === 'string' ? event.summary : undefined,
          nextAction:
            typeof event.nextAction === 'string' ? event.nextAction : undefined,
          missing: Array.isArray(event.missing)
            ? (event.missing as string[])
            : undefined,
          attempt:
            typeof event.attempt === 'number' ? event.attempt : undefined,
          maxAttempts:
            typeof event.maxAttempts === 'number'
              ? event.maxAttempts
              : undefined,
        };
      }
      runId = typeof event.runId === 'string' ? event.runId : runId;
    }
  }

  if (pulled) {
    bound = true;
    runId = pulled.runId ?? runId;
    definitionId = pulled.definitionId ?? definitionId;
  }

  return {
    bound,
    ...(runId ? { runId } : {}),
    ...(definitionId ? { definitionId } : {}),
    ...(pulled?.currentStep ? { currentStep: pulled.currentStep } : {}),
    ...(pulled?.status ? { status: pulled.status } : {}),
    ...(latestVerdict ? { latestVerdict } : {}),
    ...(pulled?.openGates ? { openGates: pulled.openGates } : {}),
    // Freshness comes only from a pull; there is no event that carries it.
    // `lastEvaluatedAt` is carried through even when null — null is the
    // meaningful "never evaluated" value, not a missing field.
    ...(pulled && 'lastEvaluatedAt' in pulled
      ? { lastEvaluatedAt: pulled.lastEvaluatedAt }
      : {}),
    ...(pulled?.blockedReason ? { blockedReason: pulled.blockedReason } : {}),
    ...(typeof pulled?.gateOutcomeCount === 'number'
      ? { gateOutcomeCount: pulled.gateOutcomeCount }
      : {}),
    ...(typeof pulled?.evidenceCount === 'number'
      ? { evidenceCount: pulled.evidenceCount }
      : {}),
  };
}

/**
 * Maps the `orchestration:snapshot` payload's session list
 * (`OrchestrationSessionSummary[]`, `src-server/routes/
 * orchestration.ts:305-309`'s `{sessions}`) into board-row view models.
 */
export function deriveBoardRowsFromSnapshot(
  sessions: Array<Record<string, unknown>>,
): OperateBoardRow[] {
  return sessions.map((session) => ({
    threadId: String(session.threadId),
    provider:
      typeof session.provider === 'string' ? session.provider : undefined,
    status: typeof session.status === 'string' ? session.status : undefined,
    model: typeof session.model === 'string' ? session.model : undefined,
    lastEventMethod:
      typeof session.lastEventMethod === 'string'
        ? session.lastEventMethod
        : undefined,
    updatedAt:
      typeof session.updatedAt === 'string' ? session.updatedAt : undefined,
    isLoaded:
      typeof session.isLoaded === 'boolean' ? session.isLoaded : undefined,
    isPersisted:
      typeof session.isPersisted === 'boolean'
        ? session.isPersisted
        : undefined,
    eventCount:
      typeof session.eventCount === 'number' ? session.eventCount : undefined,
    // station#1782 AC3. The snapshot payload's sessions are decorated
    // `OrchestrationSessionSummary`s, so the operate TUI gets the serving
    // Station's answerability observation for free and never re-derives it.
    // Normalized because this crosses the wire as an untyped record: a peer
    // older than ADR 0012 sends no member at all, and the required type
    // would otherwise be `undefined` at runtime for every row.
    answerability: normalizeRequestAnswerability(session.answerability),
  }));
}

/**
 * Patches a board row's `status`/`lastEventMethod`/`updatedAt` the same way
 * `projectOrchestrationEventToReadModel` does server-side
 * (`src-server/services/orchestration/orchestration-session-state.ts:48-105`, status
 * mapping at `:311-318`'s `mapOrchestrationSessionState`) — cited, not
 * reinvented — for the small subset of fields the board displays.
 */
export function applyEventToBoardRow(
  row: OperateBoardRow,
  event: Record<string, unknown>,
): OperateBoardRow {
  const method = typeof event.method === 'string' ? event.method : undefined;
  const createdAt =
    typeof event.createdAt === 'string' ? event.createdAt : undefined;

  let status = row.status;
  switch (method) {
    case 'session.started':
      status = 'connecting';
      break;
    case 'session.configured':
      status = row.status === 'closed' ? 'closed' : 'ready';
      break;
    case 'session.state-changed':
      if (typeof event.to === 'string') {
        status = mapSessionLifecycleState(event.to);
      }
      break;
    case 'session.exited':
      status = 'closed';
      break;
    default:
      break;
  }

  return {
    ...row,
    status,
    lastEventMethod: method ?? row.lastEventMethod,
    updatedAt: createdAt ?? row.updatedAt,
  };
}

/** Mirrors `mapOrchestrationSessionState` (`orchestration-session-state.ts:311-318`). */
function mapSessionLifecycleState(state: string): string {
  if (state === 'running') return 'running';
  if (state === 'errored') return 'error';
  if (state === 'exited') return 'closed';
  return 'ready';
}

/**
 * Pure focus-cycling arithmetic shared by `state.ts`'s `keypress` reducer
 * branch (`Tab`/`Shift+Tab`) — not named in the plan's Task 1A file list
 * explicitly, added here (rather than inlined in `state.ts`) so it stays
 * independently testable and reusable by Wave 2's shell if it ever needs to
 * recompute the same ordering (e.g. for `--session` validation).
 */
export function nextFocusedThreadId(
  board: OperateBoardRow[],
  currentThreadId: string | undefined,
  direction: 'next' | 'prev',
): string | undefined {
  if (board.length === 0) {
    return currentThreadId;
  }
  const currentIndex = currentThreadId
    ? board.findIndex((row) => row.threadId === currentThreadId)
    : -1;
  if (currentIndex === -1) {
    return board[0]?.threadId;
  }
  const delta = direction === 'next' ? 1 : -1;
  const nextIndex = (currentIndex + delta + board.length) % board.length;
  return board[nextIndex]?.threadId;
}
