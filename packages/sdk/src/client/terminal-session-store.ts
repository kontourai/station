import {
  decodeTerminalFrame,
  encodeTerminalFrame,
  TERMINAL_CLOSE,
  TERMINAL_FRAME_HEADER_BYTES,
  TERMINAL_INPUT,
  TERMINAL_MAX_OUTSTANDING_OUTPUT_FRAMES,
  TERMINAL_OUTPUT,
  TERMINAL_SOCKET_PROTOCOL,
  TERMINAL_TICKET_PATH,
  TERMINAL_TICKET_PATTERN,
  TERMINAL_TICKET_PROTOCOL_PREFIX,
  TERMINAL_WINDOW_BYTES,
  type TerminalLaunchProfile,
  type TerminalTicket,
} from '@kontourai/station-contracts/terminal-transport';
import { z } from 'zod';
import { envelopeError } from './api-error-message';
import {
  type ApiRequestScope,
  assertClientRawEgressAllowed,
  type ClientCredentialResolver,
  type ClientRequestOptions,
  mutateJson,
  postWithResolvedCredential,
  readJsonBody,
  StationRawEgressUnavailableError,
  StationRequestAuthorityError,
} from './http';
import { terminalOutputSocketURL } from './terminal-output-session';

/** Where a terminal runs: a Project and its binding (`project` or `thread:<id>`). */
export interface TerminalSessionTarget {
  projectId: string;
  bindingKey: string;
}

export type TerminalSessionStatus =
  | 'starting'
  | 'running'
  | 'exited'
  | 'failed';

/**
 * - `connecting`: waiting for the socket or the session.
 * - `replaying`: earlier output is arriving; input waits until `ready`.
 * - `ready`: live; input and resize are delivered.
 * - `reconnecting`: the socket dropped; output resumes where it stopped.
 * - `failed`: see `error`; this session will not recover by itself.
 * - `detached`: this view stopped; the shell itself may still run.
 */
export type TerminalSessionState =
  | 'connecting'
  | 'replaying'
  | 'ready'
  | 'reconnecting'
  | 'failed'
  | 'detached';

export type TerminalSessionErrorCode =
  | 'unsupported-host'
  | 'refused'
  | 'credential-unavailable'
  | 'raw-egress-unavailable'
  | 'pty-unavailable'
  | 'connection-lost'
  | 'protocol'
  | 'disposed';

export class TerminalSessionError extends Error {
  constructor(
    readonly code: TerminalSessionErrorCode,
    message?: string,
    /** A connection failure the store retries by itself. */
    readonly retryable = false,
    /** The host's own refusal, with its status, code and details. */
    readonly cause?: Error,
  ) {
    super(
      message ??
        cause?.message ??
        (code === 'unsupported-host'
          ? 'This host does not support terminal sessions. Update the host to use this feature.'
          : code === 'raw-egress-unavailable'
            ? 'Terminals need a direct Station connection. Select a direct connection and try again.'
            : code === 'refused'
              ? 'Terminal access was refused.'
              : `Terminal unavailable: ${code}`),
    );
    this.name = 'TerminalSessionError';
  }
}

export interface TerminalSessionListener {
  /** Bytes in sequence order; earlier output for this view arrives first. */
  output?(data: Uint8Array, sequence: number): void;
  /** Earlier output is no longer retained: clear the view before more arrives. */
  reset?(): void;
  /** Any change to state, status, read-only or error. */
  change?(session: TerminalSession): void;
}

/**
 * One terminal as a renderer sees it. It owns no socket: the store
 * multiplexes every session on one connection per Station, resumes each from
 * its last applied sequence, and never resends input whose delivery is
 * uncertain.
 */
export interface TerminalSession {
  /** The server's session id; absent until an `open` is acknowledged. */
  readonly terminalId: string | undefined;
  readonly target: TerminalSessionTarget;
  readonly state: TerminalSessionState;
  readonly status: TerminalSessionStatus | undefined;
  /** True when the caller may watch but not type, resize or close. */
  readonly readOnly: boolean;
  readonly error: TerminalSessionError | undefined;
  subscribe(listener: TerminalSessionListener): () => void;
  /** Queues input, coalesced per frame; `false` when it cannot be accepted. */
  write(data: string): boolean;
  /** Latest size wins; sent once the session is ready. */
  resize(cols: number, rows: number): void;
  /** The shell's working directory, or null when unknown. */
  cwd(): Promise<string | null>;
  /** Ends the shell. */
  close(): Promise<void>;
  /** Stops this view; the shell keeps running and can be attached again. */
  detach(): void;
}

export interface TerminalSessionRecord {
  terminalId: string;
  projectId: string;
  bindingKey: string;
  status: TerminalSessionStatus;
  createdAt: number;
  launch?:
    | { kind: 'shell' }
    | { kind: 'agent'; connectionId: string; mode: string }
    | { kind: 'server' };
  legacy?: { projectSlug: string; terminalId: string; imported: boolean };
}

export interface TerminalSessionSocket extends EventTarget {
  readonly readyState: number;
  binaryType: string;
  /** Frames are freshly encoded, so always backed by a plain ArrayBuffer. */
  send(value: string | Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
}

export interface TerminalSessionStoreOptions {
  apiBase: string;
  /** Binds ticket requests to this authority. */
  requestScope?: ApiRequestScope;
  /** A captured credential owner; absent uses the installed SDK resolver. */
  resolveCredential?: ClientCredentialResolver;
  /** Replaces the ticket request (tests and custom transports). */
  requestTicket?: (signal: AbortSignal) => Promise<TerminalTicket>;
  createSocket?: (url: string, protocols: string[]) => TerminalSessionSocket;
  /** Input and resize coalescing; defaults to the next animation frame. */
  scheduleFrame?: (callback: () => void) => void;
  /** Output kept per session for late subscribers; default 256 KiB. */
  maxBufferedBytes?: number;
}

const BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000, 10_000];
const MAX_PENDING_INPUT = 64 * 1024;
const seq = z.number().int().nonnegative().safe();
const status = z.enum(['starting', 'running', 'exited', 'failed']);
const ticketResponse = z.object({
  success: z.literal(true),
  data: z.object({ ticket: z.string(), expiresAt: z.number() }),
});
const record = z
  .object({
    terminalId: z.string().uuid(),
    projectId: z.string(),
    bindingKey: z.string(),
    status,
    createdAt: z.number(),
    launch: z
      .union([
        z.object({ kind: z.literal('shell') }),
        z.object({
          kind: z.literal('agent'),
          connectionId: z.string(),
          mode: z.string(),
        }),
        z.object({ kind: z.literal('server') }),
      ])
      .optional(),
    legacy: z
      .object({
        projectSlug: z.string(),
        terminalId: z.string(),
        imported: z.boolean(),
      })
      .optional(),
  })
  .passthrough();
const control = z.discriminatedUnion('type', [
  z.object({ type: z.literal('authenticated') }).passthrough(),
  z
    .object({
      type: z.literal('attached'),
      requestId: z.string(),
      channel: z.number(),
      terminalId: z.string().uuid(),
      status,
      replayThrough: seq,
      readOnly: z.boolean(),
      maxOutstandingOutputFrames: z.number(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('progress'),
      channel: z.number(),
      sentThrough: seq,
      replayThrough: seq,
      status,
    })
    .passthrough(),
  z.object({ type: z.literal('ready'), channel: z.number(), seq }),
  z.object({
    type: z.literal('reset'),
    channel: z.number(),
    fromSeq: seq,
    replayThrough: seq,
  }),
  z.object({ type: z.literal('input-ack') }).passthrough(),
  z.object({ type: z.literal('done'), requestId: z.string() }).passthrough(),
  z
    .object({ type: z.literal('superseded'), requestId: z.string() })
    .passthrough(),
  z.object({
    type: z.literal('list'),
    requestId: z.string(),
    records: z.array(record),
  }),
  z
    .object({
      type: z.literal('cwd'),
      requestId: z.string(),
      cwd: z.string().nullable(),
    })
    .passthrough(),
  z.object({
    type: z.literal('error'),
    code: z.string(),
    channel: z.number().optional(),
    requestId: z.string().optional(),
    message: z.string().optional(),
  }),
]);
type Control = z.infer<typeof control>;

type Pending = {
  resolve(value: unknown): void;
  reject(error: TerminalSessionError): void;
};

type HostEventTarget = {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};

function defaultFrame(callback: () => void): void {
  const frame = (
    globalThis as { requestAnimationFrame?: (callback: () => void) => void }
  ).requestAnimationFrame;
  if (frame) frame(callback);
  else setTimeout(callback, 16);
}

/**
 * Every terminal on one Station, multiplexed on one authenticated socket.
 * Admission uses a single-use ticket fetched over the ordinary authenticated
 * HTTP route, so a browser, a proxy prefix, a tailnet address and a native
 * shell's host-owned transport all reach the socket the same way.
 */
export class TerminalSessionStore {
  private readonly options: TerminalSessionStoreOptions;
  private readonly socketURL: string;
  private socket: TerminalSessionSocket | undefined;
  private authenticated = false;
  private connecting = false;
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private lifetime = new AbortController();
  private nextChannel = 1;
  private nextRequest = 1;
  private readonly sessions = new Set<StoreSession>();
  private readonly channels = new Map<number, StoreSession>();
  private readonly pending = new Map<string, Pending>();
  private disposed = false;
  private fatal: TerminalSessionError | undefined;
  private readonly unwatch: () => void;

  constructor(options: TerminalSessionStoreOptions) {
    this.options = { ...options };
    this.socketURL = terminalOutputSocketURL(options.apiBase);
    const wake = () => {
      if (!this.socket && this.retryTimer !== undefined) {
        clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
        this.attempts = 0;
        void this.connect();
      }
    };
    const host = globalThis as {
      window?: HostEventTarget;
      document?: HostEventTarget & { hidden?: boolean };
    };
    const visible = () => {
      if (!host.document?.hidden) wake();
    };
    host.window?.addEventListener('online', wake);
    host.document?.addEventListener('visibilitychange', visible);
    this.unwatch = () => {
      host.window?.removeEventListener('online', wake);
      host.document?.removeEventListener('visibilitychange', visible);
    };
  }

  /** Starts a new shell, or a named server-resolved program, in `target`. */
  open(
    target: TerminalSessionTarget,
    options: {
      cols: number;
      rows: number;
      launch?: TerminalLaunchProfile;
      /** Imports a pre-socket terminal's owned history once. */
      legacyTerminalId?: string;
    },
  ): TerminalSession {
    return this.add(
      new StoreSession(this, target, { kind: 'open', ...options }),
    );
  }

  /** Views an existing session; repeated calls share one view. */
  attach(target: TerminalSessionTarget, terminalId: string): TerminalSession {
    z.string().uuid().parse(terminalId);
    for (const session of this.sessions)
      if (
        session.terminalId === terminalId &&
        session.state !== 'detached' &&
        session.state !== 'failed'
      )
        return session;
    return this.add(
      new StoreSession(this, target, { kind: 'attach', terminalId }),
    );
  }

  /** Sessions in `target` the caller may observe, newest last. */
  async list(target: TerminalSessionTarget): Promise<TerminalSessionRecord[]> {
    const result = await this.request({ type: 'list', ...target });
    return z
      .array(record)
      .parse(result)
      .map(
        (item) =>
          ({
            terminalId: item.terminalId,
            projectId: item.projectId,
            bindingKey: item.bindingKey,
            status: item.status,
            createdAt: item.createdAt,
            ...(item.launch && { launch: item.launch }),
            ...(item.legacy && { legacy: item.legacy }),
          }) satisfies TerminalSessionRecord,
      )
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** A refusal that stopped every session, until {@link restart}. */
  get failure(): TerminalSessionError | undefined {
    return this.fatal;
  }

  /** Clears a stopping refusal (after the person reconnects or signs in). */
  restart(): void {
    if (this.disposed) return;
    this.fatal = undefined;
    this.attempts = 0;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unwatch();
    clearTimeout(this.retryTimer);
    this.lifetime.abort();
    for (const session of [...this.sessions])
      session.fail(new TerminalSessionError('disposed'));
    this.rejectPending(new TerminalSessionError('disposed'));
    this.socket?.close();
    this.socket = undefined;
  }

  // ── Store internals, used by StoreSession ─────────────────────────────

  /** @internal */
  frame(callback: () => void): void {
    (this.options.scheduleFrame ?? defaultFrame)(callback);
  }

  /** @internal */
  get maxBufferedBytes(): number {
    return this.options.maxBufferedBytes ?? 256 * 1024;
  }

  /** @internal */
  send(value: object | Uint8Array<ArrayBuffer>): boolean {
    const socket = this.socket;
    if (!socket || !this.authenticated || socket.readyState !== 1) return false;
    try {
      assertClientRawEgressAllowed(
        this.options.apiBase,
        'terminal',
        this.options.requestScope,
      );
    } catch (error) {
      this.failAll(egressError(error));
      return false;
    }
    socket.send(value instanceof Uint8Array ? value : JSON.stringify(value));
    return true;
  }

  /** @internal */
  request(command: Record<string, unknown>): Promise<unknown> {
    if (this.disposed)
      return Promise.reject(new TerminalSessionError('disposed'));
    if (this.fatal) return Promise.reject(this.fatal);
    const requestId = `r${this.nextRequest++}`;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      const dispatch = () => {
        if (!this.pending.has(requestId)) return;
        if (!this.send({ ...command, requestId })) {
          this.pending.delete(requestId);
          reject(new TerminalSessionError('connection-lost', undefined, true));
        }
      };
      if (this.authenticated) dispatch();
      else {
        this.queued.push(dispatch);
        void this.connect();
      }
    });
  }
  private queued: (() => void)[] = [];

  /** @internal */
  bind(session: StoreSession): void {
    if (!this.authenticated) {
      void this.connect();
      return;
    }
    const channel = this.nextChannel++;
    this.channels.set(channel, session);
    session.bound(channel, `c${channel}`);
  }

  /** @internal */
  forget(session: StoreSession): void {
    this.sessions.delete(session);
    if (session.channel !== undefined) this.channels.delete(session.channel);
  }

  private add(session: StoreSession): StoreSession {
    if (this.disposed) session.fail(new TerminalSessionError('disposed'));
    else if (this.fatal) session.fail(this.fatal);
    else {
      this.sessions.add(session);
      this.bind(session);
    }
    return session;
  }

  private failAll(error: TerminalSessionError): void {
    this.fatal = error;
    for (const session of [...this.sessions]) session.fail(error);
    this.rejectPending(error);
    this.socket?.close();
    this.socket = undefined;
    this.authenticated = false;
  }

  private rejectPending(error: TerminalSessionError): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    this.queued = [];
    for (const entry of pending) entry.reject(error);
  }

  private async ticket(signal: AbortSignal): Promise<TerminalTicket> {
    if (this.options.requestTicket) return this.options.requestTicket(signal);
    const url = this.options.apiBase.replace(/\/$/, '') + TERMINAL_TICKET_PATH;
    const options: ClientRequestOptions = {
      authentication: 'required',
      timeoutMs: 10_000,
      readOnly: true,
      signal,
      redirect: 'error',
      ...(this.options.requestScope && {
        requestScope: this.options.requestScope,
      }),
    };
    const response = this.options.resolveCredential
      ? await postWithResolvedCredential(
          url,
          options,
          await this.options.resolveCredential(),
        )
      : await mutateJson(url, 'POST', options);
    if (response.status === 404) {
      await response.body?.cancel();
      throw new TerminalSessionError('unsupported-host');
    }
    if (response.status === 401 || response.status === 403) {
      // The server's own refusal sentence, through the shared envelope reader.
      const refusal = envelopeError(
        response,
        await readJsonBody(response),
        'Terminal access was refused.',
      );
      throw new TerminalSessionError(
        refusal.status === 401 ? 'credential-unavailable' : 'refused',
        undefined,
        false,
        refusal,
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new TerminalSessionError('connection-lost', undefined, true);
    }
    const parsed = ticketResponse.safeParse(await readJsonBody(response));
    if (
      !parsed.success ||
      !TERMINAL_TICKET_PATTERN.test(parsed.data.data.ticket)
    )
      throw new TerminalSessionError('protocol');
    return parsed.data.data;
  }

  private async connect(): Promise<void> {
    if (this.connecting || this.socket || this.disposed || this.fatal) return;
    if (this.retryTimer !== undefined) return;
    this.connecting = true;
    for (const session of this.sessions) session.connecting();
    try {
      assertClientRawEgressAllowed(
        this.options.apiBase,
        'terminal',
        this.options.requestScope,
      );
      const { ticket } = await this.ticket(this.lifetime.signal);
      if (this.disposed) return;
      assertClientRawEgressAllowed(
        this.options.apiBase,
        'terminal',
        this.options.requestScope,
      );
      const socket = (
        this.options.createSocket ??
        ((url, protocols): TerminalSessionSocket =>
          new WebSocket(url, protocols))
      )(this.socketURL, [
        TERMINAL_SOCKET_PROTOCOL,
        TERMINAL_TICKET_PROTOCOL_PREFIX + ticket,
      ]);
      socket.binaryType = 'arraybuffer';
      this.socket = socket;
      this.authenticated = false;
      socket.addEventListener('message', (event) => {
        if (this.socket !== socket) return;
        try {
          this.receive('data' in event ? event.data : undefined);
        } catch (error) {
          this.protocolFailure(socket, error);
        }
      });
      socket.addEventListener('close', (event) => {
        if (this.socket !== socket) return;
        const code =
          'code' in event && typeof event.code === 'number' ? event.code : 1006;
        this.dropped(code);
      });
      socket.addEventListener('error', () => {
        /* The close event owns reconnect. */
      });
    } catch (error) {
      if (this.disposed) return;
      const failure =
        error instanceof TerminalSessionError
          ? error
          : error instanceof StationRawEgressUnavailableError
            ? new TerminalSessionError('raw-egress-unavailable')
            : error instanceof StationRequestAuthorityError
              ? new TerminalSessionError('credential-unavailable')
              : new TerminalSessionError('connection-lost', undefined, true);
      if (failure.retryable) this.scheduleRetry();
      else this.failAll(failure);
    } finally {
      this.connecting = false;
    }
  }

  private protocolFailure(socket: TerminalSessionSocket, _error: unknown) {
    if (this.socket !== socket) return;
    socket.close(4400, 'terminal_protocol');
    this.dropped(4400);
  }

  private dropped(code: number): void {
    this.socket = undefined;
    this.authenticated = false;
    this.channels.clear();
    this.rejectPending(
      new TerminalSessionError('connection-lost', undefined, true),
    );
    for (const session of [...this.sessions]) session.lost();
    if (this.sessions.size === 0) return;
    if (code === TERMINAL_CLOSE.lifetime) this.attempts = 0;
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.disposed || this.fatal || this.retryTimer !== undefined) return;
    const delay = BACKOFF_MS[Math.min(this.attempts++, BACKOFF_MS.length - 1)]!;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.connect();
    }, delay);
  }

  private receive(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      if (
        !this.authenticated ||
        data.byteLength > TERMINAL_WINDOW_BYTES + TERMINAL_FRAME_HEADER_BYTES
      )
        throw new TerminalSessionError('protocol');
      const frame = decodeTerminalFrame(new Uint8Array(data));
      if (frame.kind !== TERMINAL_OUTPUT)
        throw new TerminalSessionError('protocol');
      this.channels.get(frame.channel)?.output(frame.seq, frame.data);
      return;
    }
    if (typeof data !== 'string' || data.length > 1024 * 1024)
      throw new TerminalSessionError('protocol');
    const message: Control = control.parse(JSON.parse(data));
    if (message.type === 'authenticated') {
      if (this.authenticated) throw new TerminalSessionError('protocol');
      this.authenticated = true;
      this.attempts = 0;
      for (const session of [...this.sessions]) this.bind(session);
      const queued = this.queued;
      this.queued = [];
      for (const dispatch of queued) dispatch();
      return;
    }
    if (!this.authenticated) throw new TerminalSessionError('protocol');
    if (message.type === 'input-ack') return;
    const requestId = (message as { requestId?: unknown }).requestId;
    if (typeof requestId === 'string') {
      const pending = this.pending.get(requestId);
      if (pending) {
        this.pending.delete(requestId);
        if (message.type === 'error')
          pending.reject(errorFor(message.code, message.message));
        else if (message.type === 'list') pending.resolve(message.records);
        else if (message.type === 'cwd') pending.resolve(message.cwd);
        else pending.resolve(undefined);
        // A refused request (a resize of an ended shell) belongs to its
        // caller, not to the session's channel.
        return;
      }
    }
    const channel = (message as { channel?: unknown }).channel;
    if (typeof channel !== 'number') {
      if (message.type === 'error' && message.code === 'invalid-frame')
        throw new TerminalSessionError('protocol');
      return;
    }
    const session = this.channels.get(channel);
    if (!session) return;
    if (message.type === 'attached') session.attached(message);
    else if (message.type === 'progress') session.progress(message);
    else if (message.type === 'ready') session.ready(message.seq);
    else if (message.type === 'reset') session.reset(message);
    else if (message.type === 'error') {
      this.channels.delete(channel);
      session.fail(errorFor(message.code, message.message));
    }
  }
}

function errorFor(code: string, message?: string): TerminalSessionError {
  return code === 'pty-unavailable'
    ? new TerminalSessionError('pty-unavailable', message)
    : code === 'terminal-refused'
      ? new TerminalSessionError('refused')
      : new TerminalSessionError('protocol');
}

function egressError(error: unknown): TerminalSessionError {
  return error instanceof StationRawEgressUnavailableError
    ? new TerminalSessionError('raw-egress-unavailable')
    : new TerminalSessionError('credential-unavailable');
}

type Intent =
  | {
      kind: 'open';
      cols: number;
      rows: number;
      launch?: TerminalLaunchProfile;
      legacyTerminalId?: string;
    }
  | { kind: 'attach'; terminalId: string };

class StoreSession implements TerminalSession {
  terminalId: string | undefined;
  state: TerminalSessionState = 'connecting';
  status: TerminalSessionStatus | undefined;
  readOnly = false;
  channel: number | undefined;
  private failure: TerminalSessionError | undefined;
  private requestId: string | undefined;
  private openSent = false;
  private applied = 0;
  private replayThrough = 0;
  private inputSeq = 0;
  private pendingInput = '';
  private size: { cols: number; rows: number } | undefined;
  private sentSize: { cols: number; rows: number } | undefined;
  private flushScheduled = false;
  private buffer: { seq: number; data: Uint8Array }[] = [];
  private bufferedBytes = 0;
  private readonly listeners = new Set<TerminalSessionListener>();
  private readyWaiters: (() => void)[] = [];

  constructor(
    private readonly store: TerminalSessionStore,
    readonly target: TerminalSessionTarget,
    private readonly intent: Intent,
  ) {
    z.string().min(1).max(256).parse(target.projectId);
    z.string().min(1).max(512).parse(target.bindingKey);
    if (intent.kind === 'attach') this.terminalId = intent.terminalId;
    else this.size = { cols: intent.cols, rows: intent.rows };
  }

  get error(): TerminalSessionError | undefined {
    return this.failure;
  }

  subscribe(listener: TerminalSessionListener): () => void {
    this.listeners.add(listener);
    for (const chunk of this.buffer) listener.output?.(chunk.data, chunk.seq);
    return () => this.listeners.delete(listener);
  }

  write(data: string): boolean {
    if (
      this.readOnly ||
      this.state === 'failed' ||
      this.state === 'detached' ||
      this.status === 'exited' ||
      this.status === 'failed' ||
      this.pendingInput.length + data.length > MAX_PENDING_INPUT
    )
      return false;
    this.pendingInput += data;
    this.scheduleFlush();
    return true;
  }

  resize(cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) return;
    this.size = {
      cols: Math.min(1000, Math.max(1, cols)),
      rows: Math.min(1000, Math.max(1, rows)),
    };
    this.scheduleFlush();
  }

  async cwd(): Promise<string | null> {
    await this.whenReady();
    const cwd = await this.store.request({
      type: 'cwd',
      channel: this.channel,
    });
    return typeof cwd === 'string' ? cwd : null;
  }

  async close(): Promise<void> {
    await this.whenReady();
    await this.store.request({ type: 'close', channel: this.channel });
    this.finish();
  }

  detach(): void {
    if (this.state === 'detached') return;
    if (this.channel !== undefined && this.state !== 'failed')
      this.store
        .request({ type: 'detach', channel: this.channel })
        .catch(() => undefined);
    this.finish();
  }

  // ── Driven by the store ───────────────────────────────────────────────

  bound(channel: number, requestId: string): void {
    if (this.state === 'detached' || this.state === 'failed') return;
    if (this.intent.kind === 'open' && !this.terminalId && this.openSent) {
      // The previous socket dropped before the open was acknowledged: the
      // shell may exist. Never open a second one implicitly.
      this.fail(
        new TerminalSessionError(
          'connection-lost',
          'The connection dropped while the terminal was opening.',
        ),
      );
      return;
    }
    this.channel = channel;
    this.requestId = requestId;
    this.inputSeq = 0;
    this.sentSize = undefined;
    const sent =
      this.intent.kind === 'open' && !this.terminalId
        ? this.store.send({
            type: 'open',
            requestId,
            channel,
            ...this.target,
            windowBytes: TERMINAL_WINDOW_BYTES,
            cols: this.intent.cols,
            rows: this.intent.rows,
            ...(this.intent.launch && { launch: this.intent.launch }),
            ...(this.intent.legacyTerminalId && {
              legacyTerminalId: this.intent.legacyTerminalId,
            }),
          })
        : this.store.send({
            type: 'attach',
            requestId,
            channel,
            ...this.target,
            terminalId: this.terminalId,
            fromSeq: this.applied,
            windowBytes: TERMINAL_WINDOW_BYTES,
          });
    if (sent && this.intent.kind === 'open') this.openSent = true;
  }

  attached(message: Extract<Control, { type: 'attached' }>): void {
    if (
      message.requestId !== this.requestId ||
      (this.terminalId !== undefined &&
        message.terminalId !== this.terminalId) ||
      message.maxOutstandingOutputFrames !==
        TERMINAL_MAX_OUTSTANDING_OUTPUT_FRAMES
    ) {
      this.fail(new TerminalSessionError('protocol'));
      return;
    }
    this.terminalId = message.terminalId;
    this.status = message.status;
    this.readOnly = message.readOnly;
    this.replayThrough = message.replayThrough;
    this.state = 'replaying';
    // Nothing newer to replay: the baseline acknowledgement makes it ready.
    if (this.replayThrough <= this.applied) this.ack(this.applied);
    this.changed();
  }

  output(sequence: number, data: Uint8Array): void {
    if (sequence !== this.applied + 1) {
      this.fail(new TerminalSessionError('protocol'));
      return;
    }
    this.applied = sequence;
    if (data.byteLength) {
      const copy = data.slice();
      this.buffer.push({ seq: sequence, data: copy });
      this.bufferedBytes += copy.byteLength;
      while (
        this.bufferedBytes > this.store.maxBufferedBytes &&
        this.buffer.length > 1
      )
        this.bufferedBytes -= this.buffer.shift()!.data.byteLength;
      for (const listener of this.listeners) listener.output?.(copy, sequence);
    }
    this.ack(sequence);
  }

  progress(message: Extract<Control, { type: 'progress' }>): void {
    if (this.status === message.status) return;
    this.status = message.status;
    this.changed();
  }

  ready(sequence: number): void {
    if (sequence > this.applied) {
      this.fail(new TerminalSessionError('protocol'));
      return;
    }
    this.state = 'ready';
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const waiter of waiters) waiter();
    this.scheduleFlush();
    this.changed();
  }

  reset(message: Extract<Control, { type: 'reset' }>): void {
    this.buffer = [];
    this.bufferedBytes = 0;
    this.applied = message.fromSeq;
    this.replayThrough = message.replayThrough;
    this.state = 'replaying';
    for (const listener of this.listeners) listener.reset?.();
    if (this.replayThrough <= this.applied) this.ack(this.applied);
    this.changed();
  }

  connecting(): void {
    if (this.state === 'reconnecting' || this.state === 'connecting') return;
    if (this.state === 'failed' || this.state === 'detached') return;
    this.state = 'connecting';
    this.changed();
  }

  lost(): void {
    if (this.state === 'failed' || this.state === 'detached') return;
    this.channel = undefined;
    // Input queued but never sent is kept; input already sent is never
    // resent, whatever its outcome.
    this.state = 'reconnecting';
    this.changed();
  }

  fail(error: TerminalSessionError): void {
    if (this.state === 'failed' || this.state === 'detached') return;
    this.failure = error;
    this.state = 'failed';
    this.store.forget(this);
    this.pendingInput = '';
    this.readyWaiters = [];
    this.changed();
  }

  private finish(): void {
    this.state = 'detached';
    this.store.forget(this);
    this.readyWaiters = [];
    this.changed();
  }

  private whenReady(): Promise<void> {
    if (this.state === 'ready' && this.channel !== undefined)
      return Promise.resolve();
    if (this.state === 'failed')
      return Promise.reject(
        this.failure ?? new TerminalSessionError('protocol'),
      );
    if (this.state === 'detached')
      return Promise.reject(new TerminalSessionError('disposed'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new TerminalSessionError('connection-lost', undefined, true)),
        10_000,
      );
      this.readyWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private ack(sequence: number): void {
    if (this.channel !== undefined)
      this.store.send({ type: 'ack', channel: this.channel, seq: sequence });
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    this.store.frame(() => {
      this.flushScheduled = false;
      this.flush();
    });
  }

  private flush(): void {
    if (this.state !== 'ready' || this.channel === undefined || this.readOnly)
      return;
    const size = this.size;
    if (
      size &&
      (size.cols !== this.sentSize?.cols || size.rows !== this.sentSize?.rows)
    ) {
      this.sentSize = size;
      this.store
        .request({ type: 'resize', channel: this.channel, ...size })
        .catch(() => undefined);
    }
    while (this.pendingInput) {
      // Slice on a code point boundary under the frame payload limit.
      let take = Math.min(this.pendingInput.length, 16 * 1024);
      const code = this.pendingInput.charCodeAt(take - 1);
      if (take < this.pendingInput.length && code >= 0xd800 && code <= 0xdbff)
        --take;
      const chunk = this.pendingInput.slice(0, take);
      const frame = encodeTerminalFrame(
        TERMINAL_INPUT,
        this.channel,
        this.inputSeq + 1,
        new TextEncoder().encode(chunk),
      );
      if (!this.store.send(frame)) return;
      ++this.inputSeq;
      this.pendingInput = this.pendingInput.slice(take);
    }
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener.change?.(this);
      } catch {
        /* A listener cannot break delivery to the others. */
      }
    }
  }
}
