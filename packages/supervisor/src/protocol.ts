/**
 * Station supervisor protocol, version 1.
 *
 * Two channels share these definitions:
 *
 * - The control channel: NDJSON over a local socket (named pipe on Windows).
 *   Clients are the CLI, the tray, and later the core server. Every client
 *   starts with `hello`; the supervisor answers `welcome` or `refused`.
 * - The generation IPC channel: the Node fork IPC channel between the
 *   supervisor and each core server generation. Listening handles travel on
 *   this channel, one handle per message.
 *
 * Minor versions only add messages, fields, and capabilities. A peer must
 * ignore fields and capabilities it does not know. A different major is
 * refused at the handshake.
 *
 * A core generation must exit when its IPC channel disconnects (Node's
 * `process.on('disconnect')`): that is how it learns its supervisor is gone.
 * A core that keeps running holds the instance's ports. The next supervisor
 * reaps such an orphan as a fallback, but that is not a substitute.
 *
 * This module is imported by other packages through the `/protocol` subpath,
 * so it holds types, constants, and pure derivations only.
 */
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { posix, win32 } from 'node:path';

export const SUPERVISOR_PROTOCOL = Object.freeze({ major: 1, minor: 1 });

export interface ProtocolVersion {
  major: number;
  minor: number;
}

/** Capabilities this supervisor offers. Unknown client capabilities are ignored. */
export const SUPERVISOR_CAPABILITIES = Object.freeze(['events'] as const);
export type SupervisorCapability = (typeof SUPERVISOR_CAPABILITIES)[number];

/** Longest accepted control-channel line, in bytes. Longer lines are refused. */
export const CONTROL_MAX_LINE_BYTES = 1024 * 1024;
/** A client that has not said `hello` within this time is disconnected. */
export const CONTROL_HELLO_TIMEOUT_MS = 5_000;
/** Concurrent control connections; the next one is refused and closed. */
export const CONTROL_MAX_CONNECTIONS = 64;
/** An event subscriber whose unsent output exceeds this is disconnected. */
export const CONTROL_MAX_SUBSCRIBER_BACKLOG_BYTES = 1024 * 1024;

/** Environment a supervised core server generation is started with. */
export const SUPERVISOR_ENV = Object.freeze({
  ipc: 'STATION_SUPERVISOR_IPC',
  pid: 'STATION_SUPERVISOR_PID',
  generation: 'STATION_SUPERVISOR_GENERATION',
});

export interface HandoffTimings {
  parkTimeoutMs: number;
  readinessTimeoutMs: number;
  drainDeadlineMs: number;
  voiceDrainCapMs: number;
  killGraceMs: number;
  commitGraceMs: number;
  stopDrainCapMs: number;
}

export interface RestartPolicy {
  initialBackoffMs: number;
  maxBackoffMs: number;
  stableAfterMs: number;
  maxFailures: number;
  failureWindowMs: number;
}

export const HANDOFF_DEFAULTS: Readonly<HandoffTimings> = Object.freeze({
  /** A trial generation must report `parked` within this time. */
  parkTimeoutMs: 30_000,
  /** A promoted generation must report `ready` within this time. */
  readinessTimeoutMs: 60_000,
  /** The draining generation must exit within this time. */
  drainDeadlineMs: 10_000,
  /** Live voice sessions may extend the drain deadline up to this total. */
  voiceDrainCapMs: 10 * 60_000,
  /** After SIGTERM, a generation that has not exited is killed. */
  killGraceMs: 5_000,
  /** A trial that exits this soon after `ready` is a failed trial, not committed. */
  commitGraceMs: 1_000,
  /**
   * Stopping the supervisor drains for at most this long, voice sessions
   * included, so it finishes inside service managers' stop timeouts.
   */
  stopDrainCapMs: 30_000,
});

export const RESTART_DEFAULTS: Readonly<RestartPolicy> = Object.freeze({
  initialBackoffMs: 1_000,
  maxBackoffMs: 30_000,
  /** A generation serving this long resets the backoff. */
  stableAfterMs: 60_000,
  /** This many crashes within `failureWindowMs` makes the supervisor give up. */
  maxFailures: 5,
  failureWindowMs: 5 * 60_000,
});

// ---------------------------------------------------------------------------
// Control channel: client -> supervisor

export interface HelloMessage {
  type: 'hello';
  protocol: ProtocolVersion;
  token: string;
  client: { kind: string; version: string };
  capabilities: string[];
}

export interface StatusRequest {
  type: 'status';
  id: string;
}

export interface HandoffRequest {
  type: 'handoff';
  id: string;
  /** Absolute path of the core entry for the next generation. Defaults to the active entry. */
  entry?: string;
  readinessTimeoutMs?: number;
  drainDeadlineMs?: number;
}

export interface StopRequest {
  type: 'stop';
  id: string;
  drainDeadlineMs?: number;
}

/** Requires the `events` capability. */
export interface SubscribeRequest {
  type: 'subscribe';
  id: string;
}

export type ControlRequest =
  | StatusRequest
  | HandoffRequest
  | StopRequest
  | SubscribeRequest;

// ---------------------------------------------------------------------------
// Control channel: supervisor -> client

export interface WelcomeMessage {
  type: 'welcome';
  protocol: ProtocolVersion;
  supervisor: { pid: number; version: string; instance: string };
  /** The negotiated capabilities: the client's request intersected with the supervisor's. */
  capabilities: SupervisorCapability[];
}

export type RefusedReason = 'protocol-major' | 'auth' | 'bad-hello';

export interface RefusedMessage {
  type: 'refused';
  reason: RefusedReason;
  protocol: ProtocolVersion;
}

export type ErrorCode = 'unsupported' | 'bad-request' | 'line-too-long';

export interface ErrorMessage {
  type: 'error';
  id?: string;
  code: ErrorCode;
  message: string;
}

export type GenerationState =
  | 'starting'
  | 'parked'
  | 'promoted'
  | 'serving'
  | 'draining'
  | 'exited';

export interface GenerationStatus {
  generation: number;
  pid: number | null;
  entry: string;
  state: GenerationState;
  bootId: string | null;
  port: number | null;
}

export type SupervisorState =
  | 'starting'
  | 'serving'
  | 'handoff'
  | 'restarting'
  | 'stopping';

export interface ListenerStatus {
  name: string;
  port: number;
}

export interface SupervisorStatus {
  supervisor: {
    pid: number;
    version: string;
    instance: string;
    protocol: ProtocolVersion;
  };
  state: SupervisorState;
  active: GenerationStatus | null;
  trial: GenerationStatus | null;
  listeners: ListenerStatus[];
  restarts: { consecutiveFailures: number; lastBackoffMs: number | null };
}

export interface StatusResult {
  type: 'status.result';
  id: string;
  status: SupervisorStatus;
}

export type HandoffPhase =
  | 'trial-started'
  | 'trial-parked'
  | 'draining'
  | 'drained'
  | 'promoted'
  | 'rolling-back';

export interface HandoffProgress {
  type: 'handoff.progress';
  id: string;
  phase: HandoffPhase;
  generation: number;
}

export type HandoffOutcome = 'committed' | 'rolled-back' | 'refused';

export interface HandoffResult {
  type: 'handoff.result';
  id: string;
  outcome: HandoffOutcome;
  reason?: string;
  /** The generation serving after the handoff, if any. */
  generation?: number;
  bootId?: string;
}

export interface StopResult {
  type: 'stop.result';
  id: string;
  accepted: boolean;
}

export interface SubscribeResult {
  type: 'subscribe.result';
  id: string;
}

export type SupervisorEvent =
  | { type: 'generation'; generation: GenerationStatus }
  | {
      type: 'handoff';
      phase: HandoffPhase | HandoffOutcome;
      generation: number;
    }
  | { type: 'restart'; generation: number; backoffMs: number }
  | { type: 'gave-up'; failures: number }
  | { type: 'stopping' };

export interface EventMessage {
  type: 'event';
  event: SupervisorEvent;
}

export type ControlServerMessage =
  | WelcomeMessage
  | RefusedMessage
  | ErrorMessage
  | StatusResult
  | HandoffProgress
  | HandoffResult
  | StopResult
  | SubscribeResult
  | EventMessage;

// ---------------------------------------------------------------------------
// Generation IPC: core -> supervisor. A handle accompanies `listener.bound`
// and `listener.spare`.

/**
 * Sent with the listening handle as the second argument of `process.send`.
 * The handle must be the server's raw handle, `server._handle` (a TCP or Pipe
 * wrap), never the `net.Server` itself: sending the server makes Node rebuild
 * a listening server in the supervisor, which would accept connections and
 * never answer them. The supervisor refuses anything but a raw handle, closes
 * it, and fails the generation. A connected TCP wrap is refused too (its
 * `getpeername` succeeds, a listening one's fails). A connected Pipe wrap
 * cannot be told apart from a listening one, so that case is not checked.
 * No other message may carry a handle; one that does is closed.
 */
export interface ListenerBoundMessage {
  type: 'listener.bound';
  name: string;
  port: number;
}

/**
 * Answers `listener.spares` (protocol 1.1): one more copy of the named
 * listener's raw handle, sent as `listener.bound` sends one.
 */
export interface ListenerSpareMessage {
  type: 'listener.spare';
  name: string;
}

/**
 * Protocol 1.1: this generation now listens on the named adopted listener.
 * Connections the supervisor held for it during a handoff go to the first
 * generation that says so, as the kernel backlog would hand them to the
 * first one that accepts.
 */
export interface ListenerListeningMessage {
  type: 'listener.listening';
  name: string;
}

/** Code is loaded; the home has not been touched. */
export interface ParkedMessage {
  type: 'parked';
  /**
   * Protocol 1.1: this core speaks connection catching. It answers
   * `listener.spares` while listening, reports `listener.listening`, and
   * serves `connection.adopt` (see `ListenerSparesMessage`). A supervisor catches during a handoff only when
   * both the generation it drains and the trial said so; a 1.0 core ignores
   * `listener.spares` and closes an adopted connection as a stray handle.
   */
  adoptsConnections?: boolean;
}

export interface ReadyMessage {
  type: 'ready';
  bootId: string;
  port: number;
}

export interface DrainProgressMessage {
  type: 'drain.progress';
  voiceSessions: number;
}

export interface DrainedMessage {
  type: 'drained';
}

/** The core asks for a handoff, for example after the in-app update fetched new code. */
export interface CoreHandoffRequestMessage {
  type: 'handoff.request';
  requestId: string;
  entry?: string;
  readinessTimeoutMs?: number;
  drainDeadlineMs?: number;
}

export type CoreToSupervisorMessage =
  | ListenerBoundMessage
  | ListenerSpareMessage
  | ListenerListeningMessage
  | ParkedMessage
  | ReadyMessage
  | DrainProgressMessage
  | DrainedMessage
  | CoreHandoffRequestMessage;

// ---------------------------------------------------------------------------
// Generation IPC: supervisor -> core. A handle accompanies `listener.adopt`
// and `connection.adopt`.

/**
 * Leave the parked state and boot. `listeners` names every handle that follows
 * in `listener.adopt` messages; an empty list means bind normally and report
 * each listener with `listener.bound`.
 */
export interface PromoteMessage {
  type: 'promote';
  listeners: string[];
}

export interface ListenerAdoptMessage {
  type: 'listener.adopt';
  name: string;
}

/**
 * Protocol 1.1, sent when the supervisor catches connections (it decides:
 * on Windows only, unless a test forces it), to a generation that listens on
 * the named listener, before it is drained: answer with `count` (1 to
 * MAX_LISTENER_SPARES) `listener.spare` messages for that listener, then,
 * when the drain comes, close it only once no connection has reached it for
 * a short quiet window.
 *
 * Why: libuv on Windows keeps accepts (`AcceptEx`) posted on a listening
 * socket, and Windows completes a new connection into one as soon as its
 * handshake ends. Closing the listener closes those accepts, resetting any
 * connection already completed into one; POSIX leaves such connections in
 * the shared backlog. Windows hands a connection to the most recently posted
 * accept, so once the supervisor listens on the spares, connections go to it
 * instead of the generation about to close. The supervisor holds what it
 * accepts, unread, and passes it with `connection.adopt` to the next
 * generation that reports the listener listening (`listener.listening`) or,
 * failing that, ready: the trial, or the generation a rollback starts. Once
 * no connection has reached the spares for a quiet window, it closes them. A
 * 1.0 core ignores this message.
 */
export interface ListenerSparesMessage {
  type: 'listener.spares';
  name: string;
  count: number;
}

/** Most spares one `listener.spares` may ask for. */
export const MAX_LISTENER_SPARES = 32;

/**
 * Protocol 1.1: a connection the supervisor accepted during a handoff, sent
 * with the connected socket; nothing has been read from it. Serve it on the
 * named listener as if that listener had accepted it. A core that has no
 * such listener closes it: a connection held for a listener the adopting
 * generation never binds is lost.
 */
export interface ConnectionAdoptMessage {
  type: 'connection.adopt';
  name: string;
}

/**
 * Stop accepting, finish in-flight work, and exit. `deadlineMs` bounds how
 * long the core waits for in-flight HTTP connections. A missing, non-finite,
 * or non-positive value is 0: the core does not wait for HTTP connections.
 * Live voice calls are waited for either way; the supervisor's voice cap
 * bounds that wait.
 */
export interface DrainMessage {
  type: 'drain';
  deadlineMs: number;
}

/** Answers a core `handoff.request` the supervisor will not run. */
export interface CoreHandoffRefusedMessage {
  type: 'handoff.refused';
  requestId: string;
  reason: string;
}

export type SupervisorToCoreMessage =
  | PromoteMessage
  | ListenerAdoptMessage
  | ListenerSparesMessage
  | ConnectionAdoptMessage
  | DrainMessage
  | CoreHandoffRefusedMessage;

// ---------------------------------------------------------------------------
// Control endpoint derivation

/**
 * Longest usable Unix socket path in bytes, excluding the terminating NUL.
 * `sun_path` is 104 bytes on macOS and the BSDs and 108 on Linux.
 */
export function unixSocketPathLimit(platform: NodeJS.Platform): number {
  return platform === 'linux' ? 107 : 103;
}

export interface ControlEndpoint {
  /** Socket path, or named pipe path on Windows. */
  path: string;
  tokenPath: string;
  /** Set when the run-directory socket path was too long and a hashed temp path is used. */
  fallbackDir: string | null;
}

function endpointHash(home: string, instance: string): string {
  return createHash('sha256').update(`${home}\0${instance}`).digest('hex');
}

const INSTANCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidInstanceId(instance: string): boolean {
  return INSTANCE_PATTERN.test(instance);
}

/**
 * The supervisor's private run directory for `home`: the instance lock
 * epochs, control socket, token, and generation registry. It is a sibling of
 * the home, `<parent>/.<home name>.station-supervisor`, never inside it: a home
 * schema migration copies the home aside and replaces it, which would move a
 * live lock and socket out from under a running supervisor (a copy skips the
 * socket). The parent is already writable wherever Station runs, since the
 * home schema gate keeps its mutation lock there too.
 */
export function supervisorRunDir(
  home: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const path = pathFor(platform);
  const resolved = path.resolve(home);
  const name = path.basename(resolved);
  if (name === '' || path.dirname(resolved) === resolved) {
    throw new Error(`a Station home cannot be a filesystem root: ${resolved}`);
  }
  return path.join(path.dirname(resolved), `.${name}.station-supervisor`);
}

/** Paths in the flavor of the platform they are derived for. */
function pathFor(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix;
}

/**
 * Where the supervisor for `instance` in `home` listens. Clients and the
 * supervisor derive the same answer, so no discovery file is needed.
 */
export function resolveControlEndpoint(options: {
  home: string;
  instance: string;
  platform?: NodeJS.Platform;
  tmp?: string;
  uid?: number;
}): ControlEndpoint {
  const platform = options.platform ?? process.platform;
  if (!isValidInstanceId(options.instance)) {
    throw new Error(`invalid supervisor instance id: ${options.instance}`);
  }
  const { join, resolve } = pathFor(platform);
  const home = resolve(options.home);
  const runDir = supervisorRunDir(home, platform);
  const tokenPath = join(runDir, `supervisor-${options.instance}.token`);
  const hash = endpointHash(home, options.instance);
  if (platform === 'win32') {
    return {
      path: `\\\\.\\pipe\\station-supervisor-${hash}`,
      tokenPath,
      fallbackDir: null,
    };
  }
  const inRunDir = join(runDir, `supervisor-${options.instance}.sock`);
  if (Buffer.byteLength(inRunDir) <= unixSocketPathLimit(platform)) {
    return { path: inRunDir, tokenPath, fallbackDir: null };
  }
  const uid = options.uid ?? process.getuid?.() ?? 0;
  // The per-user temp directory first (private on macOS), then /tmp: a long
  // TMPDIR can leave no room for the socket name. Kept short either way.
  const bases = [options.tmp ?? tmpdir(), '/tmp'];
  for (const base of bases) {
    const fallbackDir = join(base, `station-sv-${uid}`);
    const fallback = join(fallbackDir, `${hash.slice(0, 24)}.sock`);
    if (Buffer.byteLength(fallback) <= unixSocketPathLimit(platform)) {
      return { path: fallback, tokenPath, fallbackDir };
    }
  }
  throw new Error(
    `no supervisor control socket path fits within the socket path limit for ${home}`,
  );
}
