/**
 * Classification of a per-tool load failure, shared by Station's tool loaders.
 *
 * Both loaders (`loadAgentTools` here, `loadStrandsTools` in
 * src-server/runtime/frameworks/strands-tool-loader.ts) run every phase of a
 * tool load inside one per-tool `try`, but only one of those phases connects to
 * anything. Passing every throw through the connection vocabulary asserts a
 * connection outcome for a path that never opened a connection — #1482's
 * `TypeError` on the built-in vended-tool branch reported as a tool-server
 * failure (#1485), and the same shape in the VoltAgent loader reported as
 * "Could not connect to integration 'x'" (#1486).
 *
 * These are pure functions over the thrown value. The PHASE — whether this
 * iteration had already attempted a connection — is the caller's to track, and
 * it is half of the rule: nothing here can decide it.
 *
 * ## The rule, two decisions in order
 *
 * 1. **Does the throw escape redaction?** Only when BOTH the caller says it was
 *    raised before the connection attempt AND {@link isLoaderProgrammingFailure}
 *    holds — the class is one the JavaScript runtime raises for a defect in the
 *    program itself, or the throw is not an `Error` at all. Everything from the
 *    connect / listTools / callTool path stays redacted whatever its class,
 *    because its message can be composed from remote data; so does any
 *    preconnect throw already wearing Station's bounded vocabulary
 *    (`ToolServerOperationError`, `StationOwnedToolServerError`) or an ordinary
 *    `Error`.
 * 2. **For an escaping throw, is its MESSAGE safe to surface?** Only for the
 *    classes whose message is composed from program text (`TypeError`,
 *    `ReferenceError`, `RangeError`, `EvalError`, `URIError`).
 *    {@link isLoaderMessageDataDerived} names the rest — `SyntaxError`,
 *    `AssertionError`/`ERR_ASSERTION`, and a thrown non-`Error` — whose text is
 *    composed from the data under examination. Those surface class-only.
 *
 * Surfaced text has control and format characters flattened and is bounded to
 * {@link LOADER_FAILURE_DETAIL_LIMIT} characters in total.
 */

import {
  StationOwnedToolServerError,
  ToolServerOperationError,
} from '../../services/plugins/tool-server-oauth.js';

/**
 * Classes the JavaScript runtime raises for a defect in the program itself.
 * Node's `AssertionError` carries `code: 'ERR_ASSERTION'` rather than a stable
 * constructor identity, so it is matched by both name and code.
 */
const LOADER_PROGRAMMING_ERROR_NAMES = new Set([
  'AssertionError',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
]);

/**
 * Escaping redaction decides that the CLASS is safe to name. It does not decide
 * that the MESSAGE is, and for these it is not: their text is composed from the
 * data the loader was examining rather than from program text.
 *
 * `SyntaxError` is the live one. `configLoader.loadIntegration` runs preconnect
 * and reaches unguarded `JSON.parse` calls on secret-bearing files —
 * `integration.json` (which can still hold plaintext legacy `env` values,
 * src-server/domain/config-loader-storage.ts) and the tool-server credential
 * store (plaintext secrets and OAuth tokens,
 * packages/shared/src/tool-server-credential-store.ts). V8 composes a
 * `SyntaxError` message from a WINDOW OF THE PARSED SOURCE, so a corrupt file
 * would publish secret fragments through `mcpConnectionStatus.error` into
 * `GET /agents/:slug/health` and into the log store. `AssertionError` composes
 * its message from the values compared, and a thrown non-`Error` IS a value.
 *
 * For these the class is surfaced and the text is dropped everywhere — status
 * AND log. Not "logged but redacted on egress": tool-server-oauth.ts records
 * that an earlier revision admitted raw error text to the debug logger on
 * exactly that theory and it did not hold, because `/api/diagnostics/logs`
 * serves those records to any authenticated diagnostics reader. `error.stack`
 * begins with `${name}: ${message}`, so callers withhold the whole Error object,
 * not just the message field.
 */
const LOADER_DATA_DERIVED_MESSAGE_NAMES = new Set([
  'AssertionError',
  'SyntaxError',
]);

/**
 * A surfaced detail is Station-composed but can quote a JavaScript runtime
 * message, so it is bounded before it reaches a status map an HTTP response
 * renders. The limit is the TOTAL length, truncation marker included.
 */
export const LOADER_FAILURE_DETAIL_LIMIT = 300;
const LOADER_FAILURE_TRUNCATION_MARK = '… (truncated)';

/** The throw's class name, or `non-error:<typeof>` for a thrown non-`Error`. */
export function loaderErrorClass(error: unknown): string {
  if (error instanceof Error) {
    return error.name || error.constructor?.name || 'Error';
  }
  return `non-error:${typeof error}`;
}

/** How the surfaced detail names the throw when its text is withheld. */
export function loaderFailureLabel(error: unknown): string {
  return error instanceof Error
    ? loaderErrorClass(error)
    : `Non-Error thrown (${typeof error})`;
}

/**
 * Decision 1's class half. The caller supplies the phase half; a `true` here is
 * not on its own a licence to surface anything.
 */
export function isLoaderProgrammingFailure(error: unknown): boolean {
  // A tool server reaches these seams by throwing an Error in every path the
  // loaders have; a thrown non-Error is Station's own code failing to throw
  // properly. The classification does not lean on that being exhaustive — a
  // non-Error's text is withheld either way (see LOADER_DATA_DERIVED_*).
  if (!(error instanceof Error)) return true;
  // Already bounded, Station-owned vocabulary — capture returns these as-is.
  if (
    error instanceof ToolServerOperationError ||
    error instanceof StationOwnedToolServerError
  ) {
    return false;
  }
  if (LOADER_PROGRAMMING_ERROR_NAMES.has(loaderErrorClass(error))) return true;
  return (error as { code?: unknown }).code === 'ERR_ASSERTION';
}

/** Decision 2: is the throw's message composed from data rather than program text? */
export function isLoaderMessageDataDerived(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  return (
    LOADER_DATA_DERIVED_MESSAGE_NAMES.has(loaderErrorClass(error)) ||
    (error as { code?: unknown }).code === 'ERR_ASSERTION'
  );
}

function boundLoaderDetail(detail: string): string {
  if (detail.length <= LOADER_FAILURE_DETAIL_LIMIT) return detail;
  const head = detail.slice(
    0,
    LOADER_FAILURE_DETAIL_LIMIT - LOADER_FAILURE_TRUNCATION_MARK.length,
  );
  return `${head}${LOADER_FAILURE_TRUNCATION_MARK}`;
}

export type LoaderFailureReport = {
  /** What a status map's `error` field receives. */
  detail: string;
  /** True when the throw's own text was dropped rather than surfaced. */
  messageWithheld: boolean;
};

/**
 * Decision 2 applied. Callers that reach here have already decided the throw
 * escapes redaction; this only chooses between "class and message" and
 * "class alone".
 */
export function describeLoaderFailure(error: unknown): LoaderFailureReport {
  const label = loaderFailureLabel(error);
  if (isLoaderMessageDataDerived(error)) {
    return { detail: label, messageWithheld: true };
  }
  const message = error instanceof Error ? error.message : '';
  if (!message) return { detail: label, messageWithheld: false };
  // Control and format characters would otherwise ride a multi-line runtime
  // message into a single-line status field.
  const flattened = message.replace(/[\p{Cc}\p{Cf}]/gu, ' ');
  return {
    detail: boundLoaderDetail(`${label}: ${flattened}`),
    messageWithheld: false,
  };
}
