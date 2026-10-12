import type {
  SDKRateLimitInfo,
  TerminalReason,
} from '@anthropic-ai/claude-agent-sdk';
import type { UsageLimitFailureDetails } from '@kontourai/station-contracts/connection-recovery';

/**
 * #3157: what one Claude session record has learned about its subscription
 * usage-limit windows. A resume builds a new record, so nothing here outlives
 * the SDK query that reported it.
 */
export interface ClaudeUsageLimitState {
  /**
   * Windows the SDK last reported as `rejected` without overage to continue
   * on, keyed by `rateLimitType`, with the reset each one reported (ISO) or
   * `null` when it gave none. A later `allowed` report for a window removes
   * it, and a result that is not a usage-limit stop clears them all.
   */
  rejectedUsageLimits?: Map<string, string | null>;
  /** The running turn's reply was the SDK's synthetic `rate_limit` error. */
  usageLimitReply?: boolean;
}

/** Records one `rate_limit_event`'s `rate_limit_info`. */
export function observeClaudeRateLimit(
  state: ClaudeUsageLimitState,
  info: SDKRateLimitInfo | undefined,
): void {
  if (!info) return;
  const window = info.rateLimitType ?? 'unknown';
  // Overage keeps the session running past a rejected window; that is not a
  // stop, and its reset says nothing about when work can continue.
  const continuesOnOverage =
    info.overageStatus === 'allowed' ||
    info.overageStatus === 'allowed_warning' ||
    info.isUsingOverage === true ||
    info.overageInUse === true;
  if (info.status === 'rejected' && !continuesOnOverage) {
    state.rejectedUsageLimits ??= new Map();
    state.rejectedUsageLimits.set(window, claudeResetIso(info.resetsAt));
    return;
  }
  state.rejectedUsageLimits?.delete(window);
}

/** The SDK reports `resetsAt` in epoch seconds. */
function claudeResetIso(resetsAt: unknown): string | null {
  if (
    typeof resetsAt !== 'number' ||
    !Number.isFinite(resetsAt) ||
    resetsAt <= 0
  ) {
    return null;
  }
  const date = new Date(resetsAt * 1_000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Reads, and clears for the next turn, whether the turn a `result` closes
 * stopped on a usage limit. The limit is the result's own
 * `terminal_reason: 'blocking_limit'`, or a rejected window / rate-limit reply
 * seen during the turn when the result names no other cause. The reset is the
 * latest reset among the rejected windows, and only when every one of them
 * reported one: work cannot continue until all of them have reset.
 */
export function takeClaudeUsageLimitDetails(
  state: ClaudeUsageLimitState,
  result: { terminal_reason?: TerminalReason },
): UsageLimitFailureDetails | undefined {
  const reply = state.usageLimitReply === true;
  state.usageLimitReply = undefined;
  const resets = [...(state.rejectedUsageLimits?.values() ?? [])];
  const limited =
    result.terminal_reason === 'blocking_limit' ||
    ((resets.length > 0 || reply) &&
      (result.terminal_reason === undefined ||
        result.terminal_reason === 'api_error'));
  if (!limited) {
    // A turn that ended for any other reason ran past every window it saw
    // rejected; a later failure must not inherit their resets.
    state.rejectedUsageLimits?.clear();
    return undefined;
  }
  const known = resets.filter((reset): reset is string => reset !== null);
  const resetAt =
    known.length > 0 && known.length === resets.length
      ? known.reduce((latest, reset) => (reset > latest ? reset : latest))
      : undefined;
  return {
    usageLimit: true,
    scope: 'account',
    ...(resetAt ? { resetAt } : {}),
  };
}
