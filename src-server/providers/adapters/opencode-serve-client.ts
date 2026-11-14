/**
 * HTTP and SSE client for one `opencode serve` (OpenCode 2.x) that Station
 * started on loopback (`opencode-serve-pool.ts`).
 *
 * - Auth: HTTP Basic, user `opencode`, the password Station generated for
 *   that server.
 * - Allowlist (ruling R3, tightened): the server also manages the person's
 *   provider credentials and integrations, and `GET /api/credential`
 *   answers stored keys in plain text. The client sends only the method and
 *   path templates in {@link OPENCODE_NATIVE_ROUTES}, the operations the
 *   native transport calls, matched segment by segment. A path holding `%`,
 *   `//`, `;`, a backslash or a dot segment is refused outright, since the
 *   server's router may decode it into something else. A never-allow list
 *   (credentials, sign-in, pairing, client tokens, PTY connect tokens,
 *   config writes) is checked first, so a route added to the table by
 *   mistake still cannot reach them. Refusals happen before any network I/O.
 * - Redaction: `GET /api/model` carries config-file provider keys in
 *   `settings.apiKey`; every answer is redacted before it leaves the client
 *   ({@link redactOpenCodeSecrets}).
 * - Events: `GET /api/event` is one global SSE feed, live only (no ids, no
 *   replay). The server sends a `: heartbeat` comment about every 15s, so a
 *   feed silent past the bound is treated as gone.
 */

export const OPENCODE_SERVE_USER = 'opencode';
/** Three missed heartbeats (the server sends one about every 15s). */
export const OPENCODE_EVENT_HEARTBEAT_TIMEOUT_MS = 45_000;
/** Longest wait for a JSON answer, unless the caller passes its own signal. */
export const OPENCODE_REQUEST_TIMEOUT_MS = 30_000;
/** Longest wait for the event feed's response headers. */
export const OPENCODE_EVENT_CONNECT_TIMEOUT_MS = 10_000;
/** Longest SSE frame Station buffers before refusing the feed. */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export type OpenCodeServeMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface OpenCodeServeRoute {
  /** The OpenAPI `operationId`, or `null` for the document itself. */
  readonly operationId: string | null;
  readonly method: OpenCodeServeMethod;
  /** `{name}` segments match one identifier segment. */
  readonly template: string;
}

/**
 * Every request the native transport makes. The fingerprint projects the
 * same operation ids (opencode-serve-fingerprint.ts), and a test checks each
 * template against the captured OpenAPI document.
 */
export const OPENCODE_NATIVE_ROUTES: readonly OpenCodeServeRoute[] = [
  { operationId: null, method: 'GET', template: '/openapi.json' },
  { operationId: 'server.info', method: 'GET', template: '/api/info' },
  { operationId: 'event.subscribe', method: 'GET', template: '/api/event' },
  { operationId: 'agent.get', method: 'GET', template: '/api/agent/{agentID}' },
  { operationId: 'command.list', method: 'GET', template: '/api/command' },
  { operationId: 'model.list', method: 'GET', template: '/api/model' },
  { operationId: 'mcp.list', method: 'GET', template: '/api/mcp' },
  {
    operationId: 'permission.saved.list',
    method: 'GET',
    template: '/api/permission/saved',
  },
  { operationId: 'session.create', method: 'POST', template: '/api/session' },
  {
    operationId: 'session.active',
    method: 'GET',
    template: '/api/session/active',
  },
  {
    operationId: 'session.get',
    method: 'GET',
    template: '/api/session/{sessionID}',
  },
  {
    operationId: 'session.update',
    method: 'PATCH',
    template: '/api/session/{sessionID}',
  },
  {
    operationId: 'session.switchAgent',
    method: 'POST',
    template: '/api/session/{sessionID}/agent',
  },
  {
    operationId: 'session.message.list',
    method: 'GET',
    template: '/api/session/{sessionID}/message',
  },
  {
    operationId: 'session.prompt',
    method: 'POST',
    template: '/api/session/{sessionID}/prompt',
  },
  {
    operationId: 'session.interrupt',
    method: 'POST',
    template: '/api/session/{sessionID}/interrupt',
  },
  {
    operationId: 'session.command',
    method: 'POST',
    template: '/api/session/{sessionID}/command',
  },
  {
    operationId: 'session.compact',
    method: 'POST',
    template: '/api/session/{sessionID}/compact',
  },
  {
    operationId: 'session.inbox.list',
    method: 'GET',
    template: '/api/session/{sessionID}/inbox',
  },
  {
    operationId: 'session.inbox.cancel',
    method: 'DELETE',
    template: '/api/session/{sessionID}/inbox/{inboxID}',
  },
  {
    operationId: 'session.permission.list',
    method: 'GET',
    template: '/api/session/{sessionID}/permission',
  },
  {
    operationId: 'session.permission.reply',
    method: 'POST',
    template: '/api/session/{sessionID}/permission/{requestID}/reply',
  },
  {
    operationId: 'session.form.list',
    method: 'GET',
    template: '/api/session/{sessionID}/form',
  },
  {
    operationId: 'session.form.reply',
    method: 'POST',
    template: '/api/session/{sessionID}/form/{formID}/reply',
  },
  {
    operationId: 'session.form.cancel',
    method: 'DELETE',
    template: '/api/session/{sessionID}/form/{formID}',
  },
  {
    operationId: 'session.revert.stage',
    method: 'POST',
    template: '/api/session/{sessionID}/revert/stage',
  },
  {
    operationId: 'session.revert.commit',
    method: 'POST',
    template: '/api/session/{sessionID}/revert/commit',
  },
  {
    operationId: 'session.revert.clear',
    method: 'DELETE',
    template: '/api/session/{sessionID}/revert',
  },
];

/**
 * Never sent, whatever the route table says. Matched on the lower-cased
 * pathname; `method` narrows a row to writes where reads are harmless.
 */
const NEVER_ALLOWED: ReadonlyArray<{
  pattern: RegExp;
  methods?: readonly OpenCodeServeMethod[];
  why: string;
}> = [
  { pattern: /^\/api\/credential/, why: 'stored provider credentials' },
  {
    pattern: /^\/api\/integration\/[^/]+\/connect/,
    why: 'provider sign-in',
  },
  { pattern: /^\/api\/pair/, why: 'client pairing' },
  { pattern: /^\/auth(?:\/|$)/, why: 'server sign-in' },
  {
    pattern: /^\/api\/experimental\/client-mcp\/token/,
    why: 'client MCP tokens',
  },
  { pattern: /^\/api\/pty\/[^/]+\/connect-token/, why: 'terminal tokens' },
  {
    pattern: /^\/api\/experimental\/persistent-pty\/[^/]+\/connect-token/,
    why: 'terminal tokens',
  },
  {
    pattern: /^\/api(?:\/experimental)?\/config/,
    methods: ['PUT', 'PATCH', 'POST', 'DELETE'],
    why: 'config writes',
  },
];

export class OpenCodeServeDeniedPathError extends Error {
  readonly code = 'opencode_serve_denied_path';
  constructor(path: string, why: string) {
    super(`Station does not call OpenCode's ${why} API (${path}).`);
    this.name = 'OpenCodeServeDeniedPathError';
  }
}

/**
 * A non-2xx answer. It keeps no response body: a body can echo a request's
 * or the server's secrets, and nothing Station does depends on it.
 */
export class OpenCodeServeHttpError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
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

/** One path segment Station fills in: an OpenCode id or agent name. */
const PARAM_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.~-]*$/;
/** The only query strings the transport sends. */
const QUERY = /^[A-Za-z0-9_.=&-]*$/;

function templateMatches(template: string, segments: string[]): boolean {
  const parts = template.split('/');
  if (parts.length !== segments.length) return false;
  return parts.every((part, index) => {
    const segment = segments[index] as string;
    if (part.startsWith('{') && part.endsWith('}'))
      return PARAM_SEGMENT.test(segment);
    return part === segment;
  });
}

/**
 * Refuse a request the transport never makes. Throws; nothing is sent.
 * `routes` is a parameter only so a test can prove the never-allow list
 * holds even against a table that lists a forbidden path.
 */
export function assertOpenCodeServePathAllowed(
  method: OpenCodeServeMethod,
  path: string,
  routes: readonly OpenCodeServeRoute[] = OPENCODE_NATIVE_ROUTES,
): void {
  if (!path.startsWith('/'))
    throw new OpenCodeServeDeniedPathError(path, 'non-relative path');
  if (/[%;\\#]|\/\//.test(path))
    throw new OpenCodeServeDeniedPathError(path, 'ambiguous path');
  const queryAt = path.indexOf('?');
  const pathname = queryAt < 0 ? path : path.slice(0, queryAt);
  const query = queryAt < 0 ? '' : path.slice(queryAt + 1);
  const segments = pathname.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..'))
    throw new OpenCodeServeDeniedPathError(path, 'ambiguous path');
  const lowered = pathname.toLowerCase();
  for (const rule of NEVER_ALLOWED) {
    if (
      rule.pattern.test(lowered) &&
      (!rule.methods || rule.methods.includes(method))
    )
      throw new OpenCodeServeDeniedPathError(path, rule.why);
  }
  if (!QUERY.test(query))
    throw new OpenCodeServeDeniedPathError(path, 'unexpected query');
  if (
    !routes.some(
      (route) =>
        route.method === method && templateMatches(route.template, segments),
    )
  )
    throw new OpenCodeServeDeniedPathError(path, `unlisted ${method}`);
}

const SECRET_KEY =
  /api[-_]?key|token|secret|password|credential|authorization|cookie/i;
const SECRET_HOLDERS = new Set(['settings', 'options']);
/** A header whose value is a credential. */
const SECRET_HEADER =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$|token|secret|key|auth|password|credential/i;
/** A query parameter whose value is a credential. */
const SECRET_QUERY_PARAM =
  /key|token|secret|password|credential|auth|sig(nature)?$|^code$/i;
const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * `value` without the credentials a URL can carry: its userinfo is dropped
 * and each secret-like query parameter's value is replaced. Any other
 * string is returned as it is.
 */
function redactUrl(value: string): string {
  if (!ABSOLUTE_URL.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  let changed = false;
  if (url.username || url.password) {
    url.username = '';
    url.password = '';
    changed = true;
  }
  for (const name of new Set(url.searchParams.keys()))
    if (SECRET_QUERY_PARAM.test(name)) {
      url.searchParams.set(name, 'redacted');
      changed = true;
    }
  return changed ? url.toString() : value;
}

/**
 * A copy of `value` without the secrets OpenCode can echo, applied to every
 * response body and every event of its feed:
 *
 * - every string under a `settings` or `options` object whose key reads
 *   like a secret (OpenCode answers `GET /api/model` with each model's
 *   provider settings, a config-file `apiKey` in plain text included);
 * - every credential-like entry of a `headers` object, anywhere;
 * - the userinfo and secret-like query parameters of any URL string (a
 *   provider `baseURL`).
 *
 * Station never needs any of them.
 */
export function redactOpenCodeSecrets(
  value: unknown,
  inHolder = false,
): unknown {
  if (typeof value === 'string') return redactUrl(value);
  if (Array.isArray(value))
    return value.map((item) => redactOpenCodeSecrets(item, false));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (inHolder && SECRET_KEY.test(key) && typeof child === 'string')
      out[key] = '[redacted]';
    else if (
      key.toLowerCase() === 'headers' &&
      child !== null &&
      typeof child === 'object' &&
      !Array.isArray(child)
    )
      out[key] = Object.fromEntries(
        Object.entries(child).map(([name, header]) => [
          name,
          SECRET_HEADER.test(name)
            ? '[redacted]'
            : redactOpenCodeSecrets(header, false),
        ]),
      );
    else
      out[key] = redactOpenCodeSecrets(
        child,
        SECRET_HOLDERS.has(key) || (inHolder && typeof child === 'object'),
      );
  }
  return out;
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
    method: OpenCodeServeMethod,
    path: string,
    body?: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    assertOpenCodeServePathAllowed(method, path);
    const timeout = AbortSignal.timeout(
      options.timeoutMs ?? OPENCODE_REQUEST_TIMEOUT_MS,
    );
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;
    const headers: Record<string, string> = {
      authorization: this.authorization,
      accept: 'application/json',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await this.fetchImpl(`${this.origin}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal,
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
      throw new OpenCodeServeHttpError(method, path, response.status);
    return redactOpenCodeSecrets(parsed) as T;
  }

  /**
   * The server's event feed, as parsed events, until `signal` aborts (the
   * iteration then simply ends), the server ends it, or it stays silent past
   * `heartbeatTimeoutMs` (then {@link OpenCodeEventStreamStalledError}).
   * Response headers that do not arrive within `connectTimeoutMs` count as
   * a stall too. Comment frames count as activity and are not yielded.
   */
  async *events(
    options: {
      signal?: AbortSignal;
      heartbeatTimeoutMs?: number;
      connectTimeoutMs?: number;
    } = {},
  ): AsyncGenerator<OpenCodeServeEvent> {
    const path = '/api/event';
    assertOpenCodeServePathAllowed('GET', path);
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) return;
    options.signal?.addEventListener('abort', abort, { once: true });
    const connectTimeoutMs =
      options.connectTimeoutMs ?? OPENCODE_EVENT_CONNECT_TIMEOUT_MS;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      let response: Response;
      try {
        response = await Promise.race([
          this.fetchImpl(`${this.origin}${path}`, {
            headers: {
              authorization: this.authorization,
              accept: 'text/event-stream',
            },
            signal: controller.signal,
          }),
          new Promise<never>((_, reject) => {
            connectTimer = setTimeout(
              () =>
                reject(new OpenCodeEventStreamStalledError(connectTimeoutMs)),
              connectTimeoutMs,
            );
          }),
        ]);
      } catch (error) {
        if (options.signal?.aborted) return;
        throw error;
      } finally {
        clearTimeout(connectTimer);
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new OpenCodeServeHttpError('GET', path, response.status);
      }
      try {
        yield* readOpenCodeEventStream(response.body, {
          heartbeatTimeoutMs:
            options.heartbeatTimeoutMs ?? OPENCODE_EVENT_HEARTBEAT_TIMEOUT_MS,
          signal: controller.signal,
        });
      } catch (error) {
        if (options.signal?.aborted) return;
        throw error;
      }
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
          yield redactOpenCodeSecrets(event) as OpenCodeServeEvent;
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
