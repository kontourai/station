import crypto from 'node:crypto';

/**
 * #2452: the stdio JSON-RPC connection to one `muse serve` (MSP) host.
 *
 * MSP is newline-delimited JSON-RPC 2.0 over the host's stdin/stdout, and the
 * client owns both ends (`muse serve --help`: "The client owns this process's
 * stdin and stdout and is its only connection"). This module is only the
 * framing: requests with ids, the replies that settle them, and server
 * notifications handed to the session. Nothing here knows what a turn or an
 * approval is.
 *
 * Every handler is total. A malformed line, a reply to an unknown id, or a
 * server REQUEST (the probe observed none; MSP approvals are notifications)
 * never throws inside the stdout handler: a throw there would tear down the
 * whole session.
 */

/**
 * The per-session `muse serve` child. Unlike `MuseProcessLike` (exec never
 * reads stdin), a serve host is driven through stdin, so it is here.
 * Structural so tests inject a stream double without `node:child_process`.
 */
export interface MuseServeProcessLike {
  readonly pid?: number;
  stdin: {
    write(chunk: string): boolean;
    end(): void;
    on?(event: 'error', listener: (error: Error) => void): unknown;
  };
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'exit', listener: (code: number | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  once(event: 'exit', listener: (code: number | null) => void): this;
  removeListener(event: 'exit', listener: (code: number | null) => void): this;
}

export interface MuseServeSpawnResult {
  process: MuseServeProcessLike;
  /** Drops the owned-process registry record (see `spawnOwnedChild`). */
  release?: () => void;
}

/**
 * Cap on one unterminated stdout line. The largest observed MSP frames are
 * `approval/requested` (multi-stage subjects) and a completed `workflow` item
 * carrying its reconciliation message, both well under 64 KiB; a partial line
 * past this is a host writing without newlines, and is dropped rather than
 * growing memory without bound.
 */
const MUSE_SERVE_LINE_MAX_CHARS = 4 * 1024 * 1024;

/** Bound on the stderr tail kept for a host-exit diagnosis. */
const MUSE_SERVE_STDERR_TAIL_MAX_CHARS = 400;

export class MuseServeRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'MuseServeRpcError';
  }
}

/** The host went away (or the connection was closed) before replying. */
class MuseServeClosedError extends Error {
  constructor(readonly method: string) {
    super(`The Muse host closed before answering ${method}.`);
    this.name = 'MuseServeClosedError';
  }
}

export class MuseServeTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`The Muse host did not answer ${method} within ${timeoutMs} ms.`);
    this.name = 'MuseServeTimeoutError';
  }
}

export interface MuseServeCloseInfo {
  code: number | null;
  /** Bounded, unredacted tail; the caller redacts before publishing. */
  stderrTail: string;
  error?: Error;
}

export interface MuseServeConnectionHandlers {
  onNotification(method: string, params: Record<string, unknown>): void;
  onClose(info: MuseServeCloseInfo): void;
  /** A line that was not a JSON-RPC frame, or an overflowed partial line. */
  onProtocolNoise?(detail: string): void;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A client-minted UUIDv7. MSP requires one as every command's `commandId`
 * (the idempotency handle), and a fresh turn's `turnId` derives from it.
 */
export function museUuidV7(
  nowMs: number = Date.now(),
  random: (size: number) => Buffer = crypto.randomBytes,
): string {
  const bytes = random(16);
  let ts = BigInt(Math.max(0, Math.floor(nowMs)));
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class MuseServeConnection {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer = '';
  private stderrTail = '';
  private closed = false;
  private closeReported = false;

  constructor(
    private readonly process: MuseServeProcessLike,
    private readonly handlers: MuseServeConnectionHandlers,
  ) {
    process.stdout.on('data', (chunk: Buffer | string) => {
      this.handleStdout(typeof chunk === 'string' ? chunk : chunk.toString());
    });
    process.stderr.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString();
      this.stderrTail = (this.stderrTail + text).slice(
        -MUSE_SERVE_STDERR_TAIL_MAX_CHARS,
      );
    });
    process.on('exit', (code) => this.handleClose({ code }));
    process.on('error', (error) =>
      this.handleClose({ code: process.exitCode, error }),
    );
    process.stdin.on?.('error', (error) =>
      this.handleClose({ code: process.exitCode, error }),
    );
  }

  get isClosed(): boolean {
    return this.closed;
  }

  request<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.closed) return Promise.reject(new MuseServeClosedError(method));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry: PendingRequest = {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      if (options.timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            reject(new MuseServeTimeoutError(method, options.timeoutMs ?? 0));
          }
        }, options.timeoutMs);
      }
      this.pending.set(id, entry);
      if (!this.write({ jsonrpc: '2.0', id, method, params })) {
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(new MuseServeClosedError(method));
      }
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }

  /** Rejects every pending request; the process itself is the owner's to end. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending();
    try {
      this.process.stdin.end();
    } catch {
      // Already closed: nothing to end.
    }
  }

  private write(frame: Record<string, unknown>): boolean {
    if (this.closed) return false;
    try {
      this.process.stdin.write(`${JSON.stringify(frame)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  private rejectPending(): void {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new MuseServeClosedError(entry.method));
    }
  }

  private handleClose(info: { code: number | null; error?: Error }): void {
    this.closed = true;
    this.rejectPending();
    // Reported once: a spawn `error` is usually followed by an `exit`. An
    // owner-initiated `close()` still reports the eventual exit here.
    if (this.closeReported) return;
    this.closeReported = true;
    this.handlers.onClose({
      code: info.code,
      stderrTail: this.stderrTail,
      ...(info.error ? { error: info.error } : {}),
    });
  }

  private handleStdout(chunk: string): void {
    const combined = this.buffer + chunk;
    const parts = combined.split('\n');
    const remainder = parts.pop() ?? '';
    if (remainder.length > MUSE_SERVE_LINE_MAX_CHARS) {
      this.buffer = '';
      this.handlers.onProtocolNoise?.('stdout line exceeded the frame cap');
    } else {
      this.buffer = remainder;
    }
    for (const line of parts) this.handleLine(line);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let frame: unknown;
    try {
      frame = JSON.parse(trimmed);
    } catch {
      this.handlers.onProtocolNoise?.('non-JSON stdout line');
      return;
    }
    if (!isRecord(frame)) return;
    const method = typeof frame.method === 'string' ? frame.method : undefined;
    const hasId = typeof frame.id === 'number' || typeof frame.id === 'string';
    if (method && hasId) {
      // A server-initiated REQUEST. MSP 1.3 was never observed sending one
      // (approvals are notifications), but an unanswered request would park
      // whatever issued it, so it gets a spec-conformant refusal.
      this.write({
        jsonrpc: '2.0',
        id: frame.id,
        error: { code: -32601, message: `Station does not serve ${method}.` },
      });
      return;
    }
    if (method) {
      try {
        this.handlers.onNotification(
          method,
          isRecord(frame.params) ? frame.params : {},
        );
      } catch (error) {
        this.handlers.onProtocolNoise?.(
          `notification handler threw for ${method}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }
    if (typeof frame.id !== 'number') return;
    const entry = this.pending.get(frame.id);
    if (!entry) return;
    this.pending.delete(frame.id);
    if (entry.timer) clearTimeout(entry.timer);
    if (isRecord(frame.error)) {
      entry.reject(
        new MuseServeRpcError(
          entry.method,
          typeof frame.error.code === 'number' ? frame.error.code : -32603,
          typeof frame.error.message === 'string'
            ? frame.error.message
            : `${entry.method} failed`,
          frame.error.data,
        ),
      );
      return;
    }
    entry.resolve(frame.result);
  }
}
