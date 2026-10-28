import { REMOTE_AUTH_PROTOCOL_VERSION } from '@kontourai/station-contracts/environment-security';
import {
  decodeTerminalFrame,
  TERMINAL_FRAME_HEADER_BYTES,
  TERMINAL_OUTPUT,
  TERMINAL_SOCKET_PATH,
  TERMINAL_WINDOW_BYTES,
} from '@kontourai/station-contracts/terminal-transport';
import { z } from 'zod';
import {
  type ApiRequestScope,
  assertClientRawEgressAllowed,
  type ClientCredential,
  type ClientCredentialResolver,
  getJson,
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
      | 'unsupported-host',
  ) {
    super(
      code === 'unsupported-host'
        ? 'This host does not support terminal output sessions. Update the host to use this feature.'
        : `Terminal output unavailable: ${code}`,
    );
    this.name = 'TerminalOutputError';
  }
}

export interface TerminalOutputSessionOptions {
  apiBase: string;
  projectId: string;
  bindingKey: string;
  terminalId: string;
  fromSeq?: number;
  resolveCredential: ClientCredentialResolver;
  requestScope?: ApiRequestScope;
  createSocket?: (url: string) => TerminalOutputSocket;
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
 * UNWIRED(#3994): the Coding view and native socket transport remain separate.
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
  private queuedBytes = 0;
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
      if (!configured?.credential || configured.transport)
        throw new TerminalOutputError('credential-unavailable');
      const credential = configured.credential;
      this.assertAuthority = this.credentialGuard(configured);
      this.assertAuthority();
      // The existing authenticated route distinguishes an older host's 404
      // from an access refusal before the WebSocket API hides HTTP status.
      const probe = await getJson(
        this.options.apiBase.replace(/\/$/, '') + TERMINAL_SOCKET_PATH,
        {
          credential,
          credentialOrigin: configured.origin,
          authentication: 'required',
          redirect: 'error',
          signal: this.outputLifetime.signal,
          timeoutMs: 5000,
        },
      );
      await probe.body?.cancel();
      if (this.stopped || generation !== this.generation) return;
      this.assertAuthority();
      if (probe.status === 404)
        throw new TerminalOutputError('unsupported-host');
      if (probe.status !== 204)
        throw new TerminalOutputError('terminal-refused');
      const socket = (
        this.options.createSocket ?? ((url) => new WebSocket(url))
      )(this.socketURL);
      socket.binaryType = 'arraybuffer';
      this.socket = socket;
      let authenticated = false;
      let attached = false;
      let replayThrough = this.cursor;
      const requestId = String(generation);
      socket.addEventListener('open', () => {
        if (generation !== this.generation || this.stopped) return;
        try {
          this.assertAuthority();
          this.setState('authenticating');
          socket.send(
            JSON.stringify({
              type: 'auth',
              protocolVersion: REMOTE_AUTH_PROTOCOL_VERSION,
              credential,
            }),
          );
        } catch {
          this.fail(new TerminalOutputError('authority-changed'));
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
        this.queuedBytes += bytes;
        if (
          ++this.queued > 128 ||
          this.queuedBytes > 2 * TERMINAL_WINDOW_BYTES
        ) {
          this.fail(new TerminalOutputError('protocol'));
          return;
        }
        this.work = this.work
          .then(async () => {
            if (generation !== this.generation || this.stopped) return;
            this.assertAuthority();
            if (data instanceof ArrayBuffer) {
              if (
                !attached ||
                data.byteLength >
                  TERMINAL_WINDOW_BYTES + TERMINAL_FRAME_HEADER_BYTES
              )
                throw new TerminalOutputError('protocol');
              const frame = decodeTerminalFrame(new Uint8Array(data));
              if (
                frame.kind !== TERMINAL_OUTPUT ||
                frame.channel !== 1 ||
                frame.seq !== this.cursor + 1
              )
                throw new TerminalOutputError('protocol');
              await this.options.onOutput(
                frame.data,
                frame.seq,
                this.outputLifetime.signal,
              );
              if (generation !== this.generation || this.stopped) return;
              this.assertAuthority();
              this.cursor = frame.seq;
              if (socket.readyState === 1)
                this.send(socket, {
                  type: 'ack',
                  channel: 1,
                  seq: this.cursor,
                });
              return;
            }
            if (typeof data !== 'string' || data.length > 65536)
              throw new TerminalOutputError('protocol');
            const message = control.parse(JSON.parse(data));
            if (message.type === 'authenticated') {
              if (authenticated) throw new TerminalOutputError('protocol');
              authenticated = true;
              this.send(socket, {
                type: 'attach',
                requestId,
                channel: 1,
                projectId: this.options.projectId,
                bindingKey: this.options.bindingKey,
                terminalId: this.options.terminalId,
                fromSeq: this.cursor,
                windowBytes: TERMINAL_WINDOW_BYTES,
              });
            } else if (message.type === 'attached') {
              if (
                !authenticated ||
                attached ||
                message.requestId !== requestId ||
                message.terminalId !== this.options.terminalId
              )
                throw new TerminalOutputError('protocol');
              attached = true;
              replayThrough = message.replayThrough;
              this.setState('replaying');
            } else if (message.type === 'error') {
              throw new TerminalOutputError('terminal-refused');
            } else {
              if (!attached) throw new TerminalOutputError('protocol');
              if (message.type === 'reset') {
                await this.options.onReset(
                  message.fromSeq,
                  this.outputLifetime.signal,
                );
                if (generation !== this.generation || this.stopped) return;
                this.assertAuthority();
                this.cursor = message.fromSeq;
                replayThrough = message.replayThrough;
                this.setState('replaying');
              } else if (message.type === 'progress') {
                if (message.sentThrough !== this.cursor)
                  throw new TerminalOutputError('protocol');
                this.send(socket, {
                  type: 'ack',
                  channel: 1,
                  seq: this.cursor,
                });
              } else if (message.type === 'ready') {
                if (message.seq > this.cursor || message.seq < replayThrough)
                  throw new TerminalOutputError('protocol');
                clearTimeout(this.timer);
                this.setState('ready');
                this.pending?.resolve();
                this.pending = undefined;
              }
            }
          })
          .catch((error: unknown) => {
            this.fail(
              error instanceof TerminalOutputError
                ? error
                : new TerminalOutputError('output-failed'),
            );
          })
          .finally(() => {
            --this.queued;
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
          if (++this.retries > 3) {
            this.fail(new TerminalOutputError('reconnect-exhausted'));
            return;
          }
          this.retryTimer = setTimeout(() => {
            void this.begin();
          }, 250);
        });
      });
      socket.addEventListener('error', () => {
        /* The close event owns reconnect and its bound. */
      });
    } catch (error) {
      this.fail(
        error instanceof TerminalOutputError
          ? error
          : new TerminalOutputError('credential-unavailable'),
      );
    }
  }

  private send(socket: TerminalOutputSocket, value: object): void {
    this.assertAuthority();
    if (socket.readyState === 1) socket.send(JSON.stringify(value));
  }
}
