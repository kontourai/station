/**
 * Bounded provider-plan quota failure facts (#2265).
 *
 * Engine-neutral classification of one narrow, evidenced shape: a provider
 * coding-plan quota exhaustion that arrives as a JSON-RPC request failure at
 * a terminal prompt-rejection seam (observed: Station → OpenCode ACP → ZAI,
 * where the engine's `session/prompt` rejects and the SDK surfaces the
 * failure as a `RequestError` carrying the engine's message).
 *
 * Neutral where the fact is neutral: the classifier takes an unknown
 * rejection value plus an explicitly supplied retry-after — it knows nothing
 * about ACP, OpenCode, or ZAI. The WIRING is engine-specific on purpose:
 * only the ACP adapter invokes this today, because only that path has an
 * evidenced failure shape. No other adapter may claim this classification
 * without its own observed wire form.
 *
 * Security contract (mirrors the #2269 delegation seam):
 *
 * - Classify ONLY a tightly validated full-message form on a whitelisted
 *   protocol wrapper. The wrapper is the SDK's JSON-RPC error envelope —
 *   an object with a finite numeric `code` and a string `message`
 *   (verified in `@agentclientprotocol/sdk`'s `jsonrpc.js`: response
 *   errors reject as `new RequestError(code, message, data)`). Transport
 *   failures (no numeric code), non-finite codes, arbitrary output, logs,
 *   and prompts never classify.
 * - The message must match the anchored quota form END TO END. A loose
 *   substring hit — the quota sentence embedded in a longer log, URL,
 *   header, body, or attacker-suffixed text — stays generic.
 * - The observed civil reset timestamp carries NO timezone. It is forwarded
 *   only as provider-reported text labelled unqualified, and it is NEVER
 *   parsed into an epoch, interpreted as UTC/machine-local, or turned into
 *   a countdown. A qualified `retryAfterMs` crosses only when genuinely
 *   supplied alongside the failure AND validated here (finite integer,
 *   positive, within 24 h).
 * - Reconstructed captures only: `quotaWindow`/`resetReported` are rebuilt
 *   from the validated digit captures, never echoed from the raw string, so
 *   nothing outside the validated shape can ride along.
 */

export const PROVIDER_PLAN_QUOTA_EXHAUSTED_CODE =
  'provider-plan-quota-exhausted';

/**
 * Fixed safe copy published on the canonical `runtime.error` for a
 * classified quota exhaustion. Stable, generic, and free of provider text —
 * it is what the terminal attribution fold and the sessions UI render.
 */
export const PROVIDER_PLAN_QUOTA_MESSAGE =
  'The provider plan quota was exhausted; the engine refused the turn.';

/**
 * Precision marker for the provider-reported reset text. `unqualified`
 * means the civil timestamp arrived with no timezone designator: Station
 * repeats it verbatim and never computes from it.
 */
export const PROVIDER_QUOTA_RESET_PRECISION_UNQUALIFIED = 'unqualified';

/** Upper bound accepted for a caller-supplied qualified retry-after (24 h). */
const QUOTA_RETRY_AFTER_MAX_MS = 24 * 60 * 60_000;

export interface ProviderQuotaFacts {
  /** Validated window text rebuilt from captures, e.g. `'5 hour'`. */
  quotaWindow: string;
  /**
   * Provider-reported civil reset timestamp, e.g.
   * `'2026-09-21 18:55:29'`. NO timezone — display only, never parsed.
   */
  resetReported: string;
  /**
   * Qualified retry-after in milliseconds, present ONLY when genuinely
   * supplied alongside the failure and validated here.
   */
  retryAfterMs?: number;
}

/**
 * The observed OpenCode-side wrapper is a short engine prefix ahead of the
 * provider sentence (the recorded 92-char instance is a 16-char prefix plus
 * the 76-char provider sentence). The slot is optional, bounded, and
 * colon-terminated so it can only be a label — the provider sentence itself
 * is matched literally and anchored at both ends.
 */
const QUOTA_MESSAGE_PATTERN =
  /^(?:[A-Za-z][A-Za-z0-9 _./-]{0,31}: )?Usage limit reached for ([0-9]{1,3}) (hour|hours)\. Your limit will reset at ([0-9]{4})-([0-9]{2})-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2})$/;

const QUOTA_WINDOW_PATTERN = /^([0-9]{1,3}) (hours?)$/;

const QUOTA_RESET_PATTERN =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$/;

function inRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/**
 * A quota window is a positive whole-hour count plus its unit. Zero (or an
 * all-zero spelling like `00 hour`) is not a limit window anyone reported —
 * it stays generic rather than projecting a bounded fact from it.
 */
function validQuotaWindow(text: string): boolean {
  const match = QUOTA_WINDOW_PATTERN.exec(text);
  if (!match) return false;
  return inRange(Number(match[1]), 1, 999);
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 2: {
      const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      return leap ? 29 : 28;
    }
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

function validCivilTimestamp(
  year: string,
  month: string,
  day: string,
  hour: string,
  minute: string,
  second: string,
): boolean {
  // Display-only calendar plausibility (no timezone, no epoch, no
  // countdown): the day must exist in the stated month — February 31 and
  // February 29 on a non-leap year stay generic.
  const yearNumber = Number(year);
  const monthNumber = Number(month);
  return (
    inRange(yearNumber, 1970, 2100) &&
    inRange(monthNumber, 1, 12) &&
    inRange(Number(day), 1, daysInMonth(yearNumber, monthNumber)) &&
    inRange(Number(hour), 0, 23) &&
    inRange(Number(minute), 0, 59) &&
    inRange(Number(second), 0, 59)
  );
}

function validRetryAfterMs(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= QUOTA_RETRY_AFTER_MAX_MS
    ? value
    : undefined;
}

/**
 * Classify a terminal prompt rejection as a provider-plan quota exhaustion.
 * Returns validated facts, or `undefined` for everything else — transport
 * errors, generic engine failures, malformed/unknown shapes, and
 * near-misses with extra text all stay generic.
 *
 * `retryAfterMs` is the ONLY structured input beyond the rejection itself,
 * and only the caller that genuinely received a qualified retry-after passes
 * it (no ACP/OpenCode/ZAI wire source supplies one today, so the ACP seam
 * passes nothing and the field stays absent).
 */
export function classifyProviderQuotaFailure(
  error: unknown,
  options?: { retryAfterMs?: unknown },
): ProviderQuotaFacts | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as Record<string, unknown>;
  // Whitelisted protocol wrapper: the SDK's JSON-RPC error envelope. A
  // transport breakdown ('ACP connection closed') carries no numeric code
  // and can never classify, no matter what its text says — and a
  // non-finite code (NaN/Infinity) is not a protocol code either.
  if (
    typeof record.code !== 'number' ||
    !Number.isFinite(record.code) ||
    typeof record.message !== 'string'
  ) {
    return undefined;
  }
  const match = QUOTA_MESSAGE_PATTERN.exec(record.message);
  if (!match) return undefined;
  const [, windowSize, windowUnit, year, month, day, hour, minute, second] =
    match;
  if (
    !validCivilTimestamp(year, month, day, hour, minute, second) ||
    !validQuotaWindow(`${windowSize} ${windowUnit}`)
  ) {
    return undefined;
  }
  const facts: ProviderQuotaFacts = {
    quotaWindow: `${windowSize} ${windowUnit}`,
    resetReported: `${year}-${month}-${day} ${hour}:${minute}:${second}`,
  };
  const retryAfterMs = validRetryAfterMs(options?.retryAfterMs);
  if (retryAfterMs !== undefined) facts.retryAfterMs = retryAfterMs;
  return facts;
}

/**
 * Re-validate quota facts read back off a persisted event's `details` for
 * the delegation seam. A forged or malformed details object can never
 * smuggle text across: only the validated shapes survive, everything else
 * is dropped (the caller still returns the bare allowlisted code).
 */
export function providerQuotaFactsFromDetails(
  details: unknown,
): ProviderQuotaFacts | undefined {
  if (!details || typeof details !== 'object') return undefined;
  const record = details as Record<string, unknown>;
  const { quotaWindow, resetReported } = record;
  if (
    typeof quotaWindow !== 'string' ||
    !validQuotaWindow(quotaWindow) ||
    typeof resetReported !== 'string' ||
    !QUOTA_RESET_PATTERN.test(resetReported)
  ) {
    return undefined;
  }
  const [date, time] = resetReported.split(' ');
  const [year, month, day] = date.split('-');
  const [hour, minute, second] = time.split(':');
  if (!validCivilTimestamp(year, month, day, hour, minute, second)) {
    return undefined;
  }
  const facts: ProviderQuotaFacts = { quotaWindow, resetReported };
  const retryAfterMs = validRetryAfterMs(record.retryAfterMs);
  if (retryAfterMs !== undefined) facts.retryAfterMs = retryAfterMs;
  return facts;
}

/** Canonical `details` payload for a classified quota `runtime.error`. */
export function providerQuotaEventDetails(
  facts: ProviderQuotaFacts,
): Record<string, unknown> {
  return {
    quotaWindow: facts.quotaWindow,
    resetReported: facts.resetReported,
    resetPrecision: PROVIDER_QUOTA_RESET_PRECISION_UNQUALIFIED,
    ...(facts.retryAfterMs !== undefined
      ? { retryAfterMs: facts.retryAfterMs }
      : {}),
  };
}

/**
 * Host-synthesized fixed detail for the delegation reason. The reset text
 * is labelled provider-reported with no timezone — the copy states what to
 * do (wait/check, then continue explicitly) and what Station did NOT do
 * (no retry, no model/provider switch, no paid fallback).
 */
export function formatProviderQuotaReasonDetail(
  facts: ProviderQuotaFacts,
): string {
  return (
    `The provider plan quota was exhausted (${facts.quotaWindow} window). ` +
    `The provider reported the limit resets at ${facts.resetReported} ` +
    `(provider-reported time, no timezone given) — wait for the reset or ` +
    `check the provider plan, then continue explicitly. ` +
    `Station did not retry, switch models or providers, or spend on a fallback.`
  );
}

/**
 * Fixed event text for the delegated-events projection, composed ONLY from
 * validated facts — no provider or raw text.
 */
export function formatProviderQuotaEventText(
  facts: ProviderQuotaFacts,
): string {
  return (
    `The provider plan quota was exhausted (${facts.quotaWindow} window; ` +
    `provider-reported reset ${facts.resetReported}, no timezone).`
  );
}
