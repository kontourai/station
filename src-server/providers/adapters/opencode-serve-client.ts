/**
 * HTTP and SSE client for one `opencode serve` (OpenCode 2.x) that Station
 * started on loopback (`opencode-serve-pool.ts`).
 *
 * - Auth: HTTP Basic, user `opencode`, the password Station generated for
 *   that server.
 * - Denylist (ruling R3): the server also manages the person's provider
 *   credentials and integrations. `GET /api/credential` answers stored keys
 *   in plain text. Station's transport never reads or writes those, so the
 *   client refuses every request under `/api/credential`,
 *   `/api/integration/<id>/connect`, `/api/pair` and `/auth/` before any
 *   network I/O. A path it cannot read unambiguously (a dot segment, an
 *   encoded slash or dot, a backslash) is refused the same way.
 * - Events: `GET /api/event` is one global SSE feed, live only (no ids, no
 *   replay). The server sends a `: heartbeat` comment about every 15s, so a
 *   feed silent past the bound is treated as gone.
 */

export const OPENCODE_SERVE_USER = 'opencode';
/** Three missed heartbeats (the server sends one about every 15s). */
export const OPENCODE_EVENT_HEARTBEAT_TIMEOUT_MS = 45_000;
/** Longest SSE frame Station buffers before refusing the feed. */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

const DENIED_PATHS: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  {
    pattern: /^\/api\/credential(?:$|[/?])/,
    why: 'stored provider credentials',
  },
  {
    pattern: /^\/api\/integration\/[^/?]+\/connect(?:$|[/?])/,
    why: 'provider sign-in',
  },
  { pattern: /^\/api\/pair(?:$|[/?])/, why: 'client pairing' },
  { pattern: /^\/auth\//, why: 'server sign-in' },
];

export class OpenCodeServeDeniedPathError extends Error {
  readonly code = 'opencode_serve_denied_path';
  constructor(path: string, why: string) {
    super(`Station does not call OpenCode's ${why} API (${path}).`);
    this.name = 'OpenCodeServeDeniedPathError';
  }
}

export class OpenCodeServeHttpError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`OpenCode answered ${method} ${path} with ${status}`);
    this.name = 'OpenCodeServeHttpError';
  }
}

export class OpenCodeEventStreamStalledError extends Error {
  constructor(timeoutMs: number) {
    super(`OpenCode's event stream sent nothing for ${timeoutMs}ms`);
    this.name = 'OpenCodeEventStreamStalledError';
  }
}

/**
 * Refuse a path the transport never calls. Throws; nothing is sent. The
 * path is checked as written and lower-cased, since the server's router is
 * not Station's to second-guess.
 */
export function assertOpenCodeServePathAllowed(path: string): void {
  if (!path.startsWith('/') || path.startsWith('//'))
    throw new OpenCodeServeDeniedPathError(path, 'non-relative path');
  const pathname = path.split(/[?#]/, 1)[0] ?? '';
  if (
    /(?:^|\/)\.\.?(?:\/|$)/.test(pathname) ||
    /%2e|%2f|%5c|\\/i.test(pathname)
  )
    throw new OpenCodeServeDeniedPathError(path, 'ambiguous path');
  const lowered = pathname.toLowerCase();
  for (const { pattern, why } of DENIED_PATHS) {
    if (pattern.test(lowered))
      throw new OpenCodeServeDeniedPathError(path, why);
  }
}

function assertLoopback(baseUrl: string): URL {
  const url = new URL(baseUrl);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    (url.pathname !== '/' && url.pathname !== '')
  )
    throw new Error(`Not a loopback OpenCode server URL: ${url.origin}`);
  return url;
}

export interface OpenCodeServeEvent {
  readonly id?: string;
  readonly type: string;
  readonly data?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

export interface OpenCodeServeClientOptions {
  readonly baseUrl: string;
  readonly password: string;
  readonly fetch?: typeof fetch;
}

export class OpenCodeServeClient {
  private readonly origin: string;
  private readonly authorization: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenCodeServeClientOptions) {
    this.origin = assertLoopback(options.baseUrl).origin;
    this.authorization = `Basic ${Buffer.from(
      `${OPENCODE_SERVE_USER}:${options.password}`,
    ).toString('base64')}`;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /**
   * One JSON request. Answers the parsed body (`undefined` for an empty
   * one); a non-2xx answer throws {@link OpenCodeServeHttpError}.
   */
  async request<T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    assertOpenCodeServePathAllowed(path);
    const headers: Record<string, string> = {
      authorization: this.authorization,
      accept: 'application/json',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await this.fetchImpl(`${this.origin}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const text = await response.text();
    let parsed: unknown;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!response.ok)
      throw new OpenCodeServeHttpError(method, path, response.status, parsed);
    return parsed as T;
  }

  /**
   * The server's event feed, as parsed events, until `signal` aborts, the
   * server ends it, or it stays silent past `heartbeatTimeoutMs` (then
   * {@link OpenCodeEventStreamStalledError}). Comment frames count as
   * activity and are not yielded.
   */
  async *events(
    options: { signal?: AbortSignal; heartbeatTimeoutMs?: number } = {},
  ): AsyncGenerator<OpenCodeServeEvent> {
    const path = '/api/event';
    assertOpenCodeServePathAllowed(path);
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await this.fetchImpl(`${this.origin}${path}`, {
        headers: {
          authorization: this.authorization,
          accept: 'text/event-stream',
        },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => '');
        throw new OpenCodeServeHttpError('GET', path, response.status, text);
      }
      yield* readOpenCodeEventStream(response.body, {
        heartbeatTimeoutMs:
          options.heartbeatTimeoutMs ?? OPENCODE_EVENT_HEARTBEAT_TIMEOUT_MS,
        signal: controller.signal,
      });
    } finally {
      options.signal?.removeEventListener('abort', abort);
      controller.abort();
    }
  }
}

/**
 * Parse an SSE body into events. Exported for the replay harness: it reads
 * a recorded body exactly as the live one. Frames end with a blank line
 * (`\n\n`), the only form OpenCode's feed sends.
 */
export async function* readOpenCodeEventStream(
  body: ReadableStream<Uint8Array>,
  options: { heartbeatTimeoutMs: number; signal?: AbortSignal },
): AsyncGenerator<OpenCodeServeEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      if (options.signal?.aborted) return;
      const chunk = await readWithin(reader, options.heartbeatTimeoutMs);
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > MAX_FRAME_BYTES)
        throw new Error('OpenCode sent an event frame past the size bound');
      let end = buffer.indexOf('\n\n');
      while (end >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf('\n\n');
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (!data) continue;
        let event: unknown;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        if (
          event !== null &&
          typeof event === 'object' &&
          typeof (event as { type?: unknown }).type === 'string'
        )
          yield event as OpenCodeServeEvent;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function readWithin(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<
  Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new OpenCodeEventStreamStalledError(timeoutMs)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
