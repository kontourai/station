/**
 * Control channel v1: authenticated NDJSON over a local socket or named pipe.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from 'node:net';
import { dirname, join } from 'node:path';
import type {
  HandoffOptions,
  HandoffOutcomeResult,
} from './generation-manager.ts';
import {
  encodeLine,
  isRecord,
  LineTooLongError,
  NdjsonDecoder,
} from './ndjson.ts';
import { ensurePrivateDir } from './private-dir.ts';
import {
  CONTROL_HELLO_TIMEOUT_MS,
  CONTROL_MAX_CONNECTIONS,
  CONTROL_MAX_LINE_BYTES,
  CONTROL_MAX_SUBSCRIBER_BACKLOG_BYTES,
  type ControlEndpoint,
  type ControlServerMessage,
  type ErrorCode,
  type HandoffPhase,
  type RefusedReason,
  SUPERVISOR_CAPABILITIES,
  SUPERVISOR_PROTOCOL,
  type SupervisorCapability,
  type SupervisorEvent,
  type SupervisorStatus,
  unixSocketPathLimit,
} from './protocol.ts';

/** Upper bound for any client-supplied duration. */
const MAX_REQUEST_DURATION_MS = 60 * 60_000;
const MAX_ID_LENGTH = 128;
/** Private socket names younger than this may belong to a bind in flight. */
const LEFTOVER_MIN_AGE_MS = 60_000;
/** A refused client is disconnected within this time even if it never reads. */
const REFUSED_CLOSE_TIMEOUT_MS = 1_000;

export interface ControlHandlers {
  status(): SupervisorStatus;
  handoff(
    request: HandoffOptions,
    onProgress: (phase: HandoffPhase, generation: number) => void,
  ): Promise<HandoffOutcomeResult>;
  stop(drainDeadlineMs?: number): void;
  subscribe(listener: (event: SupervisorEvent) => void): () => void;
}

export interface ControlServerOptions {
  endpoint: ControlEndpoint;
  instance: string;
  version: string;
  handlers: ControlHandlers;
  platform?: NodeJS.Platform;
  log?: (message: string) => void;
  /** Test-only seams. */
  testHooks?: {
    /** Runs between moving the socket file aside and checking its inode. */
    afterMoveAside?: (aside: string) => void;
  };
  /** True while this process holds the instance lock's top epoch; gates replacing a stale socket file. */
  mayReplaceStaleSocket?: () => boolean;
  /** The uid directories must belong to. Tests replace it to exercise the foreign-owner refusal. */
  currentUid?: () => number | undefined;
}

/**
 * Ends a refused connection and destroys it once the reply is flushed, or
 * after a short bound if the peer never reads, so it cannot hold a slot.
 */
function closeAfterReply(socket: Socket): void {
  const timer = setTimeout(() => socket.destroy(), REFUSED_CLOSE_TIMEOUT_MS);
  timer.unref();
  socket.once('close', () => clearTimeout(timer));
  socket.end(() => socket.destroy());
}

/** Writes the token atomically with mode 0600. */
function writeToken(tokenPath: string, token: string): void {
  const temp = `${tokenPath}.${process.pid}.tmp`;
  const fd = openSync(temp, 'w', 0o600);
  try {
    writeSync(fd, token);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (process.platform !== 'win32') chmodSync(temp, 0o600);
  renameSync(temp, tokenPath);
}

/**
 * What is at a socket path: a listener (connect succeeded), nothing (refused
 * or no such file), or something we cannot judge (any other error).
 */
function probeSocket(
  path: string,
): Promise<'listening' | 'nothing' | 'unknown'> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve('unknown');
    }, 2_000);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve('listening');
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve(
        error.code === 'ECONNREFUSED' || error.code === 'ENOENT'
          ? 'nothing'
          : 'unknown',
      );
    });
  });
}

function tokensMatch(expected: string, offered: unknown): boolean {
  if (typeof offered !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(offered);
  return a.length === b.length && timingSafeEqual(a, b);
}

function optionalDuration(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > MAX_REQUEST_DURATION_MS
  ) {
    return null;
  }
  return value;
}

export class ControlServer {
  private server: Server | null = null;
  private token = '';
  private bound = false;
  private boundIdentity: { dev: number; ino: number } | null = null;
  private published = false;
  private readonly sockets = new Set<Socket>();
  private readonly platform: NodeJS.Platform;
  private readonly log: (message: string) => void;

  private readonly options: ControlServerOptions;

  constructor(options: ControlServerOptions) {
    this.options = options;
    this.platform = options.platform ?? process.platform;
    this.log = options.log ?? (() => {});
  }

  async listen(): Promise<void> {
    const { endpoint } = this.options;
    const currentUid = this.options.currentUid ?? (() => process.getuid?.());
    ensurePrivateDir(dirname(endpoint.tokenPath), this.platform, currentUid);
    if (this.platform !== 'win32') {
      ensurePrivateDir(dirname(endpoint.path), this.platform, currentUid);
    }
    // The token file is written only once this process owns the endpoint, so a
    // supervisor that loses the race never replaces the running one's token.
    this.token = randomBytes(32).toString('hex');
    await this.bind();
  }

  /**
   * Binds the endpoint. An existing socket file is replaced only when the
   * caller holds the instance lock's top epoch and connecting to the file is
   * refused or finds nothing; a live listener or any other outcome refuses.
   */
  private async bind(): Promise<void> {
    const { endpoint } = this.options;
    const refuseListening = () =>
      new Error(`a process is already listening at ${endpoint.path}`);
    // Always probe, even when the file looks absent: never assume the path is free.
    const found = await probeSocket(endpoint.path);
    if (found === 'listening') throw refuseListening();
    if (found === 'unknown') {
      throw new Error(
        `cannot tell what is at ${endpoint.path}; refusing to replace it`,
      );
    }
    if (this.platform === 'win32') {
      this.server = await this.listenOn(endpoint.path, refuseListening);
      this.bound = true;
      return;
    }
    let existing: ReturnType<typeof lstatSync> | null = null;
    try {
      existing = lstatSync(endpoint.path);
    } catch {
      existing = null;
    }
    if (existing) {
      if (!existing.isSocket()) {
        throw new Error(
          `refusing to replace non-socket file at ${endpoint.path}`,
        );
      }
      if (!(this.options.mayReplaceStaleSocket?.() ?? false)) {
        throw new Error(
          `refusing to replace ${endpoint.path} without holding the instance lock`,
        );
      }
      unlinkSync(endpoint.path);
    }
    // Node unlinks the path a Unix socket was bound to when the server closes,
    // whoever owns that path by then. So bind at a private name in the same
    // directory and publish it with link(), which refuses an existing path:
    // a close then only ever unlinks the private name, never the real path.
    const privateName = join(
      dirname(endpoint.path),
      `.s${randomBytes(3).toString('hex')}`,
    );
    // No direct-bind fallback: binding at the real path would bring back
    // Node's unlink-on-close of a path that may no longer be ours.
    if (Buffer.byteLength(privateName) > unixSocketPathLimit(this.platform)) {
      throw new Error(
        `control socket directory is too long for the socket's private bind name: ${endpoint.path}`,
      );
    }
    const server = await this.listenOn(privateName, refuseListening);
    chmodSync(privateName, 0o600);
    try {
      // Filesystems that refuse link() (some FUSE, SMB, 9p) fail closed here.
      linkSync(privateName, endpoint.path);
    } catch (error) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw (error as NodeJS.ErrnoException).code === 'EEXIST'
        ? refuseListening()
        : error;
    }
    unlinkSync(privateName);
    const bound = lstatSync(endpoint.path);
    this.boundIdentity = { dev: bound.dev, ino: bound.ino };
    this.bound = true;
    this.server = server;
  }

  private async listenOn(
    path: string,
    refuseListening: () => Error,
  ): Promise<Server> {
    const server = createServer((socket) => this.accept(socket));
    server.maxConnections = CONTROL_MAX_CONNECTIONS;
    await new Promise<void>((resolve, reject) => {
      server.once('error', (error: NodeJS.ErrnoException) =>
        reject(error.code === 'EADDRINUSE' ? refuseListening() : error),
      );
      server.listen(path, () => {
        server.removeAllListeners('error');
        resolve();
      });
    });
    server.on('error', (error) =>
      this.log(`control server error: ${String(error)}`),
    );
    return server;
  }

  /**
   * Whether the endpoint this process bound is still in place: on POSIX the
   * socket file must exist with the same device and inode; on Windows the pipe
   * server must still be listening.
   */
  socketIntact(): boolean {
    if (!this.server) return false;
    if (this.platform === 'win32') return this.server.listening;
    return this.socketFileIsOurs();
  }

  private removeOwnSocketFile(): void {
    const { path } = this.options.endpoint;
    if (!this.socketFileIsOurs()) return;
    const aside = join(dirname(path), `.d${randomBytes(3).toString('hex')}`);
    try {
      renameSync(path, aside);
    } catch {
      return;
    }
    this.options.testHooks?.afterMoveAside?.(aside);
    try {
      const moved = lstatSync(aside);
      if (
        moved.dev === this.boundIdentity?.dev &&
        moved.ino === this.boundIdentity?.ino
      ) {
        unlinkSync(aside);
        return;
      }
      // Replaced between the check and the rename: put it back untouched.
      // Residual race (accepted): a third process that binds the path while
      // it is moved aside loses it here; its self-check sees the conflict and
      // it exits 1, so the instance heals by restarting.
      try {
        linkSync(aside, path);
      } catch {
        // The path is taken again; it is not ours to restore over.
      }
      unlinkSync(aside);
    } catch {
      // Best effort.
    }
  }

  /**
   * Removes leftovers of this server's own private names (`.s` bind names and
   * `.d` moved-aside names, six hex digits) from the control directory. Call
   * only while holding the instance lock. Only socket files older than a
   * minute are touched: the directory may be shared by other instances, whose
   * in-flight bind names exist for milliseconds.
   */
  sweepLeftovers(): string[] {
    if (this.platform === 'win32') return [];
    const dir = dirname(this.options.endpoint.path);
    const removed: string[] = [];
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return removed;
    }
    for (const name of names) {
      if (!/^\.[sd][0-9a-f]{6}$/.test(name)) continue;
      const path = join(dir, name);
      try {
        const stat = lstatSync(path);
        if (!stat.isSocket() || Date.now() - stat.mtimeMs < LEFTOVER_MIN_AGE_MS)
          continue;
        unlinkSync(path);
        removed.push(path);
      } catch {
        // Gone already.
      }
    }
    return removed;
  }

  private socketFileIsOurs(): boolean {
    try {
      const current = lstatSync(this.options.endpoint.path);
      return (
        current.dev === this.boundIdentity?.dev &&
        current.ino === this.boundIdentity?.ino
      );
    } catch {
      return false;
    }
  }

  /** Re-binds the endpoint after its file was deleted or replaced; connections stay open. */
  async rebind(): Promise<void> {
    const previous = this.server;
    this.server = null;
    // Safe: the previous server was bound at a private name (see bind), so
    // closing it cannot unlink whatever now sits at the endpoint path.
    // Not awaited: close's callback waits for open connections to end.
    if (previous) previous.close();
    await this.bind();
  }

  /**
   * Writes the token file. Separate from listen() so a supervisor writes it
   * only after confirming it still holds the instance lock.
   */
  publishToken(): void {
    writeToken(this.options.endpoint.tokenPath, this.token);
    this.published = true;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    const server = this.server;
    this.server = null;
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    const { endpoint } = this.options;
    // Remove only what this process created: never another supervisor's token
    // or socket. The socket path is moved aside first and unlinked only if the
    // moved file is still the inode this process bound; otherwise it goes back.
    if (this.platform !== 'win32' && this.bound) this.removeOwnSocketFile();
    for (const path of [this.published ? endpoint.tokenPath : null]) {
      if (!path) continue;
      try {
        unlinkSync(path);
      } catch {
        // Already gone.
      }
    }
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    const decoder = new NdjsonDecoder(CONTROL_MAX_LINE_BYTES);
    const send = (message: ControlServerMessage) => {
      if (!socket.destroyed) socket.write(encodeLine(message));
    };
    let capabilities: SupervisorCapability[] | null = null;
    const unsubscribers: Array<() => void> = [];
    socket.on('close', () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    });
    const helloTimer = setTimeout(
      () => socket.destroy(),
      CONTROL_HELLO_TIMEOUT_MS,
    );
    helloTimer.unref();

    const refuse = (reason: RefusedReason) => {
      send({ type: 'refused', reason, protocol: { ...SUPERVISOR_PROTOCOL } });
      closeAfterReply(socket);
    };
    const error = (code: ErrorCode, message: string, id?: string) => {
      send(
        id === undefined
          ? { type: 'error', code, message }
          : { type: 'error', id, code, message },
      );
    };

    const onLine = (line: string) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        if (capabilities === null) refuse('bad-hello');
        else error('bad-request', 'line is not JSON');
        return;
      }
      if (capabilities === null) {
        clearTimeout(helloTimer);
        capabilities = this.handshake(message, refuse, send);
        return;
      }
      this.dispatch(message, capabilities, send, error, unsubscribers, socket);
    };

    socket.on('data', (chunk: Buffer) => {
      let lines: string[];
      try {
        lines = decoder.push(chunk);
      } catch (cause) {
        if (cause instanceof LineTooLongError) {
          error('line-too-long', cause.message);
          closeAfterReply(socket);
          return;
        }
        throw cause;
      }
      for (const line of lines) {
        if (socket.destroyed || socket.writableEnded) return;
        if (line.trim().length > 0) onLine(line);
      }
    });
  }

  private handshake(
    message: unknown,
    refuse: (reason: RefusedReason) => void,
    send: (message: ControlServerMessage) => void,
  ): SupervisorCapability[] | null {
    if (
      !isRecord(message) ||
      message.type !== 'hello' ||
      !isRecord(message.protocol)
    ) {
      refuse('bad-hello');
      return null;
    }
    // Version first, so a client of another major learns why before anything else.
    if (message.protocol.major !== SUPERVISOR_PROTOCOL.major) {
      refuse('protocol-major');
      return null;
    }
    if (!tokensMatch(this.token, message.token)) {
      refuse('auth');
      return null;
    }
    const requested = Array.isArray(message.capabilities)
      ? message.capabilities
      : [];
    const negotiated = SUPERVISOR_CAPABILITIES.filter((capability) =>
      requested.includes(capability),
    );
    send({
      type: 'welcome',
      protocol: { ...SUPERVISOR_PROTOCOL },
      supervisor: {
        pid: process.pid,
        version: this.options.version,
        instance: this.options.instance,
      },
      capabilities: negotiated,
    });
    return negotiated;
  }

  private dispatch(
    message: unknown,
    capabilities: SupervisorCapability[],
    send: (message: ControlServerMessage) => void,
    error: (code: ErrorCode, message: string, id?: string) => void,
    unsubscribers: Array<() => void>,
    socket: Socket,
  ): void {
    if (!isRecord(message) || typeof message.type !== 'string') {
      error('bad-request', 'message has no type');
      return;
    }
    const id = message.id;
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      id.length > MAX_ID_LENGTH
    ) {
      error(
        'bad-request',
        'request id must be a non-empty string of at most 128 characters',
      );
      return;
    }
    const { handlers } = this.options;
    switch (message.type) {
      case 'status':
        send({ type: 'status.result', id, status: handlers.status() });
        return;
      case 'handoff': {
        const readinessTimeoutMs = optionalDuration(message.readinessTimeoutMs);
        const drainDeadlineMs = optionalDuration(message.drainDeadlineMs);
        if (readinessTimeoutMs === null || drainDeadlineMs === null) {
          error(
            'bad-request',
            `durations must be integers in 1..${MAX_REQUEST_DURATION_MS}`,
            id,
          );
          return;
        }
        if (message.entry !== undefined && typeof message.entry !== 'string') {
          error('bad-request', 'entry must be a string', id);
          return;
        }
        const request: HandoffOptions = {};
        if (typeof message.entry === 'string') request.entry = message.entry;
        if (readinessTimeoutMs !== undefined)
          request.readinessTimeoutMs = readinessTimeoutMs;
        if (drainDeadlineMs !== undefined)
          request.drainDeadlineMs = drainDeadlineMs;
        void handlers
          .handoff(request, (phase, generation) =>
            send({ type: 'handoff.progress', id, phase, generation }),
          )
          .then(
            (result) => send({ type: 'handoff.result', id, ...result }),
            (cause: unknown) =>
              send({
                type: 'handoff.result',
                id,
                outcome: 'refused',
                reason: String(cause),
              }),
          );
        return;
      }
      case 'stop': {
        const drainDeadlineMs = optionalDuration(message.drainDeadlineMs);
        if (drainDeadlineMs === null) {
          error(
            'bad-request',
            `drainDeadlineMs must be an integer in 1..${MAX_REQUEST_DURATION_MS}`,
            id,
          );
          return;
        }
        send({ type: 'stop.result', id, accepted: true });
        handlers.stop(drainDeadlineMs);
        return;
      }
      case 'subscribe': {
        if (!capabilities.includes('events')) {
          error('unsupported', 'subscribe requires the events capability', id);
          return;
        }
        send({ type: 'subscribe.result', id });
        unsubscribers.push(
          handlers.subscribe((event) => {
            if (socket.writableLength > CONTROL_MAX_SUBSCRIBER_BACKLOG_BYTES) {
              this.log('dropping a control subscriber that stopped reading');
              socket.destroy();
              return;
            }
            send({ type: 'event', event });
          }),
        );
        return;
      }
      default:
        error('unsupported', `unknown request type: ${message.type}`, id);
    }
  }
}
