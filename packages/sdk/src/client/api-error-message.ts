/**
 * What a refused request actually said.
 *
 * Lives in `client/` deliberately (station#3749): the React-free client entry
 * may only import its own siblings, and every fetcher under `client/` routes
 * its refusals through this module. `api-core` re-exports `apiErrorMessage`,
 * so the rest of the SDK has one import site and the whole package has one
 * rule.
 *
 * The shared zod middleware answers a rejected body with
 * `{ error: 'Validation failed', details: { fieldErrors } }` — the sentence
 * naming the broken rule is in `details`, and a caller reading `result.error`
 * alone can only ever show "Validation failed". A skill save refused for an
 * untypable command word therefore reached the editor with nothing to say
 * (station#3737).
 *
 * The runtime's own auth refusal is a second shape:
 * `{"error":{"code":"authentication_required"}}` — an OBJECT `error`, and no
 * `success` key at all. A fetcher that assumes the string shape renders
 * `[object Object]` (station#4-HOME-006).
 *
 * There used to be one rule per shape (`apiErrorMessage` read details,
 * `envelopeErrorMessage` read the object). Both are now thin wrappers over
 * `envelopeMessage` below, so every client derives the same sentence from the
 * same body (#2708). `StationHttpError` is defined here too (re-exported by
 * `http.ts`), so the rule and the error it builds need no import cycle.
 * `scripts/sdk-error-message-ratchet.mjs` holds the
 * hand-rolled reads at or below a per-file baseline, because an unadopted
 * helper regrows silently.
 */

/** A Station HTTP response failure whose status is safe for callers to branch on. */
export class StationHttpError extends Error {
  readonly status: number;

  /**
   * The response's `Retry-After` in milliseconds, when it sent one. Station's
   * runtime sends it with every 429 (`runtime-http.ts`'s auth-failure
   * limiter), which is the server stating exactly when a client may return —
   * an instruction a reconnecting stream should follow rather than guess past.
   */
  readonly retryAfterMs?: number;

  /**
   * The envelope's machine `code`, when it sent one (`{success:false,
   * error, code}`). Status says WHAT happened (404); the code says WHICH
   * one (a verified not-prepared Project vs. a removed one) — branch on
   * this, never on the message text. Absent on old servers, proxies and
   * non-JSON bodies, which is itself the signal that nothing is verified.
   */
  readonly code?: string;

  /**
   * The envelope's `details`, exactly as sent (#2708) — for a validation
   * refusal, `{ formErrors, fieldErrors }`. The message already carries the
   * sentences; this keeps the structure for a caller that renders per field.
   */
  readonly details?: unknown;

  constructor(
    status: number,
    message?: string,
    options?: { retryAfterMs?: number; code?: string; details?: unknown },
  ) {
    super(message ?? `HTTP ${status}`);
    this.name = 'StationHttpError';
    this.status = status;
    if (options?.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
    if (options?.code !== undefined) {
      this.code = options.code;
    }
    if (options?.details !== undefined) {
      this.details = options.details;
    }
  }
}

/**
 * Parses an HTTP `Retry-After` header. Only the delta-seconds form is honored:
 * the HTTP-date form depends on the client's clock agreeing with the server's,
 * and a skewed clock would produce a wait this code cannot bound. An
 * unparseable or negative value yields `undefined`, which leaves the caller on
 * its ordinary backoff.
 */
export function parseRetryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  // Digits only, deliberately. `Number()` would accept far more than the
  // delta-seconds grammar this claims to parse — `'0x10'` as 16 seconds,
  // `'1e3'` as 1000, `' '` and `''` as 0 — turning a malformed header into a
  // confident, wrong wait instead of falling through to the ordinary ladder.
  const trimmed = header.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds)) return undefined;
  return seconds * 1000;
}

/** Just enough of a `Response` to describe its failure. */
export interface EnvelopeFailureResponse {
  status: number;
  headers?: { get(name: string): string | null } | null;
}

/** Everything a failure envelope said, with the status it arrived under. */
export interface EnvelopeFailure {
  /** The observed HTTP status — a 2xx too, for a `success:false` body. */
  status: number;
  message: string;
  /** Top-level `code`, else the object `error`'s own `code`. */
  code?: string;
  /** The body's `details`, exactly as sent. */
  details?: unknown;
  /** `Retry-After` (delta-seconds only), in milliseconds. */
  retryAfterMs?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function stringEntries(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(nonBlank) : [];
}

/**
 * The one message rule, in order: the validation sentences in
 * `details.formErrors` / `details.fieldErrors`; a string `error`; an object
 * `error`'s `message`, then its `code` (a machine token, still shown rather
 * than swapped for an invention — it is what the server computed); the
 * top-level `message`; and only then `fallback`.
 */
export function envelopeMessage(body: unknown, fallback: string): string {
  const envelope = record(body);
  if (!envelope) return fallback;
  const details = record(envelope.details);
  const parts = stringEntries(details?.formErrors);
  const fieldErrors = record(details?.fieldErrors);
  if (fieldErrors) {
    for (const messages of Object.values(fieldErrors)) {
      parts.push(...stringEntries(messages));
    }
  }
  if (parts.length > 0) return parts.join(' ');
  const { error, message } = envelope;
  if (nonBlank(error)) return error;
  const detail = record(error);
  if (nonBlank(detail?.message)) return detail.message;
  if (nonBlank(detail?.code)) return detail.code;
  if (nonBlank(message)) return message;
  return fallback;
}

/**
 * The envelope's machine `code`: the top-level one, else the object `error`'s
 * own. Only a non-blank string counts — absence (an old server, a proxy page,
 * a non-JSON body) is the unverified signal, never a default.
 */
export function envelopeCode(body: unknown): string | undefined {
  const envelope = record(body);
  if (nonBlank(envelope?.code)) return envelope.code;
  const code = record(envelope?.error)?.code;
  return nonBlank(code) ? code : undefined;
}

/**
 * Reads a failure envelope into its parts. `body` is the parsed JSON, or
 * `undefined` when there was none; `status` is always the one observed.
 */
export function readEnvelopeFailure(
  response: EnvelopeFailureResponse,
  body: unknown,
  fallback: string,
): EnvelopeFailure {
  const failure: EnvelopeFailure = {
    status: response.status,
    message: envelopeMessage(body, fallback),
  };
  const code = envelopeCode(body);
  if (code !== undefined) failure.code = code;
  const details = record(body)?.details;
  if (details !== undefined && details !== null) failure.details = details;
  // Test doubles and some native transports hand back a bare object with no
  // `headers`; that is "no Retry-After", not a reason to lose the failure.
  const retryAfter =
    typeof response.headers?.get === 'function'
      ? response.headers.get('retry-after')
      : null;
  const retryAfterMs = parseRetryAfterMs(retryAfter);
  if (retryAfterMs !== undefined) failure.retryAfterMs = retryAfterMs;
  return failure;
}

/** `readEnvelopeFailure` as the error a fetcher throws. */
export function envelopeError(
  response: EnvelopeFailureResponse,
  body: unknown,
  fallback: string,
): StationHttpError {
  const { status, message, ...options } = readEnvelopeFailure(
    response,
    body,
    fallback,
  );
  return new StationHttpError(status, message, options);
}

/**
 * The message rule for a body a caller has already parsed. Kept for its
 * existing callers and the `api-core` export; it is `envelopeMessage`.
 */
export function apiErrorMessage(
  result:
    | {
        error?: unknown;
        message?: unknown;
        details?: { formErrors?: unknown; fieldErrors?: unknown };
      }
    | null
    | undefined,
  fallback: string,
): string {
  return envelopeMessage(result, fallback);
}
