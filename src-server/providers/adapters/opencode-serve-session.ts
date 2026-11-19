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
import { isAbsolute } from 'node:path';
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
  type ProviderRuntimeErrorBody,
} from '@kontourai/station-contracts/runtime-events';
import {
  ownArray,
  ownRecord,
  validateInputRequestContent,
} from '@kontourai/station-shared/input-request';
import { redactSecrets } from '@kontourai/station-shared/redaction';
import { toolRequestNeedsPerson } from '@kontourai/station-shared/tool-request-preview';
import {
  delegatedApprovalDenial,
  type PreToolPolicyDecision,
} from '../../runtime/agents/pre-tool-policy.js';
import {
  type OpenCodeNativeRule,
  openCodeGrantCovers,
  openCodeNativeAskAnswer,
  openCodeNativePersistenceTarget,
  openCodeNativeStationRejects,
} from '../../services/acp/opencode-approval-native.js';
import {
  openCodeNativeAskNeedsPerson,
  realish,
} from '../../services/acp/opencode-project-config.js';
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
  openCodePartKey,
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
/** Tools kept for the asks they may make (see `noteAskTool`). */
const ASK_TOOLS_MAX = 512;
const askToolKey = (sessionId: string, callId: string) =>
  `${sessionId}\u0000${callId}`;
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
/** Descendant sessions a reconnect looks up, at most (`GET /api/session?parentID=`). */
const DESCENDANTS_MAX = 200;
/** Descendant lookups a reconnect has in flight at once. */
const DESCENDANT_LOOKUPS_PARALLEL = 4;
/**
 * How long a turn Station stopped because OpenCode would not take a
 * rejection waits for OpenCode to confirm its execution ended, refusing a
 * next turn meanwhile (a prompt sent into the dying execution would be
 * delivered to it).
 */
const FAIL_CLOSE_SETTLE_MS = 3_000;
/**
 * Refused asks remembered (so a re-list never reopens one): past the first
 * bound the oldest OpenCode no longer holds is forgotten; one it may still
 * hold never is, and past the second bound the session is stopped instead.
 */
const REFUSED_ASKS_EVICT_ABOVE = CLOSED_REQUESTS_MAX;
const REFUSED_ASKS_STOP_ABOVE = 1_000;

/**
 * The warning a session stopped because it could no longer remember every
 * ask it refused that OpenCode may still hold carries.
 */
export const OPENCODE_REFUSED_ASKS_OVERFLOW = 'OPENCODE_REFUSED_ASKS_OVERFLOW';

/**
 * The permission actions a 2.3.0 tool asks for other than its own name
 * (`core/src/tool/plugin/*.ts`, `core/src/file-access.ts`). A tool asks for
 * its own name (shell, glob, grep, webfetch, websearch, subagent, skill,
 * todowrite, question; an MCP tool's `<server>_<tool>` is both its name and
 * its action, `core/src/tool/mcp.ts`); a file-touching tool also asks
 * `external_directory` (`FileAccess.authorizeExternal`), a file change
 * `edit`, a read of a skill `skill`, and image generation `webfetch`. Code
 * Mode's session move asks `external_directory` for a destination outside
 * the project's worktrees, and its worktree removal asks `edit` (only:
 * it asserts the permission itself, `tool/plugin/opencode.ts`).
 */
const OPENCODE_TOOL_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  shell: ['external_directory'],
  read: ['external_directory', 'skill'],
  glob: ['external_directory'],
  grep: ['external_directory'],
  edit: ['edit', 'external_directory'],
  write: ['edit', 'external_directory'],
  patch: ['edit', 'external_directory'],
  experimental_image_generate: ['webfetch', 'external_directory'],
  opencode_session_move: ['external_directory'],
  opencode_worktree_remove: ['edit'],
};

/**
 * Whether an ask for `action` can come from the tool `toolName` (OpenCode's
 * name for it), so the ask may be decided as that tool's. Anything else is
 * a tool Station cannot name for the ask, whose ask goes to the person.
 */
export function openCodeAskFitsTool(toolName: string, action: string): boolean {
  if (action === toolName) return true;
  return Object.hasOwn(OPENCODE_TOOL_ACTIONS, toolName)
    ? (OPENCODE_TOOL_ACTIONS[toolName] as readonly string[]).includes(action)
    : false;
}

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
function newOpenCodeMessageId(timestamp = Date.now()): string {
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
  steerCustody?: { begin(id: string): void; complete(id: string): void };
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
   * The session's directory (OpenCode names a write inside it relative to
   * it), for the configuration-edit guard (`openCodeNativeAskNeedsPerson`):
   * where it was created, then wherever `session.moved` says it went.
   */
  cwd: string;
  /**
   * The directory the server was launched in: the location its server-wide
   * lists of pending asks and forms (`/api/permission/request`,
   * `/api/form`) are read from. Defaults to {@link cwd} at start.
   */
  readonly serverDirectory?: string;
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
  /**
   * #4828: whether this conversation, or one that delegated to it, has read
   * untrusted content (the ledger the ACP path asks). Then an ask to change
   * a known agent-instruction or git-hook file is rejected, before any
   * grant, mode or person (`openCodeNativePersistenceTarget`).
   */
  readonly untrustedRead?: () => Promise<boolean>;
  /**
   * Station's staged pre-tool policy for a session started as an Agent
   * (the evaluator the ACP adapter runs in `requestPermission`), bound to
   * this session's Agent, conversation and delegation. Asked about every
   * ask, this session's or a descendant's, whose tool OpenCode named, as
   * OpenCode's own ACP layer names it (`toolCall.name`: the tool part's
   * name); see {@link OpenCodeNativeSession.decideAsk}.
   */
  /**
   * A delegated session whose delegation may not grant approvals
   * (`delegation.denyApprovals`): nobody can answer its asks or questions,
   * so one that would go to a person is declined at once, as the ACP
   * adapter declines it (`requestPermission`, `askPersonFor`).
   */
  readonly denyApprovals?: boolean;
  readonly preToolPolicy?: (
    tool: {
      readonly toolName: string;
      readonly toolCallId: string;
      readonly toolArgs: unknown;
    },
    /** The session runs at full access (`approvalMode: 'never'`). */
    fullAccess?: boolean,
  ) => Promise<PreToolPolicyDecision>;
  /**
   * This session, or one of its descendants, moved to another directory
   * (`session.moved`). OpenCode has loaded that directory's configuration
   * by then; the adapter decides whether the session may go on.
   */
  readonly onMoved?: (move: {
    readonly sessionId: string;
    readonly directory: string;
  }) => void;
  readonly now?: () => Date;
  readonly reconnectFirstMs?: number;
  readonly heartbeatTimeoutMs?: number;
  /** Tests: {@link FAIL_CLOSE_SETTLE_MS}. */
  readonly failCloseSettleMs?: number;
  /** Tests: {@link REFUSED_ASKS_EVICT_ABOVE} and {@link REFUSED_ASKS_STOP_ABOVE}. */
  readonly refusedAsksBounds?: { evictAbove: number; stopAbove: number };
  /**
   * The session can no longer be governed and must stop (after a
   * `runtime.warning` saying why): the adapter stops it as a person would.
   * Without one it stops itself.
   */
  readonly onMustStop?: () => void;
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
  /**
   * Stopped because OpenCode would not take a rejection ({@link
   * OpenCodeNativeSession.failClosed}): the turn ends with this error, once
   * OpenCode confirms its execution ended or the wait for that runs out.
   */
  failClose?: FailClose;
  /** Its prompt's POST has settled (a turn `sendTurn` began). */
  posted?: Promise<void>;
  /**
   * An earlier turn's prompt still to be stopped if it starts, set aside
   * when OpenCode took this turn's: if this turn's own prompt is then taken
   * back, that earlier prompt is again the one a start would be.
   */
  displacedUnwithdrawn?: { readonly turnId: string };
  outputText: string;
  stepModel?: Extract<
    EventBody,
    { method: 'token-usage.updated' }
  >['servedModelObservation'];
  readonly openTools: Map<string, string>;
  readonly done: Promise<void>;
  resolveDone(): void;
}

interface FailClose {
  /** What Station had to reject, and what OpenCode answered (the first refusal's). */
  readonly reason: string;
  /** OpenCode reported this session's execution ended. */
  confirmed: boolean;
  /** Why an interrupt of this session Station sent failed, if one did. */
  interruptFailed?: string;
  /** Why the interrupt of an asking descendant failed, by its session. */
  readonly subagentInterruptFailed: Map<string, string>;
  /**
   * Nothing ran the turn yet, so its prompt was taken back out of the inbox
   * instead: `failed` says why that did not work, if it did not.
   */
  withdrawal?: { failed?: string };
  timer?: ReturnType<typeof setTimeout>;
}

/** An ask Station refused that OpenCode would not take. */
interface RefusedAsk {
  /** The OpenCode session that asked (this one, or a descendant). */
  readonly sessionId: string;
  /**
   * OpenCode may still hold it: its session's execution has not been seen
   * to end, so stopping the session rejects it again and interrupts.
   */
  held: boolean;
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
  delivered?: boolean;
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
  /** The message of the tool call that asked (`source.messageID`). */
  readonly messageId: string | undefined;
  /** The files an edit ask names in its metadata (`metadata.files[].file`). */
  readonly files: readonly string[];
  /** The ask's own metadata, the tool's arguments when its input is not known. */
  readonly metadata: unknown;
  /** The turn live when it arrived, if one was. */
  readonly turnId: string | undefined;
  /**
   * How many times its session's execution had been seen to end when it
   * arrived ({@link OpenCodeNativeSession.releaseRefusedAsks}): one more
   * since, and OpenCode no longer holds it.
   */
  readonly releases: number;
}

interface SessionGrant {
  readonly action: string;
  readonly patterns: readonly string[];
}

/**
 * A descendant session: a child (`parentID` this session) or a child's own
 * child, at any depth (2.3.0 allows it when `experimental.subagent_depth`
 * is raised). Each is reported as this session's child work.
 */
interface ChildSession {
  readonly childId: string;
  readonly parentId: string;
  /** Its directory, once known (`session.created`, `session.moved`). */
  directory?: string;
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
  /**
   * A turn stopped before anything ran it whose prompt Station could not
   * take back (a command has no inbox item; or the withdrawal failed): if
   * OpenCode starts an execution while no turn is live, before it takes a
   * next prompt or compaction of Station's, that execution is interrupted.
   * The start is not matched to the prompt: a command has no id to match.
   */
  private unwithdrawn: { readonly turnId: string } | undefined;
  /** Asks Station is deciding or answering itself, by the session that asked. */
  private readonly autoAnswering = new Map<string, string>();
  /** Child agents' rules, by agent name (`agentRulesFor`). */
  private readonly childRules = new Map<
    string,
    Promise<readonly OpenCodeNativeRule[] | undefined>
  >();
  /**
   * Asks Station had to reject and OpenCode would not take, by native id:
   * their execution was interrupted instead, and a re-list never shows them
   * to a person. Oldest first, bounded by {@link rememberRefused}.
   */
  private readonly refusedAsks = new Map<string, RefusedAsk>();
  /** Times each session's execution was seen to end, by session. */
  private readonly releases = new Map<string, number>();
  /**
   * Refusals of this session's own asks, raised with no turn live, whose
   * interrupt has not answered and whose wait has not run out: a next turn
   * is refused as busy meanwhile.
   */
  private stoppingRefused = 0;
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

  /** Where the session was when it started here (before any move). */
  private readonly startDirectory: string;

  constructor(deps: OpenCodeNativeSessionDeps) {
    this.deps = deps;
    this.sessionId = deps.sessionId;
    this.startDirectory = deps.cwd;
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
    if (this.stopped)
      throw new SendTurnRefusedError(
        'This OpenCode session has stopped.',
        'unavailable',
      );
    if (this.withdrawalUnconfirmed || this.withdrawingSteers.size > 0)
      throw new SendTurnRefusedError(
        'OpenCode steer withdrawal is unconfirmed; this session cannot accept more work.',
        'unavailable',
      );
    if (this.rewinding) throw new SessionRewindingError();
    const live = this.turn ?? this.pendingStart;
    if (live && !live.settled) {
      if (live.kind === 'provider') throw new ProviderTurnInProgressError();
      throw new SendTurnRefusedError(
        'This OpenCode session is already running a turn.',
        'busy',
      );
    }
    if (this.stoppingRefused > 0)
      throw new SendTurnRefusedError(
        'This OpenCode session is still being stopped after a request Station had to reject.',
        'busy',
      );
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
    let posted!: () => void;
    turn.posted = new Promise((resolve) => {
      posted = resolve;
    });
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
      posted();
      if (error instanceof OpenCodeServeHttpError)
        throw new SendTurnRefusedError(
          `OpenCode refused the prompt (${error.status}).`,
          'unavailable',
        );
      throw error;
    }
    // A turn stopped while this was in flight takes its item back out now
    // ({@link withdrawUnstarted}).
    posted();
    // OpenCode took a next prompt: an execution starting now is taken to be
    // this turn's (`onExecutionStarted`). A refused one leaves the earlier
    // turn's prompt still to be stopped if it starts.
    if (this.unwithdrawn) turn.displacedUnwithdrawn = this.unwithdrawn;
    this.unwithdrawn = undefined;
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
    if (
      !turn ||
      turn.settled ||
      turn.turnId !== turnId ||
      !turn.executing ||
      // Stopped by Station: its execution is ending.
      turn.failClose
    )
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
    this.deps.steerCustody?.begin(inboxId);
    this.steers.set(inboxId, steer);
    try {
      await this.deps.client.request(
        'POST',
        `/api/session/${this.sessionId}/prompt`,
        { id: inboxId, text, delivery: 'steer' },
      );
    } catch (error) {
      if (steer.delivered) {
        this.deps.steerCustody?.complete(inboxId);
        return;
      }
      this.steers.delete(inboxId);
      // An HTTP failure does not establish that the prompt was never queued.
      await this.deleteInboxItem(inboxId, false);
      throw new Error(
        `OpenCode did not confirm the steering request; the input may still be queued: ${redactSecrets(errorMessage(error))}`,
      );
    } finally {
      steer.posting = false;
    }
    if (steer.delivered) this.deps.steerCustody?.complete(inboxId);
    if (steer.withdrawn) {
      // Withdrawn while in flight: the item it made must not wait for the
      // next execution. This steer takes it back itself, so it leaves the
      // set first: a stop's sweep, resuming once the prompt has landed,
      // would otherwise take it back a second time.
      this.steers.delete(inboxId);
      await this.deleteInboxItem(inboxId);
      steer.reject(
        this.withdrawalUnconfirmed
          ? new Error(
              'OpenCode steer withdrawal is unconfirmed; the input may still be queued.',
            )
          : new ProviderTurnEndedError(),
      );
    } else if (turn.settled) {
      // The execution ended while the prompt was in flight.
      void this.withdrawSteer(inboxId);
    }
    if (this.withdrawalUnconfirmed)
      throw new Error(
        'OpenCode steer withdrawal is unconfirmed; the input may still be queued.',
      );
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
    this.appendText(turn, `text:${turnId}:command`, text);
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
    this.unwithdrawn = undefined;
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
      steer.reject(
        this.withdrawalUnconfirmed
          ? new Error(
              'OpenCode steer withdrawal is unconfirmed; the input may still be queued.',
            )
          : new ProviderTurnEndedError(),
      );
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
   * proceeds, or waits for a later execution). An ask Station refused that
   * OpenCode would not take, and may still hold, counts as running work:
   * the session asking it is interrupted with this one, and the rejection
   * is sent again with the others; so is an ask Station was still deciding
   * or answering itself, whose answer stopping drops. Each request is
   * bounded on its own, so
   * one the engine never answers cannot hold back the interrupt; best
   * effort, the session is released whatever the engine answers. A steer
   * whose prompt is still in flight is withdrawn when it lands (`steer`).
   */
  private async dropEngineWork(): Promise<void> {
    const client = this.deps.client;
    const live = this.turn ?? this.pendingStart;
    const held = [...this.refusedAsks.entries()].filter(
      ([, refused]) => refused.held,
    );
    // Asks Station was still deciding or answering itself: stopping drops
    // that answer, so each is rejected here instead (one already answered
    // is gone, and its rejection is refused).
    const answering = [...this.autoAnswering.entries()].filter(
      ([nativeId]) => !this.refusedAsks.has(nativeId),
    );
    const running =
      (live !== undefined && !live.settled) ||
      this.hasOpenWork() ||
      held.length > 0 ||
      answering.length > 0;
    const send = (method: 'POST' | 'DELETE', path: string, body?: unknown) =>
      client
        .request(method, path, body, { timeoutMs: STOP_REQUEST_MS })
        .catch(() => undefined);
    // A descendant runs as a background job of its own (2.3.0), which the
    // root's interrupt does not stop.
    const askers = new Set(
      [
        ...held.map(([, refused]) => refused.sessionId),
        ...answering.map(([, sessionId]) => sessionId),
      ].filter((sessionId) => sessionId !== this.sessionId),
    );
    if (running)
      await Promise.all(
        [this.sessionId, ...askers].map((sessionId) =>
          send('POST', `/api/session/${sessionId}/interrupt`),
        ),
      );
    await Promise.all([
      ...held.map(([nativeId, refused]) =>
        send(
          'POST',
          `/api/session/${refused.sessionId}/permission/${nativeId}/reply`,
          { decision: 'reject' },
        ),
      ),
      ...answering.map(([nativeId, sessionId]) =>
        send('POST', `/api/session/${sessionId}/permission/${nativeId}/reply`, {
          decision: 'reject',
        }),
      ),
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
        .map(([inboxId]) => this.deleteInboxItem(inboxId)),
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
            // Never fatal: a reconnect that throws must not drop the feed it
            // just opened (and so reconnect again, and again).
            if (this.connections > 1)
              await this.reread('what the feed gap hid', () =>
                this.reconcile(),
              );
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
    if (this.turn) delete this.turn.stepModel;
    for (const part of this.parts.values()) {
      if (part.open) part.gapped = true;
    }
  }

  /**
   * Re-read what a feed gap hid (PLAN A.4). Best effort; never fatal. Each
   * read stands on its own: one that fails is reported in a warning of its
   * own, and the others still run. What needs a failed read (which sessions
   * run, for a child's or the turn's outcome and a steer's delivery) is
   * left as it was.
   */
  private async reconcile(): Promise<void> {
    const client = this.deps.client;
    const base = `/api/session/${this.sessionId}`;
    let activeSessions: Record<string, unknown> | undefined;
    await this.reread('which sessions are running', async () => {
      const active = await client.request<{ data?: unknown }>(
        'GET',
        '/api/session/active',
      );
      activeSessions = ownRecord(active?.data) ?? {};
    });
    const running =
      activeSessions === undefined
        ? undefined
        : Object.hasOwn(activeSessions, this.sessionId);
    let history: unknown[] | undefined;
    await this.reread('the session history', async () => {
      history = await this.readHistory();
      this.adoptStartedDuringGap(history);
      this.catchUpText(history);
    });
    await this.reread('its subagents and pending requests', () =>
      this.reconcileTree(activeSessions),
    );
    await this.reread('the inbox', async () => {
      const inbox = await client.request<{ data?: unknown }>(
        'GET',
        `${base}/inbox`,
      );
      if (running === undefined) return;
      const queued = new Set(
        (ownArray(inbox?.data) ?? []).flatMap((item) => {
          const id = readString(ownRecord(item)?.id);
          return id ? [id] : [];
        }),
      );
      for (const inboxId of [...this.steers.keys()]) {
        if (queued.has(inboxId)) continue;
        // Only the exact user message proves consumption. An absent inbox
        // item can also be cancelled, or its POST may still be in flight.
        if (history?.some((item) => ownRecord(item)?.id === inboxId))
          this.onSteerDelivered(inboxId);
        else if (!running && history) void this.withdrawSteer(inboxId);
      }
    });
    if (running !== false) return;
    // Not running: whatever it asked, OpenCode no longer holds.
    this.releaseRefusedAsks(this.sessionId);
    const turn = this.turn;
    if (history && turn && !turn.settled && turn.executing) {
      const read = history;
      await this.reread("the live turn's outcome", async () =>
        this.settleFromHistory(turn, read),
      );
    }
  }

  /** One of a reconnect's reads; a failure is reported and goes no further. */
  private async reread(what: string, read: () => Promise<void>): Promise<void> {
    try {
      await read();
    } catch (error) {
      this.emit({
        method: 'runtime.warning',
        severity: 'warning',
        message: `Station reconnected to OpenCode but could not re-read ${what}: ${redactSecrets(errorMessage(error))}`,
      });
    }
  }

  /**
   * The pending asks and forms of this session and every descendant, and
   * the descendants themselves. This session's are read from its own lists
   * (`GET /api/session/{id}/permission`, `/form`), which follow it wherever
   * it moved. A descendant's are read from the server-wide lists, which hold
   * only the server's launch directory's (`move-gap` capture), each kept
   * only when it is from this tree (a server may run other sessions); a
   * descendant in another directory is read from its own lists. Every list
   * and every descendant lookup is read on its own ({@link reread}).
   */
  private async reconcileTree(
    activeSessions: Record<string, unknown> | undefined,
  ): Promise<void> {
    await this.relistOwn(this.sessionId, 'this session');
    await this.reconcileDescendants(activeSessions);
    if (this.children.size === 0) return;
    const client = this.deps.client;
    const descendant = (sessionId: unknown) =>
      typeof sessionId === 'string' && this.children.has(sessionId);
    await this.reread(
      "its subagents' pending permission requests",
      async () => {
        const permissions = await client.request<{ data?: unknown }>(
          'GET',
          '/api/permission/request',
        );
        for (const item of ownArray(permissions?.data) ?? []) {
          const ask = ownRecord(item);
          if (ask && descendant(ask.sessionID)) this.onPermissionAsked(ask);
        }
      },
    );
    await this.reread("its subagents' pending questions", async () => {
      const forms = await client.request<{ data?: unknown }>(
        'GET',
        '/api/form',
      );
      for (const item of ownArray(forms?.data) ?? []) {
        if (descendant(ownRecord(item)?.sessionID)) this.onFormCreated(item);
      }
    });
    const real = (directory: string) =>
      isAbsolute(directory) ? realish(directory) : directory;
    const server = real(this.deps.serverDirectory ?? this.startDirectory);
    for (const child of [...this.children.values()]) {
      if (child.directory && real(child.directory) !== server)
        await this.relistOwn(
          child.childId,
          `subagent session ${child.childId}`,
        );
    }
  }

  /** One session's pending asks and forms, from its own lists, each read on its own. */
  private async relistOwn(sessionId: string, label: string): Promise<void> {
    const client = this.deps.client;
    const base = `/api/session/${sessionId}`;
    await this.reread(
      `the pending permission requests of ${label}`,
      async () => {
        const permissions = await client.request<{ data?: unknown }>(
          'GET',
          `${base}/permission`,
        );
        for (const item of ownArray(permissions?.data) ?? []) {
          const ask = ownRecord(item);
          if (ask && ask.sessionID === sessionId) this.onPermissionAsked(ask);
        }
      },
    );
    await this.reread(`the pending questions of ${label}`, async () => {
      const forms = await client.request<{ data?: unknown }>(
        'GET',
        `${base}/form`,
      );
      for (const item of ownArray(forms?.data) ?? []) {
        if (ownRecord(item)?.sessionID === sessionId) this.onFormCreated(item);
      }
    });
  }

  /**
   * Descendants a feed gap hid (PLAN A.4): children, and their children,
   * looked up by `parentID` from this session down, at most
   * {@link DESCENDANT_LOOKUPS_PARALLEL} lookups at a time and
   * {@link DESCENDANTS_MAX} descendants in all (a warning says when more
   * were left out). Every descendant is looked up, one idle before and
   * after the gap too: its parent may have resumed it during the gap
   * (2.3.0's subagent tool continues an existing child,
   * `tool/plugin/subagent.ts`), and it may have started a child of its own
   * and gone idle again. A failed lookup is
   * reported and the walk goes on without that descendant's children. Each
   * one's agent and directory are refreshed; when which sessions run is
   * known, one running now is reported running, and one reported running
   * that has since ended is settled with the outcome OpenCode kept for it.
   */
  private async reconcileDescendants(
    activeSessions: Record<string, unknown> | undefined,
  ): Promise<void> {
    const queue = [this.sessionId];
    const seen = new Set(queue);
    const listed: Array<{ child: ChildSession; outcome?: string }> = [];
    let truncated = false;
    const lookUp = async (parentId: string) => {
      let answer: { data?: unknown } | undefined;
      await this.reread(
        parentId === this.sessionId
          ? 'its subagent sessions'
          : `the subagent sessions of ${parentId}`,
        async () => {
          answer = await this.deps.client.request<{ data?: unknown }>(
            'GET',
            `/api/session?parentID=${encodeURIComponent(parentId)}&limit=${DESCENDANTS_MAX + 1}`,
          );
        },
      );
      return answer;
    };
    while (queue.length > 0 && !truncated) {
      // A few lookups at once; their answers are taken in the order asked.
      const parents = queue.splice(0, DESCENDANT_LOOKUPS_PARALLEL);
      const answers = await Promise.all(parents.map(lookUp));
      parents.forEach((parentId, index) => {
        for (const item of ownArray(answers[index]?.data) ?? []) {
          if (truncated) return;
          const info = ownRecord(item);
          const childId = readString(info?.id);
          if (!info || !childId || seen.has(childId)) continue;
          if (readString(info.parentID) !== parentId) continue;
          if (seen.size > DESCENDANTS_MAX) {
            truncated = true;
            return;
          }
          seen.add(childId);
          queue.push(childId);
          const child = this.trackChild(childId, parentId, info);
          const outcome = readString(info.outcome);
          listed.push({ child, ...(outcome ? { outcome } : {}) });
        }
      });
    }
    if (truncated)
      this.emit({
        method: 'runtime.warning',
        severity: 'warning',
        message: `Station re-read the first ${DESCENDANTS_MAX} subagent sessions of this ${this.deps.engineName} chat after reconnecting; the others are not reported and their pending requests are not shown.`,
      });
    if (!activeSessions) return;
    for (const { child, outcome } of listed) {
      const runningNow = Object.hasOwn(activeSessions, child.childId);
      if (runningNow && !child.running) this.markChildRunning(child);
      else if (!runningNow && child.running)
        this.settleChild(
          child,
          outcome === 'failed'
            ? 'failed'
            : outcome === 'interrupted'
              ? 'cancelled'
              : 'completed',
        );
    }
  }

  /** A descendant, as `session.created` or the session list names it. */
  private trackChild(
    childId: string,
    parentId: string,
    info: Record<string, unknown>,
  ): ChildSession {
    const child = this.children.get(childId) ?? {
      childId,
      parentId,
      running: false,
    };
    const title = readString(info.title);
    const agent = readString(info.agent);
    const directory = readString(ownRecord(info.location)?.directory);
    if (title) child.title = title;
    if (agent) child.agent = agent;
    if (directory) child.directory = directory;
    this.children.set(childId, child);
    return child;
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
        if (!key.startsWith(openCodePartKey('text', id, '')) || !text) continue;
        const part = this.parts.get(key);
        if (part) {
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
    // OpenCode says the session runs nothing: the execution Station stopped ended.
    if (turn.failClose) turn.failClose.confirmed = true;
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
    if (sessionId) this.noteAskTool(event.type, data, sessionId);
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
        this.withTurn((turn) => {
          delete turn.stepModel;
        });
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
          const kind =
            event.type === 'session.text.started' ? 'text' : 'reasoning';
          const key = this.partKey(data, kind);
          if (key && !this.parts.has(key))
            this.parts.set(key, {
              turnId: turn.turnId,
              kind,
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
      case 'session.moved':
        this.onMoved(sessionId, data);
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

  /**
   * Another session's event: a descendant's lifecycle, agent, directory and
   * asks, nothing else. A descendant is a session whose `parentID` is this
   * session or a descendant already known.
   */
  private handleForeign(
    type: string,
    data: Record<string, unknown>,
    sessionId: string,
  ): void {
    if (type === 'session.created') {
      const parentId = readString(data.parentID);
      if (
        !parentId ||
        (parentId !== this.sessionId && !this.children.has(parentId))
      )
        return;
      this.trackChild(sessionId, parentId, data);
      return;
    }
    const child = this.children.get(sessionId);
    if (!child) return;
    this.noteAskTool(type, data, sessionId);
    switch (type) {
      case 'session.execution.started':
        this.markChildRunning(child);
        return;
      case 'session.agent.selected': {
        // Its asks are decided on the agent it runs now.
        const agent = readString(data.agent);
        if (agent) child.agent = agent;
        return;
      }
      case 'session.moved':
        this.onMoved(sessionId, data);
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

  /**
   * A session of this tree moved (`session.moved`: its new
   * `location.directory`). Its directory follows at once, for the
   * configuration-edit guard; the adapter is told, since OpenCode has
   * already loaded the destination's own configuration.
   */
  private onMoved(sessionId: string, data: Record<string, unknown>): void {
    const named = readString(ownRecord(data.location)?.directory);
    if (!named) return;
    // OpenCode names the directory as the move was asked, not resolved
    // (`/tmp` for `/private/tmp`): compared and checked as its real path.
    const directory = isAbsolute(named) ? realish(named) : named;
    if (sessionId === this.sessionId) this.deps.cwd = directory;
    else {
      const child = this.children.get(sessionId);
      if (!child) return;
      child.directory = directory;
    }
    this.deps.onMoved?.({ sessionId, directory });
  }

  /** A descendant's execution started: the running set is reported again. */
  private markChildRunning(child: ChildSession): void {
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
    // The session's complete running set: this adapter sees every
    // descendant OpenCode creates under it (a reconnect lists those a
    // gap hid), so the snapshot is authoritative (a child it no longer
    // lists without a settle reads `unresolved`).
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
  }

  private settleChild(
    child: ChildSession,
    status: 'completed' | 'failed' | 'cancelled' | 'unresolved',
  ): void {
    if (!child.running) return;
    child.running = false;
    this.releaseRefusedAsks(child.childId);
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
    const unwithdrawn = this.unwithdrawn;
    if (unwithdrawn) {
      // The prompt of a turn Station already ended, started after all.
      this.unwithdrawn = undefined;
      void this.interruptFor(this.sessionId).then((failure) =>
        this.emit({
          method: 'runtime.warning',
          severity: 'warning',
          message: failure
            ? `${this.deps.engineName} started the prompt of turn ${unwithdrawn.turnId} after Station had ended that turn, and Station could not interrupt it (${failure}); ${this.deps.engineName} may still be running it.`
            : `${this.deps.engineName} started the prompt of turn ${unwithdrawn.turnId} after Station had ended that turn, so Station interrupted it.`,
        }),
      );
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
    this.releaseRefusedAsks(this.sessionId);
    const turn = this.turn;
    if (!turn || turn.settled) return;
    for (const [inboxId, steer] of this.steers) {
      if (steer.turnId === turn.turnId) void this.withdrawSteer(inboxId);
    }
    this.closeOpenTools(turn);
    if (turn.failClose) {
      // Ended as Station stopped it: with the error that says why.
      turn.failClose.confirmed = true;
      this.settle(turn, { method: 'turn.aborted', reason: 'interrupted' });
      return;
    }
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
    this.withdrawingSteers.add(inboxId);
    // Still in flight: `steer` deletes the item once its prompt lands, before
    // it reports the refusal.
    if (steer.posting) return;
    await this.deleteInboxItem(inboxId);
    steer.reject(
      this.withdrawalUnconfirmed
        ? new Error(
            'OpenCode steer withdrawal is unconfirmed; the input may still be queued.',
          )
        : new ProviderTurnEndedError(),
    );
  }

  private withdrawalUnconfirmed = false;
  private readonly withdrawingSteers = new Set<string>();

  private async deleteInboxItem(
    inboxId: string,
    postConfirmed = true,
  ): Promise<void> {
    if (!postConfirmed) this.withdrawalUnconfirmed = true;
    this.withdrawingSteers.add(inboxId);
    await this.deps.client
      .request('DELETE', `/api/session/${this.sessionId}/inbox/${inboxId}`)
      .then(() => {
        this.withdrawingSteers.delete(inboxId);
        if (postConfirmed) this.deps.steerCustody?.complete(inboxId);
      })
      .catch((error: unknown) => {
        if (error instanceof OpenCodeServeHttpError && error.status === 404) {
          this.withdrawingSteers.delete(inboxId);
          if (postConfirmed) this.deps.steerCustody?.complete(inboxId);
          return;
        }
        this.withdrawalUnconfirmed = true;
        this.emit({
          method: 'runtime.warning',
          severity: 'warning',
          message: `OpenCode could not confirm that a queued steer was withdrawn: ${redactSecrets(errorMessage(error))}. This session cannot accept more work.`,
        });
      });
  }

  private onSteerDelivered(inboxId: string): void {
    const steer = this.steers.get(inboxId);
    if (!steer) return;
    if (!steer.posting) this.deps.steerCustody?.complete(inboxId);
    steer.delivered = true;
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
    this.withTurn((turn) => {
      const model = ownRecord(data.model);
      const providerId = readString(model?.providerID);
      const modelId = readString(model?.id);
      const assistantMessageId = readString(data.assistantMessageID);
      delete turn.stepModel;
      if (providerId && modelId && assistantMessageId) {
        turn.stepModel = {
          source: 'opencode-step-started',
          providerId,
          modelId,
          assistantMessageId,
        };
      }
    });
  }

  private onConfigured(data: Record<string, unknown>): void {
    const model = ownRecord(data.model);
    const modelId =
      readString(model?.id) && readString(model?.providerID)
        ? `${model?.providerID as string}/${model?.id as string}`
        : undefined;
    const agent = readString(data.agent);
    if (modelId !== undefined && modelId !== this.lastModel) {
      this.lastModel = modelId;
      this.emit({
        method: 'session.configured',
        sessionId: this.deps.threadId,
        model: modelId,
        cwd: this.deps.cwd,
      });
    }
    if (agent !== undefined && agent !== this.lastAgent) {
      this.lastAgent = agent;
      this.emit({ method: 'session.engine-mode-observed', modeId: agent });
    }
  }

  private onStepEnded(turn: NativeTurn, data: Record<string, unknown>): void {
    const stepModel = turn.stepModel;
    delete turn.stepModel;
    const usage = openCodeStepUsage(data);
    if (!usage) return;
    this.publishForTurn(turn, {
      method: 'token-usage.updated',
      turnId: turn.turnId,
      ...(stepModel && stepModel.assistantMessageId === data.assistantMessageID
        ? { servedModelObservation: stepModel }
        : {}),
      ...usage,
    });
  }

  /**
   * A streamed part's identity. OpenCode numbers each kind of part on its
   * own (a reply after reasoning is text `ordinal: 0` beside reasoning
   * `ordinal: 0`; fixture `opencode-serve-2.3.0-reasoning.jsonl`), so the
   * kind is part of it. History keys its text the same way
   * ({@link openCodeHistoryText}).
   */
  private partKey(
    data: Record<string, unknown>,
    kind: 'text' | 'reasoning',
  ): string | undefined {
    const messageId = readString(data.assistantMessageID);
    const ordinal = data.ordinal;
    return messageId && typeof ordinal === 'number'
      ? openCodePartKey(kind, messageId, ordinal)
      : undefined;
  }

  private onDelta(
    turn: NativeTurn,
    data: Record<string, unknown>,
    kind: 'text' | 'reasoning',
  ): void {
    const key = this.partKey(data, kind);
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
        itemId: key,
        delta,
      });
    }
  }

  private onPartEnded(
    turn: NativeTurn,
    data: Record<string, unknown>,
    kind: 'text' | 'reasoning',
  ): void {
    const key = this.partKey(data, kind);
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
      itemId: key,
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
      this.autoAnswering.has(nativeId) ||
      this.refusedAsks.has(nativeId)
    )
      return;
    const resources = (ownArray(data.resources) ?? []).filter(
      (item): item is string => typeof item === 'string',
    );
    const live = this.turn ?? this.pendingStart;
    const ask: NativeAsk = {
      nativeId,
      sessionId,
      action,
      resources,
      save: (ownArray(data.save) ?? []).filter(
        (item): item is string => typeof item === 'string',
      ),
      toolCallId: readString(ownRecord(data.source)?.id),
      messageId: readString(ownRecord(data.source)?.messageID),
      files: (ownArray(ownRecord(data.metadata)?.files) ?? []).flatMap(
        (entry) => {
          const file = readString(ownRecord(entry)?.file);
          return file ? [file] : [];
        },
      ),
      metadata: data.metadata,
      turnId: live && !live.settled ? live.turnId : undefined,
      releases: this.releases.get(sessionId) ?? 0,
    };
    // #4828, first: after an untrusted read, a change to a known
    // agent-instruction or git-hook file is rejected, whatever a grant, the
    // mode or the agent would say (as on ACP, before its staged policy).
    if (
      openCodeNativePersistenceTarget(ask, this.askDirectory(sessionId)) &&
      this.deps.untrustedRead
    ) {
      const untrustedRead = this.deps.untrustedRead;
      this.autoAnswering.set(nativeId, sessionId);
      void untrustedRead()
        .catch(() => true)
        .then((read) => {
          this.autoAnswering.delete(nativeId);
          if (this.stopped || this.requests.has(nativeId)) return;
          if (read)
            this.answerAutomatically(ask, 'reject', {
              why: 'this conversation read untrusted content, and the change is to an agent-instruction or git-hook file (#4828)',
            });
          else this.routeAsk(ask);
        });
      return;
    }
    this.routeAsk(ask);
  }

  /**
   * The directory a session of this tree asks from, which its relative
   * resources are named against: this session's (followed through moves),
   * or a descendant's own, else this session's.
   */
  private askDirectory(sessionId: string): string {
    return sessionId === this.sessionId
      ? this.deps.cwd
      : (this.children.get(sessionId)?.directory ?? this.deps.cwd);
  }

  /** Decide an ask on the rules of the agent that asked. */
  private routeAsk(ask: NativeAsk): void {
    const { nativeId, sessionId } = ask;
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
    this.autoAnswering.set(nativeId, sessionId);
    void lookup.then((rules) => {
      this.autoAnswering.delete(nativeId);
      if (this.stopped || this.requests.has(nativeId)) return;
      if (rules) this.decideAsk(ask, rules);
      else this.decideAsk(ask, undefined, { personOnly: true });
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
   * Decide an ask, this session's or a descendant's, in the ACP adapter's
   * order (`requestPermission` in acp-adapter.ts; the #4828 persistence
   * decline already ran, in {@link onPermissionAsked}):
   * 1. `reject` when the confined rules govern and Station keeps the asking
   *    agent's deny (native only: over ACP OpenCode enforces it itself);
   * 2. Station's staged pre-tool policy, for a session started as an
   *    Agent: its deny rejects, with its reason as OpenCode's feedback to
   *    the model; its allow answers `once`, except for a request addressed
   *    to a person (`toolRequestNeedsPerson`) or one the configuration-edit
   *    guard gives a person (`openCodeNativeAskNeedsPerson`), as ACP's
   *    `needsPerson` holds it back; its required ask goes to the person;
   *    anything else goes on. An evaluator that throws denies. An ask whose
   *    tool OpenCode did not name, or that does not fit the tool recorded
   *    for its call ({@link askingTool}), is one the policy cannot be asked
   *    about: it goes to the person (ACP, given no tool name, skips the
   *    policy and lets a grant or the mode answer);
   * 3. a session grant or the mode, never for an OpenCode configuration
   *    edit below full access (`openCodeNativeAskAnswer`), else the person,
   *    or, in a delegated session that may not grant approvals, a rejection
   *    ({@link toPerson}).
   */
  private decideAsk(
    ask: NativeAsk,
    agentRules: readonly OpenCodeNativeRule[] | undefined,
    options: { personOnly?: true } = {},
  ): void {
    const request = { action: ask.action, resources: ask.resources };
    if (agentRules && openCodeNativeStationRejects(agentRules, request)) {
      this.answerAutomatically(ask, 'reject', {
        why: "the asking agent's own rules deny it",
      });
      return;
    }
    // OpenCode names a write relative to the asking session's directory.
    const cwd = this.askDirectory(ask.sessionId);
    const configNeedsPerson = () =>
      openCodeNativeAskNeedsPerson(request, cwd, this.deps.configEnv);
    const answer = (personOnly: boolean, guardianReason?: string) => {
      const decided = personOnly
        ? 'person'
        : openCodeNativeAskAnswer({
            mode: this.deps.approvalMode,
            agentRules: undefined,
            request,
            granted: this.grants.some((grant) =>
              openCodeGrantCovers(grant, request),
            ),
            configNeedsPerson,
          });
      if (decided === 'person') this.toPerson(ask, { guardianReason });
      else this.answerAutomatically(ask, decided);
    };
    const policy = this.deps.preToolPolicy;
    if (!policy) {
      answer(options.personOnly === true);
      return;
    }
    const tool = this.askingTool(ask);
    if (!tool?.name || !ask.toolCallId) {
      answer(true);
      return;
    }
    const toolName = tool.name;
    const toolCallId = ask.toolCallId;
    this.autoAnswering.set(ask.nativeId, ask.sessionId);
    // An evaluator that throws, at once or later, denies.
    void Promise.resolve()
      .then(() =>
        policy(
          {
            toolName,
            toolCallId,
            toolArgs: tool.input ?? ask.metadata ?? {},
          },
          this.deps.approvalMode === 'never',
        ),
      )
      .catch(
        (error: unknown): PreToolPolicyDecision => ({
          behavior: 'deny',
          denial: {
            allowed: false,
            reason: `Station pre-tool policy failed; tool execution was denied: ${errorMessage(error)}`,
          },
        }),
      )
      .then((decision) => {
        this.autoAnswering.delete(ask.nativeId);
        if (this.stopped || this.requests.has(ask.nativeId)) return;
        if (decision.behavior === 'deny') {
          this.answerAutomatically(ask, 'reject', {
            message: decision.denial.reason,
            why: decision.denial.reason,
          });
          return;
        }
        const needsPerson =
          options.personOnly === true ||
          toolRequestNeedsPerson(toolName) ||
          (this.deps.approvalMode !== 'never' && configNeedsPerson());
        if (decision.behavior === 'allow' && !needsPerson) {
          this.answerAutomatically(ask, 'once');
          return;
        }
        answer(
          needsPerson ||
            (decision.behavior === 'ask' && decision.required === true),
          decision.behavior === 'ask' ? decision.guardianReason : undefined,
        );
      });
  }

  /**
   * The tools an ask may come from, by session and call id: the name
   * `session.tool.input.started` gives and the input `session.tool.called`
   * gives, as OpenCode's own ACP layer keeps them for its permission
   * requests (2.3.0 `cli/src/acp/translate.ts`), until the tool ends.
   */
  private readonly askTools = new Map<
    string,
    { name?: string; input?: unknown; messageId?: string }
  >();

  /**
   * The tool an ask came from, as {@link askTools} recorded it for the
   * ask's session and call id, only when the ask fits that tool: its action
   * is one the tool asks for ({@link openCodeAskFitsTool}) and, when both
   * name one, its message is the tool call's. Code Mode runs its nested
   * calls under the `execute` call's own id and message (2.3.0
   * `codemode/tool.ts`), so a nested shell ask names the `execute` call; it
   * is treated as a tool OpenCode did not name.
   */
  private askingTool(
    ask: NativeAsk,
  ): { name?: string; input?: unknown } | undefined {
    if (!ask.toolCallId) return undefined;
    const tool = this.askTools.get(askToolKey(ask.sessionId, ask.toolCallId));
    if (!tool?.name || !openCodeAskFitsTool(tool.name, ask.action))
      return undefined;
    if (tool.messageId && ask.messageId && tool.messageId !== ask.messageId)
      return undefined;
    return tool;
  }
  private noteAskTool(
    type: string,
    data: Record<string, unknown>,
    sessionId: string,
  ): void {
    const callId = readString(data.id);
    if (!callId) return;
    const key = askToolKey(sessionId, callId);
    if (type === 'session.tool.success' || type === 'session.tool.failed') {
      this.askTools.delete(key);
      return;
    }
    const known = this.askTools.get(key) ?? {};
    const messageId = readString(data.assistantMessageID);
    if (messageId) known.messageId = messageId;
    if (type === 'session.tool.input.started') {
      const name = readString(data.name);
      if (name) known.name = name;
    } else if (type === 'session.tool.called') {
      known.input = data.input;
    } else return;
    this.askTools.delete(key);
    this.askTools.set(key, known);
    // A tool whose end the feed hid is not kept for ever.
    if (this.askTools.size > ASK_TOOLS_MAX)
      this.askTools.delete(this.askTools.keys().next().value as string);
  }

  /**
   * Answer an ask for the person (`once` or `reject`). A 404 means it is
   * gone already (its execution ended). A `once` OpenCode will not take is
   * put to the person (the safe direction). A `reject` it will not take is
   * sent once more; failing again, the ask is never put to a person who
   * could allow it: the turn is stopped instead ({@link failClosed}).
   */
  private answerAutomatically(
    ask: NativeAsk,
    answer: 'once' | 'reject',
    options: {
      /** A rejection's reason, which OpenCode gives the model as feedback. */
      message?: string;
      /** Why Station rejects it, for the error if the rejection fails. */
      why?: string;
    } = {},
  ): void {
    this.autoAnswering.set(ask.nativeId, ask.sessionId);
    const send = () =>
      this.deps.client.request(
        'POST',
        `/api/session/${ask.sessionId}/permission/${ask.nativeId}/reply`,
        {
          decision: answer,
          ...(options.message ? { message: options.message } : {}),
        },
      );
    const gone = (error: unknown) =>
      error instanceof OpenCodeServeHttpError && error.status === 404;
    void send()
      .catch((error: unknown) => {
        if (answer !== 'reject' || gone(error) || this.stopped) throw error;
        return send();
      })
      .then(
        () => {
          this.autoAnswering.delete(ask.nativeId);
        },
        (error: unknown) => {
          this.autoAnswering.delete(ask.nativeId);
          // Gone already (its execution ended): nothing waits on it.
          if (gone(error)) return;
          if (this.stopped || this.requests.has(ask.nativeId)) return;
          if (answer === 'reject') {
            this.failClosed(ask, error, options.why);
            return;
          }
          // Still pending in OpenCode, and nobody would see it: the person
          // answers it instead.
          this.toPerson(ask, {
            autoAnswerFailed: `Station could not allow this automatically: ${errorMessage(error)}`,
          });
        },
      );
  }

  /**
   * An ask Station must reject that OpenCode would not take: it stays
   * pending there, so the execution that asked is interrupted, which drops
   * it. It is never shown to a person, and a later re-list does not reopen
   * it.
   *
   * This session's ask stops the turn it was raised in, and a descendant's
   * stops the live turn if that turn started it: the asking descendant is
   * interrupted (a 2.3.0 subagent is a background job of its own, which the
   * root's interrupt does not stop) and this session too. The turn ends
   * with a `runtime.error` saying why once OpenCode reports the execution
   * ended, or after {@link FAIL_CLOSE_SETTLE_MS} if it does not; until then
   * it is still the live turn, so a next turn is refused as busy and a steer
   * as too late rather than delivered into the execution being stopped. A
   * second refusal in that turn adds its interrupts to the first's record,
   * whose reason and wait stand. A turn nothing runs yet has its prompt
   * taken back out of the inbox instead ({@link withdrawUnstarted}).
   *
   * An ask that is not the live turn's (a descendant some other turn
   * started, or this session's from a turn that has ended) interrupts the
   * session that asked, with a warning: the live turn is not settled for it.
   * This session's ask with no turn live at all ends in a `runtime.error` of
   * its own, and a next turn is refused as busy until the interrupt answers
   * or the same wait runs out. An interrupt that fails is reported in a
   * warning of its own; stopping the session interrupts again and repeats
   * the rejection while OpenCode may still hold the ask ({@link
   * dropEngineWork}).
   */
  private failClosed(
    ask: NativeAsk,
    error: unknown,
    why: string | undefined,
  ): void {
    // Its execution ended before the refusal came back: nothing holds it.
    const held = (this.releases.get(ask.sessionId) ?? 0) === ask.releases;
    if (!this.rememberRefused(ask.nativeId, { sessionId: ask.sessionId, held }))
      return;
    const engine = this.deps.engineName;
    const own = ask.sessionId === this.sessionId;
    const reason = `Station had to reject ${engine}'s request${own ? '' : ` from subagent session ${ask.sessionId}`} to ${ask.action}${why ? ` (${redactSecrets(why).slice(0, 1000)})` : ''}, but ${engine} did not take the rejection (${redactSecrets(errorMessage(error))})`;
    const live = this.turn ?? this.pendingStart;
    const turn = live && !live.settled ? live : undefined;
    const ofTurn =
      turn !== undefined &&
      (own
        ? ask.turnId === turn.turnId
        : this.children.get(ask.sessionId)?.item?.parent?.turnId ===
          turn.turnId);
    if (own && !held && turn && !ofTurn) {
      // From a turn that has ended, whose execution ended with it: OpenCode
      // dropped the ask then, so nothing holds it, and interrupting this
      // session would stop only the turn now running.
      this.emit({
        method: 'runtime.warning',
        severity: 'warning',
        message: `${reason}. The turn that asked had ended and ${engine} no longer holds the request, so Station interrupted nothing; the turn now running goes on.`,
      });
      return;
    }
    if (!ofTurn && (turn || !own)) {
      // Not the live turn's work: the session that asked stops, the live
      // turn (if any) is not ended for it.
      void this.interruptFor(ask.sessionId).then((failure) =>
        this.emit({
          method: 'runtime.warning',
          severity: 'warning',
          message: own
            ? failure
              ? `${reason}, and Station could not interrupt ${engine} (${failure}); ${engine} may still hold it. The turn that asked had ended; the turn now running was not stopped for it.`
              : `${reason}, so Station interrupted ${engine}. The turn that asked had ended; the turn now running was not stopped for it.`
            : failure
              ? `${reason}, and Station could not stop that subagent (${failure}); ${engine} may still be running it.`
              : `${reason}, so Station stopped that subagent.`,
        }),
      );
      return;
    }
    const subagent = own ? [] : [ask.sessionId];
    const interrupts = [...subagent, this.sessionId].map((sessionId) =>
      this.interruptFor(sessionId).then((failure) => ({ sessionId, failure })),
    );
    const settleMs = this.deps.failCloseSettleMs ?? FAIL_CLOSE_SETTLE_MS;
    if (!turn) {
      // This session's, with no turn to end: the error stands on its own,
      // once the interrupt has answered. Until then (or the wait runs out)
      // a next turn would be delivered into the execution being stopped.
      let busy = true;
      this.stoppingRefused += 1;
      const idle = () => {
        if (!busy) return;
        busy = false;
        this.stoppingRefused -= 1;
      };
      const timer = setTimeout(idle, settleMs);
      void Promise.all(interrupts).then((answers) => {
        clearTimeout(timer);
        idle();
        const failure = answers.find((answer) => answer.failure)?.failure;
        this.emit({
          method: 'runtime.error',
          ...providerFailure('provider_error'),
          severity: 'error',
          code: ENGINE_TURN_FAILED_CODE,
          message: failure
            ? `${reason}, and Station could not stop it (${failure}); ${engine} may still be running it.`
            : `${reason}, so Station interrupted it.`,
        } satisfies ProviderRuntimeErrorBody);
      });
      return;
    }
    turn.stopRequested = true;
    // A second refusal in the turn adds to the first's record: its reason
    // and its wait stand.
    const first = turn.failClose === undefined;
    turn.failClose ??= {
      reason,
      confirmed: false,
      subagentInterruptFailed: new Map(),
    };
    const failClose = turn.failClose;
    for (const pending of interrupts)
      void pending.then(({ sessionId, failure }) => {
        if (!failure) return;
        if (sessionId === this.sessionId) failClose.interruptFailed ??= failure;
        else if (!failClose.subagentInterruptFailed.has(sessionId))
          failClose.subagentInterruptFailed.set(sessionId, failure);
      });
    if (!first) return;
    if (!turn.executing) {
      void this.withdrawUnstarted(turn, failClose);
      return;
    }
    this.armFailCloseWait(turn, failClose);
  }

  /**
   * Remember a refused ask. Past {@link REFUSED_ASKS_EVICT_ABOVE} the oldest
   * one OpenCode no longer holds is forgotten; one it may still hold is
   * never, since stopping the session must reject it again. Past {@link
   * REFUSED_ASKS_STOP_ABOVE} the session is stopped instead, with a warning
   * (false: it is stopping).
   */
  private rememberRefused(nativeId: string, refused: RefusedAsk): boolean {
    this.refusedAsks.set(nativeId, refused);
    const bounds = this.deps.refusedAsksBounds ?? {
      evictAbove: REFUSED_ASKS_EVICT_ABOVE,
      stopAbove: REFUSED_ASKS_STOP_ABOVE,
    };
    if (this.refusedAsks.size > bounds.evictAbove) {
      for (const [id, entry] of this.refusedAsks) {
        if (entry.held) continue;
        this.refusedAsks.delete(id);
        break;
      }
    }
    if (this.refusedAsks.size <= bounds.stopAbove) return true;
    this.emit({
      method: 'runtime.warning',
      severity: 'warning',
      code: OPENCODE_REFUSED_ASKS_OVERFLOW,
      message: `Station stopped this ${this.deps.engineName} chat: ${this.deps.engineName} would not take ${this.refusedAsks.size} of Station's rejections and may still hold them, more than Station keeps track of.`,
    });
    if (this.deps.onMustStop) this.deps.onMustStop();
    else void this.stop('stopped');
    return false;
  }

  /**
   * Stopped before anything ran it: its prompt is taken back out of the
   * inbox (once its POST has landed), so it cannot start after Station has
   * said the turn ended. If an execution started for it meanwhile, the turn
   * waits for that execution's end instead.
   */
  private async withdrawUnstarted(
    turn: NativeTurn,
    failClose: FailClose,
  ): Promise<void> {
    // Its execution started after all: the interrupt sent before it may
    // not have reached it, so it is sent again, and its end waited for.
    const started = () => {
      failClose.withdrawal = undefined;
      void this.interruptFor(this.sessionId).then((failure) => {
        if (failure) failClose.interruptFailed ??= failure;
      });
      this.armFailCloseWait(turn, failClose);
    };
    await turn.posted;
    if (turn.settled) return;
    if (turn.executing) return started();
    if (turn.messageId && this.pendingStart === turn) {
      try {
        await this.deps.client.request(
          'DELETE',
          `/api/session/${this.sessionId}/inbox/${turn.messageId}`,
          undefined,
          { timeoutMs: STOP_REQUEST_MS },
        );
        failClose.withdrawal = {};
      } catch (error) {
        failClose.withdrawal = { failed: redactSecrets(errorMessage(error)) };
      }
      if (turn.settled) return;
      if (turn.executing) return started();
    }
    if (!failClose.withdrawal || failClose.withdrawal.failed)
      this.unwithdrawn = { turnId: turn.turnId };
    // Taken back: an earlier prompt it set aside is again the one to stop.
    else this.unwithdrawn ??= turn.displacedUnwithdrawn;
    this.closeOpenTools(turn);
    this.settle(turn, { method: 'turn.aborted', reason: 'interrupted' });
  }

  /** Wait for OpenCode to say the stopped execution ended, at most {@link FAIL_CLOSE_SETTLE_MS}. */
  private armFailCloseWait(turn: NativeTurn, failClose: FailClose): void {
    failClose.timer = setTimeout(() => {
      if (turn.settled) return;
      // OpenCode did not say the execution ended: the turn ends anyway, and
      // takes back what it queued.
      for (const [inboxId, steer] of this.steers) {
        if (steer.turnId === turn.turnId) void this.withdrawSteer(inboxId);
      }
      this.closeOpenTools(turn);
      this.settle(turn, { method: 'turn.aborted', reason: 'interrupted' });
    }, this.deps.failCloseSettleMs ?? FAIL_CLOSE_SETTLE_MS);
  }

  /**
   * Interrupt one session of this tree for {@link failClosed}, bounded.
   * Resolves with why it failed (also reported in a warning), or undefined.
   */
  private async interruptFor(sessionId: string): Promise<string | undefined> {
    try {
      await this.deps.client.request(
        'POST',
        `/api/session/${sessionId}/interrupt`,
        undefined,
        { timeoutMs: STOP_REQUEST_MS },
      );
      return undefined;
    } catch (error) {
      if (this.stopped) return undefined;
      const failure = redactSecrets(errorMessage(error));
      this.emit({
        method: 'runtime.warning',
        severity: 'warning',
        message: `Station could not interrupt ${this.deps.engineName}${sessionId === this.sessionId ? '' : ` subagent session ${sessionId}`} after it would not take a rejection: ${failure}. Stopping the session tries again.`,
      });
      return failure;
    }
  }

  /** The error a turn {@link failClosed} stopped ends with. */
  private failCloseMessage(failClose: FailClose): string {
    const engine = this.deps.engineName;
    // A descendant whose interrupt failed, and that has not been seen to
    // end, may still run whatever this session's execution did.
    for (const [sessionId, failure] of failClose.subagentInterruptFailed) {
      if (this.children.get(sessionId)?.running)
        return `${failClose.reason}, and Station could not stop subagent session ${sessionId} in ${engine} (${failure}): ${engine} may still be running it.`;
    }
    if (failClose.withdrawal)
      return failClose.withdrawal.failed
        ? `${failClose.reason}, and Station could not take the turn's prompt back out of ${engine}'s queue (${failClose.withdrawal.failed}): ${engine} may still run it.`
        : `${failClose.reason}, so Station stopped the turn and took its prompt back out of ${engine}'s queue before ${engine} ran it.`;
    if (failClose.confirmed)
      return `${failClose.reason}, so Station stopped the turn.`;
    if (failClose.interruptFailed)
      return `${failClose.reason}, and Station could not stop the turn in ${engine} (${failClose.interruptFailed}): ${engine} may still be running it.`;
    return `${failClose.reason}, so Station stopped the turn; ${engine} had not confirmed its execution ended.`;
  }

  /** OpenCode no longer holds `sessionId`'s refused asks: its execution ended. */
  private releaseRefusedAsks(sessionId: string): void {
    this.releases.set(sessionId, (this.releases.get(sessionId) ?? 0) + 1);
    for (const refused of this.refusedAsks.values()) {
      if (refused.sessionId === sessionId) refused.held = false;
    }
  }

  /**
   * An ask only a person can answer now. In a delegated session that may
   * not grant approvals nobody can, so it is rejected at once, as the ACP
   * adapter declines it (`requestPermission`, after the policy, a grant and
   * the mode), with the denial the staged evaluator gives such a session.
   */
  private toPerson(
    ask: NativeAsk,
    note: { autoAnswerFailed?: string; guardianReason?: string } = {},
  ): void {
    if (this.deps.denyApprovals) {
      const reason = delegatedApprovalDenial(
        this.askingTool(ask)?.name ?? ask.action,
        'external',
      ).denial.reason;
      this.answerAutomatically(ask, 'reject', { message: reason, why: reason });
      return;
    }
    this.openPermission(ask, note);
  }

  /** Show an ask to the person as an approval request. */
  private openPermission(
    ask: NativeAsk,
    note: { autoAnswerFailed?: string; guardianReason?: string } = {},
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
        ...(note.guardianReason ? { guardianReason: note.guardianReason } : {}),
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
    if (!mapped || this.deps.denyApprovals) {
      // Station cannot show it faithfully: decline it rather than guess.
      void this.deps.client
        .request('DELETE', `/api/session/${sessionId}/form/${nativeId}`)
        .catch(() => undefined);
      this.emit({
        method: 'runtime.warning',
        severity: 'warning',
        message: mapped
          ? `${this.deps.engineName} asked a question, but nobody can answer this delegated session's questions, so it was cancelled.`
          : `${this.deps.engineName} asked a question Station cannot show, so it was cancelled.`,
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
      method: 'failed',
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
    requested:
      | {
          method: 'turn.completed';
          finishReason: 'stop' | 'cancelled' | 'other';
        }
      | { method: 'turn.aborted'; reason: string }
      // Ends in a `runtime.error` with this message.
      | { method: 'failed'; message: string },
  ): void {
    if (turn.settled) return;
    if (turn.failClose) clearTimeout(turn.failClose.timer);
    // However it ends, a turn Station stopped ends with why.
    const outcome = turn.failClose
      ? {
          method: 'failed' as const,
          message: this.failCloseMessage(turn.failClose),
        }
      : requested;
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
      } satisfies ProviderRuntimeErrorBody);
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
