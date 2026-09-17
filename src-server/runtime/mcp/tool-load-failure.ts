/**
 * Classification of a per-tool load failure.
 *
 * Station has two tool loaders — `loadAgentTools` (VoltAgent, in
 * ./mcp-manager.ts) and `loadStrandsTools` (src-server/runtime/frameworks/
 * strands-tool-loader.ts) — and both run every phase of a tool load inside one
 * per-tool `try`, though only one of those phases connects to anything. Passing
 * every throw through the connection vocabulary asserts a connection outcome
 * for a path that never opened a connection: #1482's `TypeError` on the
 * built-in vended-tool branch reported as a tool-server failure (#1485), and
 * the same shape in the VoltAgent loader reported as "Could not connect to
 * integration 'x'" (#1486).
 *
 * ONLY `loadAgentTools` CONSUMES THIS MODULE TODAY. The Strands loader carries
 * its own copy of these decisions, in flight as #1489/#1485 — the two were
 * developed in parallel and this module is the extraction of that branch's
 * final state, so the loaders agree on the rule before they agree on the code.
 * Folding the Strands loader onto this module is the follow-up that makes the
 * vocabulary literally shared rather than merely identical; until it lands, a
 * change here must be mirrored there.
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
 *    classes whose message is composed from program text.
 *    {@link isLoaderMessageDataDerived} names the rest — matched by class name
 *    AND by Node error code — whose text is composed from the data under
 *    examination. Those surface class-only, behind
 *    {@link LOADER_WITHHELD_STATUS_REASON}.
 *
 * Surfaced text — the class label included — has control, format and separator
 * characters flattened and is bounded before it reaches a status map an HTTP
 * response renders.
 */

import {
  StationOwnedToolServerError,
  ToolServerOperationError,
} from '../../services/plugins/tool-server-oauth.js';

/**
 * Classes the JavaScript runtime raises for a defect in the program itself.
 * Node's `AssertionError` carries `code: 'ERR_ASSERTION'` rather than a stable
 * constructor identity, so it is also matched by code below.
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
 * opens with the message, so the Error object is withheld too, not just its
 * `message` field; only the call FRAMES are logged ({@link loaderStackFrames}).
 *
 * THIS SET IS COMPLETE ONLY FOR THE CURRENT PRECONNECT CALL GRAPH, and it is a
 * set of MESSAGE COMPOSERS, not of classes. Node's own argument validation
 * throws ordinary `TypeError`/`RangeError` whose messages embed `util.inspect`
 * of the value received — `Buffer.from(123)` says `Received type number (123)`
 * — so those are matched by CODE below. Nothing preconnect calls `Buffer`,
 * `crypto`, `new URL`, or `decodeURIComponent` today; the moment something
 * does, or a helper starts composing a message from a config value, this
 * decision has to be made again. Adding a call to the preconnect stretch means
 * re-deciding what its failure text can quote.
 */
const LOADER_DATA_DERIVED_MESSAGE_NAMES = new Set([
  'AssertionError',
  'SyntaxError',
]);

/**
 * Node error codes whose message is composed from the value that was rejected
 * rather than from program text. These ride on plain `TypeError`/`RangeError`,
 * so the name set above cannot see them.
 */
const LOADER_DATA_DERIVED_MESSAGE_CODES = new Set([
  'ERR_ASSERTION',
  'ERR_INVALID_ARG_TYPE',
  'ERR_INVALID_ARG_VALUE',
  'ERR_OUT_OF_RANGE',
]);

/**
 * A surfaced detail is Station-composed but can quote a JavaScript runtime
 * message, so it is bounded and control characters are flattened before it
 * reaches a status map an HTTP response renders. The limit is the TOTAL
 * length, truncation marker included.
 */
export const LOADER_FAILURE_DETAIL_LIMIT = 300;
/** A class name is an identifier; nothing legitimate needs more than this. */
export const LOADER_FAILURE_CLASS_LIMIT = 60;
const LOADER_FAILURE_TRUNCATION_MARK = '… (truncated)';
/** Enough frames to locate the failing call without unbounded log growth. */
const LOADER_STACK_FRAME_LIMIT = 20;
/** A stack frame is a path plus a position; this is generous for both. */
const LOADER_STACK_FRAME_LIMIT_CHARS = 200;

/**
 * The Station-owned half of a withheld status. It says what was observed (the
 * load failed with nothing connected) and what was decided (the detail was
 * withheld) — both derived here — and nothing about WHY the throw happened,
 * which is the part this branch has determined it cannot safely quote.
 */
export const LOADER_WITHHELD_STATUS_REASON =
  'Tool load failed before any connection; detail withheld';

/**
 * Flatten anything that would break a single-line status field or smuggle
 * layout control into a log record: C0/C1 controls, format characters
 * (zero-width, bidi overrides), and the Unicode line/paragraph separators.
 */
function flattenLoaderText(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ');
}

function boundText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - LOADER_FAILURE_TRUNCATION_MARK.length)}${LOADER_FAILURE_TRUNCATION_MARK}`;
}

/**
 * The raw `name`, for exact matching against the decision sets above. Never
 * displayed: {@link loaderErrorClass} is the display form. Splitting the two
 * matters because the display form is flattened and bounded, and a bounded
 * label would silently stop matching a set entry.
 */
export function loaderErrorName(error: unknown): string {
  return error instanceof Error
    ? error.name || error.constructor?.name || 'Error'
    : '';
}

/**
 * The display form of the class. `name` is a writable own property on any
 * Error, so a class label reaching a status field or a log record gets the same
 * flatten-and-bound treatment as a message.
 */
export function loaderErrorClass(error: unknown): string {
  return boundText(
    flattenLoaderText(
      error instanceof Error
        ? loaderErrorName(error)
        : `non-error:${typeof error}`,
    ),
    LOADER_FAILURE_CLASS_LIMIT,
  );
}

/** How the surfaced detail names the throw. */
export function loaderFailureLabel(error: unknown): string {
  return error instanceof Error
    ? loaderErrorClass(error)
    : boundText(
        flattenLoaderText(`Non-Error thrown (${typeof error})`),
        LOADER_FAILURE_CLASS_LIMIT,
      );
}

function loaderErrorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' ? code : '';
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
  if (LOADER_PROGRAMMING_ERROR_NAMES.has(loaderErrorName(error))) return true;
  return LOADER_DATA_DERIVED_MESSAGE_CODES.has(loaderErrorCode(error));
}

/** Decision 2: is the throw's message composed from data rather than program text? */
export function isLoaderMessageDataDerived(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  return (
    LOADER_DATA_DERIVED_MESSAGE_NAMES.has(loaderErrorName(error)) ||
    LOADER_DATA_DERIVED_MESSAGE_CODES.has(loaderErrorCode(error))
  );
}

/**
 * The call frames only, so an operator can still locate the corrupt file when
 * the message itself is withheld.
 *
 * NOT `stack.split('\n').slice(1)`: a stack's header is `${name}: ${message}`
 * and a MULTI-LINE message (every `AssertionError`, and any `SyntaxError`
 * quoting a source window with a newline in it) spans several lines, so
 * dropping one line leaks the rest. Keep only frame-shaped lines, and drop any
 * line the message itself contains — that second test is what stops a message
 * with `\n    at …` in it from smuggling a line through as a fake frame.
 */
export function loaderStackFrames(error: unknown): string[] | undefined {
  if (!(error instanceof Error) || typeof error.stack !== 'string') {
    return undefined;
  }
  const message = typeof error.message === 'string' ? error.message : '';
  const frames = error.stack
    .split('\n')
    .filter((line) => /^\s+at\s/.test(line) && !message.includes(line.trim()))
    .slice(0, LOADER_STACK_FRAME_LIMIT)
    .map((line) =>
      boundText(flattenLoaderText(line.trim()), LOADER_STACK_FRAME_LIMIT_CHARS),
    );
  return frames.length ? frames : undefined;
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
    return {
      detail: `${LOADER_WITHHELD_STATUS_REASON} (${label})`,
      messageWithheld: true,
    };
  }
  const message = error instanceof Error ? error.message : '';
  if (!message) return { detail: label, messageWithheld: false };
  return {
    detail: boundText(
      `${label}: ${flattenLoaderText(message)}`,
      LOADER_FAILURE_DETAIL_LIMIT,
    ),
    messageWithheld: false,
  };
}
