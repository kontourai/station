import type {
  TelemetryRequestFailure,
  TelemetryRequestFailureCode,
} from '@kontourai/station-contracts/telemetry-delivery';
import { sanitizeFreeText } from '@kontourai/station-shared/redaction';

export class TelemetryRequestError extends Error {
  constructor(
    readonly code: TelemetryRequestFailureCode,
    readonly httpStatus?: number,
    /** A refusal's server-requested delay and sanitized reason; never logged. */
    readonly refusal: { retryAfterMs?: number; detail?: string } = {},
  ) {
    super(httpStatus === undefined ? code : `${code}: HTTP ${httpStatus}`);
  }
}

/**
 * A refusal that resending the same request cannot change (#4994). A 4xx
 * other than 408 (request timeout) and 429 (rate limited) judges the request
 * itself. Everything else, including a 2xx without a matching commit receipt,
 * may succeed later: the receiver deduplicates by event ID, so a resend after
 * an unreadable acknowledgement cannot double-count.
 */
export function isPermanentTelemetryFailure(
  failure: Pick<TelemetryRequestFailure, 'code' | 'httpStatus'>,
): boolean {
  const status = failure.httpStatus;
  return (
    failure.code === 'http_refused' &&
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  );
}

/** `Retry-After` as delta-seconds or an HTTP date; anything else is absent. */
export function parseRetryAfterMs(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

const ERROR_DETAIL_MAX_BYTES = 1024;
const ERROR_DETAIL_MAX_LENGTH = 200;
const IDENTIFIER_PATTERN =
  /\b(?:[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;
// Product source and publisher keys, which generic credential shapes miss.
const RECEIVER_KEY_PATTERN = /\bst[pq]_[A-Za-z0-9_-]{16,}/g;

/**
 * The reason a receiver gave for refusing a request, reduced to a short,
 * sanitized sentence for the delivery status. A JSON body contributes only its
 * `error`/`code`/`message`/`reason` strings, so an echoed batch never becomes
 * the detail; installation hashes and event IDs are masked, and known
 * credential shapes, URLs and paths are redacted. It is best effort: an
 * unreadable body yields no detail rather than a different failure.
 */
export async function readTelemetryErrorDetail(
  response: Response,
  signal: AbortSignal,
): Promise<string | undefined> {
  const reader = response.body?.getReader?.();
  if (!reader) return undefined;
  const bytes: number[] = [];
  try {
    while (bytes.length < ERROR_DETAIL_MAX_BYTES) {
      const { value, done } = await abortableTelemetryOperation(
        reader.read(),
        signal,
      );
      if (done) break;
      for (const byte of value.subarray(
        0,
        ERROR_DETAIL_MAX_BYTES - bytes.length,
      ))
        bytes.push(byte);
    }
  } catch {
    /* A partial body still explains the refusal; none leaves it absent. */
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return summarizeTelemetryErrorBody(
    new TextDecoder('utf-8').decode(new Uint8Array(bytes)),
  );
}

function summarizeTelemetryErrorBody(text: string): string | undefined {
  let summary = text;
  try {
    const parsed: unknown = JSON.parse(text);
    const fields: string[] = [];
    const collect = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      for (const key of ['error', 'code', 'message', 'reason']) {
        const field = (value as Record<string, unknown>)[key];
        if (typeof field === 'string') fields.push(field);
        else if (key === 'error') collect(field);
      }
    };
    collect(parsed);
    summary = fields.join(': ');
  } catch {
    /* Not JSON (or truncated): the text itself is the reason. */
  }
  summary = Array.from(summary, (character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? ' ' : character;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .replace(IDENTIFIER_PATTERN, '[id]')
    .replace(RECEIVER_KEY_PATTERN, '[redacted]')
    .trim();
  return summary
    ? sanitizeFreeText(summary, ERROR_DETAIL_MAX_LENGTH)
    : undefined;
}

export function telemetryRequestFailure(
  error: unknown,
  signal?: AbortSignal,
): TelemetryRequestFailure {
  return {
    at: new Date().toISOString(),
    code:
      error instanceof TelemetryRequestError
        ? error.code
        : signal?.aborted
          ? signal.reason === 'timeout'
            ? 'request_timeout'
            : 'request_cancelled'
          : 'request_failed',
    ...(error instanceof TelemetryRequestError && error.httpStatus !== undefined
      ? { httpStatus: error.httpStatus }
      : {}),
    ...(error instanceof TelemetryRequestError && error.refusal.detail
      ? { detail: error.refusal.detail }
      : {}),
  };
}

/** The deadline settles even when a transport does not cooperate with cancellation. */
export function abortableTelemetryOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(
        new TelemetryRequestError(
          signal.reason === 'timeout' ? 'request_timeout' : 'request_cancelled',
        ),
      );
    if (signal.aborted) {
      void operation.catch(() => undefined);
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    void operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Receipts and OTLP probe responses are bounded and never logged as remote content. */
export async function readTelemetryJson(
  response: Response,
  signal: AbortSignal,
  maxBytes = 8192,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new TelemetryRequestError('response_invalid');
  const bytes: number[] = [];
  try {
    for (;;) {
      const { value, done } = await abortableTelemetryOperation(
        reader.read(),
        signal,
      );
      if (done) break;
      if (bytes.length + value.length > maxBytes)
        throw new TelemetryRequestError('response_too_large');
      for (const byte of value) bytes.push(byte);
    }
    try {
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes)),
      );
    } catch {
      throw new TelemetryRequestError('response_invalid');
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
