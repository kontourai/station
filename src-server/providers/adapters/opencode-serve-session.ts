/**
 * One Station session on OpenCode 2.x's native transport: an OpenCode
 * session on an `opencode serve` Station started (`opencode-serve-pool.ts`),
 * driven over HTTP and read from the server's event feed (PLAN A.3-A.5).
 *
 * Turns. Every prompt is an OpenCode inbox item; the engine runs it in an
 * execution (`session.execution.started` ... `.succeeded|failed|interrupted`).
 * A Station turn is the execution its prompt started. An execution Station
 * did not start (a subagent's report waking the session, a revert) is the
 * engine's own turn (`metadata.trigger: 'provider'`), published only once it
 * shows something, so an execution with nothing to show leaves no turn.
 *
 * Reconnect (A.4). The feed is live only: nothing is replayed. When it
 * drops, or stays silent past the heartbeat bound, the session reconnects
 * with back-off and, once the server says `server.connected`, re-reads what
 * the gap hid: whether the session still runs, its history (text a message
 * finished during the gap, and the execution's outcome if it ended), the
 * pending permission asks and forms, and the inbox. OpenCode keeps a text
 * part's text only once the part ends, so a part that was streaming when the
 * feed dropped is not continued from later deltas (they would land after a
 * hole); it is completed from the full text its `session.text.ended` carries.
 *
 * Approvals (A.5, ruling R4). Station answers a permission ask only `once`
 * or `reject`, never `always`: "allow for this session" is a grant this
 * session keeps, scoped to what was asked (OpenCode's `save` patterns, else
 * the exact resources), answered `once` each time and dropped when the
 * approval mode changes. A request resolves when the engine says it was
 * answered (`permission.replied`, `form.replied`), so its acknowledgement is
 * the engine's; an execution that ends drops its pending asks silently, so
 * they close then, and a late answer is refused without reaching OpenCode.
 */
import crypto from 'node:crypto';
import type { ChildWorkItem } from '@kontourai/station-contracts/child-work';
import type { EngineCommandOutcome } from '@kontourai/station-contracts/engine-commands';
import type {
  InputRequestContent,
  InputRequestForm,
} from '@kontourai/station-contracts/input-request';
import {
  ACP_SESSION_REWOUND_CODE,
  ENGINE_TURN_FAILED_CODE,
  type EngineId,
  SESSION_REWIND_AFFECTED_PATHS_MAX,
  type SessionRewindOutcome,
} from '@kontourai/station-contracts/provider';
import {
  type ApprovalStatus,
  type ProviderRuntimeEvent as CanonicalRuntimeEvent,
  PROVIDER_TURN_TRIGGER,
} from '@kontourai/station-contracts/runtime-events';
import {
  ownArray,
  ownRecord,
  validateInputRequestContent,
} from '@kontourai/station-shared/input-request';
import { redactSecrets } from '@kontourai/station-shared/redaction';
import {
  type OpenCodeNativeRule,
  openCodeGrantCovers,
  openCodeNativeAskAnswer,
} from '../../services/acp/opencode-approval-native.js';
import { openCodeNativeAskNeedsPerson } from '../../services/acp/opencode-project-config.js';
import { errorMessage } from '../../utils/error-message.js';
import {
  type ProviderInterruptTurnResult,
  ProviderTurnEndedError,
  ProviderTurnInProgressError,
  SendTurnRefusedError,
  SessionRewindingError,
} from '../adapter-shape.js';
import { ProviderRefusalError, providerFailure } from '../provider-failure.js';
import { projectBoundedToolOutput } from '../tool-output-projection.js';
import type { AcpAppliedApprovalMode } from './acp-approval-mode.js';
import {
  OPENCODE_IGNORED_EVENTS,
  openCodeEventSessionId,
  openCodeFormAnswer,
  openCodeFormRequest,
  openCodeHistoryText,
  openCodeMcpStatus,
  openCodeStepUsage,
  openCodeToolError,
  openCodeToolOutput,
  readString,
} from './opencode-native-events.js';
import {
  type OpenCodeServeClient,
  type OpenCodeServeEvent,
  OpenCodeServeHttpError,
} from './opencode-serve-client.js';
import { UNRESOLVED_TOOL_OUTPUT } from './unresolved-tool-output.js';

/** Back-off between reconnect attempts: doubles from the first, capped. */
const RECONNECT_FIRST_MS = 250;
const RECONNECT_MAX_MS = 5_000;
/** How long a start waits for the feed's first `server.connected`. */
const FEED_READY_TIMEOUT_MS = 10_000;
/** Settled turns kept as rewind points. */
const TURN_MESSAGES_MAX = 500;
/** How long stopping a session waits on each request that drops engine work. */
const STOP_REQUEST_MS = 2_000;
/** Request ids closed without an answer, remembered to refuse a late one. */
const CLOSED_REQUESTS_MAX = 200;
/** Messages per page of a reconnect's history read (OpenCode takes 1-200). */
const HISTORY_PAGE = 100;
/**
 * Pages a reconnect reads, newest first, looking for the live turn's start;
 * past this it works from what it read.
 */
const HISTORY_PAGES_MAX = 20;

/**
 * An answer to a request OpenCode no longer holds: its execution ended (an
 * interrupt or failure drops a pending ask without `permission.replied`),
 * or the session stopped. Nothing is sent to the engine.
 */
export class OpenCodeRequestClosedError extends ProviderRefusalError {
  constructor() {
    super(
      'OpenCode no longer holds this request: the turn that asked it ended.',
      'conflict',
    );
    this.name = 'OpenCodeRequestClosedError';
  }
}

const ID_CHARS =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
let lastIdTimestamp = 0;
let idCounter = 0;

/**
 * A new OpenCode message id, in OpenCode's own ascending form
 * (`@opencode/schema` `Identifier.ascending`: 48 bits of time and counter
 * in hex, then 14 random characters). Station chooses a prompt's id so the
 * turn (or steer) is known by it before the engine can report it.
 */
export function newOpenCodeMessageId(timestamp = Date.now()): string {
  if (timestamp !== lastIdTimestamp) {
    lastIdTimestamp = timestamp;
    idCounter = 0;
  }
  idCounter += 1;
  const value = BigInt(timestamp) * 0x1000n + BigInt(idCounter);
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, '0'),
  ).join('');
  const random = Array.from(
    crypto.randomBytes(14),
    (byte) => ID_CHARS[byte % ID_CHARS.length],
  ).join('');
  return `msg_${time}${random}`;
}

export type OpenCodeNativeDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel';

export interface OpenCodeNativeSessionDeps {
  readonly threadId: string;
  readonly provider: EngineId;
  /** The engine's name, as output lines and requests attribute it. */
  readonly engineName: string;
  readonly client: OpenCodeServeClient;
  /** The OpenCode session id (`ses_...`), also the ACP session id. */
  readonly sessionId: string;
  readonly publish: (event: CanonicalRuntimeEvent) => void;
  /** Station's applied approval mode; answers asks it covers without a person. */
  approvalMode?: AcpAppliedApprovalMode;
  /**
   * The session agent's own rules while Station's confined rules govern it
   * (Ask, Auto); undefined otherwise. An ask they deny is rejected.
   */
  agentRules?: readonly OpenCodeNativeRule[];
  /**
   * The directory the session was created at (OpenCode names a write
   * inside it relative to it), for the configuration-edit guard
   * (`openCodeNativeAskNeedsPerson`).
   */
  readonly cwd: string;
  /** The environment the server was launched with: where its global configuration lives. */
  readonly configEnv?: NodeJS.ProcessEnv;
  /**
   * A child session's agent's own rules (`GET /api/agent/{name}`). A child
   * inherits this session's rules (`core/src/session.ts` create:
   * `permissions: input.permissions ?? parent?.permissions`) but runs its
   * own agent, whose denies Station keeps. Absent or failing: a governed
   * child's ask goes to a person.
   */
  readonly agentRulesFor?: (
    agent: string,
  ) => Promise<readonly OpenCodeNativeRule[]>;
  readonly now?: () => Date;
  readonly reconnectFirstMs?: number;
  readonly heartbeatTimeoutMs?: number;
  /** Tests: the ids Station gives its prompts (default {@link newOpenCodeMessageId}). */
  readonly newMessageId?: () => string;
}

interface NativeTurn {
  readonly turnId: string;
  readonly kind: 'station' | 'provider';
  readonly invocationId?: string;
  /** The user message (inbox item) the turn's prompt is, once known. */
  messageId?: string;
  /**
   * For a turn with no message of its own (the engine's, or a command's):
   * the server's time its execution started, which bounds what history
   * belongs to it.
   */
  sinceMs?: number;
  /** Bound to the engine execution running it. */
  executing: boolean;
  startPublished: boolean;
  readonly buffered: Array<() => void>;
  settled: boolean;
  stopRequested: boolean;
  outputText: string;
  readonly openTools: Map<string, string>;
  readonly done: Promise<void>;
  resolveDone(): void;
}

interface TextPart {
  readonly turnId: string;
  readonly kind: 'text' | 'reasoning';
  streamed: string;
  open: boolean;
  /** The feed dropped while the part streamed: later deltas are not appended. */
  gapped: boolean;
}

interface PendingRequest {
  readonly kind: 'permission' | 'form';
  readonly nativeId: string;
  readonly eventId: string;
  /** The OpenCode session that asked (this one, or a child). */
  readonly sessionId: string;
  readonly action?: string;
  /** What an "allow for this session" grant of it covers. */
  readonly patterns?: readonly string[];
  readonly form?: InputRequestForm;
  readonly turnId?: string;
  decided?: OpenCodeNativeDecision;
}

interface PendingSteer {
  readonly turnId: string;
  readonly text: string;
  /** Its prompt is in flight: a withdrawal must be repeated once it lands. */
  posting: boolean;
  withdrawn: boolean;
  resolve(): void;
  reject(error: Error): void;
}

/** A `permission.asked` request, as read from its event. */
interface NativeAsk {
  readonly nativeId: string;
  /** The OpenCode session that asked (this one, or a child). */
  readonly sessionId: string;
  readonly action: string;
  readonly resources: readonly string[];
  readonly save: readonly string[];
  readonly toolCallId: string | undefined;
}

interface SessionGrant {
  readonly action: string;
  readonly patterns: readonly string[];
}

interface ChildSession {
  readonly childId: string;
  title?: string;
  agent?: string;
  running: boolean;
  /** The running item last reported for it, re-listed by each snapshot. */
  item?: ChildWorkItem;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** An event as this session builds it; the envelope is added on publish. */
type EventBody = DistributiveOmit<
  CanonicalRuntimeEvent,
  'eventId' | 'provider' | 'threadId' | 'createdAt'
>;

/**
 * The files a staged revert restores (its answer's `data.files[].file`), as
 * a rewind outcome carries them: the exact count, at most
 * {@link SESSION_REWIND_AFFECTED_PATHS_MAX} paths. Undefined when the answer
 * names none in a shape Station reads.
 */
function openCodeRevertFiles(
  answer: unknown,
): { count: number; paths: string[] } | undefined {
  const files = ownArray(ownRecord(ownRecord(answer)?.data)?.files);
  if (!files) return undefined;
  const paths = files
    .map((entry) => ownRecord(entry)?.file)
    .filter((file): file is string => typeof file === 'string');
  if (paths.length === 0) return undefined;
  return {
    count: paths.length,
    paths: paths.slice(0, SESSION_REWIND_AFFECTED_PATHS_MAX),
  };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export class OpenCodeNativeSession {
  readonly sessionId: string;
  private readonly deps: OpenCodeNativeSessionDeps;
  private readonly controller = new AbortController();
  private turn: NativeTurn | undefined;
  /** A Station turn whose prompt was sent and whose execution has not started. */
  private pendingStart: NativeTurn | undefined;
  private readonly turnMessages: Array<{ turnId: string; messageId: string }> =
    [];
  private readonly parts = new Map<string, TextPart>();
  private readonly requests = new Map<string, PendingRequest>();
  /**
   * Session grants (R4): the action and the patterns allowed for it,
   * answered `once` each time; cleared when the approval mode changes.
   */
  private readonly grants: SessionGrant[] = [];
  /** Asks Station is answering itself (or deciding), by native id. */
  private readonly autoAnswering = new Set<string>();
  /** Child agents' rules, by agent name (`agentRulesFor`). */
  private readonly childRules = new Map<
    string,
    Promise<readonly OpenCodeNativeRule[] | undefined>
  >();
  /** Requests closed unanswered (their execution ended), oldest first. */
  private readonly closedRequests = new Set<string>();
  private readonly steers = new Map<string, PendingSteer>();
  private readonly children = new Map<string, ChildSession>();
  private lastModel: string | undefined;
  private lastAgent: string | undefined;
  private connections = 0;
  private stopped = false;
  /** A rewind is with the engine (between its stage and its commit). */
  private rewinding = false;
  private feedReady!: () => void;
  private readonly ready: Promise<void>;
  private loop: Promise<void> | undefined;
  private mcpRefresh: Promise<void> | undefined;
  /** Events of types this build does not map, by type. Never fatal. */
  readonly unknownEvents = new Map<string, number>();

  constructor(deps: OpenCodeNativeSessionDeps) {
    this.deps = deps;
    this.sessionId = deps.sessionId;
    this.ready = new Promise((resolve) => {
      this.feedReady = resolve;
    });
  }

  get activeTurnId(): string | undefined {
    const turn = this.turn ?? this.pendingStart;
    return turn && !turn.settled ? turn.turnId : undefined;
  }

  /** Children still running: they end with the server, past the turn. */
  hasOpenWork(): boolean {
    return [...this.children.values()].some((child) => child.running);
  }

  /** Stopped: no engine process holds this session any more. */
  get isStopped(): boolean {
    return this.stopped;
  }

  /** Turns that can be rewound to, oldest first. */
  rewindPoints(): string[] {
    return this.turnMessages.map((entry) => entry.turnId);
  }

  get approvalMode(): AcpAppliedApprovalMode | undefined {
    return this.deps.approvalMode;
  }

  /**
   * A changed mode starts over: the grants made under the old one go.
   * `agentRules` are the agent's own rules while the confined rules govern.
   */
  setApprovalMode(
    mode: AcpAppliedApprovalMode | undefined,
    agentRules?: readonly OpenCodeNativeRule[],
  ): void {
    if (mode !== this.deps.approvalMode) this.grants.splice(0);
    this.deps.approvalMode = mode;
    this.deps.agentRules = agentRules;
  }

  /** Refuse, before anything reaches the engine, while a turn runs. */
  assertIdle(): void {
    if (this.rewinding) throw new SessionRewindingError();
    const live = this.turn ?? this.pendingStart;
    if (live && !live.settled) {
      if (live.kind === 'provider') throw new ProviderTurnInProgressError();
      throw new SendTurnRefusedError(
        'This OpenCode session is already running a turn.',
        'busy',
      );
    }
  }

  private newMessageId(): string {
    return (this.deps.newMessageId ?? newOpenCodeMessageId)();
  }

  /** Open the event feed and wait until the server has said it is connected. */
  async start(): Promise<void> {
    this.loop ??= this.run();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.ready,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error("OpenCode's event feed did not connect in time."),
              ),
            FEED_READY_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    void this.refreshMcp();
  }

  // --- Turns ------------------------------------------------------------

  async sendTurn(input: {
    turnId: string;
    text: string;
    /** Prompt files (`PromptInput.FileAttachment`): images as data URIs. */
    files?: ReadonlyArray<{ uri: string; name: string }>;
    displayText: string;
    invocationId?: string;
    metadata?: Record<string, unknown>;
    /** Send as this listed OpenCode command (`POST /command`) instead. */
    command?: { name: string; args: string };
  }): Promise<void> {
    this.assertIdle();
    const turn = this.createTurn(input.turnId, 'station', input.invocationId);
    this.pendingStart = turn;
    // The prompt's id is chosen here, so the turn is known by it before the
    // engine can report it (a delivery, or history read after a feed gap).
    // `POST /command` takes no id; its turn is bound when it is delivered.
    if (!input.command) turn.messageId = this.newMessageId();
    try {
      if (input.command) {
        await this.deps.client.request(
          'POST',
          `/api/session/${this.sessionId}/command`,
          { name: input.command.name, text: input.command.args },
        );
      } else {
        await this.deps.client.request<{ data?: unknown }>(
          'POST',
          `/api/session/${this.sessionId}/prompt`,
          {
            id: turn.messageId,
            text: input.text,
            ...(input.files?.length ? { files: input.files } : {}),
          },
        );
      }
    } catch (error) {
      if (this.pendingStart === turn) this.pendingStart = undefined;
      turn.settled = true;
      turn.resolveDone();
      if (error instanceof OpenCodeServeHttpError)
        throw new SendTurnRefusedError(
          `OpenCode refused the prompt (${error.status}).`,
          'unavailable',
        );
      throw error;
    }
    if (turn.messageId) this.recordRewindPoint(turn);
    this.publishStart(turn, {
      prompt: input.displayText,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
  }

  /**
   * Mid-turn input (PLAN B steer): a prompt with `delivery: 'steer'`, which
   * the engine reads at its next step. Acknowledged when the engine
   * delivers it; if the execution ends first the item is withdrawn and the
   * steer refused as too late.
   */
  async steer(text: string, turnId: string): Promise<void> {
    const turn = this.turn;
    if (!turn || turn.settled || turn.turnId !== turnId || !turn.executing)
      throw new ProviderTurnEndedError();
    // Known by its id before it is sent: the engine can deliver it (on the
    // feed) before the prompt's answer arrives.
    const inboxId = this.newMessageId();
    let steer!: PendingSteer;
    const delivered = new Promise<void>((resolve, reject) => {
      steer = {
        turnId,
        text,
        posting: true,
        withdrawn: false,
        resolve,
        reject,
      };
    });
    // A withdrawal can reject it before it is awaited below.
    delivered.catch(() => undefined);
    this.steers.set(inboxId, steer);
    try {
      await this.deps.client.request(
        'POST',
        `/api/session/${this.sessionId}/prompt`,
        { id: inboxId, text, delivery: 'steer' },
      );
    } catch (error) {
      this.steers.delete(inboxId);
      if (steer.withdrawn) throw new ProviderTurnEndedError();
      throw error;
    } finally {
      steer.posting = false;
    }
    if (steer.withdrawn) {
      // Withdrawn while in flight: the item it made must not wait for the
      // next execution.
      await this.deleteInboxItem(inboxId);
    } else if (turn.settled) {
      // The execution ended while the prompt was in flight.
      void this.withdrawSteer(inboxId);
    }
    await delivered;
  }

  async interrupt(turnId?: string): Promise<ProviderInterruptTurnResult> {
    const turn = this.turn ?? this.pendingStart;
    if (!turn || turn.settled) return { outcome: 'no-active-turn' };
    if (turnId && turnId !== turn.turnId)
      return { outcome: 'target-mismatch', activeTurnId: turn.turnId };
    turn.stopRequested = true;
    try {
      await this.deps.client.request(
        'POST',
        `/api/session/${this.sessionId}/interrupt`,
      );
    } catch {
      return { outcome: 'termination-unconfirmed', turnId: turn.turnId };
    }
    if (!turn.executing) {
      // Nothing ran yet: the turn ends here.
      this.settle(turn, { method: 'turn.aborted', reason: 'interrupted' });
    }
    return { outcome: 'cancelled', turnId: turn.turnId };
  }

  /** Show `text` as this turn's output; end the turn unless an execution runs it. */
  answerTurn(turnId: string, text: string): void {
    const turn =
      this.turn?.turnId === turnId
        ? this.turn
        : this.pendingStart?.turnId === turnId
          ? this.pendingStart
          : undefined;
    if (!turn || turn.settled) return;
    if (!turn.startPublished) this.publishStart(turn, {});
    this.appendText(turn, `${turnId}:command`, text);
    if (!turn.executing && this.pendingStart !== turn)
      this.settle(turn, { method: 'turn.completed', finishReason: 'stop' });
  }

  /**
   * Begin a Station turn for a slash command; its execution (if the command
   * starts one) binds to it like a prompt's.
   */
  beginCommandTurn(input: {
    turnId: string;
    displayText: string;
    invocationId?: string;
  }): void {
    this.assertIdle();
    const turn = this.createTurn(input.turnId, 'station', input.invocationId);
    this.turn = turn;
    this.publishStart(turn, { prompt: input.displayText });
  }

  /** Run `/compact` on the turn `turnId` already began. */
  async compact(turnId: string): Promise<EngineCommandOutcome> {
    const turn = this.turn;
    if (!turn || turn.turnId !== turnId || turn.settled)
      return { kind: 'failed', message: 'The turn ended.' };
    // The compaction runs as an execution; it is this turn's.
    this.turn = undefined;
    this.pendingStart = turn;
    try {
      await this.deps.client.request(
        'POST',
        `/api/session/${this.sessionId}/compact`,
        {},
      );
    } catch (error) {
      this.pendingStart = undefined;
      this.turn = turn;
      return { kind: 'failed', message: errorMessage(error) };
    }
    return { kind: 'answered', text: '' };
  }

  /**
   * Rewind the engine to before `turnId` (`ProviderAdapterShape.
   * rewindSession`): stage a revert to that turn's own user message, files
   * included, then commit it, so that turn and every later one are hidden
   * from the engine. A failed commit clears the staged revert. Refused,
   * before anything reaches the engine, while a turn runs, while another
   * rewind is with the engine, and for a turn whose message this process
   * never saw. The caller refuses a session that is not live or is still
   * preparing a send.
   */
  async rewind(
    turnId: string,
    options: { commandTurnId?: string } = {},
  ): Promise<SessionRewindOutcome> {
    if (this.stopped) return { kind: 'refused', reason: 'not-live' };
    // `/rewind` runs on a turn of its own, which runs nothing on the engine.
    const live = this.turn ?? this.pendingStart;
    if (
      live &&
      !live.settled &&
      (live.turnId !== options.commandTurnId || live.executing)
    )
      return { kind: 'refused', reason: 'turn-running' };
    if (this.rewinding) return { kind: 'refused', reason: 'rewind-pending' };
    const index = this.turnMessages.findIndex(
      (entry) => entry.turnId === turnId,
    );
    const point = this.turnMessages[index];
    if (!point) return { kind: 'refused', reason: 'unknown-turn' };
    const hidden = this.turnMessages.slice(index);
    const base = `/api/session/${this.sessionId}/revert`;
    // `assertIdle` refuses a turn while this is set, so no prompt reaches
    // the engine (or the ledger) between the stage and the commit.
    this.rewinding = true;
    let affectedFiles: { count: number; paths: string[] } | undefined;
    try {
      let staged: unknown;
      try {
        staged = await this.deps.client.request('POST', `${base}/stage`, {
          messageID: point.messageId,
          files: true,
        });
      } catch (error) {
        return { kind: 'failed', message: errorMessage(error) };
      }
      affectedFiles = openCodeRevertFiles(staged);
      try {
        await this.deps.client.request('POST', `${base}/commit`);
      } catch (error) {
        await this.deps.client.request('DELETE', base).catch(() => undefined);
        return { kind: 'failed', message: errorMessage(error) };
      }
    } finally {
      this.rewinding = false;
    }
    this.turnMessages.splice(index);
    const hiddenTurnIds = hidden.map((entry) => entry.turnId);
    this.emit({
      method: 'runtime.warning',
      severity: 'warning',
      code: ACP_SESSION_REWOUND_CODE,
      message: `${this.deps.engineName} rewound this conversation; ${hiddenTurnIds.length === 1 ? 'one turn is' : `${hiddenTurnIds.length} turns are`} hidden from it${affectedFiles ? ` and it restored ${affectedFiles.count === 1 ? 'one file' : `${affectedFiles.count} files`}` : ''}.`,
      details: {
        beforeTurnId: turnId,
        hiddenTurnIds,
        ...(affectedFiles ? { affectedFileCount: affectedFiles.count } : {}),
      },
    });
    return {
      kind: 'rewound',
      beforeTurnId: turnId,
      hiddenTurnIds,
      ...(affectedFiles ? { affectedFiles } : {}),
    };
  }

  /**
   * Restart one of the server's MCP servers: OpenCode's disconnect, then
   * connect. A server added by name for this session (Station's) and one
   * from OpenCode's own configuration restart alike. OpenCode 2 has no MCP
   * sign-in Station can start, so `startOAuth` is refused before anything
   * is sent.
   */
  async reconnectMcp(
    name: string,
    options: { startOAuth: boolean },
  ): Promise<EngineCommandOutcome> {
    if (options.startOAuth)
      return {
        kind: 'failed',
        message: `${this.deps.engineName} has no MCP sign-in Station can start; reconnect without it.`,
      };
    const base = `/api/experimental/mcp/${encodeURIComponent(name)}`;
    try {
      await this.deps.client.request('POST', `${base}/disconnect`);
      await this.deps.client.request('POST', `${base}/connect`);
    } catch (error) {
      return { kind: 'failed', message: errorMessage(error) };
    } finally {
      void this.refreshMcp();
    }
    return {
      kind: 'answered',
      success: true,
      text: `${this.deps.engineName} reconnected MCP server ${name}.`,
    };
  }

  // --- Requests ---------------------------------------------------------

  async respond(
    requestId: string,
    decision: OpenCodeNativeDecision,
    context?: {
      inputContent?: InputRequestContent;
      expectedRequestEventId?: string;
    },
  ): Promise<void> {
    const pending = this.requests.get(requestId);
    if (!pending) {
      if (this.closedRequests.has(requestId))
        throw new OpenCodeRequestClosedError();
      throw new Error(`Unknown OpenCode request: ${requestId}`);
    }
    if (pending.decided) throw new Error('This request was already answered.');
    const base = `/api/session/${pending.sessionId}`;
    if (pending.kind === 'form') {
      if (
        context?.expectedRequestEventId !== pending.eventId ||
        decision === 'acceptForSession'
      )
        throw new Error('Inspect this question before answering it.');
      const form = pending.form as InputRequestForm;
      if (decision === 'accept') {
        const content = validateInputRequestContent(
          form,
          context?.inputContent,
        );
        pending.decided = decision;
        await this.deps.client.request(
          'POST',
          `${base}/form/${pending.nativeId}/reply`,
          { answer: openCodeFormAnswer(form, content) },
        );
        return;
      }
      if (context?.inputContent !== undefined)
        throw new Error('A declined question cannot carry answers.');
      pending.decided = decision;
      await this.deps.client.request(
        'DELETE',
        `${base}/form/${pending.nativeId}`,
      );
      return;
    }
    if (context?.inputContent !== undefined)
      throw new Error('This request does not accept question answers.');
    pending.decided = decision;
    // Ruling R4: never `always`. A session grant stays here, answered `once`.
    try {
      await this.deps.client.request(
        'POST',
        `${base}/permission/${pending.nativeId}/reply`,
        decision === 'accept' || decision === 'acceptForSession'
          ? { decision: 'once' }
          : { decision: 'reject' },
      );
    } catch (error) {
      if (error instanceof OpenCodeServeHttpError && error.status === 404) {
        // The engine dropped the ask (its execution ended) without saying so.
        this.closeRequest(pending);
        throw new OpenCodeRequestClosedError();
      }
      pending.decided = undefined;
      throw error;
    }
    // Scoped as OpenCode would save it: the ask's `save` patterns, else its
    // exact resources. Most tools ask with `save: ["*"]` (2.3.0 governed
    // capture: edit), so for them a grant covers the whole action, as
    // OpenCode's own "always" would; shell saves a command prefix
    // (`echo *`).
    if (decision === 'acceptForSession' && pending.action && pending.patterns)
      this.grants.push({ action: pending.action, patterns: pending.patterns });
  }

  // --- Lifecycle --------------------------------------------------------

  /** End the session: the feed closes and anything open is settled. */
  async stop(reason: 'stopped' | 'exited'): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    // Withdrawn from here: a steer whose prompt lands while the engine's
    // work is dropped takes its item back out itself (`steer`).
    for (const steer of this.steers.values()) steer.withdrawn = true;
    if (reason === 'stopped') await this.dropEngineWork();
    this.controller.abort();
    for (const [inboxId, steer] of this.steers) {
      this.steers.delete(inboxId);
      steer.reject(new ProviderTurnEndedError());
    }
    for (const turn of [this.turn, this.pendingStart]) {
      if (turn && !turn.settled) {
        this.closeOpenTools(turn);
        this.settle(turn, {
          method: 'turn.aborted',
          reason: reason === 'exited' ? 'engine-exited' : 'session-stopped',
        });
      }
    }
    for (const pending of [...this.requests.values()])
      this.closeRequest(pending);
    for (const child of this.children.values()) {
      if (child.running) this.settleChild(child, 'unresolved');
    }
    await this.loop?.catch(() => undefined);
  }

  /**
   * Stopping a live session stops what OpenCode runs for it: its execution
   * is interrupted first, then its pending asks are rejected, its questions
   * cancelled and its queued steers withdrawn (so nothing they hold
   * proceeds, or waits for a later execution). Each request is bounded on
   * its own, so one the engine never answers cannot hold back the
   * interrupt; best effort, the session is released whatever the engine
   * answers. A steer whose prompt is still in flight is withdrawn when it
   * lands (`steer`).
   */
  private async dropEngineWork(): Promise<void> {
    const client = this.deps.client;
    const live = this.turn ?? this.pendingStart;
    const running = (live !== undefined && !live.settled) || this.hasOpenWork();
    const send = (method: 'POST' | 'DELETE', path: string, body?: unknown) =>
      client
        .request(method, path, body, { timeoutMs: STOP_REQUEST_MS })
        .catch(() => undefined);
    if (running) await send('POST', `/api/session/${this.sessionId}/interrupt`);
    await Promise.all([
      ...[...this.requests.values()]
        .filter((pending) => !pending.decided)
        .map((pending) => {
          pending.decided = 'cancel';
          const base = `/api/session/${pending.sessionId}`;
          return pending.kind === 'permission'
            ? send('POST', `${base}/permission/${pending.nativeId}/reply`, {
                decision: 'reject',
              })
            : send('DELETE', `${base}/form/${pending.nativeId}`);
        }),
      ...[...this.steers.entries()]
        .filter(([, steer]) => !steer.posting)
        .map(([inboxId]) =>
          send('DELETE', `/api/session/${this.sessionId}/inbox/${inboxId}`),
        ),
    ]);
  }

  private async run(): Promise<void> {
    let attempt = 0;
    const signal = this.controller.signal;
    while (!this.stopped) {
      try {
        for await (const event of this.deps.client.events({
          signal,
          ...(this.deps.heartbeatTimeoutMs
            ? { heartbeatTimeoutMs: this.deps.heartbeatTimeoutMs }
            : {}),
        })) {
          if (this.stopped) return;
          attempt = 0;
          if (event.type === 'server.connected') {
            this.connections += 1;
            if (this.connections > 1) await this.reconcile();
            this.feedReady();
            continue;
          }
          if (event.type === 'location.shutdown') break;
          this.handle(event);
        }
      } catch {
        // A dropped or silent feed: reconnect below.
      }
      if (this.stopped) return;
      this.onDisconnect();
      const first = this.deps.reconnectFirstMs ?? RECONNECT_FIRST_MS;
      await delay(Math.min(first * 2 ** attempt, RECONNECT_MAX_MS), signal);
      attempt += 1;
    }
  }

  private onDisconnect(): void {
    for (const part of this.parts.values()) {
      if (part.open) part.gapped = true;
    }
  }

  /** Re-read what a feed gap hid (PLAN A.4). Best effort; never fatal. */
  private async reconcile(): Promise<void> {
    const client = this.deps.client;
    const base = `/api/session/${this.sessionId}`;
    try {
      const active = await client.request<{ data?: unknown }>(
        'GET',
        '/api/session/active',
      );
      const running = Object.hasOwn(
        ownRecord(active?.data) ?? {},
        this.sessionId,
      );
      const history = await this.readHistory();
      this.adoptStartedDuringGap(history);
      this.catchUpText(history);
      const permissions = await client.request<{ data?: unknown }>(
        'GET',
        `${base}/permission`,
      );
      for (const item of ownArray(permissions?.data) ?? [])
        this.onPermissionAsked(ownRecord(item) ?? {});
      const forms = await client.request<{ data?: unknown }>(
        'GET',
        `${base}/form`,
      );
      for (const item of ownArray(forms?.data) ?? []) this.onFormCreated(item);
      const inbox = await client.request<{ data?: unknown }>(
        'GET',
        `${base}/inbox`,
      );
      const queued = new Set(
        (ownArray(inbox?.data) ?? []).flatMap((item) => {
          const id = readString(ownRecord(item)?.id);
          return id ? [id] : [];
        }),
      );
      for (const inboxId of [...this.steers.keys()]) {
        if (queued.has(inboxId)) continue;
        // No longer queued: delivered during the gap, or the run ended.
        if (running) this.onSteerDelivered(inboxId);
        else void this.withdrawSteer(inboxId);
      }
      const turn = this.turn;
      if (!running && turn && !turn.settled && turn.executing)
        this.settleFromHistory(turn, history);
    } catch (error) {
      this.emit({
        method: 'runtime.warning',
        severity: 'warning',
        message: `Station reconnected to OpenCode but could not re-read the session: ${redactSecrets(errorMessage(error))}`,
      });
    }
  }

  /**
   * The session's latest history, oldest first, reaching back to the live
   * turn's start. OpenCode pages its history (50 messages unless asked
   * otherwise), so it is read newest first, following each page's
   * `cursor.next`, until the oldest message a reconnect needs is in it: the
   * running turn's own message (or, for a turn with none, a message from
   * before its execution started), or for a prompt not yet seen to start,
   * the last earlier prompt Station sent. At most {@link HISTORY_PAGES_MAX}
   * pages.
   */
  private async readHistory(): Promise<unknown[]> {
    const base = `/api/session/${this.sessionId}/message`;
    const reached = this.historyStart();
    const newestFirst: unknown[] = [];
    let path = `${base}?order=desc&limit=${HISTORY_PAGE}`;
    for (let page = 0; page < HISTORY_PAGES_MAX; page += 1) {
      const answer = await this.deps.client.request<{
        data?: unknown;
        cursor?: unknown;
      }>('GET', path);
      const items = ownArray(answer?.data) ?? [];
      newestFirst.push(...items);
      if (!reached || items.some((item) => reached(ownRecord(item) ?? {})))
        break;
      const next = readString(ownRecord(answer?.cursor)?.next);
      if (items.length < HISTORY_PAGE || !next) break;
      // A cursor carries its own order; OpenCode refuses both together.
      path = `${base}?cursor=${encodeURIComponent(next)}&limit=${HISTORY_PAGE}`;
    }
    return newestFirst.reverse();
  }

  /**
   * Whether a history message is as far back as a reconnect must read;
   * undefined when nothing live needs more than the newest page.
   */
  private historyStart():
    | ((message: Record<string, unknown>) => boolean)
    | undefined {
    const turn = this.turn && !this.turn.settled ? this.turn : undefined;
    if (turn?.messageId) {
      const id = turn.messageId;
      return (message) => message.id === id;
    }
    if (turn?.sinceMs !== undefined) {
      const since = turn.sinceMs;
      return (message) => {
        const created = ownRecord(message.time)?.created;
        return typeof created === 'number' && created < since;
      };
    }
    const pending = this.pendingStart;
    if (!pending || pending.settled || !pending.messageId) return undefined;
    // Its message, if delivered, follows every earlier prompt's.
    const earlier = this.turnMessages
      .filter((entry) => entry.messageId !== pending.messageId)
      .at(-1)?.messageId;
    const own = pending.messageId;
    return (message) => message.id === own || message.id === earlier;
  }

  /**
   * A prompt whose execution started while the feed was down: its message is
   * in history (a queued inbox item is not), so the execution running, or
   * the one that ran, is its turn's. Still queued, it waits as before.
   */
  private adoptStartedDuringGap(messages: unknown): void {
    const pending = this.pendingStart;
    if (!pending || pending.settled || !pending.messageId) return;
    const delivered = (ownArray(messages) ?? []).some(
      (item) => ownRecord(item)?.id === pending.messageId,
    );
    if (!delivered) return;
    const current = this.turn;
    if (current && !current.settled && current !== pending) {
      // An execution Station saw start before this prompt's: it is over.
      this.closeOpenTools(current);
      this.settle(current, { method: 'turn.completed', finishReason: 'other' });
    }
    this.pendingStart = undefined;
    pending.executing = true;
    this.turn = pending;
  }

  /** Where each history message falls against `turn`'s start, in order. */
  private historyBound(
    turn: NativeTurn | undefined,
  ): (message: Record<string, unknown>) => 'before' | 'mark' | 'in' {
    let after = false;
    return (message) => {
      if (!turn) return 'before';
      if (turn.messageId) {
        if (message.id === turn.messageId) {
          after = true;
          return 'mark';
        }
        return after ? 'in' : 'before';
      }
      // No message of its own: bounded by when its execution started, and
      // with no bound nothing in history is known to be its.
      const created = ownRecord(message.time)?.created;
      return turn.sinceMs !== undefined &&
        typeof created === 'number' &&
        created >= turn.sinceMs
        ? 'in'
        : 'before';
    };
  }

  /**
   * Text a message finished during the gap: whatever of it was not already
   * streamed is published, for parts Station saw and for parts of the
   * running turn it never saw at all.
   */
  private catchUpText(messages: unknown): void {
    const texts = openCodeHistoryText(messages);
    const turn = this.turn;
    const bound = this.historyBound(turn);
    for (const item of ownArray(messages) ?? []) {
      const message = ownRecord(item);
      const id = readString(message?.id);
      if (!message || !id) continue;
      if (bound(message) !== 'in' || message.type !== 'assistant') continue;
      for (const [key, text] of texts) {
        if (!key.startsWith(`${id}:`) || !text) continue;
        const part = this.parts.get(key);
        if (part) {
          if (part.kind !== 'text') continue;
          if (
            text.length > part.streamed.length &&
            text.startsWith(part.streamed)
          ) {
            const owner = this.turnById(part.turnId);
            if (owner)
              this.appendText(owner, key, text.slice(part.streamed.length));
          }
          part.open = false;
          part.gapped = false;
        } else if (turn && !turn.settled && turn.executing) {
          this.parts.set(key, {
            turnId: turn.turnId,
            kind: 'text',
            streamed: '',
            open: false,
            gapped: false,
          });
          this.appendText(turn, key, text);
        }
      }
    }
  }

  /** The execution ended during the gap: its outcome is history's idle entry. */
  private settleFromHistory(turn: NativeTurn, messages: unknown): void {
    let outcome: string | undefined;
    const bound = this.historyBound(turn);
    for (const item of ownArray(messages) ?? []) {
      const message = ownRecord(item);
      if (message && bound(message) === 'in' && message.type === 'idle')
        outcome = readString(message.outcome);
    }
    this.closeOpenTools(turn);
    if (outcome === 'failed') this.settleFailed(turn, undefined);
    else if (outcome === 'interrupted') this.settleInterrupted(turn);
    else
      this.settle(turn, {
        method: 'turn.completed',
        finishReason: outcome === 'succeeded' ? 'stop' : 'other',
      });
  }

  // --- Event mapping ----------------------------------------------------

  private handle(event: OpenCodeServeEvent): void {
    const data = ownRecord(event.data) ?? {};
    const sessionId = openCodeEventSessionId(data);
    if (event.type === 'mcp.status.changed') {
      void this.refreshMcp();
      return;
    }
    if (sessionId && sessionId !== this.sessionId) {
      this.handleForeign(event.type, data, sessionId);
      return;
    }
    if (!sessionId) {
      if (!OPENCODE_IGNORED_EVENTS.has(event.type)) this.countUnknown(event);
      return;
    }
    switch (event.type) {
      case 'session.execution.started':
        this.onExecutionStarted(
          typeof event.created === 'number' ? event.created : undefined,
        );
        return;
      case 'session.execution.succeeded':
        this.onExecutionEnded((turn) =>
          this.settle(turn, { method: 'turn.completed', finishReason: 'stop' }),
        );
        return;
      case 'session.execution.failed':
        this.onExecutionEnded((turn) => this.settleFailed(turn, data.error));
        return;
      case 'session.execution.interrupted':
        this.onExecutionEnded((turn) => this.settleInterrupted(turn));
        return;
      case 'session.inbox.delivered': {
        const inboxId = readString(data.inboxID);
        if (!inboxId) return;
        const turn = this.turn;
        if (turn && turn.kind === 'station' && !turn.messageId) {
          turn.messageId = inboxId;
          this.recordRewindPoint(turn);
        }
        this.onSteerDelivered(inboxId);
        return;
      }
      case 'session.inbox.cancelled': {
        const inboxId = readString(data.inboxID);
        const steer = inboxId ? this.steers.get(inboxId) : undefined;
        if (inboxId && steer) {
          this.steers.delete(inboxId);
          steer.reject(new ProviderTurnEndedError());
        }
        return;
      }
      case 'session.step.started':
        this.onStepStarted(data);
        return;
      case 'session.step.ended':
        this.withTurn((turn) => this.onStepEnded(turn, data));
        return;
      case 'session.step.failed':
        return;
      case 'session.text.delta':
      case 'session.reasoning.delta':
        this.withTurn((turn) =>
          this.onDelta(
            turn,
            data,
            event.type === 'session.text.delta' ? 'text' : 'reasoning',
          ),
        );
        return;
      case 'session.text.ended':
      case 'session.reasoning.ended':
        this.withTurn((turn) =>
          this.onPartEnded(
            turn,
            data,
            event.type === 'session.text.ended' ? 'text' : 'reasoning',
          ),
        );
        return;
      case 'session.tool.input.started': {
        const callId = readString(data.id);
        const name = readString(data.name);
        if (callId && name) this.toolNames.set(callId, name);
        return;
      }
      case 'session.text.started':
      case 'session.reasoning.started':
        this.withTurn((turn) => {
          const key = this.partKey(data);
          if (key && !this.parts.has(key))
            this.parts.set(key, {
              turnId: turn.turnId,
              kind:
                event.type === 'session.text.started' ? 'text' : 'reasoning',
              streamed: '',
              open: true,
              gapped: false,
            });
        });
        return;
      case 'session.tool.called':
        this.withTurn((turn) => this.onToolCalled(turn, data));
        return;
      case 'session.tool.progress':
        this.withTurn((turn) => this.onToolProgress(turn, data));
        return;
      case 'session.tool.success':
      case 'session.tool.failed':
        this.withTurn((turn) =>
          this.onToolEnded(turn, data, event.type === 'session.tool.success'),
        );
        return;
      case 'permission.asked':
        this.onPermissionAsked(data);
        return;
      case 'permission.replied':
        this.onRequestSettled(readString(data.requestID), data.reply);
        return;
      case 'form.created':
        this.onFormCreated(data.form);
        return;
      case 'form.replied':
        this.onRequestSettled(readString(data.id), 'answered');
        return;
      case 'form.cancelled':
        this.onRequestSettled(readString(data.id), 'cancelled');
        return;
      case 'session.retry.scheduled':
        this.emit({
          method: 'runtime.warning',
          severity: 'warning',
          message: `${this.deps.engineName} is retrying the model request.`,
          ...this.turnRef(),
        });
        return;
      case 'session.compaction.started':
        return;
      case 'session.compaction.ended':
        this.emit({
          method: 'runtime.warning',
          severity: 'warning',
          message: `${this.deps.engineName} compacted the conversation.`,
          ...this.turnRef(),
        });
        return;
      case 'session.compaction.failed':
        this.emit({
          method: 'runtime.warning',
          severity: 'warning',
          message: `${this.deps.engineName} could not compact the conversation: ${openCodeToolError(data.error)}`,
          ...this.turnRef(),
        });
        return;
      case 'session.revert.committed':
        return;
      case 'session.agent.selected':
      case 'session.model.selected':
        this.onConfigured(data);
        return;
      default:
        if (!OPENCODE_IGNORED_EVENTS.has(event.type)) this.countUnknown(event);
    }
  }

  private countUnknown(event: OpenCodeServeEvent): void {
    this.unknownEvents.set(
      event.type,
      (this.unknownEvents.get(event.type) ?? 0) + 1,
    );
  }

  /** Another session's event: a child's lifecycle and asks, nothing else. */
  private handleForeign(
    type: string,
    data: Record<string, unknown>,
    sessionId: string,
  ): void {
    if (type === 'session.created') {
      if (readString(data.parentID) !== this.sessionId) return;
      const child: ChildSession = {
        childId: sessionId,
        ...(readString(data.title) ? { title: data.title as string } : {}),
        ...(readString(data.agent) ? { agent: data.agent as string } : {}),
        running: false,
      };
      this.children.set(sessionId, child);
      return;
    }
    const child = this.children.get(sessionId);
    if (!child) return;
    switch (type) {
      case 'session.execution.started':
        child.running = true;
        child.item = {
          producer: 'engine-subagent',
          reporterThreadId: this.deps.threadId,
          childId: child.childId,
          status: 'running',
          workKind: 'agent',
          ...(child.title ? { title: child.title } : {}),
          ...(child.agent ? { kindLabel: child.agent } : {}),
          parent: {
            threadId: this.deps.threadId,
            ...(this.activeTurnId ? { turnId: this.activeTurnId } : {}),
          },
          startedAt: this.nowIso(),
        };
        // The session's complete running set: this adapter sees every child
        // OpenCode creates under it, so the snapshot is authoritative (a
        // child it no longer lists without a settle reads `unresolved`).
        this.emit({
          method: 'child-work.updated',
          ...this.turnRef(),
          delta: {
            kind: 'snapshot',
            producer: 'engine-subagent',
            reporterThreadId: this.deps.threadId,
            running: [...this.children.values()].flatMap((entry) =>
              entry.running && entry.item ? [entry.item] : [],
            ),
          },
        });
        return;
      case 'session.execution.succeeded':
        this.settleChild(child, 'completed');
        return;
      case 'session.execution.failed':
        this.settleChild(child, 'failed');
        return;
      case 'session.execution.interrupted':
        this.settleChild(child, 'cancelled');
        return;
      case 'permission.asked':
        this.onPermissionAsked(data);
        return;
      case 'permission.replied':
        this.onRequestSettled(readString(data.requestID), data.reply);
        return;
      case 'form.created':
        this.onFormCreated(data.form);
        return;
      case 'form.replied':
        this.onRequestSettled(readString(data.id), 'answered');
        return;
      case 'form.cancelled':
        this.onRequestSettled(readString(data.id), 'cancelled');
        return;
    }
  }

  private settleChild(
    child: ChildSession,
    status: 'completed' | 'failed' | 'cancelled' | 'unresolved',
  ): void {
    if (!child.running) return;
    child.running = false;
    for (const pending of [...this.requests.values()]) {
      if (pending.sessionId === child.childId) this.closeRequest(pending);
    }
    this.emit({
      method: 'child-work.updated',
      delta: {
        kind: 'settle',
        producer: 'engine-subagent',
        reporterThreadId: this.deps.threadId,
        childId: child.childId,
        status,
        ...(status === 'unresolved' ? { endedBy: 'engine-exit' as const } : {}),
      },
    });
  }

  private onExecutionStarted(createdMs: number | undefined): void {
    const start = (turn: NativeTurn) => {
      turn.executing = true;
      if (!turn.messageId && createdMs !== undefined) turn.sinceMs = createdMs;
    };
    const pending = this.pendingStart;
    if (pending && !pending.settled) {
      this.pendingStart = undefined;
      start(pending);
      this.turn = pending;
      return;
    }
    if (this.turn && !this.turn.settled) {
      start(this.turn);
      return;
    }
    // The engine's own execution: published when it shows something.
    const turn = this.createTurn(crypto.randomUUID(), 'provider');
    start(turn);
    this.turn = turn;
  }

  private onExecutionEnded(settle: (turn: NativeTurn) => void): void {
    // OpenCode drops this session's pending asks with its execution and
    // says nothing of them (no `permission.replied` after an interrupt or a
    // failure): they close here, whatever the outcome.
    for (const pending of [...this.requests.values()]) {
      if (pending.sessionId === this.sessionId) this.closeRequest(pending);
    }
    const turn = this.turn;
    if (!turn || turn.settled) return;
    for (const [inboxId, steer] of this.steers) {
      if (steer.turnId === turn.turnId) void this.withdrawSteer(inboxId);
    }
    this.closeOpenTools(turn);
    if (turn.kind === 'provider' && !turn.startPublished) {
      // Nothing to show: no turn.
      turn.settled = true;
      turn.resolveDone();
      this.turn = undefined;
      return;
    }
    settle(turn);
  }

  /** A steer the execution ended before reading: take it back out of the inbox. */
  private async withdrawSteer(inboxId: string): Promise<void> {
    const steer = this.steers.get(inboxId);
    if (!steer) return;
    this.steers.delete(inboxId);
    steer.withdrawn = true;
    // Still in flight: `steer` deletes the item once its prompt lands, before
    // it reports the refusal.
    if (!steer.posting) await this.deleteInboxItem(inboxId);
    steer.reject(new ProviderTurnEndedError());
  }

  private async deleteInboxItem(inboxId: string): Promise<void> {
    await this.deps.client
      .request('DELETE', `/api/session/${this.sessionId}/inbox/${inboxId}`)
      .catch(() => undefined);
  }

  private onSteerDelivered(inboxId: string): void {
    const steer = this.steers.get(inboxId);
    if (!steer) return;
    this.steers.delete(inboxId);
    this.emit({
      method: 'turn.started',
      turnId: steer.turnId,
      prompt: steer.text,
      inputKind: 'steer',
    });
    steer.resolve();
  }

  private onStepStarted(data: Record<string, unknown>): void {
    this.onConfigured(data);
  }

  private onConfigured(data: Record<string, unknown>): void {
    const model = ownRecord(data.model);
    const modelId =
      readString(model?.id) && readString(model?.providerID)
        ? `${model?.providerID as string}/${model?.id as string}`
        : undefined;
    const agent = readString(data.agent);
    if (
      (modelId === undefined || modelId === this.lastModel) &&
      (agent === undefined || agent === this.lastAgent)
    )
      return;
    this.lastModel = modelId ?? this.lastModel;
    this.lastAgent = agent ?? this.lastAgent;
    this.emit({
      method: 'session.configured',
      sessionId: this.deps.threadId,
      ...(this.lastModel ? { model: this.lastModel } : {}),
      ...(this.lastAgent ? { metadata: { mode: this.lastAgent } } : {}),
    });
  }

  private onStepEnded(turn: NativeTurn, data: Record<string, unknown>): void {
    const usage = openCodeStepUsage(data);
    if (!usage) return;
    this.publishForTurn(turn, {
      method: 'token-usage.updated',
      turnId: turn.turnId,
      ...usage,
    });
  }

  private partKey(data: Record<string, unknown>): string | undefined {
    const messageId = readString(data.assistantMessageID);
    const ordinal = data.ordinal;
    return messageId && typeof ordinal === 'number'
      ? `${messageId}:${ordinal}`
      : undefined;
  }

  private onDelta(
    turn: NativeTurn,
    data: Record<string, unknown>,
    kind: 'text' | 'reasoning',
  ): void {
    const key = this.partKey(data);
    const delta = typeof data.delta === 'string' ? data.delta : '';
    if (!key || !delta) return;
    let part = this.parts.get(key);
    if (!part) {
      // A delta for a part whose start Station saw is the first; one it did
      // not see (it began during a gap) cannot be continued from deltas.
      part = {
        turnId: turn.turnId,
        kind,
        streamed: '',
        open: true,
        gapped: this.connections > 1,
      };
      this.parts.set(key, part);
    }
    if (part.gapped || !part.open) return;
    if (kind === 'text') this.appendText(turn, key, delta);
    else {
      part.streamed += delta;
      this.publishForTurn(turn, {
        method: 'content.reasoning-delta',
        turnId: turn.turnId,
        itemId: `reasoning:${key}`,
        delta,
      });
    }
  }

  private onPartEnded(
    turn: NativeTurn,
    data: Record<string, unknown>,
    kind: 'text' | 'reasoning',
  ): void {
    const key = this.partKey(data);
    if (!key) return;
    const part = this.parts.get(key);
    const full = typeof data.text === 'string' ? data.text : undefined;
    if (part) part.open = false;
    if (kind !== 'text' || full === undefined) return;
    const streamed = part?.streamed ?? '';
    if (full.length > streamed.length && full.startsWith(streamed)) {
      if (!part)
        this.parts.set(key, {
          turnId: turn.turnId,
          kind,
          streamed: '',
          open: false,
          gapped: false,
        });
      this.appendText(turn, key, full.slice(streamed.length));
    }
    const settled = this.parts.get(key);
    if (settled) settled.gapped = false;
  }

  private appendText(turn: NativeTurn, key: string, delta: string): void {
    const part = this.parts.get(key);
    if (part) part.streamed += delta;
    turn.outputText += delta;
    this.publishForTurn(turn, {
      method: 'content.text-delta',
      turnId: turn.turnId,
      itemId: `text:${key}`,
      delta,
    });
  }

  private onToolCalled(turn: NativeTurn, data: Record<string, unknown>): void {
    const callId = readString(data.id);
    if (!callId || turn.openTools.has(callId)) return;
    const name = this.toolName(data) ?? 'tool';
    turn.openTools.set(callId, name);
    this.publishForTurn(turn, {
      method: 'tool.started',
      turnId: turn.turnId,
      itemId: `tool:${callId}`,
      toolCallId: callId,
      toolName: name,
      ...(data.input !== undefined
        ? { arguments: projectBoundedToolOutput(data.input).value }
        : {}),
    });
  }

  /** The tool's name, from its `input.started` (remembered) or the call. */
  private readonly toolNames = new Map<string, string>();
  private toolName(data: Record<string, unknown>): string | undefined {
    const callId = readString(data.id);
    return (
      readString(data.name) ?? (callId ? this.toolNames.get(callId) : undefined)
    );
  }

  private onToolProgress(
    turn: NativeTurn,
    data: Record<string, unknown>,
  ): void {
    const callId = readString(data.id);
    if (!callId) return;
    if (!turn.openTools.has(callId)) this.onToolCalled(turn, data);
    const metadata = ownRecord(data.metadata);
    const status = readString(metadata?.status);
    this.publishForTurn(turn, {
      method: 'tool.progress',
      turnId: turn.turnId,
      itemId: `tool:${callId}`,
      toolCallId: callId,
      message: status ?? 'running',
    });
  }

  private onToolEnded(
    turn: NativeTurn,
    data: Record<string, unknown>,
    success: boolean,
  ): void {
    const callId = readString(data.id);
    if (!callId) return;
    if (!turn.openTools.has(callId)) this.onToolCalled(turn, data);
    const name = turn.openTools.get(callId) ?? 'tool';
    turn.openTools.delete(callId);
    const output = success
      ? openCodeToolOutput(data.content, data.metadata)
      : undefined;
    const preview =
      output === undefined ? undefined : projectBoundedToolOutput(output);
    this.publishForTurn(turn, {
      method: 'tool.completed',
      turnId: turn.turnId,
      itemId: `tool:${callId}`,
      toolCallId: callId,
      toolName: name,
      status: success ? 'success' : 'error',
      ...(preview ? { output: preview.value } : {}),
      ...(preview?.receipt ? { outputReceipt: preview.receipt } : {}),
      ...(success ? {} : { error: openCodeToolError(data.error) }),
    });
  }

  private onPermissionAsked(data: Record<string, unknown>): void {
    const nativeId = readString(data.id);
    const sessionId = readString(data.sessionID);
    const action = readString(data.action);
    if (
      !nativeId ||
      !sessionId ||
      !action ||
      this.requests.has(nativeId) ||
      this.autoAnswering.has(nativeId)
    )
      return;
    const resources = (ownArray(data.resources) ?? []).filter(
      (item): item is string => typeof item === 'string',
    );
    const ask: NativeAsk = {
      nativeId,
      sessionId,
      action,
      resources,
      save: (ownArray(data.save) ?? []).filter(
        (item): item is string => typeof item === 'string',
      ),
      toolCallId: readString(ownRecord(data.source)?.id),
    };
    if (sessionId === this.sessionId) {
      this.decideAsk(ask, this.deps.agentRules);
      return;
    }
    // A child session inherits this one's rules (and so its asks) but runs
    // its own agent: Station keeps that agent's denies, read before the
    // ask is decided. Without them a governed child's ask is a person's.
    if (!this.deps.agentRules) {
      this.decideAsk(ask, undefined);
      return;
    }
    const agent = this.children.get(sessionId)?.agent;
    const lookup =
      agent && this.deps.agentRulesFor
        ? this.childAgentRules(agent)
        : Promise.resolve(undefined);
    this.autoAnswering.add(nativeId);
    void lookup.then((rules) => {
      this.autoAnswering.delete(nativeId);
      if (this.stopped || this.requests.has(nativeId)) return;
      if (rules) this.decideAsk(ask, rules);
      else this.openPermission(ask);
    });
  }

  /** A child agent's rules, read once per agent name; undefined if unreadable. */
  private childAgentRules(
    agent: string,
  ): Promise<readonly OpenCodeNativeRule[] | undefined> {
    let found = this.childRules.get(agent);
    if (!found) {
      found = (
        this.deps.agentRulesFor?.(agent) ?? Promise.resolve(undefined)
      ).catch(() => undefined);
      this.childRules.set(agent, found);
      // A failed read is asked again for the next ask.
      void found.then((rules) => {
        if (!rules) this.childRules.delete(agent);
      });
    }
    return found;
  }

  /**
   * Answer an ask without a person where Station may (a kept deny, a
   * session grant, the mode), else open it for the person. An OpenCode
   * configuration edit is never answered by a grant or a mode below full
   * access (`openCodeNativeAskNeedsPerson`).
   */
  private decideAsk(
    ask: NativeAsk,
    agentRules: readonly OpenCodeNativeRule[] | undefined,
  ): void {
    const request = { action: ask.action, resources: ask.resources };
    const answer = openCodeNativeAskAnswer({
      mode: this.deps.approvalMode,
      agentRules,
      request,
      granted: this.grants.some((grant) => openCodeGrantCovers(grant, request)),
      configNeedsPerson: () =>
        openCodeNativeAskNeedsPerson(
          request,
          this.deps.cwd,
          this.deps.configEnv,
        ),
    });
    if (answer === 'person') {
      this.openPermission(ask);
      return;
    }
    this.autoAnswering.add(ask.nativeId);
    void this.deps.client
      .request(
        'POST',
        `/api/session/${ask.sessionId}/permission/${ask.nativeId}/reply`,
        { decision: answer },
      )
      .then(
        () => {
          this.autoAnswering.delete(ask.nativeId);
        },
        (error: unknown) => {
          this.autoAnswering.delete(ask.nativeId);
          // Gone already (its execution ended): nothing waits on it.
          if (error instanceof OpenCodeServeHttpError && error.status === 404)
            return;
          if (this.stopped || this.requests.has(ask.nativeId)) return;
          // Still pending in OpenCode, and nobody would see it: the person
          // answers it instead.
          this.openPermission(ask, {
            autoAnswerFailed: `Station could not ${answer === 'reject' ? 'reject' : 'allow'} this automatically: ${errorMessage(error)}`,
          });
        },
      );
  }

  /** Show an ask to the person as an approval request. */
  private openPermission(
    ask: NativeAsk,
    note: { autoAnswerFailed?: string } = {},
  ): void {
    const { nativeId, sessionId, action, resources, save } = ask;
    const own = sessionId === this.sessionId;
    const turnId = own ? this.activeTurnId : undefined;
    const pending: PendingRequest = {
      kind: 'permission',
      nativeId,
      eventId: crypto.randomUUID(),
      sessionId,
      action,
      ...(save.length > 0 || resources.length > 0
        ? { patterns: save.length > 0 ? save : resources }
        : {}),
      ...(turnId ? { turnId } : {}),
    };
    this.requests.set(nativeId, pending);
    const toolCallId = ask.toolCallId;
    const asked =
      resources.length > 0
        ? `${own ? this.deps.engineName : `A ${this.deps.engineName} subagent`} asks to ${action}: ${resources.join(', ').slice(0, 500)}`
        : undefined;
    const description = [asked, note.autoAnswerFailed]
      .filter((part): part is string => part !== undefined)
      .join(' ');
    const show = () =>
      this.emit({
        eventId: pending.eventId,
        ...(turnId ? { turnId } : {}),
        requestId: nativeId,
        method: 'request.opened',
        requestType: 'approval',
        title: `Allow ${action}`,
        ...(description ? { description } : {}),
        payload: {
          toolName: action,
          ...(toolCallId ? { toolCallId } : {}),
          rawInput: { action, resources },
          ...(action === 'edit' ? { toolKind: 'edit' } : {}),
          ...(own
            ? {}
            : {
                childWork: {
                  producer: 'engine-subagent',
                  reporterThreadId: this.deps.threadId,
                  childId: sessionId,
                },
              }),
        },
      });
    const turn = this.turn;
    if (own && turn && turn.turnId === turnId)
      this.publishForTurnFrame(turn, show);
    else show();
  }

  private onFormCreated(info: unknown): void {
    const form = ownRecord(info);
    const nativeId = readString(form?.id);
    const sessionId = readString(form?.sessionID);
    if (!form || !nativeId || !sessionId || this.requests.has(nativeId)) return;
    const mapped = openCodeFormRequest(form, this.deps.engineName);
    if (!mapped) {
      // Station cannot show it faithfully: decline it rather than guess.
      void this.deps.client
        .request('DELETE', `/api/session/${sessionId}/form/${nativeId}`)
        .catch(() => undefined);
      this.emit({
        method: 'runtime.warning',
        severity: 'warning',
        message: `${this.deps.engineName} asked a question Station cannot show, so it was cancelled.`,
        ...this.turnRef(),
      });
      return;
    }
    const own = sessionId === this.sessionId;
    const turnId = own ? this.activeTurnId : undefined;
    const pending: PendingRequest = {
      kind: 'form',
      nativeId,
      eventId: crypto.randomUUID(),
      sessionId,
      form: mapped.form,
      ...(turnId ? { turnId } : {}),
    };
    this.requests.set(nativeId, pending);
    const show = () =>
      this.emit({
        eventId: pending.eventId,
        ...(turnId ? { turnId } : {}),
        requestId: nativeId,
        method: 'request.opened',
        requestType: 'approval',
        title: mapped.form.message,
        payload: {
          inputRequest: mapped.form,
          ...(own
            ? {}
            : {
                childWork: {
                  producer: 'engine-subagent',
                  reporterThreadId: this.deps.threadId,
                  childId: sessionId,
                },
              }),
        },
      });
    const turn = this.turn;
    if (own && turn && turn.turnId === turnId)
      this.publishForTurnFrame(turn, show);
    else show();
  }

  /** The engine closed a request: Station's answer, or another client's. */
  private onRequestSettled(nativeId: string | undefined, reply: unknown): void {
    const pending = nativeId ? this.requests.get(nativeId) : undefined;
    if (!pending) return;
    this.requests.delete(pending.nativeId);
    const status: ApprovalStatus =
      reply === 'once' || reply === 'always' || reply === 'answered'
        ? 'approved'
        : reply === 'cancelled' && pending.decided !== 'decline'
          ? 'cancelled'
          : 'denied';
    this.publishResolved(pending, status);
  }

  private publishResolved(
    pending: PendingRequest,
    status: ApprovalStatus,
  ): void {
    this.emit({
      ...(pending.turnId ? { turnId: pending.turnId } : {}),
      requestId: pending.nativeId,
      method: 'request.resolved',
      status,
      acknowledgement: 'engine',
    });
  }

  private refreshMcp(): Promise<void> {
    this.mcpRefresh ??= (async () => {
      try {
        const answer = await this.deps.client.request<{ data?: unknown }>(
          'GET',
          '/api/mcp',
        );
        this.emit({
          method: 'engine-mcp.status',
          servers: openCodeMcpStatus(answer?.data),
          complete: true,
          // Every server can be restarted (`reconnectMcp`), so a surface
          // offers the action.
          reconnect: true,
        });
      } catch {
        // Status is informational; the next change asks again.
      } finally {
        this.mcpRefresh = undefined;
      }
    })();
    return this.mcpRefresh;
  }

  // --- Turn bookkeeping -------------------------------------------------

  private createTurn(
    turnId: string,
    kind: NativeTurn['kind'],
    invocationId?: string,
  ): NativeTurn {
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    return {
      turnId,
      kind,
      ...(invocationId ? { invocationId } : {}),
      executing: false,
      startPublished: false,
      buffered: [],
      settled: false,
      stopRequested: false,
      outputText: '',
      openTools: new Map(),
      done,
      resolveDone,
    };
  }

  /** The turn's message, once the engine has it, is a rewind point. */
  private recordRewindPoint(turn: NativeTurn): void {
    const messageId = turn.messageId;
    if (!messageId) return;
    this.turnMessages.push({ turnId: turn.turnId, messageId });
    if (this.turnMessages.length > TURN_MESSAGES_MAX) this.turnMessages.shift();
  }

  /** A request closed unanswered: resolved cancelled, a late answer refused. */
  private closeRequest(pending: PendingRequest): void {
    if (this.requests.get(pending.nativeId) !== pending) return;
    this.requests.delete(pending.nativeId);
    this.closedRequests.add(pending.nativeId);
    if (this.closedRequests.size > CLOSED_REQUESTS_MAX) {
      const oldest = this.closedRequests.values().next().value;
      if (oldest !== undefined) this.closedRequests.delete(oldest);
    }
    this.publishResolved(pending, 'cancelled');
  }

  private turnById(turnId: string): NativeTurn | undefined {
    if (this.turn?.turnId === turnId) return this.turn;
    if (this.pendingStart?.turnId === turnId) return this.pendingStart;
    return undefined;
  }

  /** The turn an execution event belongs to, or nothing when none runs. */
  private withTurn(apply: (turn: NativeTurn) => void): void {
    const turn = this.turn;
    if (!turn || turn.settled) return;
    apply(turn);
  }

  private publishStart(
    turn: NativeTurn,
    extra: { prompt?: string; metadata?: Record<string, unknown> },
  ): void {
    if (turn.startPublished) return;
    turn.startPublished = true;
    this.emit({
      method: 'turn.started',
      turnId: turn.turnId,
      ...(turn.invocationId ? { invocationId: turn.invocationId } : {}),
      ...(extra.prompt !== undefined ? { prompt: extra.prompt } : {}),
      ...(turn.kind === 'provider'
        ? { metadata: { trigger: PROVIDER_TURN_TRIGGER } }
        : extra.metadata
          ? { metadata: extra.metadata }
          : {}),
    });
    for (const frame of turn.buffered.splice(0)) frame();
  }

  private publishForTurn(turn: NativeTurn, event: EventBody): void {
    this.publishForTurnFrame(turn, () => this.emit(event));
  }

  /**
   * Run `frame` once the turn's start is published: a Station turn's events
   * can arrive before its prompt's answer, and a provider turn starts only
   * when it shows something.
   */
  private publishForTurnFrame(turn: NativeTurn, frame: () => void): void {
    if (turn.startPublished) {
      frame();
      return;
    }
    if (turn.kind === 'provider') {
      this.publishStart(turn, {});
      frame();
      return;
    }
    turn.buffered.push(frame);
  }

  private closeOpenTools(turn: NativeTurn): void {
    for (const [callId, toolName] of turn.openTools) {
      this.publishForTurn(turn, {
        method: 'tool.completed',
        turnId: turn.turnId,
        itemId: `tool:${callId}`,
        toolCallId: callId,
        toolName,
        status: 'unresolved',
        output: UNRESOLVED_TOOL_OUTPUT,
      });
    }
    turn.openTools.clear();
  }

  private settleFailed(turn: NativeTurn, error: unknown): void {
    const detail = readString(ownRecord(error)?.message);
    this.settle(turn, {
      method: 'runtime.error',
      message: `The ${this.deps.engineName} turn failed${detail ? `: ${redactSecrets(detail).slice(0, 1000)}` : '.'}`,
    });
  }

  private settleInterrupted(turn: NativeTurn): void {
    if (turn.stopRequested)
      this.settle(turn, { method: 'turn.aborted', reason: 'interrupted' });
    else
      this.settle(turn, {
        method: 'turn.completed',
        finishReason: 'cancelled',
      });
  }

  private settle(
    turn: NativeTurn,
    outcome:
      | {
          method: 'turn.completed';
          finishReason: 'stop' | 'cancelled' | 'other';
        }
      | { method: 'turn.aborted'; reason: string }
      | { method: 'runtime.error'; message: string },
  ): void {
    if (turn.settled) return;
    if (!turn.startPublished) this.publishStart(turn, {});
    turn.settled = true;
    const metadata =
      turn.kind === 'provider'
        ? { metadata: { trigger: PROVIDER_TURN_TRIGGER } }
        : {};
    const base = {
      turnId: turn.turnId,
      ...(turn.invocationId ? { invocationId: turn.invocationId } : {}),
      ...metadata,
    };
    if (outcome.method === 'turn.completed')
      this.emit({
        ...base,
        method: 'turn.completed',
        finishReason: outcome.finishReason,
        ...(turn.outputText ? { outputText: turn.outputText } : {}),
      });
    else if (outcome.method === 'turn.aborted')
      this.emit({ ...base, method: 'turn.aborted', reason: outcome.reason });
    else
      this.emit({
        ...base,
        method: 'runtime.error',
        ...providerFailure('provider_error'),
        severity: 'error',
        code: ENGINE_TURN_FAILED_CODE,
        message: outcome.message,
      });
    for (const [key, part] of this.parts) {
      if (part.turnId === turn.turnId) this.parts.delete(key);
    }
    if (this.turn === turn) this.turn = undefined;
    if (this.pendingStart === turn) this.pendingStart = undefined;
    turn.resolveDone();
  }

  private turnRef(): { turnId?: string } {
    const turnId = this.activeTurnId;
    return turnId ? { turnId } : {};
  }

  private nowIso(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  private emit(event: EventBody & { eventId?: string }): void {
    this.deps.publish({
      eventId: crypto.randomUUID(),
      provider: this.deps.provider,
      threadId: this.deps.threadId,
      createdAt: this.nowIso(),
      ...event,
    } as CanonicalRuntimeEvent);
  }
}
