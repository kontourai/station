import crypto from 'node:crypto';
import {
  type ApprovalMode,
  ENGINE_TURN_FAILED_CODE,
  FIRST_TURN_INSTRUCTIONS_COMPOSED_METADATA_KEY,
  MUSE_APPROVAL_EXPIRED_CODE,
  MUSE_SERVE_HOST_EXITED_CODE,
} from '@kontourai/station-contracts/provider';
import {
  type ApprovalStatus,
  type CanonicalRuntimeEvent,
  PROVIDER_TURN_TRIGGER,
} from '@kontourai/station-contracts/runtime-events';
import { redactSecrets } from '@kontourai/station-shared/redaction';
import type { Logger } from '../../utils/logger.js';
import {
  type ProviderInterruptTurnResult,
  type ProviderTaskStopResult,
  ProviderTurnInProgressError,
  SendTurnRefusedError,
} from '../adapter-shape.js';
import { projectBoundedToolOutput } from '../tool-output-projection.js';
import {
  createMuseServeChildWorkState,
  type MuseServeChildWorkContext,
  museServeChildIsRunning,
  museServeHasRunningChildren,
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
import { UNRESOLVED_TURN_TOOL_OUTPUT } from './unresolved-tool-output.js';

/**
 * #2452: one Station session driven through a `muse serve` (MSP) host.
 *
 * What the live probe (Muse Code 1.3.0-R3401.1) established, and what this
 * module relies on (captures in `__tests__/fixtures/muse-serve-1.3.0-*`):
 *
 * - Handshake: `initialize` (the reply carries the stable-surface schema
 *   fingerprint) → `initialized` → `session/start {commandId, workspaceRoot,
 *   approvalMode, modelId?}`. Provider, model, workspace and approval mode
 *   travel on the wire; sandbox posture is fixed per host process
 *   (`--disable-sandbox`).
 * - Sessions are durable: a fresh host re-attaches with `session/resume`
 *   and keeps context. `--no-session-log` never delivers turn or item
 *   events, so it is never passed.
 * - Every approval arrives as an `approval/requested` NOTIFICATION (never a
 *   server request), a subagent's with `subagentOrigin`. One command can
 *   need several stages: `approval/decide` answers `terminal: false` and an
 *   `approval/updated` names the next `currentRequirementId`. The outcome is
 *   `approval/resolved`. The host NEVER times an unanswered approval out, so
 *   Station bounds it ({@link MUSE_APPROVAL_DEADLINE_MS}).
 * - After background work finishes, the host starts a follow-up turn of its
 *   own, with a turn id no client minted. It is adopted as a provider turn
 *   (`metadata.trigger: 'provider'`, #2324), and a send is refused while it
 *   runs rather than queued into it.
 */

type MuseServeLogger = Pick<Logger, 'warn' | 'info'>;

/**
 * Schema fingerprints of the MSP stable surface this adapter was verified
 * against (`muse schema generate-json-schema`, Muse Code 1.3.0-R3401.1). A
 * host reporting any other fingerprint speaks a protocol nobody checked this
 * mapping against, so the session falls back to `muse exec` (and says so)
 * rather than guessing at approval and child-work shapes.
 */
export const MUSE_SERVE_VERIFIED_SCHEMA_FINGERPRINTS: ReadonlySet<string> =
  new Set([
    'sha256:7469c9e352e67def4a59df7e439984d7194fa351e1c8b7abb34060fd977ced81',
  ]);

/**
 * Station's bound on an unanswered Muse approval. `muse serve` never expires
 * one itself; past this Station declines it (`abort`, with feedback) and the
 * request resolves `expired`, so the turn or subagent that asked continues.
 * The same order as the lingering-child reap (30 minutes): long enough for a
 * person who stepped away, short enough that nothing waits forever.
 */
export const MUSE_APPROVAL_DEADLINE_MS = 30 * 60_000;
export const MUSE_SERVE_HANDSHAKE_TIMEOUT_MS = 20_000;
export const MUSE_SERVE_REQUEST_TIMEOUT_MS = 30_000;
/** How long an interrupt waits for the turn's own `cancelled` terminal. */
export const MUSE_SERVE_INTERRUPT_SETTLE_MS = 10_000;
/** Bound on stages walked for one approval (the probe saw two). */
const APPROVAL_STAGES_MAX = 32;
/** Bound on settled turns remembered (workflow items outlive their turn). */
const SETTLED_TURNS_MAX = 32;
const TITLE_COMMAND_MAX_CHARS = 160;
const TURN_ERROR_MESSAGE_MAX_CHARS = 500;

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

/** The host could not be used; the caller falls back to `muse exec`. */
export class MuseServeUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`muse serve is unavailable: ${reason}`);
    this.name = 'MuseServeUnavailableError';
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
  terminateHost: (spawned: MuseServeSpawnResult) => Promise<void>;
  newCommandId: () => string;
  approvalTimeoutMs: number;
  handshakeTimeoutMs: number;
  requestTimeoutMs: number;
  interruptSettleMs: number;
}

export interface MuseServeStartInput {
  cwd?: string;
  modelId?: string;
  approvalMode?: ApprovalMode;
}

export interface MuseServeStarted {
  museSessionId: string;
  /** The model the host reported applying, when it reported one. */
  modelId?: string;
  plan: MuseServeApprovalPlan;
}

export interface MuseServeTurnInput {
  prompt: string;
  displayPrompt: string;
  images: Array<{ mediaType: string; base64: string }>;
  modelId?: string;
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
  epoch: number;
  /** Set before an owner-initiated close, so its exit is not a failure. */
  closing: boolean;
}

interface ServeTurn {
  turnId: string;
  kind: 'dispatched' | 'provider';
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
  deciding: boolean;
  lastDecidedKey?: string;
  stagesDecided: number;
  deadline?: ReturnType<typeof setTimeout>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function formatMuseServeDuration(ms: number): string {
  const unit = (value: number, name: string) =>
    `${value} ${name}${value === 1 ? '' : 's'}`;
  if (ms > 0 && ms % 3_600_000 === 0) return unit(ms / 3_600_000, 'hour');
  if (ms > 0 && ms % 60_000 === 0) return unit(ms / 60_000, 'minute');
  return unit(ms / 1_000, 'second');
}

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

export class MuseServeSession {
  private host?: ServeHost;
  private hostEpoch = 0;
  private museSessionIdValue?: string;
  private plan: MuseServeApprovalPlan = museServeApprovalPlan(undefined);
  private model?: string;
  private stopped = false;
  private sending = false;
  private readonly turns = new Map<string, ServeTurn>();
  private readonly itemKinds = new Map<string, string>();
  private readonly approvals = new Map<string, PendingApproval>();
  /** approvalIds whose request Station already resolved once. */
  private readonly resolvedApprovalIds = new Set<string>();
  /** Tool-level session grants (`acceptForSession`), Station-side (#2299). */
  private readonly approvedTools = new Set<string>();
  private readonly childWork: MuseServeChildWorkContext;

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
    return this.host?.spawned.process.pid;
  }

  /** Spawns the host, verifies the handshake, and starts the MSP session. */
  async start(input: MuseServeStartInput): Promise<MuseServeStarted> {
    const plan = museServeApprovalPlan(input.approvalMode);
    const host = await this.openHost({ disableSandbox: plan.disableSandbox });
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
        `session/start failed: ${error instanceof Error ? error.message : String(error)}`,
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
    return {
      museSessionId,
      ...(this.model ? { modelId: this.model } : {}),
      plan,
    };
  }

  hasLiveTurn(): boolean {
    return this.liveTurn() !== undefined;
  }

  async sendTurn(input: MuseServeTurnInput): Promise<{ turnId: string }> {
    if (this.stopped) {
      throw new SendTurnRefusedError('This Muse session is stopped.');
    }
    const live = this.liveTurn();
    if (live?.kind === 'provider') throw new ProviderTurnInProgressError();
    if (live || this.sending) {
      throw new SendTurnRefusedError(
        'This Muse session already has an active turn.',
      );
    }
    this.sending = true;
    try {
      const plan =
        input.approvalMode !== undefined
          ? museServeApprovalPlan(input.approvalMode)
          : this.plan;
      await this.ensureHost({ disableSandbox: plan.disableSandbox });
      const connection = this.requireConnection();
      const sessionId = this.requireMuseSessionId();
      if (plan.museMode !== this.plan.museMode) {
        await this.refusingRequest(connection, 'session/setApprovalMode', {
          commandId: this.deps.newCommandId(),
          sessionId,
          mode: plan.museMode,
        });
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
      this.turns.set(commandId, turn);
      let ack: unknown;
      try {
        ack = await connection.request(
          'turn/start',
          {
            commandId,
            sessionId,
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
          error: error instanceof Error ? error.message : String(error),
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
    if (decision === 'acceptForSession') {
      this.approvedTools.add(pending.toolName);
    }
    pending.intent =
      decision === 'accept' || decision === 'acceptForSession'
        ? 'accept'
        : decision === 'decline'
          ? 'decline'
          : 'cancel';
    this.continueWalk(pending);
  }

  async stopChild(childId: string): Promise<ProviderTaskStopResult> {
    if (!museServeChildIsRunning(this.childWork, childId)) {
      return { outcome: 'no-active-task', taskId: childId };
    }
    const connection = this.requireConnection();
    await connection.request(
      'subagent/stop',
      {
        commandId: this.deps.newCommandId(),
        sessionId: this.requireMuseSessionId(),
        subagentId: childId,
        reason: 'Stopped from Station.',
      },
      { timeoutMs: this.deps.requestTimeoutMs },
    );
    recordMuseChildStopRequested(this.childWork, childId);
    return { outcome: 'stopped', taskId: childId };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const pending of this.approvals.values()) {
      this.clearDeadline(pending);
      this.publishResolved(pending, 'cancelled');
    }
    this.approvals.clear();
    for (const turn of this.turns.values()) {
      if (turn.settled) continue;
      this.closeOpenTools(turn);
      this.settle(turn, {
        method: 'turn.aborted',
        reason: 'session-stopped',
      });
    }
    settleOpenMuseChildren(this.childWork, { close: true });
    await this.closeHost();
  }

  // --------------------------------------------------------------- host

  private async openHost(posture: MuseServeHostPosture): Promise<ServeHost> {
    let spawned: MuseServeSpawnResult;
    try {
      spawned = this.deps.spawnHost(posture);
    } catch (error) {
      throw new MuseServeUnavailableError(
        `could not start muse serve: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const epoch = ++this.hostEpoch;
    const host: ServeHost = {
      spawned,
      posture,
      epoch,
      closing: false,
      connection: new MuseServeConnection(spawned.process, {
        onNotification: (method, params) =>
          this.handleNotification(epoch, method, params),
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
          : `initialize failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const schema =
      isRecord(result) && isRecord(result.schema) ? result.schema : {};
    const fingerprint = readString(schema.fingerprint);
    if (
      !fingerprint ||
      !MUSE_SERVE_VERIFIED_SCHEMA_FINGERPRINTS.has(fingerprint)
    ) {
      await this.closeHost();
      throw new MuseServeUnavailableError(
        `unverified MSP schema fingerprint ${fingerprint ?? '(none)'}`,
      );
    }
    const durability = isRecord(result) ? result.sessionDurability : undefined;
    if (durability !== undefined && durability !== 'durable') {
      await this.closeHost();
      throw new MuseServeUnavailableError(
        `the host reports ${String(durability)} sessions`,
      );
    }
    host.connection.notify('initialized');
    return host;
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
        await host.connection.request(
          'session/setApprovalMode',
          {
            commandId: this.deps.newCommandId(),
            sessionId,
            mode: this.plan.museMode,
          },
          { timeoutMs: this.deps.requestTimeoutMs },
        );
      }
      await this.reseedPendingApprovals();
    } catch (error) {
      await this.closeHost();
      throw new SendTurnRefusedError(
        `Muse's host could not be restarted: ${error instanceof Error ? error.message : String(error)}`,
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
  }

  private async closeHost(): Promise<void> {
    const host = this.host;
    if (!host) return;
    this.host = undefined;
    host.closing = true;
    host.connection.close();
    try {
      await this.deps.terminateHost(host.spawned);
    } finally {
      host.spawned.release?.();
    }
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
    for (const turn of this.turns.values()) {
      if (turn.settled) continue;
      this.closeOpenTools(turn);
      this.settle(turn, {
        method: 'runtime.error',
        message,
        code: MUSE_SERVE_HOST_EXITED_CODE,
      });
    }
    for (const pending of this.approvals.values()) {
      this.clearDeadline(pending);
      this.publishResolved(pending, 'cancelled');
    }
    this.approvals.clear();
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
      case 'approval/requested':
        this.onApprovalRequested(params);
        return;
      case 'approval/updated':
        this.onApprovalUpdated(params);
        return;
      case 'approval/resolved':
        this.onApprovalResolved(params);
        return;
      default:
        return;
    }
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
    this.closeOpenTools(turn);
    const terminal = readString(params.terminal);
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
        code: ENGINE_TURN_FAILED_CODE,
        message: `The Muse turn failed${
          detail
            ? `: ${truncate(redactSecrets(detail), TURN_ERROR_MESSAGE_MAX_CHARS)}`
            : '.'
        }`,
        ...(typeof error.retryable === 'boolean'
          ? { retriable: error.retryable }
          : {}),
      });
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
    // One model completion's usage (not cumulative): each event is its own
    // receipt, which is how the usage fold treats a non-cumulative engine.
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
    });
  }

  // ------------------------------------------------------------ approvals

  private onApprovalRequested(params: Record<string, unknown>): void {
    const approvalId = readString(params.approvalId);
    if (!approvalId || this.stopped) return;
    const existing = this.approvals.get(approvalId);
    if (existing) {
      this.updateApproval(existing, params);
      this.continueWalk(existing);
      return;
    }
    const origin = isRecord(params.subagentOrigin) ? params.subagentOrigin : {};
    const subagentId = readString(origin.subagentId);
    const toolName = readString(params.toolName) ?? 'tool';
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
    };
    this.updateApproval(pending, params);
    this.approvals.set(approvalId, pending);
    this.armDeadline(pending);
    if (this.approvedTools.has(toolName)) {
      // "Allow for this session" covers every later call of the tool (#2299);
      // denies are never remembered. Walked with one-time allows only.
      pending.intent = 'accept';
      this.continueWalk(pending);
      return;
    }
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
    const ownTurn = turnId && this.turns.has(turnId) ? turnId : undefined;
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
    this.updateApproval(pending, params);
    this.continueWalk(pending);
  }

  private onApprovalResolved(params: Record<string, unknown>): void {
    const approvalId = readString(params.approvalId);
    const pending = approvalId ? this.approvals.get(approvalId) : undefined;
    if (!pending) return;
    this.approvals.delete(pending.approvalId);
    this.clearDeadline(pending);
    const decision = readString(params.decision);
    this.publishResolved(
      pending,
      mapResolvedDecision(decision, pending.intent),
      {
        ...(decision ? { decision } : {}),
        ...(readString(params.resolvedBy)
          ? { resolvedBy: params.resolvedBy }
          : {}),
      },
    );
  }

  private publishResolved(
    pending: PendingApproval,
    status: ApprovalStatus,
    response?: Record<string, unknown>,
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
    });
  }

  private armDeadline(pending: PendingApproval): void {
    this.clearDeadline(pending);
    pending.deadline = setTimeout(() => {
      pending.deadline = undefined;
      if (!this.approvals.has(pending.approvalId) || this.stopped) return;
      const limit = formatMuseServeDuration(this.deps.approvalTimeoutMs);
      pending.intent = 'expire';
      this.publishResolved(pending, 'expired');
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
    }, this.deps.approvalTimeoutMs);
  }

  private clearDeadline(pending: PendingApproval): void {
    if (pending.deadline) clearTimeout(pending.deadline);
    pending.deadline = undefined;
  }

  /**
   * Answers the approval's current stage according to `intent`, one
   * `approval/decide` per stage. Accepting walks every stage with the
   * one-time `allow_once`; `allow_local_prefix` (which persists a workspace
   * rule) is never chosen. Declining answers `abort`, with feedback the
   * model reads.
   */
  private continueWalk(pending: PendingApproval): void {
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
        pending.deciding = false;
        // An `approval/updated` naming the next stage may already be in.
        this.continueWalk(pending);
      })
      .catch((error: unknown) => {
        pending.deciding = false;
        this.deps.logger?.warn('Muse approval/decide was not admitted', {
          threadId: this.deps.threadId,
          approvalId: pending.approvalId,
          error: error instanceof Error ? error.message : String(error),
        });
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
        museSandbox: plan.disableSandbox ? 'disabled' : 'enabled',
        ...(plan.stationMode ? { approvalMode: plan.stationMode } : {}),
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
      | {
          method: 'runtime.error';
          message: string;
          code: string;
          retriable?: boolean;
        },
  ): void {
    if (turn.settled) return;
    turn.settled = true;
    const metadata =
      turn.kind === 'provider' ? { trigger: PROVIDER_TURN_TRIGGER } : undefined;
    const base = {
      eventId: crypto.randomUUID(),
      provider: 'muse' as const,
      threadId: this.deps.threadId,
      createdAt: this.nowIso(),
      turnId: turn.turnId,
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
        severity: 'error',
        message: outcome.message,
        code: outcome.code,
        ...(outcome.retriable !== undefined
          ? { retriable: outcome.retriable }
          : {}),
        ...(metadata ? { metadata } : {}),
      });
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
        `Muse refused ${method}: ${error instanceof Error ? error.message : String(error)}`,
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
