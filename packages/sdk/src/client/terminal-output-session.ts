import {
  decodeTerminalFrame,
  TERMINAL_FRAME_HEADER_BYTES,
  TERMINAL_MAX_OUTSTANDING_OUTPUT_FRAMES,
  TERMINAL_OUTPUT,
  TERMINAL_SOCKET_PATH,
  TERMINAL_SOCKET_PROTOCOL,
  TERMINAL_TICKET_PATH,
  TERMINAL_TICKET_PATTERN,
  TERMINAL_TICKET_PROTOCOL_PREFIX,
  TERMINAL_WINDOW_BYTES,
} from '@kontourai/station-contracts/terminal-transport';
import { z } from 'zod';
import {
  type ApiRequestScope,
  assertClientRawEgressAllowed,
  type ClientCredential,
  type ClientCredentialResolver,
  postWithResolvedCredential,
  readJsonBody,
  StationRawEgressUnavailableError,
  StationRequestAuthorityError,
  StationRequestTimeoutError,
} from './http';

const seq = z.number().int().nonnegative().safe();
const control = z.discriminatedUnion('type', [
  z.object({ type: z.literal('authenticated'), protocolVersion: z.literal(1) }),
  z.object({
    type: z.literal('attached'),
    channel: z.literal(1),
    requestId: z.string(),
    terminalId: z.string().uuid(),
    replayThrough: seq,
    maxOutstandingOutputFrames: z.unknown().optional(),
  }),
  z.object({
    type: z.literal('progress'),
    channel: z.literal(1),
    sentThrough: seq,
    replayThrough: seq,
  }),
  z.object({ type: z.literal('ready'), channel: z.literal(1), seq }),
  z.object({
    type: z.literal('reset'),
    channel: z.literal(1),
    fromSeq: seq,
    replayThrough: seq,
  }),
  z.object({ type: z.literal('error'), code: z.string() }),
]);

export type TerminalOutputState =
  | 'connecting'
  | 'authenticating'
  | 'replaying'
  | 'ready'
  | 'disconnected'
  | 'failed'
  | 'disposed';

export interface TerminalOutputSocket extends EventTarget {
  readonly readyState: number;
  binaryType: string;
  send(value: string): void;
  close(): void;
}

export class TerminalOutputError extends Error {
  constructor(
    readonly code:
      | 'credential-unavailable'
      | 'authority-changed'
      | 'protocol'
      | 'terminal-refused'
      | 'connection-timeout'
      | 'output-failed'
      | 'reconnect-exhausted'
      | 'disposed'
      | 'unsupported-host'
      | 'native-transport-unsupported'
      | 'raw-egress-unavailable',
  ) {
    super(
      code === 'unsupported-host'
        ? 'This host does not support terminal output sessions. Update the host to use this feature.'
        : code === 'raw-egress-unavailable'
          ? 'Terminal output requires a direct Station connection. Select a direct connection and try again.'
          : code === 'native-transport-unsupported'
            ? 'Terminal output is not available over this native transport. Select a direct Station connection.'
            : `Terminal output unavailable: ${code}`,
    );
    this.name = 'TerminalOutputError';
  }
}

type TerminalControl = z.infer<typeof control>;
interface TerminalOutputConnection {
  socket: TerminalOutputSocket;
  generation: number;
  requestId: string;
  authenticated: boolean;
  attached: boolean;
  replayThrough: number;
  baselineAckNeeded: boolean;
}

export interface TerminalOutputSessionOptions {
  apiBase: string;
  projectId: string;
  bindingKey: string;
  terminalId: string;
  fromSeq?: number;
  resolveCredential: ClientCredentialResolver;
  requestScope?: ApiRequestScope;
  createSocket?: (url: string, protocols: string[]) => TerminalOutputSocket;
  /** Resolves only after these bytes have been applied to the view. */
  onOutput(
    data: Uint8Array,
    sequence: number,
    signal: AbortSignal,
  ): void | Promise<void>;
  /** Clear the previous renderer epoch before replay credit is acknowledged. */
  onReset(fromSeq: number, signal: AbortSignal): void | Promise<void>;
  onState?(state: TerminalOutputState): void;
  onError?(error: TerminalOutputError): void;
}

/** Preserve a reverse proxy's API-base prefix; credentials never enter the URL. */
export function terminalOutputSocketURL(apiBase: string): string {
  const url = new URL(apiBase);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new TerminalOutputError('protocol');
  url.pathname = url.pathname.replace(/\/$/, '') + TERMINAL_SOCKET_PATH;
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

/**
 * Observe one existing terminal; no open, input, resize or lifecycle command.
 * UNWIRED(#3994): no Station surface watches output-only yet; Coding operates
 * terminals through `TerminalSessionStore`.
 */
export class TerminalOutputSession {
  private readonly options: TerminalOutputSessionOptions;
  private readonly socketURL: string;
  private socket: TerminalOutputSocket | undefined;
  private generation = 0;
  private cursor: number;
  private retries = 0;
  private stopped = false;
  private started = false;
  private state: TerminalOutputState = 'disconnected';
  private work: Promise<void> = Promise.resolve();
  private queued = 0;
  private queuedFrames = 0;
  private queuedControls = 0;
  private queuedBytes = 0;
  private queuedFrameBytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private assertAuthority: () => void = () => {
    throw new TerminalOutputError('credential-unavailable');
  };
  private pending:
    | {
        promise: Promise<void>;
        resolve(): void;
        reject(error: TerminalOutputError): void;
      }
    | undefined;
  private readonly outputLifetime = new AbortController();

  constructor(options: TerminalOutputSessionOptions) {
    this.options = {
      ...options,
      requestScope: options.requestScope && { ...options.requestScope },
    };
    this.socketURL = terminalOutputSocketURL(options.apiBase);
    this.cursor = seq.parse(options.fromSeq ?? 0);
    z.string().uuid().parse(options.terminalId);
    z.string().min(1).max(256).parse(options.projectId);
    z.string().min(1).max(512).parse(options.bindingKey);
  }

  get appliedThrough(): number {
    return this.cursor;
  }

  connect(): Promise<void> {
    if (this.stopped)
      return Promise.reject(new TerminalOutputError('disposed'));
    if (this.state === 'ready') return Promise.resolve();
    if (this.pending) return this.pending.promise;
    if (this.state === 'failed')
      return Promise.reject(new TerminalOutputError('terminal-refused'));
    let resolve!: () => void;
    let reject!: (error: TerminalOutputError) => void;
    const promise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    this.pending = { promise, resolve, reject };
    if (!this.started) void this.begin();
    return promise;
  }

  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    ++this.generation;
    clearTimeout(this.timer);
    clearTimeout(this.retryTimer);
    this.outputLifetime.abort();
    this.socket?.close();
    this.socket = undefined;
    this.pending?.reject(new TerminalOutputError('disposed'));
    this.pending = undefined;
    this.setState('disposed');
  }

  private setState(state: TerminalOutputState): void {
    this.state = state;
    try {
      this.options.onState?.(state);
    } catch {
      this.fail(new TerminalOutputError('output-failed'));
    }
  }

  private fail(error: TerminalOutputError): void {
    if (this.stopped || this.state === 'failed') return;
    ++this.generation;
    clearTimeout(this.timer);
    clearTimeout(this.retryTimer);
    this.outputLifetime.abort();
    this.socket?.close();
    this.socket = undefined;
    this.pending?.reject(error);
    this.pending = undefined;
    this.setState('failed');
    try {
      this.options.onError?.(error);
    } catch {
      /* Notification cannot prevent already-completed settlement. */
    }
  }

  private credentialGuard(configured: ClientCredential): () => void {
    const expected = this.options.requestScope;
    const authority = configured.requestAuthority;
    const current = authority?.isCurrent;
    const authorityKey = authority?.authorityKey;
    const apiBase = authority?.apiBase;
    const transportCurrent = configured.transportBindingIsCurrent;
    if (
      new URL(configured.origin).origin !==
        new URL(this.options.apiBase).origin ||
      (authority && apiBase !== this.options.apiBase) ||
      (expected &&
        (!authority ||
          expected.authorityKey !== authorityKey ||
          expected.apiBase !== apiBase))
    )
      throw new TerminalOutputError('authority-changed');
    return () => {
      assertClientRawEgressAllowed(this.options.apiBase, 'terminal', expected);
      if ((current && !current()) || (transportCurrent && !transportCurrent()))
        throw new TerminalOutputError('authority-changed');
    };
  }

  private async begin(): Promise<void> {
    const generation = ++this.generation;
    this.started = true;
    clearTimeout(this.retryTimer);
    this.timer = setTimeout(
      () => this.fail(new TerminalOutputError('connection-timeout')),
      5000,
    );
    this.setState('connecting');
    if (generation !== this.generation || this.stopped) return;
    try {
      assertClientRawEgressAllowed(
        this.options.apiBase,
        'terminal',
        this.options.requestScope,
      );
      const configured = await this.options.resolveCredential();
      if (this.stopped || generation !== this.generation) return;
      // A native shell's host transport owns its bearer: the ticket is
      // minted through it, so the renderer never holds the credential.
      if (!configured?.credential && !configured?.transport)
        throw new TerminalOutputError('credential-unavailable');
      this.assertAuthority = this.credentialGuard(configured);
      this.assertAuthority();
      clearTimeout(this.timer);
      const probeScope = this.options.requestScope ??
        configured.requestAuthority ?? {
          apiBase: this.options.apiBase,
          authorityKey: 'terminal-output-captured',
        };
      const probeCredential: ClientCredential = {
        ...configured,
        requestAuthority: {
          ...probeScope,
          isCurrent: () => {
            if (this.stopped || generation !== this.generation) return false;
            try {
              this.assertAuthority();
              return true;
            } catch {
              return false;
            }
          },
        },
      };
      // The authenticated ticket mint distinguishes an older host's 404 from
      // an access refusal before the WebSocket API hides HTTP status, and its
      // single-use ticket admits the socket before the upgrade.
      let probe: Response;
      try {
        probe = await postWithResolvedCredential(
          this.options.apiBase.replace(/\/$/, '') + TERMINAL_TICKET_PATH,
          {
            authentication: 'required',
            requestScope: probeScope,
            redirect: 'error',
            signal: this.outputLifetime.signal,
            timeoutMs: 5000,
            readOnly: true,
          },
          probeCredential,
        );
      } catch (error) {
        if (
          error instanceof TypeError ||
          error instanceof StationRequestTimeoutError
        ) {
          if (!this.stopped && generation === this.generation) {
            this.assertAuthority();
            clearTimeout(this.timer);
            this.setState('disconnected');
            this.retry();
          }
          return;
        }
        throw error;
      }
      if (probe.status !== 200) await probe.body?.cancel();
      if (this.stopped || generation !== this.generation) return;
      this.assertAuthority();
      if (probe.status === 404)
        throw new TerminalOutputError('unsupported-host');
      if (probe.status !== 200)
        throw new TerminalOutputError('terminal-refused');
      const minted = (await readJsonBody(probe)) as {
        data?: { ticket?: unknown };
      } | null;
      const ticket = minted?.data?.ticket;
      if (typeof ticket !== 'string' || !TERMINAL_TICKET_PATTERN.test(ticket))
        throw new TerminalOutputError('protocol');
      if (this.stopped || generation !== this.generation) return;
      this.assertAuthority();
      this.timer = setTimeout(
        () => this.fail(new TerminalOutputError('connection-timeout')),
        5000,
      );
      const socket = (
        this.options.createSocket ??
        ((url, protocols) => new WebSocket(url, protocols))
      )(this.socketURL, [
        TERMINAL_SOCKET_PROTOCOL,
        TERMINAL_TICKET_PROTOCOL_PREFIX + ticket,
      ]);
      socket.binaryType = 'arraybuffer';
      this.socket = socket;
      const connection: TerminalOutputConnection = {
        socket,
        generation,
        requestId: String(generation),
        authenticated: false,
        attached: false,
        replayThrough: this.cursor,
        baselineAckNeeded: false,
      };
      socket.addEventListener('open', () => {
        if (generation !== this.generation || this.stopped) return;
        try {
          // The ticket admitted this socket before its upgrade; the server
          // acknowledges with `authenticated` and no credential is sent.
          this.assertAuthority();
          this.setState('authenticating');
        } catch (error) {
          this.fail(
            new TerminalOutputError(
              error instanceof StationRawEgressUnavailableError
                ? 'raw-egress-unavailable'
                : 'authority-changed',
            ),
          );
        }
      });
      socket.addEventListener('message', (event) => {
        if (generation !== this.generation || this.stopped) return;
        const data = 'data' in event ? event.data : undefined;
        const bytes =
          data instanceof ArrayBuffer
            ? data.byteLength
            : typeof data === 'string'
              ? new TextEncoder().encode(data).byteLength
              : 0;
        const binary = data instanceof ArrayBuffer;
        this.queuedBytes += bytes;
        if (binary) {
          ++this.queuedFrames;
          this.queuedFrameBytes += bytes;
        } else ++this.queuedControls;
        if (
          ++this.queued > 3 * TERMINAL_MAX_OUTSTANDING_OUTPUT_FRAMES + 8 ||
          this.queuedFrames > TERMINAL_MAX_OUTSTANDING_OUTPUT_FRAMES ||
          this.queuedFrameBytes >
            TERMINAL_WINDOW_BYTES +
              TERMINAL_MAX_OUTSTANDING_OUTPUT_FRAMES *
                TERMINAL_FRAME_HEADER_BYTES ||
          this.queuedControls >
            2 * TERMINAL_MAX_OUTSTANDING_OUTPUT_FRAMES + 8 ||
          (!binary && bytes > 4096) ||
          this.queuedBytes >
            TERMINAL_WINDOW_BYTES +
              TERMINAL_MAX_OUTSTANDING_OUTPUT_FRAMES *
                TERMINAL_FRAME_HEADER_BYTES +
              (2 * TERMINAL_MAX_OUTSTANDING_OUTPUT_FRAMES + 8) * 4096
        ) {
          this.fail(new TerminalOutputError('protocol'));
          return;
        }
        this.work = this.work
          .then(() => this.receive(connection, data))
          .catch((error: unknown) => {
            this.fail(
              error instanceof TerminalOutputError
                ? error
                : error instanceof StationRequestAuthorityError
                  ? new TerminalOutputError('authority-changed')
                  : error instanceof StationRawEgressUnavailableError
                    ? new TerminalOutputError('raw-egress-unavailable')
                    : new TerminalOutputError('output-failed'),
            );
          })
          .finally(() => {
            --this.queued;
            if (binary) {
              --this.queuedFrames;
              this.queuedFrameBytes -= bytes;
            } else --this.queuedControls;
            this.queuedBytes -= bytes;
          });
      });
      socket.addEventListener('close', (event) => {
        if (generation !== this.generation || this.stopped) return;
        clearTimeout(this.timer);
        this.socket = undefined;
        const code =
          'code' in event && typeof event.code === 'number' ? event.code : 1006;
        if (code >= 4400) {
          this.fail(new TerminalOutputError('terminal-refused'));
          return;
        }
        this.setState('disconnected');
        // Finish already-delivered rendering before choosing the resume cursor.
        this.timer = setTimeout(
          () => this.fail(new TerminalOutputError('output-failed')),
          5000,
        );
        void this.work.then(() => {
          if (
            generation !== this.generation ||
            this.stopped ||
            this.state === 'failed'
          )
            return;
          clearTimeout(this.timer);
          this.retry();
        });
      });
      socket.addEventListener('error', () => {
        /* The close event owns reconnect and its bound. */
      });
    } catch (error) {
      if (this.stopped || generation !== this.generation) return;
      clearTimeout(this.timer);
      this.fail(
        error instanceof TerminalOutputError
          ? error
          : error instanceof StationRequestAuthorityError
            ? new TerminalOutputError('authority-changed')
            : error instanceof StationRawEgressUnavailableError
              ? new TerminalOutputError('raw-egress-unavailable')
              : new TerminalOutputError('credential-unavailable'),
      );
    }
  }

  private retry(): void {
    if (++this.retries > 3) {
      this.fail(new TerminalOutputError('reconnect-exhausted'));
      return;
    }
    this.retryTimer = setTimeout(() => void this.begin(), 250);
  }

  private armProgressDeadline(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => this.fail(new TerminalOutputError('output-failed')),
      5000,
    );
  }

  private live(connection: TerminalOutputConnection): boolean {
    return connection.generation === this.generation && !this.stopped;
  }

  private async receive(
    connection: TerminalOutputConnection,
    data: unknown,
  ): Promise<void> {
    if (!this.live(connection)) return;
    this.assertAuthority();
    if (data instanceof ArrayBuffer) return this.applyOutput(connection, data);
    if (typeof data !== 'string' || data.length > 65536)
      throw new TerminalOutputError('protocol');
    const message = control.parse(JSON.parse(data));
    if (message.type === 'authenticated') return this.authenticated(connection);
    if (message.type === 'attached') return this.attached(connection, message);
    if (message.type === 'error')
      throw new TerminalOutputError('terminal-refused');
    if (!connection.attached) throw new TerminalOutputError('protocol');
    if (message.type === 'reset') return this.reset(connection, message);
    if (message.type === 'ready') return this.ready(connection, message.seq);
    if (message.sentThrough !== this.cursor)
      throw new TerminalOutputError('protocol');
    if (connection.baselineAckNeeded) {
      connection.baselineAckNeeded = false;
      this.send(connection.socket, {
        type: 'ack',
        channel: 1,
        seq: this.cursor,
      });
    }
  }

  private authenticated(connection: TerminalOutputConnection): void {
    if (connection.authenticated) throw new TerminalOutputError('protocol');
    connection.authenticated = true;
    this.send(connection.socket, {
      type: 'attach',
      requestId: connection.requestId,
      channel: 1,
      projectId: this.options.projectId,
      bindingKey: this.options.bindingKey,
      terminalId: this.options.terminalId,
      fromSeq: this.cursor,
      windowBytes: TERMINAL_WINDOW_BYTES,
    });
  }

  private attached(
    connection: TerminalOutputConnection,
    message: Extract<TerminalControl, { type: 'attached' }>,
  ): void {
    if (
      !connection.authenticated ||
      connection.attached ||
      message.requestId !== connection.requestId ||
      message.terminalId !== this.options.terminalId
    )
      throw new TerminalOutputError('protocol');
    if (
      message.maxOutstandingOutputFrames !==
      TERMINAL_MAX_OUTSTANDING_OUTPUT_FRAMES
    )
      throw new TerminalOutputError('unsupported-host');
    connection.attached = true;
    connection.replayThrough = message.replayThrough;
    connection.baselineAckNeeded = message.replayThrough <= this.cursor;
    this.armProgressDeadline();
    this.setState('replaying');
  }

  private async applyOutput(
    connection: TerminalOutputConnection,
    data: ArrayBuffer,
  ): Promise<void> {
    if (
      !connection.attached ||
      data.byteLength > TERMINAL_WINDOW_BYTES + TERMINAL_FRAME_HEADER_BYTES
    )
      throw new TerminalOutputError('protocol');
    const frame = decodeTerminalFrame(new Uint8Array(data));
    if (
      frame.kind !== TERMINAL_OUTPUT ||
      frame.channel !== 1 ||
      frame.seq !== this.cursor + 1
    )
      throw new TerminalOutputError('protocol');
    if (this.state !== 'ready') this.armProgressDeadline();
    await this.options.onOutput(
      frame.data,
      frame.seq,
      this.outputLifetime.signal,
    );
    if (!this.live(connection)) return;
    this.assertAuthority();
    this.cursor = frame.seq;
    connection.baselineAckNeeded = false;
    if (this.state === 'ready') clearTimeout(this.timer);
    else this.armProgressDeadline();
    if (connection.socket.readyState === 1)
      this.send(connection.socket, {
        type: 'ack',
        channel: 1,
        seq: this.cursor,
      });
  }

  private async reset(
    connection: TerminalOutputConnection,
    message: Extract<TerminalControl, { type: 'reset' }>,
  ): Promise<void> {
    this.armProgressDeadline();
    await this.options.onReset(message.fromSeq, this.outputLifetime.signal);
    if (!this.live(connection)) return;
    this.assertAuthority();
    this.cursor = message.fromSeq;
    connection.replayThrough = message.replayThrough;
    connection.baselineAckNeeded = message.replayThrough <= this.cursor;
    this.armProgressDeadline();
    this.setState('replaying');
  }

  private ready(connection: TerminalOutputConnection, sequence: number): void {
    if (sequence > this.cursor || sequence < connection.replayThrough)
      throw new TerminalOutputError('protocol');
    clearTimeout(this.timer);
    this.retries = 0;
    this.setState('ready');
    this.pending?.resolve();
    this.pending = undefined;
  }

  private send(socket: TerminalOutputSocket, value: object): void {
    this.assertAuthority();
    if (socket.readyState === 1) socket.send(JSON.stringify(value));
  }
}
