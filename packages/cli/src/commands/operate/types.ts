/**
 * Pure types for `station operate` (#168 Wave 1, Task 1A). This file is
 * TTY-free by contract: it must never import `readline`/`node:tty`/
 * `node:http`/`fetch` (grep-verifiable, see the plan's Task 1A acceptance
 * note) so `reduce()`/`render()`/the keypress-intent mapping can be unit
 * tested with zero process/terminal setup.
 *
 * `ApprovalDecision` is re-exported (type-only) from the SDK's canonical
 * `client/orchestration.ts` so `OperateIntent`'s `respond-approval` payload
 * stays in lockstep with `respondToRequest`'s accepted decisions rather than
 * re-declaring the same four strings — this is a type-only import (no
 * runtime code pulled in), so it does not violate the TTY-free/dependency
 * -free contract above.
 */
import type { FleetRoutingReceiptPage } from '@kontourai/station-contracts/fleet-routing-receipt';
import type { RequestAnswerability } from '@kontourai/station-contracts/orchestration';
import type { ApprovalDecision } from '@kontourai/station-sdk/client';

export type { ApprovalDecision };

/**
 * The fleet routing-receipt window this Station most recently reported
 * (station#1398 slice 4).
 *
 * `undefined` = never pulled, `null` = pulled and the read FAILED, a page =
 * the real thing. Three states for the same reason `gateSnapshot` has three:
 * "not asked" and "asked and could not answer" must not render as "nothing
 * has been fleet-routed". A receipt surface that shows an empty list for a
 * failed read is the silent-degradation shape §4.5 bans, applied to the
 * receipts themselves.
 *
 * Station-scoped, not session-scoped, and that is deliberate: a routing
 * decision is made for an AGENT's turn and the envelope records the agent
 * name, not a thread id — Dispatch's receipt carries no session identity at
 * any version (§3.4). Keying this pane by session would require inventing a
 * correlation nothing produces.
 */
export interface OperateFleetRouting {
  page: FleetRoutingReceiptPage | null;
  /** Why the read failed, when it did. */
  error?: string;
}

/**
 * A small, stable keypress shape decoupled from Node's raw `readline` key
 * object, so `reduce()`/`keys.ts`/tests never import `readline`. Wave 2's
 * `shell.ts` is responsible for translating
 * `readline.emitKeypressEvents`'s callback args into this shape.
 */
export interface KeyInfo {
  name?: string;
  ctrl: boolean;
  shift: boolean;
  sequence: string;
}

/**
 * Extends `approvals.ts`'s `PendingApproval` shape
 * (`packages/cli/src/commands/approvals.ts:49-56`) with `toolInput` — the
 * run-003 friction (3) gap ("approvals list lacks tool command/input for
 * informed decisions",
 * `.kontourai/flow-agents/s150-selfhosted/run-003-operator-log.md`).
 * `toolInput` is `unknown` because different providers put different shapes
 * on `request.opened`'s `payload.toolInput`
 * (`src-server/providers/adapters/claude-adapter.ts:361-363` for Claude's
 * `canUseTool` shape; other adapters may omit it).
 *
 * `createdAt` (the event's own ISO timestamp) is carried instead of a
 * precomputed `ageMs` (#168 iteration-2 review finding M1 fix) — computing
 * age at derivation time meant reading `Date.now()` inside the otherwise-pure
 * `derivePendingApprovalsForSession`, which both hid an impurity and froze
 * the displayed age between renders. `render.ts` computes the displayed age
 * from `state.now` (advanced once a second by the shell's `tick` action) at
 * render time instead.
 */
export interface OperateApproval {
  threadId: string;
  requestId: string;
  requestType: string;
  title: string;
  toolName?: string;
  toolInput?: unknown;
  createdAt?: string;
}

export type FlowGateVerdict = 'pass' | 'route-back' | 'block' | 'wait';

/**
 * The latest-observed `flow.gate-verdict` event's fields
 * (`packages/contracts/src/runtime-events.ts:225-252`), folded down to the
 * subset the gate-verdicts pane renders.
 */
export interface OperateGateVerdict {
  verdict: FlowGateVerdict;
  gateId?: string;
  summary?: string;
  nextAction?: string;
  missing?: string[];
  attempt?: number;
  maxAttempts?: number;
}

/**
 * The slim view `shell.ts` (Wave 2) maps the SDK's `getSessionFlowRun`
 * result (`SessionFlowRunView`, `packages/sdk/src/client/orchestration.ts`)
 * down to before dispatching a `flow-run-snapshot` action — keeps this pure
 * module decoupled from the SDK's richer `FlowRunStatus`/`FlowRunState`
 * shapes (`@kontourai/flow`'s `flow-types.d.ts:78-92`), which carry a lot
 * more than the gate pane needs (manifest, full definition, etc).
 */
export interface FlowRunSnapshotInput {
  runId: string;
  definitionId: string;
  currentStep?: string;
  status?: string;
  openGates: Array<{ id: string; step: string }>;
  /**
   * Freshness of the run's gate evaluation (station#189 S1). `status`/
   * `currentStep` alone read as progress even when nothing has been evaluated
   * — which is exactly what the gates pane rendered for the whole of the
   * dogfood run that found this. `lastEvaluatedAt: null` with
   * `gateOutcomeCount: 0` is "never evaluated", and `blockedReason:
   * 'ungated-step'` says the run cannot be evaluated at all on this step.
   * All optional: an older server sends none of them, which the pane reports
   * as unknown rather than as either progress or a stall.
   */
  lastEvaluatedAt?: string | null;
  blockedReason?: 'ungated-step';
  gateOutcomeCount?: number;
  evidenceCount?: number;
}

/**
 * Event-sourced (`flow.run-attached`/`flow.gate-verdict`) plus pulled
 * (`flow-run-snapshot` action) gate state for one session, per the plan's
 * exact shape (`bound`, `runId?`, `definitionId?`, `currentStep?`,
 * `status?`, `latestVerdict?`, `openGates?`).
 */
export interface OperateGateState {
  bound: boolean;
  runId?: string;
  definitionId?: string;
  currentStep?: string;
  status?: string;
  latestVerdict?: OperateGateVerdict;
  openGates?: Array<{ id: string; step: string }>;
  /** Pulled freshness (station#189 S1); see `FlowRunSnapshotInput`. */
  lastEvaluatedAt?: string | null;
  blockedReason?: 'ungated-step';
  gateOutcomeCount?: number;
  evidenceCount?: number;
}

/**
 * The Builder run joined to the focused session (station#189 S4), as pulled
 * from `GET /sessions/:threadId/builder-run`. `null` = pulled and confirmed
 * nothing joinable; `undefined` = never pulled — the same three-state
 * convention `gateSnapshot` uses, and for the same reason: "not asked" and
 * "asked, nothing there" must not render the same way.
 *
 * Kept structurally separate from `OperateGateState` on purpose. This is a
 * different run, from a different lifecycle, and the pane renders it as its
 * own row; a shared shape would invite exactly the merge station#189 is
 * about.
 */
export interface OperateBuilderRun {
  identityStatus: 'present' | 'unavailable' | 'unsupported';
  matchKind: 'started-by-station' | 'correlation-matched' | 'none';
  reason?: string;
  taskSlug?: string;
  /**
   * The binding named a task whose sidecar could not be read — a broken
   * binding, NOT a run that has published nothing yet. The pane must not
   * print "no run projection published yet" for it.
   */
  taskSidecarUnreadable?: true;
  runRef?: string;
  definitionId?: string;
  currentStep?: string;
  status?: string;
  openGateIds?: string[];
  /** `state.json.updated_at` — when the sidecar FILE was last written. */
  sidecarUpdatedAt?: string;
}

/** One row of the session board — mirrors the small subset of
 * `OrchestrationSessionSummary` fields the board table renders. */
export interface OperateBoardRow {
  threadId: string;
  provider?: string;
  status?: string;
  model?: string;
  lastEventMethod?: string;
  updatedAt?: string;
  isLoaded?: boolean;
  isPersisted?: boolean;
  eventCount?: number;
  /**
   * The serving Station's answerability observation for this session, or
   * `null` when this row has never carried one.
   *
   * REQUIRED — including the `null` — following the same enforcement ADR
   * 0012 put on the wire types: a row that could be constructed without
   * saying anything about answerability is a row the approvals pane renders
   * as live with nothing behind it. There are two construction sites and
   * they are genuinely different facts, which is exactly why the absence has
   * to be spelled rather than defaulted: `deriveBoardRowsFromSnapshot` has
   * the decorated summary and passes the observation through, while the
   * live-event path (`state.ts`'s `'event'` branch) invents a row for a
   * thread no snapshot has described yet and has observed NOTHING. Folding
   * that second case to `{ answerable: true }` would be a default that
   * decides — it renders identically to a real positive observation.
   */
  answerability: RequestAnswerability | null;
}

export type OperateConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

/**
 * Per-session slice of `OperateState`. `events` is the capped raw-event
 * buffer (cap: 500 events/session, oldest-evicted) derive.ts's fold
 * functions operate over; `approvals`/`gateState` are recomputed from
 * `events` (plus any pulled `gateSnapshot`) every time `reduce()` applies an
 * `event`/`flow-run-snapshot` action for this thread, so callers (keypress
 * handling, `render()`) always read a ready-made view instead of re-folding
 * on every access.
 */
export interface OperateSessionState {
  threadId: string;
  events: Array<Record<string, unknown>>;
  approvals: OperateApproval[];
  selectedApprovalIndex: number;
  gateState: OperateGateState;
  /**
   * The last `getSessionFlowRun` pull result: `undefined` = never pulled,
   * `null` = pulled and confirmed not Flow-bound (the route's 404), an
   * object = the slim pulled snapshot. Kept alongside `gateState` (which is
   * always the merged view) so a later `event` action can re-derive
   * `gateState` without losing the previously pulled `openGates`/
   * `currentStep`/`status`.
   */
  gateSnapshot?: FlowRunSnapshotInput | null;
  /**
   * The last `getSessionBuilderRun` pull result (station#189 S4). Same
   * three-state convention as `gateSnapshot`: `undefined` = never pulled,
   * `null` = pulled and nothing joinable, an object = the joined view.
   */
  builderRun?: OperateBuilderRun | null;
}

export interface OperateState {
  connectionStatus: OperateConnectionStatus;
  connectionError?: string;
  focusedThreadId?: string;
  board: OperateBoardRow[];
  sessions: Record<string, OperateSessionState>;
  pendingIntent: OperateIntent | null;
  /** station#1398 slice 4. `undefined` = never pulled; see the type's doc. */
  fleetRouting?: OperateFleetRouting;
  now: number;
}

export type OperateAction =
  | { type: 'snapshot'; sessions: Array<Record<string, unknown>> }
  | { type: 'event'; event: Record<string, unknown> }
  | { type: 'focus-change'; threadId: string }
  | {
      type: 'flow-run-snapshot';
      threadId: string;
      snapshot: FlowRunSnapshotInput | null;
    }
  | {
      type: 'builder-run-snapshot';
      threadId: string;
      builderRun: OperateBuilderRun | null;
    }
  | { type: 'fleet-routing-snapshot'; fleetRouting: OperateFleetRouting }
  | { type: 'keypress'; key: KeyInfo }
  | {
      type: 'connection-status';
      status: OperateConnectionStatus;
      error?: string;
    }
  | { type: 'tick'; now: number }
  | { type: 'clear-intent' };

/**
 * The (at most one) pending side effect a keypress produced, computed
 * purely by `reduce()` and read by the shell after each dispatch. The shell
 * performs the side effect (if any — several bindings, e.g. `move-selection`,
 * are pure and need no shell action beyond clearing the intent) then
 * dispatches `{type:'clear-intent'}`.
 */
export type OperateIntent =
  | {
      type: 'respond-approval';
      threadId: string;
      requestId: string;
      decision: ApprovalDecision;
    }
  | { type: 'refresh-focus'; threadId: string }
  | { type: 'quit' }
  | { type: 'move-focus'; direction: 'next' | 'prev' }
  | { type: 'move-selection'; direction: 'up' | 'down' };
