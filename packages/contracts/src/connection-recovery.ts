/**
 * Provider-neutral, non-secret connection-recovery contract. Recovery refers
 * back to the canonical `turn.started` event; it never contains the prompt,
 * attachments, credential material, account identity, or a raw error.
 */
export type ConnectionRecoveryFailureKind =
  | 'authentication'
  | 'rate-limit'
  | 'capacity'
  | 'unknown';

/** The owner of the exhausted capacity, never an account selector. */
export type ConnectionRecoveryScope =
  | 'account'
  | 'provider'
  | 'server'
  | 'unknown';

export interface ConnectionRecoveryTiming {
  /** Preferred provider-declared reset time. */
  resetAt?: string;
  /** A bounded derived schedule when the runtime only gives a retry delay. */
  retryAfterMs?: number;
}

/** Optional declaration: omitting it is a hard opt-out. */
export interface ConnectionRecoveryCapability {
  sameSession: true;
  /** Total Station dispatch attempts for one durable intent. */
  maxAttempts?: number;
  /**
   * How an adapter can apply a selected credential profile. Omission is an
   * opt-out and projects as `unsupported`; it is never inferred from the
   * adapter or provider name.
   */
  application?: CredentialProfileApplicationCapability;
  /**
   * Evidence an Adapter can provide after it invokes a recovery dispatch.
   * A local queue write or `turn.started` observation is not provider
   * acceptance. Omission therefore fails closed after an invocation.
   */
  dispatchSettlement?: 'provider-response';
}

/** Truthful adapter declaration for selected credential-profile application. */
export type CredentialProfileApplicationCapability =
  | 'hot_apply'
  | 'restart_resume'
  | 'unsupported';

/** Returns the fail-closed projection for an optional adapter declaration. */
export function resolveCredentialProfileApplicationCapability(
  capability?: ConnectionRecoveryCapability,
): CredentialProfileApplicationCapability {
  return capability?.application ?? 'unsupported';
}

/** Non-secret registry metadata; the opaque ref is the only runtime identity. */
export interface CredentialProfile {
  ref: string;
  /** Optional management-only display label. Never use as account identity. */
  label?: string;
}

/** Explicit membership required before a profile can be automatically selected. */
export interface CredentialRecoveryGroup {
  profileRefs: string[];
  enrolledProfileRefs: string[];
}

/** Absence is deliberately equivalent to the default `automatic: false`. */
export interface CredentialRecoveryPolicy {
  automatic?: boolean;
}

export const DEFAULT_CREDENTIAL_RECOVERY_POLICY = {
  automatic: false,
} as const satisfies Required<CredentialRecoveryPolicy>;

/** No profile is automatically selected unless this exact opt-in is present. */
export function isAutomaticCredentialRecoveryEnabled(
  policy?: CredentialRecoveryPolicy,
): boolean {
  return policy?.automatic === true;
}

export type CredentialProfileApplicationOutcome =
  | 'staged'
  | 'adopted'
  | 'failed'
  | 'rolled_back'
  | 'rejected'
  | 'unsupported';

/**
 * Persisted, non-secret credential-profile state. Credential values belong
 * exclusively to the selected app-home directory, never to this record.
 */
export interface CredentialProfileRegistryState {
  profiles?: CredentialProfile[];
  group?: CredentialRecoveryGroup;
  policy?: CredentialRecoveryPolicy;
  activeProfileRef?: string;
  outcome?: CredentialProfileApplicationOutcome;
}

/** API/CLI/UI-safe current application state; contains no credential material. */
export interface CredentialProfileApplicationProjection {
  capability: CredentialProfileApplicationCapability;
  activeProfileRef?: string;
  pendingProfileRef?: string;
  outcome?: CredentialProfileApplicationOutcome;
}

/** Non-secret connection projection for profile management and recovery state. */
export interface CredentialRecoveryGroupProjection {
  profiles: CredentialProfile[];
  group: CredentialRecoveryGroup;
  policy: Required<CredentialRecoveryPolicy>;
  application: CredentialProfileApplicationProjection;
}

export type ConnectionRecoveryDecision =
  | 'retry-now'
  | 'wait-until-reset'
  | 'reconnect'
  | 'manual'
  | 'unsupported';

export type ConnectionRecoveryOutcome =
  | 'armed'
  /** A recovery decision that Station intentionally leaves to the user. */
  | 'manual'
  | 'resumed'
  /** Durable, identity-free marker that profile-state compensation must retry. */
  | 'compensation-required'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'unsupported'
  /** A provider invocation may have happened but Station cannot settle it. */
  | 'indeterminate';

/** Stored durably with opaque canonical event/turn identifiers only. */
export interface ConnectionRecoveryIntent {
  fingerprint: string;
  threadId: string;
  provider: string;
  sourceEventId: string;
  sourceTurnId: string;
  failureKind: ConnectionRecoveryFailureKind;
  scope: ConnectionRecoveryScope;
  decision: ConnectionRecoveryDecision;
  dueAt?: string;
  attempts: number;
  maxAttempts: number;
  outcome: ConnectionRecoveryOutcome;
  /** Provider acceptance is distinct from local canonical observation. */
  dispatchSettlement?: 'prepared' | 'accepted';
  /** Whether the prepared dispatch had staged a credential profile. */
  dispatchKind?: 'due' | 'profile';
  resumedTurnId?: string;
  createdAt: string;
  updatedAt: string;
}

/** Shared API/CLI session detail projection; intentionally content-free. */
export interface ConnectionRecoveryProjection {
  failureKind: ConnectionRecoveryFailureKind;
  scope: ConnectionRecoveryScope;
  decision: ConnectionRecoveryDecision;
  outcome: ConnectionRecoveryOutcome;
  dueAt?: string;
  attempts: number;
  maxAttempts: number;
  updatedAt: string;
}
