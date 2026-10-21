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
  /** Optional display label. Never use as account identity. */
  label?: string;
  /**
   * Optional non-secret environment overlay applied to engine sessions that
   * run under this profile (for example a proxy base URL). An empty-string
   * value masks an inherited variable. Credential-shaped names and values
   * are refused by a heuristic (names such as `*_KEY`, `*_TOKEN`, `*_AUTH`,
   * `*_HEADERS`; values carrying URL userinfo or an authorization header),
   * as are the profile-home keys and Station-internal names. It is visible
   * to anyone who can read connection settings and to the engine's tools.
   */
  env?: Record<string, string>;
}

/**
 * Value-free marker for a saved env overlay that breaks the env rules (for
 * example after a hand edit that pasted a key). Lists the offending
 * variable NAMES only, never values; malformed names are not echoed.
 */
export interface CredentialProfileEnvInvalid {
  names: string[];
}

/**
 * A profile as persisted in `CredentialProfileRegistryState`. `env`, when
 * present, is a valid overlay. When a saved overlay breaks the env rules,
 * normalization drops its values and persists `envInvalid` instead (and no
 * `env`), so the pasted text is not retained while unrelated writes keep
 * the profile refused rather than silently un-routed. Sessions under a
 * profile carrying `envInvalid` fail closed until its overlay is replaced.
 */
export interface CredentialProfileRecord extends CredentialProfile {
  envInvalid?: CredentialProfileEnvInvalid;
}

/** Management projection of a profile. */
export interface CredentialProfileProjection extends CredentialProfile {
  /**
   * Present when the saved overlay breaks the env rules (see
   * `CredentialProfileRecord`). Sessions under this profile fail closed
   * until the overlay is replaced; `env` is then omitted.
   */
  envInvalid?: CredentialProfileEnvInvalid;
}

/** Minimal profile metadata for an explicitly delegated engine sign-in. */
export interface EngineLoginProfile extends CredentialProfile {
  authState: 'authenticated' | 'unauthenticated' | 'unknown';
  mechanisms: Array<'device-code'>;
}

export interface EngineLoginProfiles {
  profiles: EngineLoginProfile[];
}

/** Explicit membership required before a profile can be automatically selected. */
export interface CredentialRecoveryGroup {
  profileRefs: string[];
  enrolledProfileRefs: string[];
}

/** Optional ranking within the existing authorized recovery candidates. */
export interface AllowanceRoutingPreference {
  /** Optimize this provider-reported window; other rolling resets do not rank. */
  windowId: string;
  minimumRemainingPercent: number;
}

/** Absence is deliberately equivalent to the default `automatic: false`. */
export interface CredentialRecoveryPolicy {
  automatic?: boolean;
  /** Explicit opt-in; omitted policy retains enrollment order. */
  allowancePreference?: AllowanceRoutingPreference;
}

export const DEFAULT_CREDENTIAL_RECOVERY_POLICY = {
  automatic: false,
} as const satisfies Pick<CredentialRecoveryPolicy, 'automatic'>;

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
 * Persisted, non-secret credential-profile state. Credential values belong to
 * the selected app-home directory, never to this record: a profile's `env`
 * overlay is refused (heuristically) when a name or value looks like a
 * credential, except an empty masking value.
 */
export interface CredentialProfileRegistryState {
  profiles?: CredentialProfileRecord[];
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
  profiles: CredentialProfileProjection[];
  group: CredentialRecoveryGroup;
  policy: CredentialRecoveryPolicy & { automatic: boolean };
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
  /** Why Station left this intent to the user or retired it unsent. */
  outcomeReason?: ConnectionRecoveryOutcomeReason;
  /**
   * #3157: armed from a provider usage-limit stop (`UsageLimitFailureDetails`).
   * Only these intents are gated by `usageLimitAutoResume` and re-checked
   * against the conversation before an unattended resume.
   */
  usageLimit?: true;
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
  outcomeReason?: ConnectionRecoveryOutcomeReason;
  /** #3157: the intent came from a provider usage-limit stop. */
  usageLimit?: true;
  /**
   * #3157: on a usage-limit intent still waiting (`armed`), whether the
   * `usageLimitAutoResume` setting currently lets it run unattended at
   * `dueAt`. The setting is applied only when the resume is due, so this can
   * change while it waits. Absent when the reader did not consult it.
   */
  autoResume?: boolean;
  updatedAt: string;
}

/**
 * #3157: why a usage-limit intent did not resume on its own. A `manual`
 * intent carries `auto-resume-off`. A `canceled` intent carries
 * `superseded`, `request-pending`, `session-ended` or `user-canceled` when one
 * of those retired it; other cancellations (a Stop, shutdown) carry no reason.
 */
export type ConnectionRecoveryOutcomeReason =
  /** The user has not turned on automatic resume after usage limits. */
  | 'auto-resume-off'
  /** A newer turn started in the conversation before the resume ran. */
  | 'superseded'
  /** The Session was waiting on an open request when the resume was due. */
  | 'request-pending'
  /** The Session closed or no longer exists. */
  | 'session-ended'
  /** The user chose Cancel auto-resume on the banner while it waited. */
  | 'user-canceled';

/**
 * #3157: `runtime.error` details an engine adapter attaches when the provider
 * itself reported a usage limit. The classifier reads `usageLimit` as a
 * `rate-limit` failure; `resetAt` is the provider's own reset time and is
 * absent when the provider gave none, which keeps the stop manual. Adapters
 * never derive it from message text (#2265).
 */
export interface UsageLimitFailureDetails {
  usageLimit: true;
  scope: 'account';
  /** ISO 8601 instant the limited window resets, as the provider reported it. */
  resetAt?: string;
}
