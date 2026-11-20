import crypto from 'node:crypto';
import type { EngineCommandOutcome } from '@kontourai/station-contracts/engine-commands';
import type {
  InputRequestContent,
  InputRequestForm,
} from '@kontourai/station-contracts/input-request';
import {
  type ApprovalMode,
  ENGINE_TURN_FAILED_CODE,
  FIRST_TURN_INSTRUCTIONS_COMPOSED_METADATA_KEY,
  MUSE_APPROVAL_DECIDE_FAILED_CODE,
  MUSE_APPROVAL_EXPIRED_CODE,
  MUSE_APPROVAL_MODE_NOT_APPLIED_CODE,
  MUSE_MODEL_RETRY_SCHEDULED_CODE,
  MUSE_MODEL_ROUTE_UNSERVED_CODE,
  MUSE_SERVE_HOST_EXITED_CODE,
  MUSE_SERVE_SCHEMA_UNVERIFIED_COMPATIBLE_CODE,
} from '@kontourai/station-contracts/provider';
import type {
  PlanEntry,
  PlanEntryStatus,
  ProviderRuntimeErrorBody,
  ProviderRuntimeErrorEvent,
} from '@kontourai/station-contracts/runtime-events';
import {
  type ApprovalAcknowledgement,
  type ApprovalStatus,
  type ProviderRuntimeEvent as CanonicalRuntimeEvent,
  PROVIDER_TURN_TRIGGER,
} from '@kontourai/station-contracts/runtime-events';
import {
  SESSION_GOAL_OBJECTIVE_MAX_CHARS,
  type SessionGoal,
  type SessionGoalControlResult,
} from '@kontourai/station-contracts/session-goal';
import { validateInputRequestContent } from '@kontourai/station-shared/input-request';
import { redactSecrets } from '@kontourai/station-shared/redaction';
import { errorMessage } from '../../utils/error-message.js';
import { isRecord } from '../../utils/is-record.js';
import type { Logger } from '../../utils/logger.js';
import {
  type ProviderChildSteerResult,
  type ProviderInterruptTurnResult,
  type ProviderTaskStopResult,
  ProviderTurnEndedError,
  ProviderTurnInProgressError,
  SendTurnRefusedError,
} from '../adapter-shape.js';
import { providerFailure } from '../provider-failure.js';
import { projectBoundedToolOutput } from '../tool-output-projection.js';
import { museAnswers, museInputRequest } from './harness-questions.js';
import type { MuseReasoningEffort } from './muse-adapter-types.js';
import {
  adoptMuseBackgroundTasks,
  createMuseServeChildWorkState,
  type MuseServeChildWorkContext,
  museServeChildIsRunning,
  museServeChildSteerable,
  museServeChildStopMethod,
  museServeHasRunningChildren,
  observeMuseSubagentItem,
  observeMuseToolCallItem,
  observeMuseWorkflowItem,
  observeMuseWorkflowLaunch,
  recordMuseChildStopRequested,
  settleOpenMuseChildren,
} from './muse-serve-child-work.js';
import {
  type MuseServeCloseInfo,
  MuseServeConnection,
  MuseServeRpcError,
  type MuseServeSpawnResult,
  MuseServeTimeoutError,
} from './muse-serve-rpc.js';
import {
  type MuseServeSchemaCheck,
  type MuseServeSchemaVerdict,
  museServeKnownSchemaVerdict,
} from './muse-serve-schema.js';
import { UNRESOLVED_TURN_TOOL_OUTPUT } from './unresolved-tool-output.js';

/**
 * #2452: one Station session driven through a `muse serve` (MSP) host.
 *
 * What the live probes (Muse Code 1.3.0-R3401.1, re-checked against 1.4.18
 * and 1.4.20)
 * established, and what this module relies on (captures in
 * `__tests__/fixtures/muse-serve-1.3.0-*` and `muse-serve-1.4.18-*`):
 *
 * - Handshake: `initialize` (the reply carries the stable-surface schema
 *   fingerprint) → `initialized` → `session/start {commandId, workspaceRoot,
 *   approvalMode, modelId?}`. Provider, model, workspace and approval mode
 *   travel on the wire; sandbox posture is fixed per host process
 *   (`--disable-sandbox`).
 * - Sessions are durable: a fresh host re-attaches with `session/resume`
 *   and keeps context. `--no-session-log` never delivers turn or item
 *   events, so it is never passed.
 * - Every approval arrives as an `approval/requested` NOTIFICATION, a
 *   subagent's with `subagentOrigin`; 1.4 also presents it as an
 *   `approval/request` server REQUEST, answered with an empty presentation
 *   receipt and folded into the same approval by its id. One command can
 *   need several stages: `approval/decide` answers `terminal: false` and an
 *   `approval/updated` names the next `currentRequirementId`. The outcome is
 *   `approval/resolved`. The host NEVER times an unanswered approval out, so
 *   Station bounds it ({@link MUSE_APPROVAL_DEADLINE_MS}).
 * - After background work finishes, the host starts a follow-up turn of its
 *   own, with a turn id no client minted. It is adopted as a provider turn
 *   (`metadata.trigger: 'provider'`, #2324), and a send is refused while it
 *   runs rather than queued into it.
 * - 1.4.18: the model's `request_user_input` tool asks the user through a
 *   `userInput/request` server REQUEST plus a `userInput/requested`
 *   notification with the same params (one Station request, keyed by
 *   `userInputId`). The answer is the `userInput/answer` command (`{status:
 *   'accepted'}`), the decline `userInput/cancel`, and the outcome
 *   `userInput/settled`. `approval/listPending` lists open prompts as
 *   `userInputs` (full request params) for a re-hosted session.
 * - 1.4.18: `turn/steer {expectedTurnId}` joins input to the running turn
 *   (`{status: 'accepted', turnId}`); with no such run it is refused
 *   -32030 `commandRejected` (`missing_run`).
 * - 1.4.18 (live): `session/tokenUsage` carries one completion's `usage` and
 *   the session's `cumulative` totals, whose `cost {usd, partial}` was
 *   absent on the probed provider; `turn/modelAttemptStarted` is emitted
 *   per model call. 1.4.20 (live, `muse-serve-1.4.20-cost-context`) on a
 *   priced provider sends `cumulative.cost {usd, partial: false}` and
 *   `session/contextUsage {windowTokens, usedTokens, pressure}`. Schema-only
 *   (never observed live): `session/todoListChanged`, `session/modelChanged`,
 *   `session/modelRouteUnserved`, `turn/retryScheduled` and
 *   `turn/modelRetryScheduled`; each is mapped from its 1.4.18 schema shape.
 *   `session/reasoningEffortChanged` follows a `session/setReasoningEffort`,
 *   which Station never sends (the tier rides each `turn/start`), and no
 *   canonical event records a standing effort, so it is not mapped.
 */

type MuseServeLogger = Pick<Logger, 'warn' | 'info'>;

/**
 * Station's bound on an unanswered Muse approval. `muse serve` never expires
 * one itself; past this Station declines it (`abort`, with feedback) and the
 * request resolves `expired`, so the turn or subagent that asked continues.
 * The same order as the lingering-child reap (30 minutes): long enough for a
 * person who stepped away, short enough that nothing waits forever.
 */
export const MUSE_APPROVAL_DEADLINE_MS = 30 * 60_000;
/**
 * #2880: `muse serve` closes each approval with `approval/resolved`, which
 * acknowledges the decision Station recorded. The metadata declaration and
 * every decision's `request.resolved` read this one value.
 */
export const MUSE_SERVE_APPROVAL_ACKNOWLEDGEMENT: ApprovalAcknowledgement =
  'engine';
export const MUSE_SERVE_HANDSHAKE_TIMEOUT_MS = 20_000;
export const MUSE_SERVE_REQUEST_TIMEOUT_MS = 30_000;
/** How long an interrupt waits for the turn's own `cancelled` terminal. */
export const MUSE_SERVE_INTERRUPT_SETTLE_MS = 10_000;
/** Bound on escalated approval ids remembered per session. */
const ESCALATED_APPROVALS_MAX = 256;
/** Bound on stages walked for one approval (the probe saw two). */
const APPROVAL_STAGES_MAX = 32;
/** Bound on settled turns remembered (workflow items outlive their turn). */
const SETTLED_TURNS_MAX = 32;
const TITLE_COMMAND_MAX_CHARS = 160;
/** Bound on user-input ids remembered as settled (or unpresentable). */
const SETTLED_USER_INPUTS_MAX = 256;
/** MSP command refusal (`commandRejected`): the command had no effect. */
const MSP_COMMAND_REJECTED = -32030;
/** MSP `sessionNotFound` (live 1.4.18: `session/resume` of an unknown id). */
const MSP_SESSION_NOT_FOUND = -32020;
/** MSP `userInputNotFound` / `userInputAlreadySettled`. */
const MSP_USER_INPUT_GONE = new Set([-32055, -32056]);
const TURN_ERROR_MESSAGE_MAX_CHARS = 500;
/** A Muse model id: one token (it reaches a transcript marker verbatim). */
const MUSE_MODEL_ID = /^[A-Za-z0-9._:/@-]{1,200}$/;
/** MSP caps `turn/retryScheduled.reason` at 160; Station keeps that bound. */
const RETRY_REASON_MAX_CHARS = 160;
/** Retry attempts announced per turn (a retry chain is a handful). */
const RETRY_ANNOUNCEMENTS_MAX = 64;
/**
 * MSP `TodoStatus` → `PlanEntryStatus`. `cancelled` has no canonical status:
 * a cancelled item is no longer part of the work, and every plan surface
 * would render an unknown status as pending, so it is left out of the plan
 * rather than shown as work still to do. An unknown status (the vocabulary
 * is wire-open) is left out for the same reason.
 */
const MUSE_TODO_STATUS: Readonly<Record<string, PlanEntryStatus>> = {
  pending: 'pending',
  inProgress: 'in_progress',
  completed: 'completed',
};

export type MuseServeApprovalModeWire =
  | 'allowAll'
  | 'promptUnmatched'
  | 'onRequest';

export interface MuseServeApprovalPlan {
  museMode: MuseServeApprovalModeWire;
  /** Host posture: `--disable-sandbox`. Fixed per host process. */
  disableSandbox: boolean;
  /** The Station mode this plan applies, when it applies one. */
  stationMode?: Exclude<ApprovalMode, 'connection-default'>;
}

/**
 * Station approval mode → MSP approval mode + host sandbox posture.
 *
 * - `ask` → `promptUnmatched` (sandboxed host): anything no rule already
 *   allows is asked — the same `untrusted` posture Codex's `ask` selects.
 * - `auto` → `allowAll` on a sandboxed host: muse's sandbox is the
 *   containment, exactly what the `muse exec --approval-mode never`
 *   mitigation (#2300) runs under.
 * - `never` → `allowAll` on a `--disable-sandbox` host: Station's `never`
 *   is "no approvals and no sandbox" (the contract, and Codex's
 *   `danger-full-access`).
 * - unset / `connection-default` → `onRequest` (sandboxed): muse's own
 *   default (`muse exec --help`: "default: on-request"). Never omitted: a
 *   durable host started without a mode defaults to `allowAll`.
 */
export function museServeApprovalPlan(
  mode: ApprovalMode | undefined,
): MuseServeApprovalPlan {
  switch (mode) {
    case 'ask':
      return {
        museMode: 'promptUnmatched',
        disableSandbox: false,
        stationMode: 'ask',
      };
    case 'auto':
      return {
        museMode: 'allowAll',
        disableSandbox: false,
        stationMode: 'auto',
      };
    case 'never':
      return {
        museMode: 'allowAll',
        disableSandbox: true,
        stationMode: 'never',
      };
    default:
      return { museMode: 'onRequest', disableSandbox: false };
  }
}

/**
 * The host reports it cannot enforce its sandbox, and the posture asked for
 * (`auto`: no prompts, the sandbox as the only containment) relies on it.
 * Not a reason to fall back to `muse exec`: exec runs that same posture in
 * that same missing sandbox.
 */
export class MuseSandboxUnavailableError extends SendTurnRefusedError {
  constructor(readonly reason: string | undefined) {
    super(
      `Muse cannot enforce its sandbox on this machine${
        reason ? ` (${reason})` : ''
      }, so Auto would run every command uncontained without asking. Choose Ask, or Full access if running without a sandbox is intended.`,
      'permission_denied',
    );
    this.name = 'MuseSandboxUnavailableError';
  }
}

/**
 * What `initialize.sandboxAvailability` said about a host. `unavailable`
 * only when the host said so; an absent or unknown value claims nothing.
 */
export interface MuseServeSandboxReport {
  unavailable: boolean;
  /** Muse's own reason (`sandboxUnavailableReason`), bounded; never inferred. */
  reason?: string;
}

/** An explicit `initialize.sandboxAvailability`; unknown values are absent. */
export type MuseServeReportedSandbox =
  | { availability: 'available' }
  | { availability: 'unavailable'; reason?: string };

/** Whether `plan` relies on muse's sandbox as its only containment. */
function planReliesOnSandbox(plan: MuseServeApprovalPlan): boolean {
  return !plan.disableSandbox && plan.museMode === 'allowAll';
}

/**
 * The sandbox a turn runs under: `disabled` (Station asked for none),
 * `unavailable` (the host cannot enforce one), else `enabled` (requested;
 * a host that never reported availability is not second-guessed).
 */
export function museSandboxLabel(
  plan: MuseServeApprovalPlan,
  sandbox: MuseServeSandboxReport,
): 'disabled' | 'unavailable' | 'enabled' {
  if (plan.disableSandbox) return 'disabled';
  return sandbox.unavailable ? 'unavailable' : 'enabled';
}

/** The host could not be used; the caller falls back to `muse exec`. */
class MuseServeUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`muse serve is unavailable: ${reason}`);
    this.name = 'MuseServeUnavailableError';
  }
}

/**
 * `session/resume` cannot bring back the session a resume names: muse has
 * no such session (`sessionNotFound`), or it answered with another one. No
 * retry recovers that binding, and a blank session in its place would claim
 * a continuity it does not have.
 */
export class MuseServeResumeRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MuseServeResumeRefusedError';
  }
}

export interface MuseServeHostPosture {
  disableSandbox: boolean;
}

export interface MuseServeSessionDeps {
  threadId: string;
  now: () => Date;
  publish: (event: CanonicalRuntimeEvent) => void;
  logger?: MuseServeLogger;
  spawnHost: (posture: MuseServeHostPosture) => MuseServeSpawnResult;
  /** The session's model changed on muse's side (`session/modelChanged`). */
  onModelChanged?: (modelId: string) => void;
  terminateHost: (spawned: MuseServeSpawnResult) => Promise<void>;
  /**
   * Judges a host's reported schema (`muse-serve-schema.ts`). Absent: only a
   * verified fingerprint is accepted.
   */
  checkSchema?: MuseServeSchemaCheck;
  newCommandId: () => string;
  approvalTimeoutMs: number;
  /**
   * How long Station waits for muse to act on a deadline decline before it
   * escalates (stop the child or interrupt the turn, then re-host).
   */
  approvalEscalationMs: number;
  handshakeTimeoutMs: number;
  requestTimeoutMs: number;
  interruptSettleMs: number;
}

export interface MuseServeStartInput {
  cwd?: string;
  modelId?: string;
  approvalMode?: ApprovalMode;
  /**
   * Re-attach this durable muse session (`session/resume`) instead of
   * starting one. A failure never starts a new session in its place.
   */
  resumeSessionId?: string;
}

export interface MuseServeStarted {
  museSessionId: string;
  /** The model the host reported applying, when it reported one. */
  modelId?: string;
  plan: MuseServeApprovalPlan;
  sandbox: MuseServeSandboxReport;
}

/** A host accepted on a structural check of a schema nobody verified. */
export interface MuseServeUnverifiedSchema {
  fingerprint: string;
  museVersion: string;
}

export interface MuseServeTurnInput {
  prompt: string;
  displayPrompt: string;
  invocationId?: string;
  images: Array<{ mediaType: string; base64: string }>;
  modelId?: string;
  /**
   * `turn/start.reasoningEffort`: this turn's tier only (MSP: "sampled at
   * submission for this turn"). Absent: muse's own standing default.
   */
  reasoningEffort?: MuseReasoningEffort;
  /** Present only when this turn carries a posture (see `approval-posture`). */
  approvalMode?: ApprovalMode;
  ambientContext?: string;
  recoveryCorrelationId?: string;
  firstTurnInstructionsComposed?: boolean;
}

interface ServeHost {
  connection: MuseServeConnection;
  spawned: MuseServeSpawnResult;
  posture: MuseServeHostPosture;
  sandbox: MuseServeSandboxReport;
  epoch: number;
  /** Set before an owner-initiated close, so its exit is not a failure. */
  closing: boolean;
}

interface ServeTurn {
  turnId: string;
  kind: 'dispatched' | 'provider';
  invocationId?: string;
  /** A dispatched turn's `turn.started` waits for `turn/start`'s ack. */
  startPublished: boolean;
  buffered: Array<() => void>;
  outputText: string;
  /** agentMessage item id → text streamed for it so far. */
  streamed: Map<string, string>;
  /** Items whose text is part of `outputText` (joined by paragraph breaks). */
  textItems: string[];
  /** callId → tool name, opened and not yet completed. */
  openTools: Map<string, string>;
  stopRequested: boolean;
  settled: boolean;
  settledPromise: Promise<void>;
  resolveSettled: () => void;
  /** Retry attempts (`nextAttempt`) already announced for this turn. */
  retriesAnnounced: Set<number>;
}

/** A Muse `request_user_input` prompt Station put to the user. */
interface PendingUserInput {
  userInputId: string;
  requestId: string;
  form: InputRequestForm;
  /** The `request.opened` event the answer must name. */
  openedEventId: string;
  /** A Station turn the prompt belongs to. */
  turnId?: string;
  /** A `userInput/answer` or `userInput/cancel` is in flight. */
  answering: boolean;
  /** When Station's decision was admitted, in ms (see `request.delivery`). */
  decidedAtMs?: number;
  resolvedPublished: boolean;
}

interface ApprovalStage {
  key: string;
  resolution: string;
}

interface ApprovalChoice {
  choiceId: string;
  decision?: string;
  scope?: string;
  acceptsFeedback: boolean;
}

interface PendingApproval {
  approvalId: string;
  requestId: string;
  toolName: string;
  subagentId?: string;
  current?: { approvalId: string; sourceIndex: number };
  stages: ApprovalStage[];
  choices: ApprovalChoice[];
  /** A `request.opened` was published (a session grant skips it). */
  published: boolean;
  /** A `request.resolved` was published; nothing later publishes another. */
  resolvedPublished: boolean;
  intent?: 'accept' | 'decline' | 'cancel' | 'expire';
  /**
   * #2880: when Station recorded its decision (`intent`), in ms. Muse's own
   * `approval/resolved` after this is the engine's acknowledgement.
   */
  decidedAtMs?: number;
  deciding: boolean;
  lastDecidedKey?: string;
  stagesDecided: number;
  deadline?: ReturnType<typeof setTimeout>;
  /** The subject the published card showed (see `approvalSubjectSignature`). */
  subjectSignature?: string;
  /** A Station turn this approval belongs to (parent approvals only). */
  turnId?: string;
  /** Requirement keys whose rejected decide was already retried once. */
  retriedKeys: Set<string>;
  /** After a deadline decline: 0 none yet, 1 child/turn stopped, 2 re-hosted. */
  escalationStep: number;
  /** Invalidates asynchronous escalation work when the question changes. */
  generation: number;
  escalation?: ReturnType<typeof setTimeout>;
  /** Returned after a re-host although Station already escalated it once. */
  escalatedBefore?: true;
}

/**
 * What an approval asks for, as the user saw it: the subject's kind, command,
 * workspace and every stage's argv. Stage resolutions and the offered choices
 * are left out, because `approval/updated` legitimately changes those as a
 * walk advances; anything else changing means the request is no longer the
 * one the user answered.
 */
function approvalSubjectSignature(
  params: Record<string, unknown>,
): string | undefined {
  const subject = isRecord(params.subject) ? params.subject : undefined;
  if (!subject) return undefined;
  // A stage muse marks `argvComplete: false` may still be refined, so its
  // argv is not part of what the user is held to having seen.
  const stages = Array.isArray(subject.stages)
    ? subject.stages.map((stage) =>
        isRecord(stage) &&
        Array.isArray(stage.argv) &&
        stage.argvComplete !== false
          ? stage.argv
          : null,
      )
    : null;
  return JSON.stringify([
    subject.kind ?? null,
    subject.command ?? null,
    subject.workspaceRoot ?? null,
    stages,
  ]);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function requirementRef(
  value: unknown,
): { approvalId: string; sourceIndex: number } | undefined {
  if (!isRecord(value)) return undefined;
  const approvalId = readString(value.approvalId);
  const sourceIndex = value.sourceIndex;
  if (!approvalId || typeof sourceIndex !== 'number') return undefined;
  return { approvalId, sourceIndex };
}

function requirementKey(ref: { approvalId: string; sourceIndex: number }) {
  return `${ref.approvalId}#${ref.sourceIndex}`;
}

function parseJsonMaybe(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * `cumulative.cost.usd` when muse priced every leg. A `partial` cost (some
 * leg had no price) is a lower bound that `reportedCost` cannot mark as one,
 * so it is not published: no cost is shown rather than an understated one.
 */
function museSessionCostUsd(cumulative: unknown): number | undefined {
  if (!isRecord(cumulative) || !isRecord(cumulative.cost)) return undefined;
  if (cumulative.cost.partial !== false) return undefined;
  return readCount(cumulative.cost.usd);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function formatMuseServeDuration(ms: number): string {
  const unit = (value: number, name: string) =>
    `${value} ${name}${value === 1 ? '' : 's'}`;
  if (ms > 0 && ms % 3_600_000 === 0) return unit(ms / 3_600_000, 'hour');
  if (ms > 0 && ms % 60_000 === 0) return unit(ms / 60_000, 'minute');
  return unit(ms / 1_000, 'second');
}

/** The `tool.progress` text while muse's automated reviewer holds a call. */
export const MUSE_APPROVAL_REVIEWING_MESSAGE =
  "Muse's automated reviewer is checking this action before it runs.";

/** MSP `approval/resolved.decision` → Station's request status. */
function mapResolvedDecision(
  decision: string | undefined,
  intent: PendingApproval['intent'],
): ApprovalStatus {
  switch (decision) {
    case 'approved':
    case 'approvedForSession':
    case 'approvedPolicyAmendment':
      return 'approved';
    case 'timedOut':
      return 'expired';
    case 'denied':
    case 'deniedPolicyAmendment':
    case 'abort':
      if (intent === 'cancel') return 'cancelled';
      if (intent === 'expire') return 'expired';
      return 'denied';
    default:
      return 'cancelled';
  }
}

/** A `session/compact` muse refused at admission, as the send's refusal. */
function museCompactRefusal(error: MuseServeRpcError): SendTurnRefusedError {
  const reason =
    error.code === MSP_COMMAND_REJECTED && isRecord(error.data)
      ? readString(error.data.reason)
      : undefined;
  switch (reason) {
    case 'run_active':
      return new SendTurnRefusedError(
        'Muse compacts between turns, and this session has a turn running. Send /compact again when it finishes.',
        'busy',
      );
    case 'compaction_unavailable':
      return new SendTurnRefusedError(
        "Muse can't compact this session: compaction isn't available for its model.",
        'input_unsupported',
      );
    case 'missing_run':
      return new SendTurnRefusedError(
        'Muse has nothing to compact yet: this session has no turn.',
        'input_unsupported',
      );
    default:
      return new SendTurnRefusedError(
        `Muse did not run /compact${reason ? ` (${reason})` : ''}.`,
        'provider_error',
      );
  }
}

/**
 * What Station knows of the session's goal: nothing yet (`undefined`), a
 * goal (or none) muse reported, or a goal whose status Station cannot name.
 */
export type MuseServeGoalState =
  | undefined
  | { known: true; goal: SessionGoal | null }
  | { known: false; reason: 'unmapped-status' };

/**
 * MSP goal `status` (wire-open) → `SessionGoalStatus`. Only what 1.4.18 was
 * seen reporting (`goal/set` → `active`, `goal/pause` → `paused`); any other
 * value is a status Station cannot name, never guessed at.
 */
const MUSE_GOAL_STATUS: Readonly<Record<string, SessionGoal['status']>> = {
  active: 'active',
  paused: 'paused',
};

/** `session/goalChanged.goal` → what Station knows of the goal. */
function museGoalState(value: unknown): MuseServeGoalState {
  if (value === null) return { known: true, goal: null };
  if (!isRecord(value)) return { known: false, reason: 'unmapped-status' };
  const objective = readString(value.objective);
  const status =
    typeof value.status === 'string'
      ? MUSE_GOAL_STATUS[value.status]
      : undefined;
  if (
    !objective?.trim() ||
    objective.length > SESSION_GOAL_OBJECTIVE_MAX_CHARS ||
    !status
  )
    return { known: false, reason: 'unmapped-status' };
  // Muse reports no token budget, token use or elapsed time for a goal:
  // those fields stay absent, never zero.
  return { known: true, goal: { objective, status } };
}

export class MuseServeSession {
  private host?: ServeHost;
  private hostEpoch = 0;
  private museSessionIdValue?: string;
  private plan: MuseServeApprovalPlan = museServeApprovalPlan(undefined);
  private model?: string;
  private stopped = false;
  private stopHost?: ServeHost;
  private reportedSandboxValue?: MuseServeReportedSandbox;
  /** Unverified-but-compatible fingerprints this session already announced. */
  private readonly announcedSchemas = new Set<string>();
  private startSchema?: MuseServeUnverifiedSchema;
  private stopTask?: Promise<{ terminationConfirmed: boolean }>;
  private stopConfirmed = false;
  private sending = false;
  private readonly turns = new Map<string, ServeTurn>();
  private readonly itemKinds = new Map<string, string>();
  private readonly approvals = new Map<string, PendingApproval>();
  /** approvalIds whose request Station already resolved once. */
  private readonly resolvedApprovalIds = new Set<string>();
  /** Tool-level session grants (`acceptForSession`), Station-side (#2299). */
  private readonly approvedTools = new Set<string>();
  /**
   * Durable approval ids Station already escalated (bounded, oldest first).
   * One that comes back after a re-host is declined at once, never put to
   * the user again, so the same approval cannot loop through expire,
   * escalate, re-host and reopen.
   */
  private readonly escalatedApprovalIds = new Set<string>();
  /** Open `request_user_input` prompts, by `userInputId`. */
  private readonly userInputs = new Map<string, PendingUserInput>();
  /**
   * Prompts muse settled, or Station could not present (bounded, oldest
   * first): a later re-issue of one is not put to the user again.
   */
  private readonly settledUserInputIds = new Set<string>();
  /** Prompts whose request Station resolved once (a re-issue gets a new id). */
  private readonly resolvedUserInputIds = new Set<string>();
  private readonly childWork: MuseServeChildWorkContext;
  /** The session's goal as muse last reported it (`session/goalChanged`). */
  private goal: MuseServeGoalState;
  private goalCommandPending = false;

  constructor(private readonly deps: MuseServeSessionDeps) {
    this.childWork = {
      state: createMuseServeChildWorkState(),
      reporterThreadId: deps.threadId,
      nowIso: () => this.nowIso(),
      publish: (event) => deps.publish(event),
      isTurnLive: (turnId) => {
        const turn = this.turns.get(turnId);
        return turn !== undefined && !turn.settled;
      },
    };
  }

  get museSessionId(): string | undefined {
    return this.museSessionIdValue;
  }

  get approvalPlan(): MuseServeApprovalPlan {
    return this.plan;
  }

  get hostPid(): number | undefined {
    return (this.host ?? this.stopHost)?.spawned.process.pid;
  }

  /** The latest host's sandbox report (none before a host answered). */
  get sandbox(): MuseServeSandboxReport {
    return (this.host ?? this.stopHost)?.sandbox ?? { unavailable: false };
  }

  /**
   * The last explicit `sandboxAvailability` any host of this session
   * answered, kept after that host is closed (a start that fails after the
   * handshake has closed it). Absent while no host said either way.
   */
  get reportedSandbox(): MuseServeReportedSandbox | undefined {
    return this.reportedSandboxValue;
  }

  /**
   * Spawns the host, verifies the handshake, and starts the MSP session. A
   * host without a sandbox refuses a posture that relies on one
   * ({@link MuseSandboxUnavailableError}) before any session is started.
   */
  async start(input: MuseServeStartInput): Promise<MuseServeStarted> {
    const plan = museServeApprovalPlan(input.approvalMode);
    const host = await this.openHost({ disableSandbox: plan.disableSandbox });
    if (host.sandbox.unavailable && planReliesOnSandbox(plan)) {
      await this.closeHost();
      throw new MuseSandboxUnavailableError(host.sandbox.reason);
    }
    if (input.resumeSessionId !== undefined)
      return this.resumeOnHost(host, plan, input, input.resumeSessionId);
    let result: unknown;
    try {
      result = await host.connection.request(
        'session/start',
        {
          commandId: this.deps.newCommandId(),
          ...(input.cwd ? { workspaceRoot: input.cwd } : {}),
          approvalMode: plan.museMode,
          ...(input.modelId ? { modelId: input.modelId } : {}),
        },
        { timeoutMs: this.deps.handshakeTimeoutMs },
      );
    } catch (error) {
      await this.closeHost();
      throw new MuseServeUnavailableError(
        `session/start failed: ${errorMessage(error)}`,
      );
    }
    const session =
      isRecord(result) && isRecord(result.session) ? result.session : {};
    const museSessionId = readString(session.sessionId);
    const appliedMode = isRecord(session.approvalMode)
      ? readString(session.approvalMode.mode)
      : undefined;
    if (!museSessionId) {
      await this.closeHost();
      throw new MuseServeUnavailableError(
        'session/start returned no session id',
      );
    }
    if (appliedMode !== plan.museMode) {
      // The host applied a different mode than Station asked for: the one
      // posture this session exists to honour is not in effect.
      await this.closeHost();
      throw new MuseServeUnavailableError(
        `the host applied approval mode ${appliedMode ?? 'unknown'} instead of ${plan.museMode}`,
      );
    }
    this.museSessionIdValue = museSessionId;
    this.plan = plan;
    this.model = readString(session.modelId) ?? input.modelId;
    // A session muse just started has no goal.
    this.goal = { known: true, goal: null };
    return {
      museSessionId,
      ...(this.model ? { modelId: this.model } : {}),
      plan,
      sandbox: host.sandbox,
    };
  }

  /**
   * `session/resume` of a session an earlier host (an earlier Station
   * process) started. Live 1.4.18: a fresh `muse serve` re-attaches an idle
   * session by id with its context, and refuses an unknown id
   * `sessionNotFound` (-32020). The approval mode is re-applied when the
   * resumed session reports another, and open approvals and questions are
   * put to the user again, as on a re-host.
   */
  private async resumeOnHost(
    host: ServeHost,
    plan: MuseServeApprovalPlan,
    input: MuseServeStartInput,
    sessionId: string,
  ): Promise<MuseServeStarted> {
    let result: unknown;
    try {
      result = await host.connection.request(
        'session/resume',
        {
          commandId: this.deps.newCommandId(),
          sessionId,
          excludeItems: true,
          ...(input.modelId ? { modelId: input.modelId } : {}),
        },
        { timeoutMs: this.deps.handshakeTimeoutMs },
      );
    } catch (error) {
      await this.closeHost();
      if (
        error instanceof MuseServeRpcError &&
        error.code === MSP_SESSION_NOT_FOUND
      ) {
        throw new MuseServeResumeRefusedError(
          'Muse no longer has the session this conversation ran in, so it cannot be continued there.',
        );
      }
      throw new MuseServeUnavailableError(
        `session/resume failed: ${errorMessage(error)}`,
      );
    }
    const session =
      isRecord(result) && isRecord(result.session) ? result.session : {};
    if (readString(session.sessionId) !== sessionId) {
      await this.closeHost();
      throw new MuseServeResumeRefusedError(
        'Muse resumed a different session than the one this conversation ran in.',
      );
    }
    this.museSessionIdValue = sessionId;
    this.plan = plan;
    try {
      const mode = isRecord(session.approvalMode)
        ? readString(session.approvalMode.mode)
        : undefined;
      if (mode !== plan.museMode)
        await this.applyApprovalMode(host.connection, sessionId, plan);
      await this.reseedPendingApprovals();
    } catch (error) {
      await this.closeHost();
      throw error;
    }
    // `this.goal` stays unknown: the session's goal predates this host, and
    // resuming does not restate it (live 1.4.18) until muse reports a change.
    this.model = readString(session.modelId) ?? input.modelId;
    return {
      museSessionId: sessionId,
      ...(this.model ? { modelId: this.model } : {}),
      plan,
      sandbox: host.sandbox,
    };
  }

  hasLiveTurn(): boolean {
    return this.liveTurn() !== undefined;
  }

  async sendTurn(input: MuseServeTurnInput): Promise<{ turnId: string }> {
    if (this.stopped) {
      throw new SendTurnRefusedError(
        'This Muse session is stopped.',
        'session_gone',
      );
    }
    const live = this.liveTurn();
    if (live?.kind === 'provider') throw new ProviderTurnInProgressError();
    if (live || this.sending) {
      throw new SendTurnRefusedError(
        'This Muse session already has an active turn.',
        'busy',
      );
    }
    this.sending = true;
    try {
      const plan =
        input.approvalMode !== undefined
          ? museServeApprovalPlan(input.approvalMode)
          : this.plan;
      await this.ensureHost({ disableSandbox: plan.disableSandbox });
      // Before the mode is applied: `auto` on a host without a sandbox would
      // run commands uncontained with nobody asked.
      if (this.host?.sandbox.unavailable && planReliesOnSandbox(plan)) {
        throw new MuseSandboxUnavailableError(this.host.sandbox.reason);
      }
      const connection = this.requireConnection();
      const sessionId = this.requireMuseSessionId();
      if (plan.museMode !== this.plan.museMode) {
        await this.applyApprovalMode(connection, sessionId, plan);
      }
      this.plan = plan;
      if (input.modelId && input.modelId !== this.model) {
        await this.refusingRequest(connection, 'session/setModel', {
          commandId: this.deps.newCommandId(),
          sessionId,
          model: { modelId: input.modelId },
        });
        this.model = input.modelId;
      }
      const commandId = this.deps.newCommandId();
      const turn = this.createTurn(commandId, 'dispatched');
      turn.invocationId = input.invocationId;
      this.turns.set(commandId, turn);
      let ack: unknown;
      try {
        ack = await connection.request(
          'turn/start',
          {
            commandId,
            sessionId,
            ...(input.reasoningEffort
              ? { reasoningEffort: input.reasoningEffort }
              : {}),
            input: [
              { type: 'text', text: input.prompt },
              ...input.images.map((image) => ({
                type: 'image',
                mediaType: image.mediaType,
                base64Data: image.base64,
              })),
            ],
          },
          { timeoutMs: this.deps.requestTimeoutMs },
        );
      } catch (error) {
        this.turns.delete(commandId);
        if (error instanceof MuseServeRpcError) {
          // Refused at admission: MSP acks only after durable intake, so a
          // JSON-RPC error means nothing started.
          throw new SendTurnRefusedError(
            `Muse did not accept this message: ${error.message}`,
            'provider_error',
          );
        }
        // A timeout or a vanished host is indeterminate: the turn may exist.
        throw error;
      }
      const ackTurnId =
        isRecord(ack) && readString(ack.turnId)
          ? (ack.turnId as string)
          : commandId;
      if (ackTurnId !== commandId) this.rekeyTurn(commandId, ackTurnId);
      this.publishDispatchedStart(turn, input, plan);
      return { turnId: turn.turnId };
    } finally {
      this.sending = false;
    }
  }

  async interrupt(turnId?: string): Promise<ProviderInterruptTurnResult> {
    const live = this.liveTurn();
    if (!live) return { outcome: 'no-active-turn' };
    if (turnId && turnId !== live.turnId) {
      return { outcome: 'target-mismatch', activeTurnId: live.turnId };
    }
    live.stopRequested = true;
    const connection = this.host?.connection;
    if (connection && !connection.isClosed) {
      try {
        await connection.request(
          'turn/interrupt',
          {
            commandId: this.deps.newCommandId(),
            sessionId: this.requireMuseSessionId(),
            turnId: live.turnId,
          },
          { timeoutMs: this.deps.requestTimeoutMs },
        );
      } catch (error) {
        this.deps.logger?.warn('Muse turn/interrupt was not admitted', {
          threadId: this.deps.threadId,
          turnId: live.turnId,
          error: errorMessage(error),
        });
      }
    }
    // Admission is not the stop: the turn is over at its own `cancelled`
    // terminal (TurnInterruptResult's own contract).
    const settled = await Promise.race([
      live.settledPromise.then(() => true),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), this.deps.interruptSettleMs),
      ),
    ]);
    return settled
      ? { outcome: 'cancelled', turnId: live.turnId }
      : { outcome: 'termination-unconfirmed', turnId: live.turnId };
  }

  async respond(
    requestId: string,
    decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
  ): Promise<void> {
    const pending = [...this.approvals.values()].find(
      (candidate) => candidate.requestId === requestId,
    );
    if (!pending || pending.resolvedPublished || pending.intent) {
      throw new Error(`Unknown Muse approval request: ${requestId}`);
    }
    // Answered: the deadline is for requests nobody answered, and must not
    // expire a walk the user already approved.
    this.clearDeadline(pending);
    if (decision === 'acceptForSession') {
      this.approvedTools.add(pending.toolName);
    }
    pending.intent =
      decision === 'accept' || decision === 'acceptForSession'
        ? 'accept'
        : decision === 'decline'
          ? 'decline'
          : 'cancel';
    // #2880: `request.resolved` means "decision recorded" on every adapter;
    // Muse's `approval/resolved` later acknowledges it (`request.delivery`).
    this.recordDecision(pending);
    this.continueWalk(pending);
  }

  private recordDecision(pending: PendingApproval): void {
    pending.decidedAtMs = this.deps.now().getTime();
    this.publishResolved(
      pending,
      pending.intent === 'accept'
        ? 'approved'
        : pending.intent === 'decline'
          ? 'denied'
          : pending.intent === 'expire'
            ? 'expired'
            : 'cancelled',
      undefined,
      MUSE_SERVE_APPROVAL_ACKNOWLEDGEMENT,
    );
  }

  /**
   * Joins `text` to the running turn `turnId` (`turn/steer`, whose
   * `expectedTurnId` keeps it from landing in any other turn). Refused with
   * {@link ProviderTurnEndedError} — no effect — when that turn is not the
   * one running, here or in muse (`commandRejected`, e.g. `missing_run`).
   */
  async steer(turnId: string, text: string): Promise<void> {
    const turn = this.turns.get(turnId);
    const connection = this.host?.connection;
    if (
      this.stopped ||
      !turn ||
      turn.settled ||
      !turn.startPublished ||
      this.liveTurn() !== turn ||
      !connection ||
      connection.isClosed
    ) {
      throw new ProviderTurnEndedError();
    }
    let result: unknown;
    try {
      result = await connection.request(
        'turn/steer',
        {
          commandId: this.deps.newCommandId(),
          sessionId: this.requireMuseSessionId(),
          expectedTurnId: turnId,
          input: [{ type: 'text', text }],
        },
        { timeoutMs: this.deps.requestTimeoutMs },
      );
    } catch (error) {
      if (
        error instanceof MuseServeRpcError &&
        error.code === MSP_COMMAND_REJECTED
      ) {
        throw new ProviderTurnEndedError();
      }
      // A timeout or a vanished host is indeterminate: the input may be in.
      throw error;
    }
    // The steer `turn.started` below is attributed to `turnId`, so muse must
    // name that turn as the one that took the input.
    if (readString(isRecord(result) ? result.turnId : undefined) !== turnId) {
      throw new Error(
        'Muse did not report the steer joining the steered turn.',
      );
    }
    // Muse can write the turn's terminal before this reply. A steer
    // `turn.started` after that terminal would reopen a turn that never ends
    // again. Muse accepted the input, so whether the ended turn used it is
    // unknown: a plain (indeterminate) error, not a no-effect refusal. A turn
    // muse opened meanwhile does not matter: muse confirmed this one took it.
    if (turn.settled) {
      throw new Error(
        'The Muse turn ended as it accepted the steer; whether it used the input is unknown.',
      );
    }
    this.deps.publish({
      eventId: crypto.randomUUID(),
      provider: 'muse',
      threadId: this.deps.threadId,
      createdAt: this.nowIso(),
      turnId,
      method: 'turn.started',
      prompt: text,
      inputKind: 'steer',
    });
  }

  /** Whether `requestId` is an open Muse question (not an approval). */
  hasUserInput(requestId: string): boolean {
    return [...this.userInputs.values()].some(
      (pending) => pending.requestId === requestId,
    );
  }

  /**
   * Answers an open question: `accept` sends the validated answers as
   * `userInput/answer`, anything else declines it with `userInput/cancel`.
   * The request resolves once muse admits the command; muse's own
   * `userInput/settled` then acknowledges it (`request.delivery`). A refused
   * command leaves the question open and throws, except when muse says the
   * prompt is gone, which closes it.
   */
  async answerUserInput(
    requestId: string,
    decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
    context: {
      inputContent?: InputRequestContent;
      expectedRequestEventId?: string;
    } = {},
  ): Promise<void> {
    const pending = [...this.userInputs.values()].find(
      (candidate) => candidate.requestId === requestId,
    );
    if (!pending || pending.resolvedPublished || pending.answering) {
      throw new Error('This Muse question is not open.');
    }
    if (
      context.expectedRequestEventId !== pending.openedEventId ||
      decision === 'acceptForSession'
    ) {
      throw new Error('Inspect this question before answering it.');
    }
    if (decision !== 'accept' && context.inputContent !== undefined) {
      throw new Error('A cancelled question cannot carry answers.');
    }
    const answers =
      decision === 'accept'
        ? museAnswers(
            pending.form,
            validateInputRequestContent(pending.form, context.inputContent),
          )
        : undefined;
    const connection = this.requireConnection();
    const sessionId = this.requireMuseSessionId();
    pending.answering = true;
    try {
      await connection.request(
        answers ? 'userInput/answer' : 'userInput/cancel',
        {
          commandId: this.deps.newCommandId(),
          sessionId,
          userInputId: pending.userInputId,
          ...(answers
            ? { answers }
            : {
                reason:
                  decision === 'decline'
                    ? 'The user declined to answer in Station.'
                    : 'The question was cancelled in Station.',
              }),
        },
        { timeoutMs: this.deps.requestTimeoutMs },
      );
    } catch (error) {
      pending.answering = false;
      if (
        error instanceof MuseServeRpcError &&
        MSP_USER_INPUT_GONE.has(error.code) &&
        this.userInputs.get(pending.userInputId) === pending
      ) {
        this.rememberSettledUserInput(pending.userInputId);
        this.closeUserInput(pending, { reason: 'closed-by-engine' });
        throw new Error('This Muse question is no longer open.');
      }
      throw error;
    }
    pending.answering = false;
    // Settled meanwhile (muse's `userInput/settled` can precede the reply).
    if (pending.resolvedPublished) return;
    pending.decidedAtMs = this.deps.now().getTime();
    this.publishUserInputResolved(
      pending,
      answers ? 'approved' : decision === 'decline' ? 'denied' : 'cancelled',
      undefined,
      MUSE_SERVE_APPROVAL_ACKNOWLEDGEMENT,
    );
  }

  /**
   * `session/compact` (muse's `/compact`). Compaction runs after the ack, so
   * the outcome says it started, or that muse had nothing to compact. A
   * command muse rejects at admission changed nothing and refuses the send:
   * `run_active` while a turn runs (retryable), `compaction_unavailable`
   * when the session's model has no summarizer.
   */
  async compact(): Promise<EngineCommandOutcome> {
    if (this.stopped) {
      throw new SendTurnRefusedError(
        'This Muse session is stopped.',
        'session_gone',
      );
    }
    if (this.liveTurn() || this.sending) {
      throw new SendTurnRefusedError(
        'Muse compacts between turns, and this session has a turn running. Send /compact again when it finishes.',
        'busy',
      );
    }
    this.sending = true;
    try {
      await this.ensureHost({ disableSandbox: this.plan.disableSandbox });
      const connection = this.requireConnection();
      let result: unknown;
      try {
        result = await connection.request(
          'session/compact',
          {
            commandId: this.deps.newCommandId(),
            sessionId: this.requireMuseSessionId(),
          },
          { timeoutMs: this.deps.requestTimeoutMs },
        );
      } catch (error) {
        if (error instanceof MuseServeRpcError) throw museCompactRefusal(error);
        // A timeout or a vanished host is indeterminate: it may be running.
        throw error;
      }
      const status = isRecord(result) ? readString(result.status) : undefined;
      const reason = isRecord(result) ? readString(result.reason) : undefined;
      if (status === 'noop') {
        return {
          kind: 'answered',
          text: `Muse had nothing to compact${reason ? ` (${reason})` : ''}.`,
        };
      }
      if (status !== 'accepted') {
        return {
          kind: 'answered',
          success: false,
          text: `muse answered ${status ?? 'with no status'}`,
        };
      }
      return {
        kind: 'answered',
        text: "Muse started compacting this session's context.",
      };
    } finally {
      this.sending = false;
    }
  }

  /** The session's goal as muse last reported it; see {@link MuseServeGoalState}. */
  get goalState(): MuseServeGoalState {
    return this.goal;
  }

  /**
   * `goal/pause` or `goal/clear` on the live host. Neither wakes a turn
   * (MSP: only `set`/`edit`/`resume` carry one). Applied only when muse's
   * own `session/goalChanged` (live 1.4.18: sent before the ack) shows the
   * result; an ack without it is indeterminate. A command muse rejected had
   * no effect; `missing_goal` also says the session has no goal.
   */
  async controlGoal(
    operation: 'pause' | 'clear',
  ): Promise<SessionGoalControlResult> {
    const connection = this.host?.connection;
    if (
      this.stopped ||
      !connection ||
      connection.isClosed ||
      !this.museSessionIdValue
    )
      return { state: 'refused', reason: 'session-not-live' };
    if (this.goalCommandPending) return { state: 'refused', reason: 'busy' };
    this.goalCommandPending = true;
    try {
      await connection.request(
        `goal/${operation}`,
        {
          commandId: this.deps.newCommandId(),
          sessionId: this.museSessionIdValue,
        },
        { timeoutMs: this.deps.requestTimeoutMs },
      );
    } catch (error) {
      if (
        error instanceof MuseServeRpcError &&
        error.code === MSP_COMMAND_REJECTED
      ) {
        if (
          isRecord(error.data) &&
          readString(error.data.reason) === 'missing_goal'
        )
          this.goal = { known: true, goal: null };
        return { state: 'refused', reason: 'invalid-command' };
      }
      return { state: 'indeterminate' };
    } finally {
      this.goalCommandPending = false;
    }
    const goal = this.goal;
    if (
      goal?.known &&
      (operation === 'clear'
        ? goal.goal === null
        : goal.goal?.status === 'paused')
    )
      return { state: 'applied', goal: goal.goal };
    return { state: 'indeterminate' };
  }

  async stopChild(childId: string): Promise<ProviderTaskStopResult> {
    if (!museServeChildIsRunning(this.childWork, childId)) {
      return { outcome: 'no-active-task', taskId: childId };
    }
    const connection = this.requireConnection();
    const sessionId = this.requireMuseSessionId();
    if (museServeChildStopMethod(this.childWork, childId) === 'task/stop') {
      // A background task. Muse admits a stop of a task that has already
      // ended, so the admission is not the stop: the task reads
      // stopped-unconfirmed until its item's own terminal arrives.
      await connection.request(
        'task/stop',
        { commandId: this.deps.newCommandId(), sessionId, taskId: childId },
        { timeoutMs: this.deps.requestTimeoutMs },
      );
    } else {
      await connection.request(
        'subagent/stop',
        {
          commandId: this.deps.newCommandId(),
          sessionId,
          subagentId: childId,
          reason: 'Stopped from Station.',
        },
        { timeoutMs: this.deps.requestTimeoutMs },
      );
    }
    recordMuseChildStopRequested(this.childWork, childId);
    return { outcome: 'stopped', taskId: childId };
  }

  /**
   * Sends `input` to a running subagent (`subagent/sendMessage`): muse
   * queues it and delivers it into the child's next step. A child that is
   * not running, or whose steer token is not `turnId`, is `no-active-task`
   * before anything reaches muse; muse refusing it (`commandRejected`, e.g.
   * `subagent_state_ineligible` once the child ended) is the same race.
   */
  async steerChild(
    childId: string,
    turnId: string,
    text: string,
  ): Promise<ProviderChildSteerResult> {
    const connection = this.host?.connection;
    if (
      this.stopped ||
      !connection ||
      connection.isClosed ||
      !museServeChildSteerable(this.childWork, childId, turnId)
    ) {
      return { outcome: 'no-active-task' };
    }
    try {
      await connection.request(
        'subagent/sendMessage',
        {
          commandId: this.deps.newCommandId(),
          sessionId: this.requireMuseSessionId(),
          subagentId: childId,
          body: text,
        },
        { timeoutMs: this.deps.requestTimeoutMs },
      );
    } catch (error) {
      if (
        error instanceof MuseServeRpcError &&
        error.code === MSP_COMMAND_REJECTED
      ) {
        return { outcome: 'no-active-task' };
      }
      // A timeout or a vanished host is indeterminate: the input may be in.
      throw error;
    }
    return { outcome: 'steered', turnId };
  }

  /**
   * Retain an unconfirmed host and retry only its original live leader.
   */
  async stop(): Promise<{ terminationConfirmed: boolean }> {
    if (this.stopConfirmed) return { terminationConfirmed: true };
    if (this.stopTask) return this.stopTask;
    this.stopTask = this.stopOnce().finally(() => {
      this.stopTask = undefined;
    });
    return this.stopTask;
  }

  private async stopOnce(): Promise<{ terminationConfirmed: boolean }> {
    if (!this.stopped) {
      this.stopHost = this.host;
      this.stopped = true;
      for (const pending of this.approvals.values()) {
        this.clearDeadline(pending);
        this.clearEscalation(pending);
        this.settleUnanswered(pending, 'cancelled');
      }
      this.approvals.clear();
      this.abandonUserInputs();
      for (const turn of this.turns.values()) {
        if (turn.settled) continue;
        this.closeOpenTools(turn);
        this.settle(turn, {
          method: 'turn.aborted',
          reason: 'session-stopped',
        });
      }
      settleOpenMuseChildren(this.childWork, { close: true });
    }
    if (this.stopHost) {
      const processHandle = this.stopHost.spawned.process;
      if (
        processHandle.exitCode !== null ||
        processHandle.signalCode !== null
      ) {
        this.stopHost.connection.close();
        return { terminationConfirmed: false };
      }
      this.host = this.stopHost;
    }
    this.stopConfirmed = await this.closeHost(true);
    if (this.stopConfirmed) this.stopHost = undefined;
    return { terminationConfirmed: this.stopConfirmed };
  }

  // --------------------------------------------------------------- host

  private async openHost(posture: MuseServeHostPosture): Promise<ServeHost> {
    let spawned: MuseServeSpawnResult;
    try {
      spawned = this.deps.spawnHost(posture);
    } catch (error) {
      throw new MuseServeUnavailableError(
        `could not start muse serve: ${errorMessage(error)}`,
      );
    }
    const epoch = ++this.hostEpoch;
    const host: ServeHost = {
      spawned,
      posture,
      sandbox: { unavailable: false },
      epoch,
      closing: false,
      connection: new MuseServeConnection(spawned.process, {
        onNotification: (method, params) =>
          this.handleNotification(epoch, method, params),
        onServerRequest: (method, params) =>
          this.handleServerRequest(epoch, method, params),
        onClose: (info) => this.handleHostClose(epoch, info),
        onProtocolNoise: (detail) =>
          this.deps.logger?.warn('Muse host wrote an unexpected frame', {
            threadId: this.deps.threadId,
            detail,
          }),
      }),
    };
    this.host = host;
    let result: unknown;
    try {
      result = await host.connection.request(
        'initialize',
        {
          clientInfo: { name: 'station', title: 'Station', version: '1' },
          capabilities: { experimentalApi: false },
        },
        { timeoutMs: this.deps.handshakeTimeoutMs },
      );
    } catch (error) {
      await this.closeHost();
      throw new MuseServeUnavailableError(
        error instanceof MuseServeTimeoutError
          ? 'the host did not answer initialize'
          : `initialize failed: ${errorMessage(error)}`,
      );
    }
    // A property of the machine (MSP: probed once at host construction), not
    // of the protocol, so `unavailable` is recorded BEFORE the fingerprint
    // and durability refusals below: a host refused as unverified (e.g. after
    // a Muse upgrade) still reported that this machine has no sandbox, and
    // the exec fallback must not run unsandboxed on the strength of that
    // refusal. Absent or unknown values read as unknown.
    if (isRecord(result) && result.sandboxAvailability === 'unavailable') {
      const reason = readString(result.sandboxUnavailableReason);
      host.sandbox = {
        unavailable: true,
        ...(reason ? { reason: truncate(reason, 80) } : {}),
      };
      this.reportedSandboxValue = {
        availability: 'unavailable',
        ...(host.sandbox.reason ? { reason: host.sandbox.reason } : {}),
      };
    }
    let verdict: MuseServeSchemaVerdict;
    try {
      verdict = this.deps.checkSchema
        ? await this.deps.checkSchema(result)
        : museServeKnownSchemaVerdict(result);
    } catch (error) {
      verdict = {
        kind: 'refused',
        reason: `the MSP schema check failed: ${errorMessage(error)}`,
      };
    }
    // The check runs while the host waits for `initialized`: it may have
    // exited, or the session been stopped, meanwhile.
    if (verdict.kind === 'refused' || this.host !== host || this.stopped) {
      if (this.host === host) await this.closeHost();
      throw new MuseServeUnavailableError(
        verdict.kind === 'refused' ? verdict.reason : 'the host exited',
      );
    }
    const durability = isRecord(result) ? result.sessionDurability : undefined;
    if (durability !== undefined && durability !== 'durable') {
      await this.closeHost();
      throw new MuseServeUnavailableError(
        `the host reports ${String(durability)} sessions`,
      );
    }
    // `available` is trusted only from a host this adapter verified: it is
    // the one report that relaxes the exec-fallback refusal. `unavailable`
    // was recorded above, before any refusal.
    if (isRecord(result) && result.sandboxAvailability === 'available') {
      this.reportedSandboxValue = { availability: 'available' };
    }
    host.connection.notify('initialized');
    if (verdict.kind === 'compatible') this.announceSchema(verdict);
    return host;
  }

  /**
   * Publishes the start host's unverified-schema notice, once the adapter
   * has published the session it belongs to.
   */
  announceStartSchema(): void {
    const verdict = this.startSchema;
    this.startSchema = undefined;
    if (verdict && this.museSessionIdValue) this.announceSchema(verdict);
  }

  /**
   * Once per session per fingerprint: this host runs on a schema nobody
   * verified, accepted because it still declares everything Station uses.
   */
  private announceSchema(verdict: MuseServeUnverifiedSchema): void {
    if (this.announcedSchemas.has(verdict.fingerprint)) return;
    // The first host answers before the session exists: its notice waits
    // for the adapter to publish the session ({@link announceStartSchema}).
    if (!this.museSessionIdValue) {
      this.startSchema = verdict;
      return;
    }
    this.announcedSchemas.add(verdict.fingerprint);
    this.deps.publish({
      eventId: crypto.randomUUID(),
      provider: 'muse',
      threadId: this.deps.threadId,
      createdAt: this.nowIso(),
      method: 'runtime.warning',
      severity: 'warning',
      code: MUSE_SERVE_SCHEMA_UNVERIFIED_COMPATIBLE_CODE,
      message: `Muse ${verdict.museVersion} speaks a protocol version Station was not tested against. It still offers everything Station uses, so this session runs on it.`,
      details: {
        fingerprint: verdict.fingerprint,
        museVersion: verdict.museVersion,
      },
    });
  }

  /**
   * A live host with `posture`. Sandbox posture is fixed per host process,
   * so a change of it (to or from `never`) re-hosts the session: the old
   * host is closed and a fresh one re-attaches with `session/resume`. The
   * same path re-attaches after the host died. A re-host is refused while
   * anything could still be running in the old host.
   */
  private async ensureHost(posture: MuseServeHostPosture): Promise<void> {
    const current = this.host;
    if (
      current &&
      !current.connection.isClosed &&
      current.posture.disableSandbox === posture.disableSandbox
    ) {
      return;
    }
    if (current && !current.connection.isClosed) {
      if (
        museServeHasRunningChildren(this.childWork) ||
        this.approvals.size > 0
      ) {
        throw new SendTurnRefusedError(
          'Muse cannot change its sandbox while background work or an approval is still open. Send again when it finishes.',
          'busy',
        );
      }
      await this.closeHost();
    }
    let host: ServeHost;
    try {
      host = await this.openHost(posture);
      const sessionId = this.requireMuseSessionId();
      const resumed = await host.connection.request(
        'session/resume',
        {
          commandId: this.deps.newCommandId(),
          sessionId,
          excludeItems: true,
        },
        { timeoutMs: this.deps.handshakeTimeoutMs },
      );
      const session =
        isRecord(resumed) && isRecord(resumed.session) ? resumed.session : {};
      const mode = isRecord(session.approvalMode)
        ? readString(session.approvalMode.mode)
        : undefined;
      if (mode !== this.plan.museMode) {
        await this.applyApprovalMode(host.connection, sessionId, this.plan);
      }
      await this.reseedPendingApprovals();
    } catch (error) {
      await this.closeHost();
      throw new SendTurnRefusedError(
        `Muse's host could not be restarted: ${errorMessage(error)}`,
        'provider_error',
      );
    }
  }

  private async reseedPendingApprovals(): Promise<void> {
    const connection = this.requireConnection();
    const listed = await connection.request(
      'approval/listPending',
      { sessionId: this.requireMuseSessionId() },
      { timeoutMs: this.deps.requestTimeoutMs },
    );
    const approvals =
      isRecord(listed) && Array.isArray(listed.approvals)
        ? listed.approvals
        : [];
    for (const approval of approvals) {
      if (isRecord(approval)) this.onApprovalRequested(approval);
    }
    // Prompts still open in the session: put to the user again (the host also
    // re-issues them as `userInput/request`; both fold by `userInputId`).
    const userInputs =
      isRecord(listed) && Array.isArray(listed.userInputs)
        ? listed.userInputs
        : [];
    for (const userInput of userInputs) {
      if (isRecord(userInput)) this.onUserInputRequested(userInput);
    }
  }

  /**
   * Close the transport and ask its owner to terminate the host. A Stop
   * retains unconfirmed custody; leader exit alone cannot settle that stop.
   */
  private async closeHost(retainUnconfirmed = false): Promise<boolean> {
    const host = this.host;
    if (!host) return true;
    this.host = undefined;
    host.closing = true;
    host.connection.close();
    try {
      await this.deps.terminateHost(host.spawned);
    } catch (error) {
      this.deps.logger?.warn('Muse host termination was not confirmed', {
        threadId: this.deps.threadId,
        pid: host.spawned.process.pid,
        error: errorMessage(error),
      });
      if (retainUnconfirmed) return false;
      const processHandle = host.spawned.process;
      if (
        processHandle.exitCode === null &&
        processHandle.signalCode === null
      ) {
        processHandle.once('exit', () => host.spawned.release?.());
        return false;
      }
    }
    host.spawned.release?.();
    return true;
  }

  private handleHostClose(epoch: number, info: MuseServeCloseInfo): void {
    const host = this.host;
    if (!host || host.epoch !== epoch) return;
    this.host = undefined;
    host.spawned.release?.();
    if (host.closing || this.stopped) return;
    const stderr = redactSecrets(info.stderrTail.trim());
    const message = `Muse's host process exited${
      info.code === null ? '' : ` with code ${info.code}`
    }${info.error ? ` (${info.error.message})` : ''}. Station will restart it on the next message.${
      stderr ? ` Last output: ${stderr}` : ''
    }`;
    this.deps.logger?.warn('Muse serve host exited', {
      threadId: this.deps.threadId,
      code: info.code,
    });
    this.settleAfterHostLoss(message);
  }

  /**
   * Everything the lost host was running can no longer report: open turns
   * fail visibly, pending approvals resolve cancelled, and running children
   * settle unresolved. The next send re-hosts and resumes the session.
   */
  private settleAfterHostLoss(message: string): void {
    for (const turn of this.turns.values()) {
      if (turn.settled) continue;
      this.closeOpenTools(turn);
      this.settle(turn, {
        method: 'runtime.error',
        severity: 'error',
        ...providerFailure('engine_crashed'),
        message,
        code: MUSE_SERVE_HOST_EXITED_CODE,
      } satisfies ProviderRuntimeErrorBody);
    }
    for (const pending of this.approvals.values()) {
      this.clearDeadline(pending);
      this.clearEscalation(pending);
      this.settleUnanswered(pending, 'cancelled');
    }
    this.approvals.clear();
    this.abandonUserInputs();
    settleOpenMuseChildren(this.childWork, { close: false });
  }

  // -------------------------------------------------------- notifications

  private handleNotification(
    epoch: number,
    method: string,
    params: Record<string, unknown>,
  ): void {
    if (epoch !== this.hostEpoch || this.stopped) return;
    const sessionId = readString(params.sessionId);
    if (
      sessionId &&
      this.museSessionIdValue &&
      sessionId !== this.museSessionIdValue
    ) {
      return;
    }
    switch (method) {
      case 'session/goalChanged':
        // Replace wholesale; `null` clears (MSP `SessionGoalChangedParams`).
        this.goal = museGoalState(params.goal);
        return;
      case 'turn/started':
        this.onTurnStarted(params);
        return;
      case 'turn/completed':
        this.routeTurnFrame(readString(params.turnId), () =>
          this.onTurnCompleted(params),
        );
        return;
      case 'item/started':
      case 'item/updated':
      case 'item/completed': {
        const item = isRecord(params.item) ? params.item : undefined;
        if (!item) return;
        if (item.kind === 'workflow') {
          observeMuseWorkflowItem(this.childWork, item);
          return;
        }
        if (item.kind === 'subagent') {
          observeMuseSubagentItem(this.childWork, item);
          return;
        }
        // A background task's revisions after its turn ended belong to the
        // task, not to the turn whose row already closed.
        if (
          item.kind === 'toolCall' &&
          observeMuseToolCallItem(this.childWork, item)
        ) {
          return;
        }
        // Deltas name only their item, so its kind and turn are recorded
        // here, before any buffering, for the deltas that follow.
        const itemId = readString(item.itemId);
        const itemTurnId = readString(item.turnId);
        if (
          itemId &&
          itemTurnId &&
          (item.kind === 'agentMessage' || item.kind === 'reasoning') &&
          method !== 'item/completed'
        ) {
          this.deltaTurnIds.set(itemId, itemTurnId);
          this.itemKinds.set(itemId, item.kind);
        }
        this.routeTurnFrame(readString(item.turnId), () =>
          this.onItem(item, method),
        );
        return;
      }
      case 'item/delta': {
        const itemId = readString(params.itemId);
        const turnId = itemId ? this.deltaTurnIds.get(itemId) : undefined;
        this.routeTurnFrame(turnId, () => this.onDelta(params));
        return;
      }
      case 'session/tokenUsage':
        this.routeTurnFrame(readString(params.turnId), () =>
          this.onTokenUsage(params),
        );
        return;
      case 'session/contextUsage':
        this.routeSessionFrame((turnId) => this.onContextUsage(params, turnId));
        return;
      case 'session/todoListChanged':
        this.routeSessionFrame((turnId) =>
          this.onTodoListChanged(params, turnId),
        );
        return;
      case 'session/modelChanged':
        this.routeSessionFrame((turnId) => this.onModelChanged(params, turnId));
        return;
      case 'session/modelRouteUnserved':
        this.routeSessionFrame((turnId) =>
          this.onModelRouteUnserved(params, turnId),
        );
        return;
      case 'turn/retryScheduled':
      case 'turn/modelRetryScheduled':
        this.routeTurnFrame(readString(params.turnId), () =>
          this.onRetryScheduled(params),
        );
        return;
      case 'approval/requested':
        this.onApprovalRequested(params);
        return;
      case 'approval/updated':
        this.onApprovalUpdated(params);
        return;
      case 'approval/resolved':
        this.onApprovalResolved(params);
        return;
      case 'approval/reviewing':
        this.onApprovalReviewing(params);
        return;
      case 'userInput/requested':
        this.onUserInputRequested(params);
        return;
      case 'userInput/settled':
        this.onUserInputSettled(params);
        return;
      default:
        return;
    }
  }

  /**
   * MSP server requests: a presentation request (`approval/request`,
   * `userInput/request`) is folded into the same record its notification
   * twin opens, and answered with the empty presentation receipt
   * (`RequestReceipt`). The decision travels later as its own command. Any
   * other request is refused (`undefined`).
   */
  private handleServerRequest(
    epoch: number,
    method: string,
    params: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    if (method !== 'approval/request' && method !== 'userInput/request')
      return undefined;
    // A stale host or a stopped session cannot present anything.
    if (epoch !== this.hostEpoch || this.stopped) return undefined;
    const sessionId = readString(params.sessionId);
    if (
      sessionId &&
      this.museSessionIdValue &&
      sessionId !== this.museSessionIdValue
    )
      return undefined;
    if (method === 'approval/request') this.onApprovalRequested(params);
    else this.onUserInputRequested(params);
    return {};
  }

  /** agentMessage/reasoning item id → its turn, for deltas (which omit it). */
  private readonly deltaTurnIds = new Map<string, string>();

  /**
   * Runs `frame` now, or — for a dispatched turn whose `turn/start` ack has
   * not arrived yet — after its `turn.started` is published, so no event of
   * a turn ever precedes the turn itself.
   */
  private routeTurnFrame(turnId: string | undefined, frame: () => void): void {
    const turn = turnId ? this.turns.get(turnId) : undefined;
    if (turn && turn.kind === 'dispatched' && !turn.startPublished) {
      turn.buffered.push(frame);
      return;
    }
    frame();
  }

  /**
   * A session-level frame (no `turnId` of its own). It is attributed to the
   * turn running now, if any, and waits behind a dispatched turn's
   * `turn.started` like that turn's own frames.
   */
  private routeSessionFrame(frame: (turnId: string | undefined) => void): void {
    const live = this.liveTurn();
    if (live && live.kind === 'dispatched' && !live.startPublished) {
      live.buffered.push(() => frame(live.settled ? undefined : live.turnId));
      return;
    }
    frame(live?.turnId);
  }

  private onTurnStarted(params: Record<string, unknown>): void {
    const turnId = readString(params.turnId);
    if (!turnId || this.turns.has(turnId)) return;
    // A turn no send of Station's minted: the host opened it itself (the
    // follow-up after background work). #2324's provider turn.
    const turn = this.createTurn(turnId, 'provider');
    turn.startPublished = true;
    this.turns.set(turnId, turn);
    this.deps.publish({
      eventId: crypto.randomUUID(),
      provider: 'muse',
      threadId: this.deps.threadId,
      createdAt: this.nowIso(),
      method: 'turn.started',
      turnId,
      metadata: { trigger: PROVIDER_TURN_TRIGGER },
    });
  }

  private onTurnCompleted(params: Record<string, unknown>): void {
    const turnId = readString(params.turnId);
    const turn = turnId ? this.turns.get(turnId) : undefined;
    if (!turn || turn.settled) return;
    const terminal = readString(params.terminal);
    if (terminal === 'completed') this.closeBackgroundedTools(turn);
    this.closeOpenTools(turn);
    if (terminal === 'completed') {
      this.settle(turn, { method: 'turn.completed', finishReason: 'stop' });
      return;
    }
    if (terminal === 'cancelled') {
      if (turn.stopRequested) {
        this.settle(turn, { method: 'turn.aborted', reason: 'interrupted' });
      } else {
        // Muse cancelled it and nobody in Station asked: a cancellation,
        // never a success.
        this.settle(turn, {
          method: 'turn.completed',
          finishReason: 'cancelled',
        });
      }
      return;
    }
    if (terminal === 'failed') {
      const error = isRecord(params.error) ? params.error : {};
      const detail = readString(error.message) ?? readString(params.reason);
      this.settle(turn, {
        method: 'runtime.error',
        severity: 'error',
        ...providerFailure('provider_error'),
        code: ENGINE_TURN_FAILED_CODE,
        message: `The Muse turn failed${
          detail
            ? `: ${truncate(redactSecrets(detail), TURN_ERROR_MESSAGE_MAX_CHARS)}`
            : '.'
        }`,
        ...(typeof error.retryable === 'boolean'
          ? { retriable: error.retryable }
          : {}),
      } satisfies ProviderRuntimeErrorBody);
      return;
    }
    // An open terminal this build does not know: the turn is over, with no
    // outcome Station can name.
    this.settle(turn, { method: 'turn.completed', finishReason: 'other' });
  }

  private onItem(item: Record<string, unknown>, method: string): void {
    const itemId = readString(item.itemId);
    const turnId = readString(item.turnId);
    const kind = readString(item.kind);
    if (!itemId || !kind) return;
    const turn = turnId ? this.turns.get(turnId) : undefined;
    if (kind === 'agentMessage' || kind === 'reasoning') {
      if (method !== 'item/completed') return;
      this.deltaTurnIds.delete(itemId);
      this.itemKinds.delete(itemId);
      if (kind === 'agentMessage' && turn && !turn.settled) {
        this.reconcileMessageText(turn, itemId, readString(item.text) ?? '');
      }
      return;
    }
    if (kind !== 'toolCall') return;
    const callId = readString(item.callId);
    const toolName = readString(item.tool);
    if (!callId || !toolName || !turn || turn.settled) return;
    const status = readString(item.status);
    if (!turn.openTools.has(callId) && status === 'inProgress') {
      turn.openTools.set(callId, toolName);
      this.deps.publish({
        eventId: crypto.randomUUID(),
        provider: 'muse',
        threadId: this.deps.threadId,
        createdAt: this.nowIso(),
        method: 'tool.started',
        turnId: turn.turnId,
        itemId: `tool:${callId}`,
        toolCallId: callId,
        toolName,
        arguments: parseJsonMaybe(item.args),
      });
      return;
    }
    if (!status || status === 'inProgress') return;
    if (!turn.openTools.has(callId)) {
      // Completed without a start we saw: open it so the row has a start.
      this.deps.publish({
        eventId: crypto.randomUUID(),
        provider: 'muse',
        threadId: this.deps.threadId,
        createdAt: this.nowIso(),
        method: 'tool.started',
        turnId: turn.turnId,
        itemId: `tool:${callId}`,
        toolCallId: callId,
        toolName,
        arguments: parseJsonMaybe(item.args),
      });
    }
    turn.openTools.delete(callId);
    if (toolName === 'workflow') {
      observeMuseWorkflowLaunch(this.childWork, callId, item.visibleOutput);
    }
    const output = item.visibleOutput ?? item.failureReason;
    const preview = projectBoundedToolOutput(output);
    this.deps.publish({
      eventId: crypto.randomUUID(),
      provider: 'muse',
      threadId: this.deps.threadId,
      createdAt: this.nowIso(),
      method: 'tool.completed',
      turnId: turn.turnId,
      itemId: `tool:${callId}`,
      toolCallId: callId,
      toolName,
      status:
        status === 'completed'
          ? 'success'
          : status === 'cancelled'
            ? 'cancelled'
            : 'error',
      ...(output === undefined ? {} : { output: preview.value }),
      ...(preview.receipt ? { outputReceipt: preview.receipt } : {}),
    });
  }

  private onDelta(params: Record<string, unknown>): void {
    const itemId = readString(params.itemId);
    const delta = typeof params.delta === 'string' ? params.delta : '';
    const field = readString(params.field) ?? 'text';
    if (!itemId || !delta) return;
    const turnId = this.deltaTurnIds.get(itemId);
    const turn = turnId ? this.turns.get(turnId) : undefined;
    if (!turn || turn.settled) return;
    const kind = this.itemKinds.get(itemId);
    if (kind === 'reasoning') {
      this.deps.publish({
        eventId: crypto.randomUUID(),
        provider: 'muse',
        threadId: this.deps.threadId,
        createdAt: this.nowIso(),
        method: 'content.reasoning-delta',
        turnId: turn.turnId,
        itemId,
        delta,
      });
      return;
    }
    if (kind !== 'agentMessage' || field !== 'text') return;
    this.appendText(turn, itemId, delta);
  }

  private appendText(turn: ServeTurn, itemId: string, delta: string): void {
    if (!turn.streamed.has(itemId)) {
      turn.streamed.set(itemId, '');
      if (turn.textItems.length > 0 && turn.outputText.length > 0) {
        turn.outputText += '\n\n';
      }
      turn.textItems.push(itemId);
    }
    turn.streamed.set(itemId, (turn.streamed.get(itemId) ?? '') + delta);
    turn.outputText += delta;
    this.deps.publish({
      eventId: crypto.randomUUID(),
      provider: 'muse',
      threadId: this.deps.threadId,
      createdAt: this.nowIso(),
      method: 'content.text-delta',
      turnId: turn.turnId,
      itemId,
      delta,
    });
  }

  /**
   * An agentMessage's completed text is its full value. Whatever deltas did
   * not already carry (none streamed, or the stream saturated) is published
   * as one more delta, so the transcript and `outputText` hold all of it.
   */
  private reconcileMessageText(
    turn: ServeTurn,
    itemId: string,
    fullText: string,
  ): void {
    const streamed = turn.streamed.get(itemId) ?? '';
    if (fullText.length > streamed.length && fullText.startsWith(streamed)) {
      this.appendText(turn, itemId, fullText.slice(streamed.length));
    }
  }

  private onTokenUsage(params: Record<string, unknown>): void {
    const turnId = readString(params.turnId);
    const turn = turnId ? this.turns.get(turnId) : undefined;
    if (!turn) return;
    const usage = isRecord(params.usage) ? params.usage : {};
    const promptTokens = readCount(usage.inputTokens);
    const completionTokens = readCount(usage.outputTokens);
    if (promptTokens === undefined && completionTokens === undefined) return;
    const cacheReadTokens = readCount(usage.cacheReadTokens);
    const cacheWriteTokens = readCount(usage.cacheWriteTokens);
    const reportedCostUsd = museSessionCostUsd(params.cumulative);
    // One model completion's usage (not cumulative): each event is its own
    // receipt, which is how the usage fold treats a non-cumulative engine.
    // The cost is the session's running total (`cumulative.cost`), so it
    // rides `reportedCost` with `scope: 'session'`.
    this.deps.publish({
      eventId: crypto.randomUUID(),
      provider: 'muse',
      threadId: this.deps.threadId,
      createdAt: this.nowIso(),
      method: 'token-usage.updated',
      turnId: turn.turnId,
      ...(promptTokens !== undefined ? { promptTokens } : {}),
      ...(completionTokens !== undefined ? { completionTokens } : {}),
      totalTokens: (promptTokens ?? 0) + (completionTokens ?? 0),
      ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
      ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
      ...(reportedCostUsd !== undefined
        ? {
            reportedCost: {
              amount: reportedCostUsd,
              unit: 'USD',
              scope: 'session' as const,
            },
          }
        : {}),
    });
  }

  /**
   * `session/contextUsage`: occupancy and, when muse's basis has a limit,
   * the window. Muse sends no percentage, so none is derived here; a
   * window-less occupancy is published alone (the usage fold resolves the
   * window elsewhere). `pressure` has no canonical home and is not mapped.
   */
  private onContextUsage(
    params: Record<string, unknown>,
    turnId: string | undefined,
  ): void {
    const contextTokens = readCount(params.usedTokens);
    if (contextTokens === undefined) return;
    const window = readCount(params.windowTokens);
    this.deps.publish({
      eventId: crypto.randomUUID(),
      provider: 'muse',
      threadId: this.deps.threadId,
      createdAt: this.nowIso(),
      method: 'token-usage.updated',
      ...(turnId ? { turnId } : {}),
      contextTokens,
      ...(window !== undefined && window > 0
        ? { contextWindowTokens: window }
        : {}),
    });
  }

  /**
   * `session/todoListChanged` → `plan.updated`, a full replace (MSP: "an
   * empty `items` array is a cleared list"). Cancelled and unknown-status
   * items are left out (see {@link MUSE_TODO_STATUS}).
   */
  private onTodoListChanged(
    params: Record<string, unknown>,
    turnId: string | undefined,
  ): void {
    if (!Array.isArray(params.items)) return;
    const entries: PlanEntry[] = [];
    for (const item of params.items) {
      if (!isRecord(item)) continue;
      const content = readString(item.text);
      const status = MUSE_TODO_STATUS[readString(item.status) ?? ''];
      if (content && status) entries.push({ content, status });
    }
    this.deps.publish({
      eventId: crypto.randomUUID(),
      provider: 'muse',
      threadId: this.deps.threadId,
      createdAt: this.nowIso(),
      method: 'plan.updated',
      ...(turnId ? { turnId } : {}),
      entries,
    });
  }

  /**
   * `session/modelChanged`. A `policy` change is muse moving the session
   * onto a model nobody picked: `model.rerouted` (session scope, since the
   * selection is now the session's). A `user` or `default` change (another
   * client's pick, or muse's default resolving) reconfigures the session's
   * model. A change to the model already held (the echo of Station's own
   * `session/setModel`) publishes nothing.
   */
  private onModelChanged(
    params: Record<string, unknown>,
    turnId: string | undefined,
  ): void {
    const modelId = readString(params.modelId);
    if (!modelId || !MUSE_MODEL_ID.test(modelId) || modelId === this.model)
      return;
    const previous = this.model;
    this.model = modelId;
    this.deps.onModelChanged?.(modelId);
    const base = {
      eventId: crypto.randomUUID(),
      provider: 'muse' as const,
      threadId: this.deps.threadId,
      createdAt: this.nowIso(),
    };
    if (readString(params.source) === 'policy' && previous) {
      this.deps.publish({
        ...base,
        method: 'model.rerouted',
        ...(turnId ? { turnId } : {}),
        fromModel: previous,
        toModel: modelId,
        trigger: 'other',
        scope: 'session',
      });
      return;
    }
    this.deps.publish({
      ...base,
      method: 'session.configured',
      sessionId: this.deps.threadId,
      model: modelId,
    });
  }

  /** `session/modelRouteUnserved`: the standing model cannot be served now. */
  private onModelRouteUnserved(
    params: Record<string, unknown>,
    turnId: string | undefined,
  ): void {
    const modelId = readString(params.modelId);
    const installed = readString(params.installedProviderId);
    const model = modelId && MUSE_MODEL_ID.test(modelId) ? modelId : undefined;
    const provider =
      installed && MUSE_MODEL_ID.test(installed) ? installed : undefined;
    this.deps.publish({
      eventId: crypto.randomUUID(),
      provider: 'muse',
      threadId: this.deps.threadId,
      createdAt: this.nowIso(),
      method: 'runtime.warning',
      severity: 'warning',
      code: MUSE_MODEL_ROUTE_UNSERVED_CODE,
      ...(turnId ? { turnId } : {}),
      message: `Muse's provider${provider ? ` (${provider})` : ''} cannot serve this session's model${
        model ? ` ${model}` : ''
      }. Choose another model before the next message.`,
      details: {
        ...(model ? { modelId: model } : {}),
        ...(provider ? { installedProviderId: provider } : {}),
      },
    });
  }

  /**
   * `turn/retryScheduled` / `turn/modelRetryScheduled`: a model attempt of a
   * running turn failed and muse scheduled the next. Both shapes describe the
   * same scheduled attempt, so each `nextAttempt` is announced once per turn.
   */
  private onRetryScheduled(params: Record<string, unknown>): void {
    const turnId = readString(params.turnId);
    const turn = turnId ? this.turns.get(turnId) : undefined;
    if (!turn || turn.settled) return;
    const nextAttempt = readCount(params.nextAttempt);
    const maxAttempts = readCount(params.maxAttempts);
    const retryDelayMs = readCount(params.retryDelayMs);
    if (nextAttempt === undefined || maxAttempts === undefined) return;
    if (
      turn.retriesAnnounced.has(nextAttempt) ||
      turn.retriesAnnounced.size >= RETRY_ANNOUNCEMENTS_MAX
    )
      return;
    turn.retriesAnnounced.add(nextAttempt);
    const reason = readString(params.reason);
    const errorKind = readString(params.errorKind);
    const httpStatus = readCount(params.httpStatus);
    const why = reason
      ? truncate(redactSecrets(reason), RETRY_REASON_MAX_CHARS)
      : errorKind
        ? truncate(redactSecrets(errorKind), RETRY_REASON_MAX_CHARS)
        : undefined;
    this.deps.publish({
      eventId: crypto.randomUUID(),
      provider: 'muse',
      threadId: this.deps.threadId,
      createdAt: this.nowIso(),
      method: 'runtime.warning',
      severity: 'warning',
      code: MUSE_MODEL_RETRY_SCHEDULED_CODE,
      turnId: turn.turnId,
      message: `Muse is retrying the model call (attempt ${nextAttempt} of ${maxAttempts}${
        retryDelayMs !== undefined
          ? `, in ${formatMuseServeDuration(retryDelayMs)}`
          : ''
      })${why ? `: ${why}` : '.'}`,
      details: {
        nextAttempt,
        maxAttempts,
        ...(retryDelayMs !== undefined ? { retryDelayMs } : {}),
        ...(httpStatus !== undefined ? { httpStatus } : {}),
      },
    });
  }

  // ---------------------------------------------------------- user input

  /**
   * A `request_user_input` prompt (`userInput/request` or its
   * `userInput/requested` twin, or a `listPending` entry): one Station
   * request per `userInputId`. A prompt Station cannot render is declined
   * at once, so the turn waiting on it continues instead of hanging.
   */
  private onUserInputRequested(params: Record<string, unknown>): void {
    const userInputId = readString(params.userInputId);
    if (!userInputId || this.stopped) return;
    if (
      this.userInputs.has(userInputId) ||
      this.settledUserInputIds.has(userInputId)
    )
      return;
    const form = museInputRequest(params);
    if (!form) {
      this.rememberSettledUserInput(userInputId);
      this.deps.logger?.warn('Muse asked a question Station cannot present', {
        threadId: this.deps.threadId,
        userInputId,
      });
      const connection = this.host?.connection;
      const sessionId = this.museSessionIdValue;
      if (connection && !connection.isClosed && sessionId) {
        void connection
          .request(
            'userInput/cancel',
            {
              commandId: this.deps.newCommandId(),
              sessionId,
              userInputId,
              reason: 'Station cannot present this question.',
            },
            { timeoutMs: this.deps.requestTimeoutMs },
          )
          .catch((error: unknown) => {
            this.deps.logger?.warn('Muse userInput/cancel was not admitted', {
              threadId: this.deps.threadId,
              userInputId,
              error: errorMessage(error),
            });
          });
      }
      return;
    }
    const turnId = readString(params.turnId);
    const turn = turnId ? this.turns.get(turnId) : undefined;
    // Only a live turn is named: one that settled (a host loss, then a
    // re-hosted session re-listing its prompt) is not the turn waiting now.
    const ownTurn = turn && !turn.settled ? turn.turnId : undefined;
    const requestId = this.resolvedUserInputIds.has(userInputId)
      ? `${userInputId}:${crypto.randomUUID()}`
      : userInputId;
    const eventId = crypto.randomUUID();
    const pending: PendingUserInput = {
      userInputId,
      requestId,
      form,
      openedEventId: eventId,
      ...(ownTurn ? { turnId: ownTurn } : {}),
      answering: false,
      resolvedPublished: false,
    };
    this.userInputs.set(userInputId, pending);
    // Muse times an unengaged prompt out itself, per question.
    const perQuestionMs = params.autoResolutionMs;
    const expiresAt =
      typeof perQuestionMs === 'number' &&
      Number.isFinite(perQuestionMs) &&
      perQuestionMs > 0
        ? new Date(
            this.deps.now().getTime() + perQuestionMs * form.body.fields.length,
          ).toISOString()
        : undefined;
    const publish = () =>
      this.deps.publish({
        eventId,
        provider: 'muse',
        threadId: this.deps.threadId,
        createdAt: this.nowIso(),
        ...(ownTurn ? { turnId: ownTurn } : {}),
        requestId,
        method: 'request.opened',
        requestType: 'approval',
        title: form.message,
        payload: {
          toolName: readString(params.toolName) ?? 'request_user_input',
          ...(readString(params.toolCallId)
            ? { toolCallId: params.toolCallId }
            : {}),
          inputRequest: form,
          ...(expiresAt ? { expiresAt } : {}),
        },
      });
    this.routeTurnFrame(ownTurn, publish);
  }

  private onUserInputSettled(params: Record<string, unknown>): void {
    const userInputId = readString(params.userInputId);
    if (!userInputId) return;
    this.rememberSettledUserInput(userInputId);
    const pending = this.userInputs.get(userInputId);
    if (!pending) return;
    this.userInputs.delete(userInputId);
    const outcome = readString(params.outcome);
    const engineStatus: ApprovalStatus =
      outcome === 'answered' || outcome === 'clarified'
        ? 'approved'
        : outcome === 'timedOut'
          ? 'expired'
          : 'cancelled';
    if (pending.decidedAtMs !== undefined && pending.resolvedPublished) {
      this.deps.publish({
        eventId: crypto.randomUUID(),
        provider: 'muse',
        threadId: this.deps.threadId,
        createdAt: this.nowIso(),
        requestId: pending.requestId,
        method: 'request.delivery',
        outcome: 'acknowledged',
        waitedMs: Math.max(0, this.deps.now().getTime() - pending.decidedAtMs),
        engineStatus,
      });
      return;
    }
    this.publishUserInputResolved(pending, engineStatus, {
      ...(outcome ? { outcome } : {}),
    });
  }

  /**
   * Station stops offering `pending` without muse having settled it (its
   * turn ended, the host went away, the session stopped). A decision Station
   * already recorded was never acknowledged; otherwise the request resolves
   * cancelled.
   */
  private closeUserInput(
    pending: PendingUserInput,
    response?: Record<string, unknown>,
  ): void {
    if (this.userInputs.get(pending.userInputId) === pending)
      this.userInputs.delete(pending.userInputId);
    if (pending.decidedAtMs !== undefined && pending.resolvedPublished) {
      const decidedAtMs = pending.decidedAtMs;
      pending.decidedAtMs = undefined;
      this.deps.publish({
        eventId: crypto.randomUUID(),
        provider: 'muse',
        threadId: this.deps.threadId,
        createdAt: this.nowIso(),
        requestId: pending.requestId,
        method: 'request.delivery',
        outcome: 'unacknowledged',
        reason: 'no-acknowledgement',
        waitedMs: Math.max(0, this.deps.now().getTime() - decidedAtMs),
      });
      return;
    }
    this.publishUserInputResolved(pending, 'cancelled', response);
  }

  private abandonUserInputs(): void {
    for (const pending of [...this.userInputs.values()])
      this.closeUserInput(pending);
  }

  private publishUserInputResolved(
    pending: PendingUserInput,
    status: ApprovalStatus,
    response?: Record<string, unknown>,
    acknowledgement?: ApprovalAcknowledgement,
  ): void {
    if (pending.resolvedPublished) return;
    pending.resolvedPublished = true;
    this.resolvedUserInputIds.add(pending.userInputId);
    if (this.resolvedUserInputIds.size > SETTLED_USER_INPUTS_MAX) {
      const oldest = this.resolvedUserInputIds.values().next().value;
      if (oldest !== undefined) this.resolvedUserInputIds.delete(oldest);
    }
    this.deps.publish({
      eventId: crypto.randomUUID(),
      provider: 'muse',
      threadId: this.deps.threadId,
      createdAt: this.nowIso(),
      requestId: pending.requestId,
      method: 'request.resolved',
      status,
      ...(response && Object.keys(response).length > 0 ? { response } : {}),
      ...(acknowledgement ? { acknowledgement } : {}),
    });
  }

  private rememberSettledUserInput(userInputId: string): void {
    this.settledUserInputIds.delete(userInputId);
    this.settledUserInputIds.add(userInputId);
    if (this.settledUserInputIds.size > SETTLED_USER_INPUTS_MAX) {
      const oldest = this.settledUserInputIds.values().next().value;
      if (oldest !== undefined) this.settledUserInputIds.delete(oldest);
    }
  }

  // ------------------------------------------------------------ approvals

  /**
   * `approval/reviewing` (stable MSP): muse's automated reviewer holds an
   * approval — "typed activity, not a request". Nobody is asked anything, so
   * it is not a `request.opened`; it is progress on the tool call waiting
   * for it (`tool.progress`). If the reviewer escalates, the same approval
   * then arrives as `approval/requested` (`judgeEscalated: true`) and is
   * asked as usual; if it decides, `approval/resolved` follows.
   *
   * Reported only where Station can name the tool: a call (`toolCallId`, the
   * provider's call id, which is what `tool.started` keys on) of the
   * session's own live turn that Station has seen open. A workflow
   * subagent's approval (`subagentOrigin`) belongs to its child work, which
   * has no tool rows of its own here, so it is not reported.
   */
  private onApprovalReviewing(params: Record<string, unknown>): void {
    if (this.stopped || isRecord(params.subagentOrigin)) return;
    const turnId = readString(params.turnId);
    const turn = turnId ? this.turns.get(turnId) : undefined;
    if (!turn || turn.settled) return;
    const callId = readString(params.toolCallId);
    if (!callId || !turn.openTools.has(callId)) return;
    this.deps.publish({
      eventId: crypto.randomUUID(),
      provider: 'muse',
      threadId: this.deps.threadId,
      createdAt: this.nowIso(),
      method: 'tool.progress',
      turnId: turn.turnId,
      itemId: `tool:${callId}`,
      toolCallId: callId,
      message: MUSE_APPROVAL_REVIEWING_MESSAGE,
    });
  }

  private onApprovalRequested(params: Record<string, unknown>): void {
    const approvalId = readString(params.approvalId);
    if (!approvalId || this.stopped) return;
    const existing = this.approvals.get(approvalId);
    if (existing) {
      this.onApprovalRestated(existing, params);
      return;
    }
    const origin = isRecord(params.subagentOrigin) ? params.subagentOrigin : {};
    const subagentId = readString(origin.subagentId);
    const toolName = readString(params.toolName) ?? 'tool';
    const escalatedBefore = this.escalatedApprovalIds.has(approvalId);
    const requestId = this.resolvedApprovalIds.has(approvalId)
      ? `${approvalId}:${crypto.randomUUID()}`
      : approvalId;
    const pending: PendingApproval = {
      approvalId,
      requestId,
      toolName,
      ...(subagentId ? { subagentId } : {}),
      stages: [],
      choices: [],
      published: false,
      resolvedPublished: false,
      deciding: false,
      stagesDecided: 0,
      retriedKeys: new Set(),
      escalationStep: 0,
      generation: 0,
      ...(escalatedBefore ? { escalatedBefore: true } : {}),
    };
    const signature = approvalSubjectSignature(params);
    if (signature) pending.subjectSignature = signature;
    const turnId = readString(params.turnId);
    // #3071: only a request the turn itself is waiting on names the turn. A
    // workflow subagent's does not, whatever turn id its origin reports: a
    // turn's abort settles the requests that name it, and a subagent's unit
    // of work is not the turn.
    if (!subagentId && turnId && this.turns.has(turnId))
      pending.turnId = turnId;
    this.updateApproval(pending, params);
    this.approvals.set(approvalId, pending);
    if (escalatedBefore) {
      // Already declined and escalated once, and back after a re-host:
      // attempt to decline it at once rather than ask again.
      this.deps.publish({
        eventId: crypto.randomUUID(),
        provider: 'muse',
        threadId: this.deps.threadId,
        createdAt: this.nowIso(),
        method: 'runtime.warning',
        severity: 'warning',
        code: MUSE_APPROVAL_EXPIRED_CODE,
        message: `Muse brought back a request to use ${toolName} that Station had already declined, so Station attempted to decline it again without asking.`,
        details: {
          approvalId,
          ...(subagentId ? { childId: subagentId } : {}),
        },
      });
      pending.intent = 'expire';
      this.armDeadline(pending);
      this.continueWalk(pending);
      return;
    }
    if (this.approvedTools.has(toolName)) {
      // "Allow for this session" covers every later call of the tool (#2299,
      // Station's rule for every engine: trust the tool, not the call);
      // denies are never remembered. Walked with one-time allows only.
      pending.intent = 'accept';
      this.continueWalk(pending);
      return;
    }
    this.armDeadline(pending);
    this.publishOpened(pending, params);
  }

  private updateApproval(
    pending: PendingApproval,
    params: Record<string, unknown>,
  ): void {
    const current = requirementRef(params.currentRequirementId);
    if (current) pending.current = current;
    const subject = isRecord(params.subject) ? params.subject : {};
    if (Array.isArray(subject.stages)) {
      pending.stages = subject.stages.flatMap((stage) => {
        if (!isRecord(stage)) return [];
        const ref = requirementRef(stage.requirementId);
        const resolution = isRecord(stage.resolution)
          ? readString(stage.resolution.kind)
          : undefined;
        return ref
          ? [
              {
                key: requirementKey(ref),
                resolution: resolution ?? 'unresolved',
              },
            ]
          : [];
      });
    }
    if (Array.isArray(params.availableChoices)) {
      pending.choices = params.availableChoices.flatMap((choice) => {
        if (!isRecord(choice)) return [];
        const choiceId = readString(choice.choiceId);
        return choiceId
          ? [
              {
                choiceId,
                ...(readString(choice.decision)
                  ? { decision: choice.decision as string }
                  : {}),
                ...(readString(choice.scope)
                  ? { scope: choice.scope as string }
                  : {}),
                acceptsFeedback: choice.acceptsFeedback === true,
              },
            ]
          : [];
      });
    }
  }

  private publishOpened(
    pending: PendingApproval,
    params: Record<string, unknown>,
  ): void {
    const subject = isRecord(params.subject) ? params.subject : {};
    const command = readString(subject.command);
    const stages = Array.isArray(subject.stages)
      ? subject.stages.flatMap((stage) =>
          isRecord(stage) && Array.isArray(stage.argv)
            ? [
                stage.argv.filter(
                  (part): part is string => typeof part === 'string',
                ),
              ]
            : [],
        )
      : [];
    const turnId = readString(params.turnId);
    const ownTurn =
      !pending.subagentId && turnId && this.turns.has(turnId)
        ? turnId
        : undefined;
    const expiresAt = new Date(
      this.deps.now().getTime() + this.deps.approvalTimeoutMs,
    ).toISOString();
    const who = pending.subagentId ? 'A Muse workflow subagent' : 'Muse';
    const toolInput = parseJsonMaybe(params.rawArgs);
    pending.published = true;
    this.deps.publish({
      eventId: crypto.randomUUID(),
      provider: 'muse',
      threadId: this.deps.threadId,
      createdAt: this.nowIso(),
      ...(ownTurn ? { turnId: ownTurn } : {}),
      requestId: pending.requestId,
      method: 'request.opened',
      requestType: 'approval',
      title: `Allow ${pending.toolName}`,
      description: command
        ? `${who} asks to run: ${truncate(command, TITLE_COMMAND_MAX_CHARS)}`
        : `${who} asks to use ${pending.toolName}.`,
      payload: {
        toolName: pending.toolName,
        ...(readString(params.toolCallId)
          ? { toolCallId: params.toolCallId }
          : {}),
        ...(toolInput !== undefined
          ? { toolInput: projectBoundedToolOutput(toolInput).value }
          : {}),
        ...(command ? { command } : {}),
        ...(stages.length > 1 ? { stages } : {}),
        // The subagent that asked, keyed exactly as its child work is
        // (`engine-subagent` / this thread / the workflow childId), so the
        // request is attributed to the child rather than the main thread.
        ...(pending.subagentId
          ? {
              agentId: pending.subagentId,
              childWork: {
                producer: 'engine-subagent',
                reporterThreadId: this.deps.threadId,
                childId: pending.subagentId,
              },
            }
          : {}),
        expiresAt,
      },
    });
  }

  private onApprovalUpdated(params: Record<string, unknown>): void {
    const approvalId = readString(params.approvalId);
    const pending = approvalId ? this.approvals.get(approvalId) : undefined;
    if (!pending) return;
    this.onApprovalRestated(pending, params);
  }

  /**
   * A later statement of a known approval (`approval/updated`, a re-issued
   * `approval/requested`, a `listPending` read). A walk only continues while
   * the subject is the one the user answered: if it changed, the answer does
   * not carry over. The old request resolves `cancelled` and the new subject
   * is put to the user as a new request.
   */
  private onApprovalRestated(
    pending: PendingApproval,
    params: Record<string, unknown>,
  ): void {
    const signature = approvalSubjectSignature(params);
    if (
      signature &&
      pending.subjectSignature &&
      signature !== pending.subjectSignature
    ) {
      pending.subjectSignature = signature;
      this.updateApproval(pending, params);
      this.settleUnanswered(pending, 'cancelled', {
        reason: 'subject-changed',
      });
      pending.requestId = `${pending.approvalId}:${crypto.randomUUID()}`;
      pending.published = false;
      pending.resolvedPublished = false;
      pending.intent = undefined;
      delete pending.escalatedBefore;
      pending.deciding = false;
      pending.lastDecidedKey = undefined;
      pending.stagesDecided = 0;
      // A new question for the user: nothing the old one set in motion (an
      // escalation, its step, the retries) may act on it.
      this.clearEscalation(pending);
      pending.escalationStep = 0;
      pending.generation += 1;
      this.escalatedApprovalIds.delete(pending.approvalId);
      pending.retriedKeys.clear();
      this.armDeadline(pending);
      this.publishOpened(pending, {
        ...params,
        ...(pending.turnId ? { turnId: pending.turnId } : {}),
      });
      return;
    }
    this.updateApproval(pending, params);
    this.continueWalk(pending);
  }

  private onApprovalResolved(params: Record<string, unknown>): void {
    const approvalId = readString(params.approvalId);
    const pending = approvalId ? this.approvals.get(approvalId) : undefined;
    if (!pending) return;
    this.approvals.delete(pending.approvalId);
    this.clearDeadline(pending);
    this.clearEscalation(pending);
    const decision = readString(params.decision);
    const engineStatus = mapResolvedDecision(decision, pending.intent);
    if (pending.decidedAtMs !== undefined && pending.resolvedPublished) {
      // #2880: Station's recorded decision, closed by the engine. The
      // engine's own outcome rides along: "acknowledged" never claims the
      // decision was applied as given.
      this.deps.publish({
        eventId: crypto.randomUUID(),
        provider: 'muse',
        threadId: this.deps.threadId,
        createdAt: this.nowIso(),
        requestId: pending.requestId,
        method: 'request.delivery',
        outcome: 'acknowledged',
        waitedMs: Math.max(0, this.deps.now().getTime() - pending.decidedAtMs),
        engineStatus,
      });
      return;
    }
    this.publishResolved(pending, engineStatus, {
      ...(decision ? { decision } : {}),
      ...(readString(params.resolvedBy)
        ? { resolvedBy: params.resolvedBy }
        : {}),
    });
  }

  /**
   * #2880: a request Station stops waiting on without muse closing it. If
   * Station had recorded a decision, that decision was never acknowledged
   * (`request.delivery` `unacknowledged`); otherwise the request itself
   * resolves with `status`, as before.
   */
  private settleUnanswered(
    pending: PendingApproval,
    status: ApprovalStatus,
    response?: Record<string, unknown>,
  ): void {
    if (pending.decidedAtMs !== undefined && pending.resolvedPublished) {
      this.publishUnacknowledged(pending);
      return;
    }
    this.publishResolved(pending, status, response);
  }

  private publishUnacknowledged(pending: PendingApproval): void {
    if (pending.decidedAtMs === undefined) return;
    const decidedAtMs = pending.decidedAtMs;
    // Once: a request is only ever given up on once.
    pending.decidedAtMs = undefined;
    this.deps.publish({
      eventId: crypto.randomUUID(),
      provider: 'muse',
      threadId: this.deps.threadId,
      createdAt: this.nowIso(),
      requestId: pending.requestId,
      method: 'request.delivery',
      outcome: 'unacknowledged',
      reason: 'no-acknowledgement',
      waitedMs: Math.max(0, this.deps.now().getTime() - decidedAtMs),
    });
  }

  private publishResolved(
    pending: PendingApproval,
    status: ApprovalStatus,
    response?: Record<string, unknown>,
    acknowledgement?: ApprovalAcknowledgement,
  ): void {
    if (!pending.published || pending.resolvedPublished) return;
    pending.resolvedPublished = true;
    this.resolvedApprovalIds.add(pending.approvalId);
    this.deps.publish({
      eventId: crypto.randomUUID(),
      provider: 'muse',
      threadId: this.deps.threadId,
      createdAt: this.nowIso(),
      requestId: pending.requestId,
      method: 'request.resolved',
      status,
      ...(response && Object.keys(response).length > 0 ? { response } : {}),
      ...(acknowledgement ? { acknowledgement } : {}),
    });
  }

  private armDeadline(pending: PendingApproval): void {
    this.clearDeadline(pending);
    pending.deadline = setTimeout(() => {
      if (!this.isCurrent(pending)) return;
      pending.deadline = undefined;
      if (pending.escalatedBefore) {
        this.approvals.delete(pending.approvalId);
        this.publishUnacknowledged(pending);
        this.deps.publish({
          eventId: crypto.randomUUID(),
          provider: 'muse',
          threadId: this.deps.threadId,
          createdAt: this.nowIso(),
          method: 'runtime.warning',
          severity: 'warning',
          code: MUSE_APPROVAL_EXPIRED_CODE,
          message: `Muse did not settle the repeated request to use ${pending.toolName}; Station stopped waiting for it.`,
          details: { approvalId: pending.approvalId },
        });
        return;
      }
      const limit = formatMuseServeDuration(this.deps.approvalTimeoutMs);
      pending.intent = 'expire';
      this.recordDecision(pending);
      this.deps.publish({
        eventId: crypto.randomUUID(),
        provider: 'muse',
        threadId: this.deps.threadId,
        createdAt: this.nowIso(),
        method: 'runtime.warning',
        severity: 'warning',
        code: MUSE_APPROVAL_EXPIRED_CODE,
        message: `Nobody answered Muse's request to use ${pending.toolName} within ${limit}, so Station declined it and ${
          pending.subagentId ? 'the subagent' : 'the turn'
        } continues without it.`,
        details: {
          requestId: pending.requestId,
          ...(pending.subagentId ? { childId: pending.subagentId } : {}),
          timeoutMs: this.deps.approvalTimeoutMs,
        },
      });
      // A decision may be in flight for this stage; the walk then declines
      // the next one. Either way Station's own outcome is already published.
      pending.lastDecidedKey = undefined;
      this.continueWalk(pending);
      // If muse does not act on the decline (a rejected decide, or no
      // `approval/resolved`), Station escalates rather than show `expired`
      // over a request muse is still waiting on.
      this.armEscalation(pending);
    }, this.deps.approvalTimeoutMs);
  }

  private clearDeadline(pending: PendingApproval): void {
    if (pending.deadline) clearTimeout(pending.deadline);
    pending.deadline = undefined;
  }

  private armEscalation(pending: PendingApproval): void {
    this.clearEscalation(pending);
    pending.escalation = setTimeout(
      () => this.escalate(pending),
      this.deps.approvalEscalationMs,
    );
  }

  private clearEscalation(pending: PendingApproval): void {
    if (pending.escalation) clearTimeout(pending.escalation);
    pending.escalation = undefined;
  }

  private isCurrent(pending: PendingApproval): boolean {
    return this.approvals.get(pending.approvalId) === pending && !this.stopped;
  }

  /**
   * A declined-at-deadline approval muse has not resolved. First stop what
   * is waiting on it — the subagent (`subagent/stop`) or the turn
   * (`turn/interrupt`) — and give muse the same bound again; if that is not
   * admitted or still resolves nothing, end the host (its session resumes on
   * the next send). Every step is announced.
   */
  private escalate(pending: PendingApproval): void {
    if (!this.isCurrent(pending)) return;
    this.clearEscalation(pending);
    const generation = pending.generation;
    pending.escalationStep += 1;
    this.rememberEscalated(pending.approvalId);
    const connection = this.host?.connection;
    const sessionId = this.museSessionIdValue;
    const target = pending.subagentId
      ? {
          method: 'subagent/stop',
          params: {
            subagentId: pending.subagentId,
            reason: 'An approval it asked for went unanswered.',
          },
        }
      : pending.turnId
        ? { method: 'turn/interrupt', params: { turnId: pending.turnId } }
        : undefined;
    if (
      pending.escalationStep === 1 &&
      target &&
      connection &&
      !connection.isClosed &&
      sessionId
    ) {
      this.announceEscalation(
        pending,
        pending.subagentId
          ? 'Muse did not act on the declined request, so Station stopped the subagent that asked.'
          : 'Muse did not act on the declined request, so Station interrupted the turn that asked.',
      );
      connection
        .request(
          target.method,
          {
            commandId: this.deps.newCommandId(),
            sessionId,
            ...target.params,
          },
          { timeoutMs: this.deps.requestTimeoutMs },
        )
        .then(() => {
          if (!this.isCurrent(pending) || pending.generation !== generation)
            return;
          if (pending.subagentId) {
            recordMuseChildStopRequested(this.childWork, pending.subagentId);
          }
          this.armEscalation(pending);
        })
        .catch(() => {
          if (this.isCurrent(pending) && pending.generation === generation)
            this.escalate(pending);
        });
      return;
    }
    pending.escalationStep = Math.max(pending.escalationStep, 2);
    this.announceEscalation(
      pending,
      "Muse still did not act on the declined request, so Station ended Muse's host process; it restarts on the next message.",
    );
    void this.abandonHost(
      `Station ended Muse's host process because it did not act on a declined request to use ${pending.toolName}. It restarts on the next message.`,
    );
  }

  private rememberEscalated(approvalId: string): void {
    this.escalatedApprovalIds.delete(approvalId);
    this.escalatedApprovalIds.add(approvalId);
    if (this.escalatedApprovalIds.size > ESCALATED_APPROVALS_MAX) {
      const oldest = this.escalatedApprovalIds.values().next().value;
      if (oldest !== undefined) this.escalatedApprovalIds.delete(oldest);
    }
  }

  private announceEscalation(pending: PendingApproval, message: string): void {
    this.deps.publish({
      eventId: crypto.randomUUID(),
      provider: 'muse',
      threadId: this.deps.threadId,
      createdAt: this.nowIso(),
      method: 'runtime.warning',
      severity: 'warning',
      code: MUSE_APPROVAL_EXPIRED_CODE,
      message,
      details: {
        requestId: pending.requestId,
        step: pending.escalationStep,
        ...(pending.subagentId ? { childId: pending.subagentId } : {}),
      },
    });
  }

  /** Ends the host on Station's own decision, with the host-loss settlement. */
  private async abandonHost(message: string): Promise<void> {
    if (!this.host) return;
    this.settleAfterHostLoss(message);
    await this.closeHost();
  }

  /**
   * One retry of a rejected `approval/decide`: re-read the approval from
   * `approval/listPending` (a stale `requirementId` is the likely cause) and
   * decide again on the requirement it names now. A second rejection of a
   * deadline decline escalates.
   */
  private async retryDecide(
    pending: PendingApproval,
    key: string,
  ): Promise<void> {
    if (!this.isCurrent(pending)) return;
    const generation = pending.generation;
    if (pending.retriedKeys.has(key)) {
      this.decideUndeliverable(pending);
      return;
    }
    pending.retriedKeys.add(key);
    const connection = this.host?.connection;
    if (!connection || connection.isClosed) return;
    let listed: unknown;
    try {
      listed = await connection.request(
        'approval/listPending',
        { sessionId: this.requireMuseSessionId() },
        { timeoutMs: this.deps.requestTimeoutMs },
      );
    } catch {
      if (this.isCurrent(pending) && pending.generation === generation)
        this.decideUndeliverable(pending);
      return;
    }
    const fresh = (
      isRecord(listed) && Array.isArray(listed.approvals)
        ? listed.approvals
        : []
    ).find(
      (approval): approval is Record<string, unknown> =>
        isRecord(approval) && approval.approvalId === pending.approvalId,
    );
    if (!this.isCurrent(pending) || pending.generation !== generation) return;
    if (!fresh) {
      // Not pending any more: it was resolved meanwhile, and its
      // `approval/resolved` closes it — bounded all the same, in case that
      // resolution never arrives.
      this.armEscalation(pending);
      return;
    }
    pending.lastDecidedKey = undefined;
    this.onApprovalRestated(pending, fresh);
  }

  /**
   * Station's answer could not be delivered, even after the retry. A decline
   * at the deadline escalates now. Any other answer (the user's, or a session
   * grant's) must not leave muse waiting with no timer: the user is told
   * their answer did not reach muse, and the escalation path bounds the
   * request. A previously escalated request gets one stop without re-hosting.
   */
  private decideUndeliverable(pending: PendingApproval): void {
    if (!this.isCurrent(pending)) return;
    if (pending.escalatedBefore) {
      // A second host escalation would bring the same request back again.
      // Send one bounded stop request, then release Station's pending record.
      const connection = this.host?.connection;
      const sessionId = this.museSessionIdValue;
      // Only the turn this approval belongs to. Never fall back to whatever
      // turn is live now: after a re-host that can be the user's new message.
      const turnId = pending.turnId;
      const { approvalId, subagentId } = pending;
      const target = pending.subagentId
        ? {
            method: 'subagent/stop',
            params: {
              subagentId: pending.subagentId,
              reason: 'Station could not decline an approval it asked for.',
            },
          }
        : turnId
          ? { method: 'turn/interrupt', params: { turnId } }
          : undefined;
      if (target && connection && !connection.isClosed && sessionId) {
        void connection
          .request(
            target.method,
            {
              commandId: this.deps.newCommandId(),
              sessionId,
              ...target.params,
            },
            { timeoutMs: this.deps.requestTimeoutMs },
          )
          .then(() => {
            if (subagentId) {
              recordMuseChildStopRequested(this.childWork, subagentId);
            }
          })
          .catch((error: unknown) => {
            // Accepted limitation: with the decline undeliverable twice and
            // the stop refused too, Station has no further bounded action
            // that would not bring the request back (a re-host re-lists it).
            // The warning below tells the user muse is waiting; stopping the
            // session ends it.
            this.deps.logger?.warn('Muse approval stop was not admitted', {
              threadId: this.deps.threadId,
              approvalId,
              error: errorMessage(error),
            });
          });
      }
      this.deps.publish({
        eventId: crypto.randomUUID(),
        provider: 'muse',
        threadId: this.deps.threadId,
        createdAt: this.nowIso(),
        method: 'runtime.warning',
        severity: 'warning',
        code: MUSE_APPROVAL_DECIDE_FAILED_CODE,
        message: `Muse is still waiting on a request Station could not decline. Station ${target ? 'asked Muse to stop' : 'could not identify'} the ${pending.subagentId ? 'subagent' : 'turn'} that asked. If Muse stays stuck, stop this session.`,
        details: {
          requestId: pending.requestId,
          ...(pending.subagentId ? { childId: pending.subagentId } : {}),
        },
      });
      this.approvals.delete(pending.approvalId);
      this.clearDeadline(pending);
      this.clearEscalation(pending);
      return;
    }
    if (pending.intent === 'expire') {
      this.escalate(pending);
      return;
    }
    this.deps.publish({
      eventId: crypto.randomUUID(),
      provider: 'muse',
      threadId: this.deps.threadId,
      createdAt: this.nowIso(),
      method: 'runtime.warning',
      severity: 'warning',
      code: MUSE_APPROVAL_DECIDE_FAILED_CODE,
      message: `Your answer to Muse's request to use ${pending.toolName} did not reach Muse. If Muse does not settle it shortly, Station stops ${
        pending.subagentId ? 'the subagent that asked' : 'the turn that asked'
      }.`,
      details: {
        requestId: pending.requestId,
        ...(pending.subagentId ? { childId: pending.subagentId } : {}),
      },
    });
    this.armEscalation(pending);
  }

  /**
   * Answers the approval's current stage according to `intent`, one
   * `approval/decide` per stage. Accepting walks every stage with the
   * one-time `allow_once`; `allow_local_prefix` (which persists a workspace
   * rule) is never chosen. Declining answers `abort`, with feedback the
   * model reads.
   */
  private continueWalk(pending: PendingApproval): void {
    if (!this.isCurrent(pending)) return;
    const connection = this.host?.connection;
    if (
      !pending.intent ||
      pending.deciding ||
      !connection ||
      connection.isClosed
    )
      return;
    const current = pending.current;
    if (!current) return;
    const key = requirementKey(current);
    const stage = pending.stages.find((candidate) => candidate.key === key);
    if (stage && stage.resolution !== 'unresolved') return;
    if (key === pending.lastDecidedKey) return;
    if (pending.stagesDecided >= APPROVAL_STAGES_MAX) return;
    const accept = pending.intent === 'accept';
    const choice = accept
      ? (pending.choices.find(
          (candidate) => candidate.choiceId === 'allow_once',
        ) ??
        pending.choices.find(
          (candidate) =>
            candidate.decision === 'approved' && candidate.scope === 'once',
        ))
      : (pending.choices.find((candidate) => candidate.choiceId === 'abort') ??
        pending.choices.find(
          (candidate) =>
            candidate.decision === 'abort' || candidate.decision === 'denied',
        ));
    if (!choice) {
      this.deps.logger?.warn('Muse approval offered no usable choice', {
        threadId: this.deps.threadId,
        approvalId: pending.approvalId,
        intent: pending.intent,
      });
      return;
    }
    const feedback =
      pending.intent === 'decline'
        ? 'The user declined this request in Station.'
        : pending.intent === 'cancel'
          ? 'The request was cancelled in Station.'
          : pending.intent === 'expire'
            ? `Nobody answered this request in Station within ${formatMuseServeDuration(this.deps.approvalTimeoutMs)}, so it was declined.`
            : undefined;
    pending.deciding = true;
    const generation = pending.generation;
    pending.lastDecidedKey = key;
    pending.stagesDecided += 1;
    connection
      .request<unknown>(
        'approval/decide',
        {
          commandId: this.deps.newCommandId(),
          sessionId: this.requireMuseSessionId(),
          approvalId: pending.approvalId,
          choiceId: choice.choiceId,
          requirementId: current,
          ...(feedback && choice.acceptsFeedback ? { feedback } : {}),
        },
        { timeoutMs: this.deps.requestTimeoutMs },
      )
      .then(() => {
        if (!this.isCurrent(pending) || pending.generation !== generation)
          return;
        pending.deciding = false;
        // An `approval/updated` naming the next stage may already be in.
        this.continueWalk(pending);
      })
      .catch((error: unknown) => {
        if (!this.isCurrent(pending) || pending.generation !== generation)
          return;
        pending.deciding = false;
        this.deps.logger?.warn('Muse approval/decide was not admitted', {
          threadId: this.deps.threadId,
          approvalId: pending.approvalId,
          error: errorMessage(error),
        });
        void this.retryDecide(pending, key);
      });
  }

  // ---------------------------------------------------------------- turns

  private createTurn(turnId: string, kind: ServeTurn['kind']): ServeTurn {
    let resolveSettled: () => void = () => {};
    const settledPromise = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    return {
      turnId,
      kind,
      startPublished: false,
      buffered: [],
      outputText: '',
      streamed: new Map(),
      textItems: [],
      openTools: new Map(),
      stopRequested: false,
      settled: false,
      settledPromise,
      resolveSettled,
      retriesAnnounced: new Set(),
    };
  }

  private rekeyTurn(from: string, to: string): void {
    const turn = this.turns.get(from);
    if (!turn) return;
    this.turns.delete(from);
    turn.turnId = to;
    this.turns.set(to, turn);
  }

  private publishDispatchedStart(
    turn: ServeTurn,
    input: MuseServeTurnInput,
    plan: MuseServeApprovalPlan,
  ): void {
    const startedAt = this.nowIso();
    this.deps.publish({
      eventId: crypto.randomUUID(),
      provider: 'muse',
      threadId: this.deps.threadId,
      createdAt: startedAt,
      method: 'turn.started',
      turnId: turn.turnId,
      ...(turn.invocationId ? { invocationId: turn.invocationId } : {}),
      prompt: input.displayPrompt,
      ...(input.ambientContext ? { ambientContext: input.ambientContext } : {}),
      metadata: {
        ...(input.recoveryCorrelationId
          ? { recoveryCorrelationId: input.recoveryCorrelationId }
          : {}),
        ...(input.firstTurnInstructionsComposed
          ? { [FIRST_TURN_INSTRUCTIONS_COMPOSED_METADATA_KEY]: true }
          : {}),
        museTransport: 'serve',
        museApprovalMode: plan.museMode,
        museSandbox: museSandboxLabel(plan, this.sandbox),
        ...(plan.stationMode ? { approvalMode: plan.stationMode } : {}),
        // The tier this turn's `turn/start` carried, which muse admitted (a
        // tier it refuses fails the send before this is published).
        ...(input.reasoningEffort
          ? { museReasoningEffort: input.reasoningEffort }
          : {}),
        // #2269: no Station-imposed bound on a serve turn.
        supervision: { provider: 'muse', turnId: turn.turnId, startedAt },
      },
    });
    turn.startPublished = true;
    const buffered = turn.buffered.splice(0);
    for (const frame of buffered) frame();
  }

  /**
   * The turn a send must not overlap: a provider turn the host is running
   * first (it is what muse is doing now), else Station's own unsettled turn.
   * Derived from the turn table, never from a marker that a race between a
   * send and a host-initiated turn could leave pointing at the wrong one.
   */
  private liveTurn(): ServeTurn | undefined {
    const unsettled = [...this.turns.values()].filter((turn) => !turn.settled);
    return (
      unsettled.find((turn) => turn.kind === 'provider') ?? unsettled.at(-1)
    );
  }

  /**
   * A turn muse completed with a call still running: the call returned to
   * the model (its output says the command went to the background) and muse
   * keeps running it as a task, which is child work from here on. Its row
   * closes as a call that returned, not as one whose fate is unknown.
   */
  private closeBackgroundedTools(turn: ServeTurn): void {
    const adopted = adoptMuseBackgroundTasks(
      this.childWork,
      turn.turnId,
      turn.openTools.keys(),
    );
    for (const { callId, output } of adopted) {
      const toolName = turn.openTools.get(callId);
      if (!toolName) continue;
      turn.openTools.delete(callId);
      const preview = projectBoundedToolOutput(output);
      this.deps.publish({
        eventId: crypto.randomUUID(),
        provider: 'muse',
        threadId: this.deps.threadId,
        createdAt: this.nowIso(),
        method: 'tool.completed',
        turnId: turn.turnId,
        itemId: `tool:${callId}`,
        toolCallId: callId,
        toolName,
        status: 'success',
        ...(output === undefined ? {} : { output: preview.value }),
        ...(preview.receipt ? { outputReceipt: preview.receipt } : {}),
      });
    }
  }

  private closeOpenTools(turn: ServeTurn): void {
    for (const [callId, toolName] of turn.openTools) {
      this.deps.publish({
        eventId: crypto.randomUUID(),
        provider: 'muse',
        threadId: this.deps.threadId,
        createdAt: this.nowIso(),
        method: 'tool.completed',
        turnId: turn.turnId,
        itemId: `tool:${callId}`,
        toolCallId: callId,
        toolName,
        status: 'unresolved',
        output: UNRESOLVED_TURN_TOOL_OUTPUT,
      });
    }
    turn.openTools.clear();
  }

  private settle(
    turn: ServeTurn,
    outcome:
      | {
          method: 'turn.completed';
          finishReason: 'stop' | 'cancelled' | 'other';
        }
      | { method: 'turn.aborted'; reason: string }
      | (ProviderRuntimeErrorBody & { code: string }),
  ): void {
    if (turn.settled) return;
    turn.settled = true;
    // A prompt its turn was waiting on cannot be answered once the turn is
    // over; muse settles it itself, and Station stops offering it now.
    for (const pending of [...this.userInputs.values()]) {
      if (pending.turnId === turn.turnId) this.closeUserInput(pending);
    }
    const metadata =
      turn.kind === 'provider' ? { trigger: PROVIDER_TURN_TRIGGER } : undefined;
    const base = {
      eventId: crypto.randomUUID(),
      provider: 'muse' as const,
      threadId: this.deps.threadId,
      createdAt: this.nowIso(),
      turnId: turn.turnId,
      ...(turn.invocationId ? { invocationId: turn.invocationId } : {}),
    };
    if (outcome.method === 'turn.completed') {
      this.deps.publish({
        ...base,
        method: 'turn.completed',
        finishReason: outcome.finishReason,
        ...(turn.outputText ? { outputText: turn.outputText } : {}),
        ...(metadata ? { metadata } : {}),
      });
    } else if (outcome.method === 'turn.aborted') {
      this.deps.publish({
        ...base,
        method: 'turn.aborted',
        reason: outcome.reason,
        ...(metadata ? { metadata } : {}),
      });
    } else {
      this.deps.publish({
        ...base,
        method: 'runtime.error',
        ...providerFailure(
          outcome.kind,
          outcome.failurePhase,
          outcome.retryAfter,
        ),
        severity: 'error',
        message: outcome.message,
        code: outcome.code,
        ...(outcome.retriable !== undefined
          ? { retriable: outcome.retriable }
          : {}),
        ...(metadata ? { metadata } : {}),
      } satisfies ProviderRuntimeErrorEvent);
    }
    turn.resolveSettled();
    this.forgetSettledTurns();
  }

  private forgetSettledTurns(): void {
    const settled = [...this.turns.values()].filter((turn) => turn.settled);
    for (const turn of settled.slice(
      0,
      Math.max(0, settled.length - SETTLED_TURNS_MAX),
    )) {
      this.turns.delete(turn.turnId);
    }
  }

  // ---------------------------------------------------------------- misc

  /**
   * `session/setApprovalMode`, checked against what the host says it
   * applied. A reply whose `effectiveMode` is not the requested mode (the
   * host deferred, refused, or kept another mode) refuses the turn: a turn
   * labelled `ask` must never run on a session muse left in `allowAll`.
   */
  private async applyApprovalMode(
    connection: MuseServeConnection,
    sessionId: string,
    plan: MuseServeApprovalPlan,
  ): Promise<void> {
    let result: unknown;
    try {
      result = await connection.request(
        'session/setApprovalMode',
        { commandId: this.deps.newCommandId(), sessionId, mode: plan.museMode },
        { timeoutMs: this.deps.requestTimeoutMs },
      );
    } catch (error) {
      throw new SendTurnRefusedError(
        `Muse refused to change its approval mode: ${errorMessage(error)}`,
        'permission_denied',
      );
    }
    const effective =
      isRecord(result) && isRecord(result.effectiveMode)
        ? readString(result.effectiveMode.mode)
        : undefined;
    if (effective === plan.museMode) return;
    const applyOutcome = isRecord(result)
      ? readString(result.applyOutcome)
      : undefined;
    const message = `Muse did not apply the ${plan.stationMode ?? 'default'} approval mode (${plan.museMode}): it reports ${effective ?? 'no effective mode'}${
      applyOutcome ? ` (${applyOutcome})` : ''
    }. This message was not sent.`;
    this.deps.publish({
      eventId: crypto.randomUUID(),
      provider: 'muse',
      threadId: this.deps.threadId,
      createdAt: this.nowIso(),
      method: 'runtime.warning',
      severity: 'warning',
      code: MUSE_APPROVAL_MODE_NOT_APPLIED_CODE,
      message,
      details: {
        requested: plan.museMode,
        ...(effective ? { effective } : {}),
        ...(applyOutcome ? { applyOutcome } : {}),
      },
    });
    throw new SendTurnRefusedError(message, 'permission_denied');
  }

  private async refusingRequest(
    connection: MuseServeConnection,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    try {
      await connection.request(method, params, {
        timeoutMs: this.deps.requestTimeoutMs,
      });
    } catch (error) {
      throw new SendTurnRefusedError(
        `Muse refused ${method}: ${errorMessage(error)}`,
        'provider_error',
      );
    }
  }

  private requireConnection(): MuseServeConnection {
    const connection = this.host?.connection;
    if (!connection || connection.isClosed) {
      throw new Error('The Muse host is not running.');
    }
    return connection;
  }

  private requireMuseSessionId(): string {
    if (!this.museSessionIdValue)
      throw new Error('The Muse session has not started.');
    return this.museSessionIdValue;
  }

  private nowIso(): string {
    return this.deps.now().toISOString();
  }
}
