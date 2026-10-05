import type { UsageLimitFailureDetails } from '@kontourai/station-contracts/connection-recovery';

interface CodexUsageWindow {
  usedPercent?: number;
  /** Epoch seconds, as the app-server reports it. */
  resetsAt?: number;
}

/**
 * #3157: the main Codex allowance as the session's `account/rateLimits/updated`
 * notifications last described it. Those notifications are sparse, so each
 * merges into what came before; a value that is absent or `null` keeps the
 * previous one.
 */
export interface CodexUsageLimitState {
  usageLimitWindows?: Map<'primary' | 'secondary', CodexUsageWindow>;
  usageLimitReachedType?: string;
}

/** `codexErrorInfo` values that mean the account ran out of allowance. */
const CODEX_USAGE_LIMIT_CODES: ReadonlySet<string> = new Set([
  'usageLimitExceeded',
  'rateLimitExceeded',
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/** Merges one `account/rateLimits/updated` notification's params. */
export function observeCodexRateLimits(
  state: CodexUsageLimitState,
  params: unknown,
): void {
  const limits = record(record(params)?.rateLimits);
  if (!limits) return;
  // A model-specific allowance (any other `limitId`) is not the one a turn's
  // usage-limit error reports against. Older CLIs omit the id.
  if (typeof limits.limitId === 'string' && limits.limitId !== 'codex') return;
  for (const id of ['primary', 'secondary'] as const) {
    const window = record(limits[id]);
    if (!window) continue;
    state.usageLimitWindows ??= new Map();
    const previous = state.usageLimitWindows.get(id) ?? {};
    const usedPercent = finite(window.usedPercent) ?? previous.usedPercent;
    const resetsAt = finite(window.resetsAt) ?? previous.resetsAt;
    state.usageLimitWindows.set(id, {
      ...(usedPercent === undefined ? {} : { usedPercent }),
      ...(resetsAt === undefined ? {} : { resetsAt }),
    });
  }
  if (typeof limits.rateLimitReachedType === 'string')
    state.usageLimitReachedType = limits.rateLimitReachedType;
}

/**
 * The usage-limit details for a failed turn's `codexErrorInfo`, or undefined
 * when the failure is not a usage limit. The reset is the latest reset among
 * the exhausted windows of the last snapshot, and only when every exhausted
 * window reported one. A workspace credit or spend limit does not lift at a
 * window reset, so it never carries one.
 */
export function codexUsageLimitDetails(
  state: CodexUsageLimitState,
  codexErrorInfo: unknown,
): UsageLimitFailureDetails | undefined {
  if (
    typeof codexErrorInfo !== 'string' ||
    !CODEX_USAGE_LIMIT_CODES.has(codexErrorInfo)
  ) {
    return undefined;
  }
  const exhausted = [...(state.usageLimitWindows?.values() ?? [])].filter(
    (window) => (window.usedPercent ?? 0) >= 100,
  );
  const resets = exhausted
    .map((window) => window.resetsAt)
    .filter((reset): reset is number => reset !== undefined && reset > 0);
  const windowLimited =
    state.usageLimitReachedType === undefined ||
    state.usageLimitReachedType === 'rate_limit_reached';
  const resetAt =
    windowLimited && exhausted.length > 0 && resets.length === exhausted.length
      ? new Date(Math.max(...resets) * 1_000)
      : undefined;
  return {
    usageLimit: true,
    scope: 'account',
    ...(resetAt && !Number.isNaN(resetAt.getTime())
      ? { resetAt: resetAt.toISOString() }
      : {}),
  };
}
