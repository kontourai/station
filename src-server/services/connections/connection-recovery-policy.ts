import type {
  ConnectionRecoveryCapability,
  ConnectionRecoveryDecision,
  ConnectionRecoveryFailureKind,
  ConnectionRecoveryScope,
  ConnectionRecoveryTiming,
  CredentialRecoveryGroup,
  CredentialRecoveryPolicy,
} from '@kontourai/station-contracts/connection-recovery';
import {
  isAutomaticCredentialRecoveryEnabled,
  resolveCredentialProfileApplicationCapability,
} from '@kontourai/station-contracts/connection-recovery';
import { isRuntimeAuthenticationFailure } from './runtime-auth-health-monitor.js';

/** Recovery remains a short-lived continuity aid, never a long-term scheduler. */
export const MAX_RECOVERY_HORIZON_MS = 24 * 60 * 60 * 1_000;

export interface ClassifiedConnectionFailure {
  kind: ConnectionRecoveryFailureKind;
  scope: ConnectionRecoveryScope;
  timing: ConnectionRecoveryTiming;
}

export type CredentialRecoverySelectionRefusalReason =
  | 'authentication'
  | 'automatic_disabled'
  | 'not_exhausted'
  | 'ineligible_scope'
  | 'not_enrolled'
  | 'same_profile'
  | 'unsupported';

export type CredentialRecoveryCandidateSelection =
  | { outcome: 'selected'; candidateProfileRef: string }
  | {
      outcome: 'refused';
      reason: CredentialRecoverySelectionRefusalReason;
    };

/**
 * Strictly pure, fail-closed profile selection. This does not stage or apply a
 * profile; it only permits a caller to do so after an eligible observed failure.
 * Refusals never expose a candidate reference.
 */
export function selectCredentialRecoveryCandidate(input: {
  capability?: ConnectionRecoveryCapability;
  failure: ClassifiedConnectionFailure;
  policy?: CredentialRecoveryPolicy;
  group?: CredentialRecoveryGroup;
  activeProfileRef?: string;
  candidateProfileRef?: string;
}): CredentialRecoveryCandidateSelection {
  if (input.failure.kind === 'authentication') {
    return { outcome: 'refused', reason: 'authentication' };
  }
  if (
    input.failure.kind !== 'capacity' &&
    input.failure.kind !== 'rate-limit'
  ) {
    return { outcome: 'refused', reason: 'not_exhausted' };
  }
  if (input.failure.scope !== 'account') {
    return { outcome: 'refused', reason: 'ineligible_scope' };
  }
  if (!isAutomaticCredentialRecoveryEnabled(input.policy)) {
    return { outcome: 'refused', reason: 'automatic_disabled' };
  }
  if (
    !input.candidateProfileRef ||
    !input.group?.profileRefs.includes(input.candidateProfileRef) ||
    !input.group.enrolledProfileRefs.includes(input.candidateProfileRef)
  ) {
    return { outcome: 'refused', reason: 'not_enrolled' };
  }
  if (
    !input.activeProfileRef ||
    input.candidateProfileRef === input.activeProfileRef
  ) {
    return { outcome: 'refused', reason: 'same_profile' };
  }
  if (
    resolveCredentialProfileApplicationCapability(input.capability) ===
    'unsupported'
  ) {
    return { outcome: 'refused', reason: 'unsupported' };
  }
  return {
    outcome: 'selected',
    candidateProfileRef: input.candidateProfileRef,
  };
}

/**
 * Reduces an untrusted runtime error to bounded recovery classifications. The
 * raw error is deliberately consumed here and never returned or persisted.
 */
export function classifyConnectionFailure(error: {
  message: string;
  code?: string;
  details?: Record<string, unknown>;
}): ClassifiedConnectionFailure {
  if (isRuntimeAuthenticationFailure(error)) {
    return { kind: 'authentication', scope: 'unknown', timing: {} };
  }
  const code = error.code?.toLowerCase() ?? '';
  const message = error.message.toLowerCase();
  const details = error.details ?? {};
  const resetAt =
    typeof details.resetAt === 'string' ? details.resetAt : undefined;
  const retryAfterMs =
    typeof details.retryAfterMs === 'number' &&
    Number.isSafeInteger(details.retryAfterMs) &&
    details.retryAfterMs >= 0 &&
    details.retryAfterMs <= MAX_RECOVERY_HORIZON_MS
      ? details.retryAfterMs
      : undefined;
  const scope = details.scope;
  const classifiedScope: ConnectionRecoveryScope =
    scope === 'account' || scope === 'provider' || scope === 'server'
      ? scope
      : /server|overloaded|service unavailable/.test(`${code} ${message}`)
        ? 'server'
        : /provider|global/.test(`${code} ${message}`)
          ? 'provider'
          : /account|quota|billing/.test(`${code} ${message}`)
            ? 'account'
            : 'unknown';
  if (/rate.?limit|too_many_requests|429/.test(`${code} ${message}`)) {
    return {
      kind: 'rate-limit',
      scope: classifiedScope,
      timing: { resetAt, retryAfterMs },
    };
  }
  if (/capacity|quota|overloaded|unavailable/.test(`${code} ${message}`)) {
    return {
      kind: 'capacity',
      scope: classifiedScope,
      timing: { resetAt, retryAfterMs },
    };
  }
  return { kind: 'unknown', scope: 'unknown', timing: {} };
}

export function resolveRecoveryDueAt(
  timing: ConnectionRecoveryTiming,
  now: Date,
): string | undefined {
  if (timing.resetAt) {
    const parsedReset = Date.parse(timing.resetAt);
    if (
      Number.isSafeInteger(parsedReset) &&
      parsedReset >= now.getTime() - MAX_RECOVERY_HORIZON_MS &&
      parsedReset <= now.getTime() + MAX_RECOVERY_HORIZON_MS
    ) {
      return new Date(parsedReset).toISOString();
    }
  }
  if (
    typeof timing.retryAfterMs === 'number' &&
    Number.isSafeInteger(timing.retryAfterMs) &&
    timing.retryAfterMs >= 0 &&
    timing.retryAfterMs <= MAX_RECOVERY_HORIZON_MS
  ) {
    return new Date(now.getTime() + timing.retryAfterMs).toISOString();
  }
  return undefined;
}

/** Explicit decision table. No branch can return account switching. */
export function decideConnectionRecovery(input: {
  capability?: ConnectionRecoveryCapability;
  failure: ClassifiedConnectionFailure;
  now: Date;
}): { decision: ConnectionRecoveryDecision; dueAt?: string } {
  if (!input.capability?.sameSession) return { decision: 'unsupported' };
  if (input.failure.kind === 'authentication') return { decision: 'reconnect' };
  if (input.failure.kind === 'unknown') return { decision: 'manual' };
  const dueAt = resolveRecoveryDueAt(input.failure.timing, input.now);
  if (!dueAt) return { decision: 'manual' };
  return Date.parse(dueAt) <= input.now.getTime()
    ? { decision: 'retry-now', dueAt }
    : { decision: 'wait-until-reset', dueAt };
}
