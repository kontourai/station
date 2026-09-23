/**
 * Raw Chrome DevTools Protocol over `--remote-debugging-pipe` (#90, D3).
 *
 * Chromium reads commands from its fd 3 and writes responses/events to its
 * fd 4. Each message is one JSON object terminated by a NUL byte. This module
 * owns that framing, request-id correlation, per-session event delivery and
 * failure semantics; it knows nothing about processes, so it is unit-tested
 * against an in-memory pipe.
 *
 * Failure semantics:
 * - Every pending request is rejected when the transport closes, whatever the
 *   cause (explicit close, pipe end/error, oversized or corrupt frame). A
 *   caller never waits on a request the browser can no longer answer.
 * - An incoming frame larger than `maxMessageBytes` closes the transport. The
 *   stream cannot be resynchronized safely without reading the rest of the
 *   frame, and an unbounded buffer is a memory hazard.
 */
import type { CdpTransport } from './browser-host.js';

/** Default incoming frame bound. Screencast JPEG frames are well under this. */
const DEFAULT_CDP_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

export interface CdpPipeWritable {
  write(chunk: Buffer): unknown;
  end(): unknown;
  on(event: 'error', fn: (error: Error) => void): unknown;
}

export interface CdpPipeReadable {
  on(event: 'data', fn: (chunk: Buffer) => void): unknown;
  on(event: 'end' | 'close', fn: () => void): unknown;
  on(event: 'error', fn: (error: Error) => void): unknown;
  destroy?(): unknown;
}

export interface CdpPipeTransportOptions {
  maxMessageBytes?: number;
}

/** A CDP command the browser answered with an `error` object. */
export class CdpProtocolError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    readonly protocolMessage: string,
  ) {
    super(`CDP ${method} failed: ${protocolMessage}`);
    this.name = 'CdpProtocolError';
  }
}

/** The transport closed before (or instead of) answering. */
export class CdpTransportClosedError extends Error {
  constructor(
    readonly method: string | undefined,
    readonly reason: string,
  ) {
    super(
      method
        ? `CDP ${method} was not answered: transport closed (${reason}).`
        : `CDP transport closed (${reason}).`,
    );
    this.name = 'CdpTransportClosedError';
  }
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

type Listener = (params: unknown, sessionId?: string) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class CdpPipeTransport implements CdpTransport {
  readonly closed: Promise<void>;
  private readonly maxMessageBytes: number;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly chunks: Buffer[] = [];
  private bufferedBytes = 0;
  private nextId = 1;
  private closeReasonValue: string | undefined;
  private resolveClosed!: () => void;

  constructor(
    private readonly writable: CdpPipeWritable,
    private readonly readable: CdpPipeReadable,
    options: CdpPipeTransportOptions = {},
  ) {
    this.maxMessageBytes =
      options.maxMessageBytes ?? DEFAULT_CDP_MAX_MESSAGE_BYTES;
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
    readable.on('data', (chunk: Buffer) => this.onData(chunk));
    readable.on('end', () => this.shutdown('pipe ended'));
    readable.on('close', () => this.shutdown('pipe closed'));
    readable.on('error', (error: Error) =>
      this.shutdown(`pipe read error: ${error.message}`),
    );
    writable.on('error', (error: Error) =>
      this.shutdown(`pipe write error: ${error.message}`),
    );
  }

  /** Why the transport closed, or undefined while it is open. */
  get closeReason(): string | undefined {
    return this.closeReasonValue;
  }

  get isClosed(): boolean {
    return this.closeReasonValue !== undefined;
  }

  send<R = unknown>(
    method: string,
    params?: object,
    sessionId?: string,
  ): Promise<R> {
    if (this.closeReasonValue !== undefined) {
      return Promise.reject(
        new CdpTransportClosedError(method, this.closeReasonValue),
      );
    }
    const id = this.nextId++;
    const message: Record<string, unknown> = { id, method };
    if (params !== undefined) message.params = params;
    if (sessionId !== undefined) message.sessionId = sessionId;
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      try {
        this.writable.write(
          Buffer.concat([Buffer.from(JSON.stringify(message)), Buffer.of(0)]),
        );
      } catch (error) {
        this.shutdown(`pipe write threw: ${(error as Error).message}`);
      }
    });
  }

  on(event: string, fn: Listener): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  /** Subscribe to one event for one CDP session only. */
  onSession(
    sessionId: string,
    event: string,
    fn: (params: unknown) => void,
  ): () => void {
    return this.on(event, (params, eventSessionId) => {
      if (eventSessionId === sessionId) fn(params);
    });
  }

  async close(): Promise<void> {
    this.shutdown('closed by caller');
    await this.closed;
  }

  private shutdown(reason: string): void {
    if (this.closeReasonValue !== undefined) return;
    this.closeReasonValue = reason;
    const pending = [...this.pending.values()];
    this.pending.clear();
    this.chunks.length = 0;
    this.bufferedBytes = 0;
    for (const request of pending) {
      request.reject(new CdpTransportClosedError(request.method, reason));
    }
    try {
      this.writable.end();
    } catch {
      // The write side may already be gone with the process.
    }
    try {
      this.readable.destroy?.();
    } catch {
      // Same: nothing left to release.
    }
    this.resolveClosed();
  }

  private onData(chunk: Buffer): void {
    if (this.closeReasonValue !== undefined) return;
    let start = 0;
    for (;;) {
      const nul = chunk.indexOf(0, start);
      if (nul === -1) break;
      const piece = chunk.subarray(start, nul);
      if (this.bufferedBytes + piece.length > this.maxMessageBytes) {
        this.shutdown(
          `incoming CDP message exceeded ${this.maxMessageBytes} bytes`,
        );
        return;
      }
      const frame =
        this.chunks.length === 0
          ? piece
          : Buffer.concat([...this.chunks, piece]);
      this.chunks.length = 0;
      this.bufferedBytes = 0;
      this.dispatchFrame(frame);
      if (this.closeReasonValue !== undefined) return;
      start = nul + 1;
    }
    const rest = chunk.subarray(start);
    if (rest.length === 0) return;
    if (this.bufferedBytes + rest.length > this.maxMessageBytes) {
      this.shutdown(
        `incoming CDP message exceeded ${this.maxMessageBytes} bytes`,
      );
      return;
    }
    // Copy: the caller may reuse the chunk's backing memory.
    this.chunks.push(Buffer.from(rest));
    this.bufferedBytes += rest.length;
  }

  private dispatchFrame(frame: Buffer): void {
    let message: unknown;
    try {
      message = JSON.parse(frame.toString('utf8'));
    } catch {
      this.shutdown('received a CDP frame that is not JSON');
      return;
    }
    if (!isRecord(message)) {
      this.shutdown('received a CDP frame that is not an object');
      return;
    }
    const sessionId =
      typeof message.sessionId === 'string' ? message.sessionId : undefined;
    if (typeof message.id === 'number') {
      const request = this.pending.get(message.id);
      // An id we never issued (or already settled) carries nothing to deliver.
      if (!request) return;
      this.pending.delete(message.id);
      if (isRecord(message.error)) {
        request.reject(
          new CdpProtocolError(
            request.method,
            typeof message.error.code === 'number'
              ? message.error.code
              : undefined,
            typeof message.error.message === 'string'
              ? message.error.message
              : 'unknown error',
          ),
        );
      } else {
        request.resolve(message.result ?? {});
      }
      return;
    }
    if (typeof message.method !== 'string') return;
    const set = this.listeners.get(message.method);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(message.params ?? {}, sessionId);
      } catch {
        // One faulty subscriber must not starve the others or the channel.
      }
    }
  }
}
