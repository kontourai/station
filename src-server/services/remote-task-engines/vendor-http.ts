/**
 * The HTTP client every remote task binding uses. It owns what bindings must
 * not each get right on their own:
 *
 * - the credential header, built once per connection by the binding's
 *   `authorize` and never returned, logged or put in an error;
 * - status classification: 429 (and a binding's own rate-limit signal, such
 *   as GitHub's exhausted-quota 403) becomes `remote-task-rate-limited` with
 *   the vendor's wait; 5xx and network failures `remote-task-vendor-unavailable`;
 *   any other refusal `remote-task-vendor-refused` with the vendor's own message,
 *   redacted, so a plan or permission refusal reaches the person as the vendor
 *   said it (Station never pre-gates by plan);
 * - a request timeout.
 *
 * It never retries: an interactive caller gets the refusal and its wait; the
 * tracker owns backoff (`nextRemoteTaskPollDelay`).
 */
import { RemoteTaskError, redactSecret } from './remote-task-error.js';

export interface VendorErrorSummary {
  readonly message?: string;
  readonly code?: string;
}

export interface VendorHttpOptions {
  readonly vendorName: string;
  /** `https://host` with no trailing slash. */
  readonly baseUrl: string;
  /** Every request's headers, the credential included. */
  readonly headers: Readonly<Record<string, string>>;
  /** The connection's credential, removed from any vendor text Station passes on. */
  readonly secret: string;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly timeoutMs?: number;
  /** Reads the vendor's error envelope. */
  readonly readError: (body: unknown) => VendorErrorSummary;
  /** A vendor-specific rate-limit signal beyond HTTP 429. */
  readonly isRateLimited?: (status: number, headers: Headers) => boolean;
}

export interface VendorRequest {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly body?: unknown;
}

export interface VendorResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** The largest answer body Station reads from a vendor; a larger one is refused. */
export const VENDOR_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
/** An error body is read only this far: Station needs its first sentence. */
const VENDOR_ERROR_BODY_MAX_BYTES = 64 * 1024;

/**
 * The body as text, read no further than `maxBytes`; undefined when it is
 * longer (the rest is cancelled, never buffered).
 */
async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<string | undefined> {
  if (!response.body) return '';
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body.cancel().catch(() => {});
    return undefined;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * The vendor's wait in milliseconds: `Retry-After` as seconds or an HTTP
 * date, else an exhausted quota's `X-RateLimit-Reset` (epoch seconds).
 */
function retryAfterMs(headers: Headers, now: number): number | undefined {
  const retryAfter = headers.get('retry-after');
  if (retryAfter !== null) {
    const trimmed = retryAfter.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
    const at = Date.parse(trimmed);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  const reset = headers.get('x-ratelimit-reset');
  if (
    reset !== null &&
    /^\d+$/.test(reset.trim()) &&
    headers.get('x-ratelimit-remaining')?.trim() === '0'
  )
    return Math.max(0, Number(reset.trim()) * 1000 - now);
  return undefined;
}

export class VendorHttp {
  readonly #options: VendorHttpOptions;

  constructor(options: VendorHttpOptions) {
    if (!/^https:\/\/[^/]+$/.test(options.baseUrl))
      throw new Error('A vendor base URL must be https://host');
    this.#options = options;
  }

  #url(path: string, query?: VendorRequest['query']): string {
    const url = new URL(`${this.#options.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {}))
      if (value !== undefined) url.searchParams.set(key, String(value));
    return url.toString();
  }

  async #send(
    request: VendorRequest,
    extraHeaders: Record<string, string>,
  ): Promise<Response> {
    const options = this.#options;
    const timeout = AbortSignal.timeout(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    const headers: Record<string, string> = {
      ...options.headers,
      ...extraHeaders,
    };
    if (request.body !== undefined)
      headers['content-type'] = 'application/json';
    try {
      return await options.fetch(this.#url(request.path, request.query), {
        method: request.method,
        headers,
        ...(request.body !== undefined
          ? { body: JSON.stringify(request.body) }
          : {}),
        signal: timeout,
      });
    } catch {
      throw new RemoteTaskError(
        'remote-task-vendor-unavailable',
        `${options.vendorName} could not be reached.`,
        503,
      );
    }
  }

  async #refusal(response: Response): Promise<RemoteTaskError> {
    const options = this.#options;
    let body: unknown;
    try {
      const text = await readBounded(response, VENDOR_ERROR_BODY_MAX_BYTES);
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    const summary = options.readError(body);
    const vendorText = summary.message
      ? redactSecret(summary.message, options.secret)
      : undefined;
    const details = {
      vendorStatus: response.status,
      ...(summary.code
        ? { vendorCode: redactSecret(summary.code, options.secret) }
        : {}),
    };
    if (
      response.status === 429 ||
      options.isRateLimited?.(response.status, response.headers)
    ) {
      const wait = retryAfterMs(response.headers, options.now());
      return new RemoteTaskError(
        'remote-task-rate-limited',
        `${options.vendorName} is limiting requests; try again later.`,
        429,
        { ...details, ...(wait !== undefined ? { retryAfterMs: wait } : {}) },
      );
    }
    if (response.status >= 500)
      return new RemoteTaskError(
        'remote-task-vendor-unavailable',
        `${options.vendorName} answered with an error (${response.status}).`,
        503,
        details,
      );
    if (response.status === 404)
      return new RemoteTaskError(
        'remote-task-not-found',
        vendorText
          ? `${options.vendorName}: ${vendorText}`
          : `${options.vendorName} has no such task.`,
        404,
        details,
      );
    return new RemoteTaskError(
      'remote-task-vendor-refused',
      vendorText
        ? `${options.vendorName} refused the request: ${vendorText}`
        : `${options.vendorName} refused the request (${response.status}).`,
      502,
      details,
    );
  }

  /** One JSON request. A non-2xx answer throws a classified {@link RemoteTaskError}. */
  async json(request: VendorRequest): Promise<VendorResponse> {
    const response = await this.#send(request, {
      accept: this.#options.headers.accept ?? 'application/json',
    });
    if (!response.ok) throw await this.#refusal(response);
    if (response.status === 204)
      return {
        status: response.status,
        body: undefined,
        headers: response.headers,
      };
    let text: string | undefined;
    try {
      text = await readBounded(response, VENDOR_RESPONSE_MAX_BYTES);
    } catch {
      throw new RemoteTaskError(
        'remote-task-vendor-unavailable',
        `${this.#options.vendorName} stopped sending its answer.`,
        503,
      );
    }
    if (text === undefined)
      throw new RemoteTaskError(
        'remote-task-vendor-malformed',
        `${this.#options.vendorName} sent an answer larger than Station reads.`,
        502,
      );
    let body: unknown;
    try {
      body = text === '' ? undefined : JSON.parse(text);
    } catch {
      throw new RemoteTaskError(
        'remote-task-vendor-malformed',
        `${this.#options.vendorName} sent an answer Station could not read.`,
        502,
      );
    }
    return { status: response.status, body, headers: response.headers };
  }
}
