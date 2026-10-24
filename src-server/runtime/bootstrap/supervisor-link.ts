/**
 * The core server's side of the Station supervisor IPC protocol, and the one
 * place Station's stable listeners are bound.
 *
 * A supervisor (`packages/supervisor`) forks each core generation with an IPC
 * channel and `STATION_SUPERVISOR_IPC=1`. The generation:
 *
 * 1. loads its code and reports `parked` without touching the Station home;
 * 2. on `promote`, adopts every listening handle the supervisor holds
 *    (`listener.adopt`), or binds normally and hands each raw handle back
 *    (`listener.bound`) when the supervisor holds none yet;
 * 3. reports `ready` once every listener is bound;
 * 4. on `drain`, stops accepting (new connections wait in the supervisor's
 *    backlog or, on Windows, in its spare listeners), marks every response `Connection: close`, ends event streams,
 *    and waits for requests already in progress, bounded by the drain
 *    deadline; then it shuts down and exits. A request still running past
 *    that bound is cut off when the process exits.
 *
 * An unsupervised process uses the same `listen` seam through the direct
 * link, so every stable listener has one code path. The link is
 * process-global because the IPC channel it wraps is (`process.send`).
 */
import { randomUUID } from 'node:crypto';
import type {
  Server as HttpServer,
  IncomingMessage,
  ServerResponse,
} from 'node:http';
import { Server as NetServer, Socket } from 'node:net';
import {
  type CoreHandoffOutcomeMessage,
  type CoreToSupervisorMessage,
  type HandoffPhase,
  MAX_LISTENER_SPARES,
  SUPERVISOR_ENV,
} from '@kontourai/station-supervisor/protocol';

/** Stable listeners the supervisor holds across generations. */
const SUPERVISOR_LISTENER_NAMES = Object.freeze([
  'api',
  'terminal',
  'voice',
  'consent',
] as const);
export type SupervisorListenerName = (typeof SUPERVISOR_LISTENER_NAMES)[number];

/**
 * Closing an idle keep-alive connection races a client that has already sent
 * its next request: the unread request turns the close into a reset. Draining
 * therefore marks every response `Connection: close` first and closes only
 * the connections still idle after this grace.
 */
const DRAIN_IDLE_GRACE_MS = 1_000;
/** How often a drain re-checks for connections that have gone idle. */
const DRAIN_SWEEP_INTERVAL_MS = 100;
/** A drain stops waiting for requests this long before its deadline. */
const DRAIN_DEADLINE_MARGIN_MS = 2_000;
/**
 * A drain that follows `listener.spares` (a Windows handoff) closes this
 * generation's listeners only once no connection has reached them for
 * DRAIN_QUIET_CLOSE_MS, or DRAIN_QUIET_CAP_MS after the drain began. Closing
 * a listener on Windows resets a connection already completed into one of
 * its pending accepts; the supervisor's spares take new connections, but one
 * can complete here just before they do. Without this wait a Windows host
 * saw such a reset in 3 of 700 handoffs; with it, in none of 700.
 */
const DRAIN_QUIET_CLOSE_MS = 50;
const DRAIN_QUIET_CAP_MS = 1_000;
/** After `promote`, every named handle must arrive within this time. */
const ADOPT_TIMEOUT_MS = 10_000;
/** After the supervisor disconnects, graceful shutdown gets this long. */
const DISCONNECT_FORCE_EXIT_MS = 20_000;
/** A `handoff.request` that is neither refused nor drained within this time settles as unanswered. */
const HANDOFF_REQUEST_TIMEOUT_MS = 30_000;

export interface ListenAddress {
  port: number;
  host?: string;
}

export interface ListenerLink {
  readonly supervised: boolean;
  /**
   * Starts `server` listening as the named stable listener: on the handle the
   * supervisor adopted for it, or on `address` (reported back to a
   * supervisor). Resolves with the port it listens on.
   */
  listen(
    name: SupervisorListenerName,
    server: NetServer,
    address: ListenAddress,
  ): Promise<{ port: number }>;
  /**
   * Tells the link a connection left HTTP for another protocol (a WebSocket
   * upgrade); its owner ends it, so a drain no longer waits for it. Only the
   * upgrade's owner calls this: adding an 'upgrade' listener to a server
   * makes Node hand every `Connection: Upgrade` request to it instead of the
   * request handler.
   */
  upgraded(socket: Socket): void;
}

/** The parts of `process` the link uses; tests inject a fake. */
export interface SupervisorChannelProcess {
  readonly env: NodeJS.ProcessEnv;
  readonly connected?: boolean;
  send?: (
    message: CoreToSupervisorMessage,
    sendHandle?: unknown,
    options?: undefined,
    callback?: (error: Error | null) => void,
  ) => boolean;
  on(
    event: 'message',
    listener: (message: unknown, handle: unknown) => void,
  ): unknown;
  on(event: 'disconnect', listener: () => void): unknown;
  exit(code: number): void;
}

export interface SupervisorLinkOptions {
  process?: SupervisorChannelProcess;
  adoptTimeoutMs?: number;
  drainIdleGraceMs?: number;
  disconnectForceExitMs?: number;
  log?: (message: string) => void;
}

export interface DrainRequest {
  deadlineMs: number;
  /** `supervisor` for a `drain` message; `signal` when SIGTERM started it. */
  source: 'supervisor' | 'signal';
  /**
   * Settles once every HTTP connection has closed, or when the bound (the
   * deadline less a margin) passes; `lingering` counts the connections still
   * open then.
   */
  connectionsSettled: Promise<{ lingering: number }>;
}

/**
 * The drain's bound on waiting for connections: the deadline less a margin,
 * never less than the idle grace, and never more than the deadline itself.
 * A deadline of zero or less (or not a number) is zero: shut down now.
 */
export function drainWaitBoundMs(deadlineMs: number, graceMs: number): number {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) return 0;
  const margin = Math.min(DRAIN_DEADLINE_MARGIN_MS, deadlineMs / 5);
  return Math.min(deadlineMs, Math.max(graceMs, deadlineMs - margin));
}

const EVENT_STREAM_HEADER = /\r\ncontent-type:\s*text\/event-stream/i;

/**
 * Whether a response is a server-sent event stream. Station's HTTP adapter
 * writes its headers in one `writeHead`, which `getHeader` cannot read back,
 * so this reads the header block Node already sent (`_header`).
 */
function isEventStream(res: ServerResponse): boolean {
  const header: unknown = Reflect.get(res, '_header');
  return typeof header === 'string' && EVENT_STREAM_HEADER.test(header);
}

export type HandoffRequestOutcome =
  | { status: 'refused'; reason: string }
  | { status: 'draining' }
  /** The handoff failed before this generation was drained; it still serves. */
  | { status: 'rolled-back'; reason?: string }
  | { status: 'unanswered' }
  | { status: 'unsupervised' };

/**
 * What a handoff left serving, told to the generation that serves (protocol
 * 1.2). `requestId` is the `handoff.request` that started it, or null for a
 * handoff a control client (`station restart`) started.
 */
export interface HandoffOutcomeReport {
  requestId: string | null;
  outcome: CoreHandoffOutcomeMessage['outcome'];
  reason?: string;
  generation: number;
}

export interface SupervisorHandoffOptions {
  /** The next generation's entry; default the entry running now. */
  entry?: string;
  readinessTimeoutMs?: number;
  drainDeadlineMs?: number;
  /** How long to wait for the handoff to start (this generation drains) or be refused. */
  timeoutMs?: number;
  /** Each phase of this handoff the supervisor reports while this generation runs. */
  onProgress?: (phase: HandoffPhase, generation: number) => void;
}

interface ClosableHandle {
  close(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isClosable(value: unknown): value is ClosableHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { close?: unknown }).close === 'function'
  );
}

function closeQuietly(handle: unknown): void {
  if (!isClosable(handle)) return;
  try {
    handle.close();
  } catch {
    // Already closed.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isListenerName(name: string): name is SupervisorListenerName {
  return (SUPERVISOR_LISTENER_NAMES as readonly string[]).includes(name);
}

function listenOn(
  server: NetServer,
  start: (server: NetServer) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    try {
      start(server);
    } catch (error) {
      server.removeListener('error', onError);
      server.removeListener('listening', onListening);
      reject(error);
    }
  });
}

function boundPort(server: NetServer, fallback: number): number {
  const address = server.address();
  return typeof address === 'object' && address ? address.port : fallback;
}

/**
 * Closes a stable listener on shutdown without throwing or hanging when it is
 * already closed, as it is after a supervisor drain. A listening server
 * closes as `server.close()` always has; one that no longer listens only has
 * its idle connections closed. Its promise does not wait for a connection
 * served with `connection.adopt`, which net.Server does not count; a drain
 * waits for those through the link's own connection set before shutdown
 * reaches here, but a shutdown without a drain (SIGINT, or the supervisor
 * gone) does not.
 */
export function closeStableListener(server: NetServer): Promise<void> {
  if (!server.listening) {
    (server as Partial<HttpServer>).closeIdleConnections?.call(server);
    return Promise.resolve();
  }
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Binds directly; the link of every unsupervised process. */
export const DIRECT_LISTENER_LINK: ListenerLink = Object.freeze({
  supervised: false,
  async listen(
    _name: SupervisorListenerName,
    server: NetServer,
    address: ListenAddress,
  ) {
    await listenOn(server, (target) =>
      target.listen(address.port, address.host),
    );
    return { port: boundPort(server, address.port) };
  },
  upgraded() {},
});

export class SupervisorLink implements ListenerLink {
  readonly supervised = true;
  private readonly proc: SupervisorChannelProcess;
  private readonly adoptTimeoutMs: number;
  private readonly drainIdleGraceMs: number;
  private readonly disconnectForceExitMs: number;
  private readonly log: (message: string) => void;
  private expected: Set<string> | null = null;
  private parkSettled = false;
  private readonly adopted = new Map<string, unknown>();
  /** The server listening as each stable listener. */
  private readonly named = new Map<SupervisorListenerName, NetServer>();
  private readonly servers = new Set<NetServer>();
  /** When a tracked server last accepted a connection. */
  private lastAcceptAt = 0;
  /** Spares went to the supervisor: the next drain closes listeners when quiet. */
  private sparesSent = false;
  /** Open HTTP connections on tracked servers; upgraded sockets are not HTTP. */
  private readonly connections = new Set<Socket>();
  private readonly responses = new Set<ServerResponse>();
  private readonly pendingListens = new Set<Promise<unknown>>();
  private readonly drainListeners = new Set<(request: DrainRequest) => void>();
  private readonly handoffWaiters = new Map<
    string,
    (outcome: HandoffRequestOutcome) => void
  >();
  private readonly handoffProgress = new Map<
    string,
    (phase: HandoffPhase, generation: number) => void
  >();
  private readonly outcomeListeners = new Set<
    (report: HandoffOutcomeReport) => void
  >();
  /** An outcome that arrived before anything listened; the first listener gets it. */
  private unheardOutcome: HandoffOutcomeReport | null = null;
  private resolvePark: (() => void) | null = null;
  private rejectPark: ((error: Error) => void) | null = null;
  private adoptTimer: ReturnType<typeof setTimeout> | null = null;
  private shutdownHandler: (() => Promise<void> | void) | null = null;
  private disconnected = false;
  private drainRequest: DrainRequest | null = null;

  constructor(options: SupervisorLinkOptions = {}) {
    this.proc = options.process ?? (process as SupervisorChannelProcess);
    this.adoptTimeoutMs = options.adoptTimeoutMs ?? ADOPT_TIMEOUT_MS;
    this.drainIdleGraceMs = options.drainIdleGraceMs ?? DRAIN_IDLE_GRACE_MS;
    this.disconnectForceExitMs =
      options.disconnectForceExitMs ?? DISCONNECT_FORCE_EXIT_MS;
    this.log =
      options.log ??
      ((message) =>
        process.stderr.write(`[station supervisor-link] ${message}\n`));
    this.proc.on('message', (message, handle) =>
      this.onMessage(message, handle),
    );
    this.proc.on('disconnect', () => this.onDisconnect());
  }

  get draining(): boolean {
    return this.drainRequest !== null;
  }

  /** Reports `parked`; resolves once promoted with every named handle adopted. */
  park(): Promise<void> {
    const parked = new Promise<void>((resolve, reject) => {
      this.resolvePark = resolve;
      this.rejectPark = reject;
    });
    this.send({
      type: 'parked',
      adoptsConnections: true,
      capabilities: ['handoff-events'],
    });
    return parked;
  }

  /**
   * The port an adopted listener is bound to, read from its raw handle with
   * `getsockname`, which is what `net.Server#address()` itself calls. Reading
   * it this way leaves the handle untouched; listening on it to ask the
   * server would make closing that probe close the only copy of the handle.
   */
  adoptedPort(name: SupervisorListenerName): number | null {
    const handle = this.adopted.get(name) as
      | { getsockname?: (out: Record<string, unknown>) => number }
      | undefined;
    if (typeof handle?.getsockname !== 'function') return null;
    const out: Record<string, unknown> = {};
    try {
      if (handle.getsockname(out) !== 0) return null;
    } catch {
      return null;
    }
    return typeof out.port === 'number' ? out.port : null;
  }

  listen(
    name: SupervisorListenerName,
    server: NetServer,
    address: ListenAddress,
  ): Promise<{ port: number }> {
    const work = this.listenNow(name, server, address);
    this.pendingListens.add(work);
    void work.then(
      () => this.pendingListens.delete(work),
      () => this.pendingListens.delete(work),
    );
    return work;
  }

  private async listenNow(
    name: SupervisorListenerName,
    server: NetServer,
    address: ListenAddress,
  ): Promise<{ port: number }> {
    if (this.draining) {
      throw new Error(
        `refusing to start listener ${name}: this generation is draining`,
      );
    }
    this.track(server);
    this.named.set(name, server);
    const handle = this.adopted.get(name);
    if (handle !== undefined) {
      this.adopted.delete(name);
      try {
        await listenOn(server, (target) =>
          target.listen(handle as Parameters<NetServer['listen']>[0]),
        );
      } catch (error) {
        // Ours alone now; the supervisor keeps its own copy.
        closeQuietly(handle);
        throw error;
      }
      // Connections the supervisor held for this listener come here now.
      this.send({ type: 'listener.listening', name });
      const bound = server.address();
      if (typeof bound === 'object' && bound) {
        // The held socket wins: say so when configuration asks for another.
        if (address.port !== 0 && address.port !== bound.port) {
          this.log(
            `listener ${name}: configured port ${address.port} differs from the supervisor-held port ${bound.port}; serving on ${bound.port}`,
          );
        }
        if (address.host && address.host !== bound.address) {
          this.log(
            `listener ${name}: configured host ${address.host} differs from the supervisor-held address ${bound.address}; serving on ${bound.address}`,
          );
        }
      }
      return { port: boundPort(server, address.port) };
    }
    await listenOn(server, (target) =>
      target.listen(address.port, address.host),
    );
    const port = boundPort(server, address.port);
    // The raw wrap, never the server: a sent net.Server becomes a listening
    // server in the supervisor that accepts connections it never answers.
    const raw: unknown = Reflect.get(server, '_handle');
    this.send({ type: 'listener.bound', name, port }, raw);
    return { port };
  }

  /** Sends `ready` once every listener started so far has settled. */
  async ready(bootId: string, port: number): Promise<void> {
    while (this.pendingListens.size > 0) {
      await Promise.allSettled([...this.pendingListens]);
    }
    // Promoted handles this generation does not serve: the supervisor keeps
    // its own copy, so closing ours only releases the descriptor.
    for (const [name, handle] of this.adopted) {
      this.log(
        `closing adopted handle ${name}: this generation does not serve it`,
      );
      closeQuietly(handle);
    }
    this.adopted.clear();
    this.send({ type: 'ready', bootId, port });
  }

  /**
   * Drains as if the supervisor had asked, for a supervised generation that
   * receives SIGTERM: the supervisor kills it after `deadlineMs`.
   */
  beginDrain(deadlineMs: number): DrainRequest {
    this.startDrain(deadlineMs, 'signal');
    return this.drainRequest as DrainRequest;
  }

  onDrain(listener: (request: DrainRequest) => void): () => void {
    this.drainListeners.add(listener);
    if (this.drainRequest) listener(this.drainRequest);
    return () => this.drainListeners.delete(listener);
  }

  reportDrainProgress(voiceSessions: number): void {
    this.send({ type: 'drain.progress', voiceSessions });
  }

  /** Sends `drained`; resolves once the message is flushed (or cannot be). */
  reportDrained(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.send({ type: 'drained' }, undefined, () => resolve())) {
        resolve();
      }
    });
  }

  /** How a supervisor disconnect shuts this process down once boot can. */
  setShutdownHandler(handler: () => Promise<void> | void): void {
    this.shutdownHandler = handler;
  }

  /**
   * Asks the supervisor to hand off to a new generation. Settles on
   * `handoff.refused`, on this generation's drain (the handoff is running),
   * or as `unanswered` after the timeout.
   */
  requestHandoff(
    options: SupervisorHandoffOptions = {},
  ): Promise<HandoffRequestOutcome> {
    if (this.draining) return Promise.resolve({ status: 'draining' });
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => finish({ status: 'unanswered' }),
        options.timeoutMs ?? HANDOFF_REQUEST_TIMEOUT_MS,
      );
      timer.unref?.();
      const finish = (outcome: HandoffRequestOutcome) => {
        clearTimeout(timer);
        this.handoffWaiters.delete(requestId);
        // Progress keeps flowing while this generation drains; a refusal,
        // a rollback or a timeout ends it.
        if (outcome.status !== 'draining') {
          this.handoffProgress.delete(requestId);
        }
        resolve(outcome);
      };
      this.handoffWaiters.set(requestId, finish);
      if (options.onProgress) {
        this.handoffProgress.set(requestId, options.onProgress);
      }
      const sent = this.send({
        type: 'handoff.request',
        requestId,
        ...(options.entry !== undefined ? { entry: options.entry } : {}),
        ...(options.readinessTimeoutMs !== undefined
          ? { readinessTimeoutMs: options.readinessTimeoutMs }
          : {}),
        ...(options.drainDeadlineMs !== undefined
          ? { drainDeadlineMs: options.drainDeadlineMs }
          : {}),
      });
      if (!sent) finish({ status: 'unanswered' });
    });
  }

  /**
   * Reports each handoff outcome this generation is told about: the handoff
   * that left it serving, whether it is the new generation (`committed`) or
   * the previous entry serving again (`rolled-back`). An outcome that arrived
   * before any listener goes to the first one.
   */
  onHandoffOutcome(
    listener: (report: HandoffOutcomeReport) => void,
  ): () => void {
    this.outcomeListeners.add(listener);
    const unheard = this.unheardOutcome;
    if (unheard) {
      this.unheardOutcome = null;
      listener(unheard);
    }
    return () => this.outcomeListeners.delete(listener);
  }

  // -------------------------------------------------------------------------

  private send(
    message: CoreToSupervisorMessage,
    handle?: unknown,
    flushed?: () => void,
  ): boolean {
    const send = this.proc.send;
    if (typeof send !== 'function' || this.proc.connected === false) {
      return false;
    }
    try {
      // Always pass a callback: without one a closed channel is emitted as
      // an 'error' event on the process.
      return send.call(this.proc, message, handle, undefined, (error) => {
        if (error) this.log(`send ${message.type} failed: ${error.message}`);
        flushed?.();
      });
    } catch (error) {
      this.log(
        `send ${message.type} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private track(server: NetServer): void {
    if (this.servers.has(server)) return;
    this.servers.add(server);
    // Also sees connections served with `connection.adopt`, which net.Server
    // itself does not count: its close callback can fire while they are open,
    // so a drain waits on this set, never on that callback.
    server.on('connection', (socket: Socket) => {
      this.lastAcceptAt = Date.now();
      this.connections.add(socket);
      socket.once('close', () => this.connections.delete(socket));
    });
    // First, so the header is set before any route writes its response.
    server.prependListener(
      'request',
      (_req: IncomingMessage, res: ServerResponse) => {
        if (this.draining && !res.headersSent)
          res.setHeader('Connection', 'close');
        this.responses.add(res);
        res.once('close', () => this.responses.delete(res));
      },
    );
  }

  upgraded(socket: Socket): void {
    this.connections.delete(socket);
  }

  /** Ends server-sent event streams cleanly; clients reconnect into the backlog. */
  private endEventStreams(): void {
    for (const res of [...this.responses]) {
      if (res.writableEnded || !isEventStream(res)) continue;
      try {
        res.end();
      } catch {
        // Already torn down.
      }
    }
  }

  /**
   * Stops accepting on this generation's copy of each listener. The
   * supervisor still holds the sockets, so new connections wait in the kernel
   * backlog for the next generation. net.Server's close, not http.Server's:
   * the latter closes idle connections at once, racing a keep-alive client
   * whose next request is already on its way.
   */
  private async closeListeners(): Promise<void> {
    for (const server of this.servers) {
      if (server.listening) NetServer.prototype.close.call(server);
    }
  }

  /**
   * Closes the listeners once none has accepted for DRAIN_QUIET_CLOSE_MS (see
   * there), or after `capMs`. Until then this generation still answers new
   * connections, each response marked `Connection: close`.
   */
  private async closeListenersWhenQuiet(
    started: number,
    capMs: number,
  ): Promise<void> {
    for (;;) {
      const now = Date.now();
      const quietFor = now - this.lastAcceptAt;
      if (quietFor >= DRAIN_QUIET_CLOSE_MS) break;
      if (now - started >= capMs) {
        this.log(
          `drain: still accepting after ${capMs}ms; closing listeners anyway`,
        );
        break;
      }
      await sleep(
        Math.min(DRAIN_QUIET_CLOSE_MS - quietFor, capMs - (now - started)),
      );
    }
    await this.closeListeners();
  }

  private closeIdleConnections(): void {
    // Node closes only connections with no request in progress: one whose
    // next request has started arriving, even partially, is left to finish.
    for (const server of this.servers) {
      (server as Partial<HttpServer>).closeIdleConnections?.call(server);
    }
  }

  private onMessage(message: unknown, handle: unknown): void {
    if (!isRecord(message) || typeof message.type !== 'string') {
      closeQuietly(handle);
      return;
    }
    // Only listener.adopt and connection.adopt carry a handle; close one sent
    // with anything else.
    if (
      handle !== undefined &&
      message.type !== 'listener.adopt' &&
      message.type !== 'connection.adopt'
    ) {
      this.log(`closed a stray handle sent with ${message.type}`);
      closeQuietly(handle);
    }
    switch (message.type) {
      case 'promote':
        this.onPromote(message.listeners);
        return;
      case 'listener.adopt':
        this.onAdopt(message.name, handle);
        return;
      case 'listener.spares':
        this.onSpares(message.name, message.count);
        return;
      case 'connection.adopt':
        this.onConnectionAdopt(message.name, handle);
        return;
      case 'drain':
        this.startDrain(
          typeof message.deadlineMs === 'number' ? message.deadlineMs : 0,
          'supervisor',
        );
        return;
      case 'handoff.progress': {
        const requestId =
          typeof message.requestId === 'string' ? message.requestId : '';
        const listener = this.handoffProgress.get(requestId);
        if (
          listener &&
          typeof message.phase === 'string' &&
          typeof message.generation === 'number'
        ) {
          listener(message.phase as HandoffPhase, message.generation);
        }
        return;
      }
      case 'handoff.outcome':
        this.onHandoffOutcomeMessage(message);
        return;
      case 'handoff.refused': {
        const requestId =
          typeof message.requestId === 'string' ? message.requestId : '';
        this.handoffWaiters.get(requestId)?.({
          status: 'refused',
          reason: typeof message.reason === 'string' ? message.reason : '',
        });
        return;
      }
      default:
      // Minor protocol versions may add messages; ignore unknown ones.
    }
  }

  private onHandoffOutcomeMessage(message: Record<string, unknown>): void {
    const outcome = message.outcome;
    if (
      (outcome !== 'committed' && outcome !== 'rolled-back') ||
      typeof message.generation !== 'number'
    ) {
      this.log('ignored a malformed handoff.outcome');
      return;
    }
    const report: HandoffOutcomeReport = {
      requestId:
        typeof message.requestId === 'string' ? message.requestId : null,
      outcome,
      ...(typeof message.reason === 'string' ? { reason: message.reason } : {}),
      generation: message.generation,
    };
    // This generation asked and was never drained: its own request failed.
    if (report.requestId !== null && outcome === 'rolled-back') {
      this.handoffWaiters.get(report.requestId)?.({
        status: 'rolled-back',
        ...(report.reason !== undefined ? { reason: report.reason } : {}),
      });
    }
    if (this.outcomeListeners.size === 0) {
      this.unheardOutcome = report;
      return;
    }
    for (const listener of [...this.outcomeListeners]) listener(report);
  }

  private onPromote(listeners: unknown): void {
    if (this.expected !== null || this.parkSettled) {
      this.log('ignored a repeated promote');
      return;
    }
    if (
      !Array.isArray(listeners) ||
      !listeners.every((name) => typeof name === 'string')
    ) {
      this.failPark(new Error('supervisor sent a malformed promote'));
      return;
    }
    this.expected = new Set(listeners as string[]);
    if (this.expected.size > 0) {
      this.adoptTimer = setTimeout(() => {
        const missing = [...(this.expected ?? [])];
        this.failPark(
          new Error(
            `supervisor promoted with listeners it never sent: ${missing.join(', ')}`,
          ),
        );
      }, this.adoptTimeoutMs);
    }
    this.settleParkIfComplete();
  }

  private onAdopt(name: unknown, handle: unknown): void {
    const acceptable =
      typeof name === 'string' &&
      this.expected !== null &&
      this.expected.has(name) &&
      !this.parkSettled &&
      isClosable(handle);
    if (!acceptable) {
      this.log(`closed an unsolicited listener.adopt for ${String(name)}`);
      closeQuietly(handle);
      return;
    }
    this.expected?.delete(name);
    if (isListenerName(name)) {
      this.adopted.set(name, handle);
    } else {
      this.log(`closed adopted handle ${name}: not a listener this core knows`);
      closeQuietly(handle);
    }
    this.settleParkIfComplete();
  }

  /** Sends the supervisor `count` copies of a listener's raw handle. */
  private onSpares(name: unknown, count: unknown): void {
    const server =
      typeof name === 'string' && isListenerName(name)
        ? this.named.get(name)
        : undefined;
    const raw: unknown = server ? Reflect.get(server, '_handle') : undefined;
    if (
      !server?.listening ||
      raw === undefined ||
      this.draining ||
      typeof count !== 'number' ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > MAX_LISTENER_SPARES
    ) {
      this.log(
        `ignored listener.spares for ${String(name)} (${String(count)})`,
      );
      return;
    }
    this.sparesSent = true;
    for (let i = 0; i < count; i += 1) {
      this.send({ type: 'listener.spare', name: name as string }, raw);
    }
  }

  /** Serves a connection the supervisor held during a handoff. */
  private onConnectionAdopt(name: unknown, handle: unknown): void {
    if (!(handle instanceof Socket)) {
      this.log(`ignored connection.adopt for ${String(name)}: no socket`);
      closeQuietly(handle);
      return;
    }
    const server =
      typeof name === 'string' && isListenerName(name)
        ? this.named.get(name)
        : undefined;
    if (!server) {
      this.log(
        `closed an adopted connection for ${String(name)}: no such listener`,
      );
      handle.destroy();
      return;
    }
    server.emit('connection', handle);
    handle.resume();
  }

  private settleParkIfComplete(): void {
    if (this.parkSettled || this.expected === null || this.expected.size > 0) {
      return;
    }
    this.parkSettled = true;
    if (this.adoptTimer) clearTimeout(this.adoptTimer);
    this.resolvePark?.();
  }

  private failPark(error: Error): void {
    if (this.parkSettled) return;
    this.parkSettled = true;
    if (this.adoptTimer) clearTimeout(this.adoptTimer);
    for (const handle of this.adopted.values()) closeQuietly(handle);
    this.adopted.clear();
    this.rejectPark?.(error);
  }

  private startDrain(deadlineMs: number, source: DrainRequest['source']): void {
    if (this.drainRequest) return;
    const started = Date.now();
    const bound = drainWaitBoundMs(deadlineMs, this.drainIdleGraceMs);
    const listenersClosed = this.sparesSent
      ? this.closeListenersWhenQuiet(
          started,
          Math.min(DRAIN_QUIET_CAP_MS, bound),
        )
      : this.closeListeners();
    const connectionsSettled = (async () => {
      this.endEventStreams();
      await listenersClosed;
      // From here every response says Connection: close, so busy keep-alive
      // connections close after their response. Wait the grace before closing
      // idle ones, then keep closing connections as they go idle until none
      // is left or the bound passes.
      // A deadline shorter than the grace shortens the grace too.
      await sleep(Math.min(this.drainIdleGraceMs, bound));
      for (;;) {
        this.endEventStreams();
        this.closeIdleConnections();
        if (this.connections.size === 0) return { lingering: 0 };
        if (Date.now() - started >= bound) {
          this.log(
            `drain: ${this.connections.size} connection(s) still open after ${bound}ms; shutting down anyway`,
          );
          return { lingering: this.connections.size };
        }
        await sleep(DRAIN_SWEEP_INTERVAL_MS);
      }
    })();
    this.drainRequest = { deadlineMs, source, connectionsSettled };
    for (const settle of [...this.handoffWaiters.values()]) {
      settle({ status: 'draining' });
    }
    if (this.drainListeners.size === 0) {
      // Nothing booted far enough to drain: report and leave.
      void connectionsSettled
        .then(() => this.reportDrained())
        .then(() => this.proc.exit(0));
      return;
    }
    for (const listener of [...this.drainListeners]) {
      listener(this.drainRequest);
    }
  }

  private onDisconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.log('supervisor IPC channel disconnected; shutting down');
    this.failPark(new Error('supervisor disconnected'));
    const handler = this.shutdownHandler;
    if (!handler) {
      // Still booting or parked: nothing to shut down gracefully yet.
      this.proc.exit(1);
      return;
    }
    const timer = setTimeout(
      () => this.proc.exit(1),
      this.disconnectForceExitMs,
    );
    timer.unref?.();
    void Promise.resolve()
      .then(handler)
      .catch(() => this.proc.exit(1));
  }
}

/**
 * Parks this generation under its supervisor, if it has one. Resolves with
 * the promoted link, or null when the process is not supervised. Throws when
 * the environment claims supervision but there is no IPC channel.
 */
export async function parkUnderSupervisor(
  options: SupervisorLinkOptions = {},
): Promise<SupervisorLink | null> {
  const proc = options.process ?? (process as SupervisorChannelProcess);
  if (!isSupervisedEnvironment(proc.env)) return null;
  if (typeof proc.send !== 'function') {
    throw new Error(
      `${SUPERVISOR_ENV.ipc}=1 but this process has no IPC channel; a supervisor must fork it with an 'ipc' stdio entry`,
    );
  }
  const link = new SupervisorLink({ ...options, process: proc });
  await link.park();
  return link;
}

export function isSupervisedEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[SUPERVISOR_ENV.ipc] === '1';
}

let installedLink: ListenerLink | null = null;
let releaseHomeAccess: () => void = () => {};
const homeAccessAllowed = new Promise<void>((resolve) => {
  releaseHomeAccess = resolve;
});

export function installListenerLink(link: ListenerLink | null): void {
  installedLink = link;
}

/**
 * Asks this process's supervisor to hand off to a new generation: the
 * in-place restart path for code that has just been rebuilt or updated.
 * Settles `draining` once the handoff has started (this generation is being
 * drained and will exit), `refused` or `rolled-back` when this generation
 * keeps serving, `unanswered` after the timeout, and `unsupervised` when no
 * supervisor runs this process.
 */
export function requestSupervisorHandoff(
  options: SupervisorHandoffOptions = {},
): Promise<HandoffRequestOutcome> {
  const link = installedLink;
  if (!(link instanceof SupervisorLink)) {
    return Promise.resolve({ status: 'unsupervised' });
  }
  return link.requestHandoff(options);
}

/**
 * Reports the outcome of the handoff that left this generation serving
 * (see `SupervisorLink.onHandoffOutcome`). A no-op when unsupervised.
 */
export function onHandoffOutcome(
  listener: (report: HandoffOutcomeReport) => void,
): () => void {
  const link = installedLink;
  if (!(link instanceof SupervisorLink)) return () => {};
  return link.onHandoffOutcome(listener);
}

/** The link every stable listener binds through. */
export function listenerLink(): ListenerLink {
  return installedLink ?? DIRECT_LISTENER_LINK;
}

/**
 * Resolves once this process may touch the Station home: at once when
 * unsupervised, otherwise once the supervisor has promoted it. Import-time
 * work that writes to the home waits on this so a parked generation never
 * writes while the previous generation still owns the home.
 */
export function whenHomeAccessAllowed(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  return isSupervisedEnvironment(env) ? homeAccessAllowed : Promise.resolve();
}

/** Called by the entry point once promoted (or once it knows it is unsupervised). */
export function allowHomeAccess(): void {
  releaseHomeAccess();
}
