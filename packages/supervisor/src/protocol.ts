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
import { join, resolve } from 'node:path';

export const SUPERVISOR_PROTOCOL = Object.freeze({ major: 1, minor: 0 });

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
// Generation IPC: core -> supervisor. A handle accompanies `listener.bound`.

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

/** Code is loaded; the home has not been touched. */
export interface ParkedMessage {
  type: 'parked';
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
  | ParkedMessage
  | ReadyMessage
  | DrainProgressMessage
  | DrainedMessage
  | CoreHandoffRequestMessage;

// ---------------------------------------------------------------------------
// Generation IPC: supervisor -> core. A handle accompanies `listener.adopt`.

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

/** Stop accepting, finish in-flight work, and exit. */
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
  /** Set when the in-home socket path was too long and a hashed temp path is used. */
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
  const home = resolve(options.home);
  const runDir = join(home, 'run');
  const tokenPath = join(runDir, `supervisor-${options.instance}.token`);
  const hash = endpointHash(home, options.instance);
  if (platform === 'win32') {
    return {
      path: `\\\\.\\pipe\\station-supervisor-${hash}`,
      tokenPath,
      fallbackDir: null,
    };
  }
  const inHome = join(runDir, `supervisor-${options.instance}.sock`);
  if (Buffer.byteLength(inHome) <= unixSocketPathLimit(platform)) {
    return { path: inHome, tokenPath, fallbackDir: null };
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
