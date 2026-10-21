import type { DelegationFileRefusalCode } from './attachment-staging.js';
import {
  CLIENT_PROTOCOL_INVALID_ERROR_CODE,
  CLIENT_PROTOCOL_UNSUPPORTED_ERROR_CODE,
} from './environment-security.js';
import { CONFINEMENT_REFUSAL_CODES } from './execution-confinement.js';
import {
  CONTINUATION_WORKSPACE_REFUSAL_CODES,
  EXECUTION_ENGINE_CHANGED_CODE,
} from './execution-target.js';
import { AUTH_RATE_LIMITED_ERROR_CODE } from './http.js';
import {
  APPROVAL_FULL_ACCESS_NOT_GRANTED_CODE,
  FOREGROUND_MESSAGE_INDETERMINATE_CODE,
} from './orchestration.js';
import { PRINCIPAL_UNRESOLVED_CODE } from './principal.js';
import { PROJECT_IDENTITY_NOT_PREPARED_CODE } from './project-identity.js';
import {
  ACP_APPROVAL_GOVERNANCE_REFUSED_CODE,
  ACP_APPROVAL_TAKEOVER_FAILED_CODE,
  APPROVAL_ESCALATION_REQUIRES_RESTART_CODE,
  ATTACHMENT_INPUT_UNSUPPORTED_CODE,
  CLIENT_TURN_IN_FLIGHT_CODE,
  CLIENT_TURN_INPUT_CONFLICT_CODE,
  CLIENT_TURN_INPUT_UNSUPPORTED_CODE,
  ENGINE_SESSION_BINDING_DEAD_CODE,
  ENGINE_SIGN_IN_REQUIRED_CODE,
  ENGINE_TURN_FAILED_CODE,
  MODEL_NOT_ADVERTISED_CODE,
  MODEL_OVERRIDE_UNSUPPORTED_CODE,
  MUSE_APPROVAL_DECIDE_FAILED_CODE,
  MUSE_APPROVAL_EXPIRED_CODE,
  MUSE_APPROVAL_MODE_NOT_APPLIED_CODE,
  MUSE_HELD_TURN_UNFINISHED_CODE,
  MUSE_LINGERING_CHILD_REAPED_CODE,
  MUSE_SERVE_HOST_EXITED_CODE,
  MUSE_SERVE_STOP_UNCONFIRMED_CODE,
  MUSE_SERVE_UNAVAILABLE_CODE,
  MUSE_TURN_IDLE_TIMEOUT_CODE,
  MUSE_TURN_SLOT_RELEASING_CODE,
  MUSE_TURN_TOTAL_TIMEOUT_CODE,
  PROVIDER_SESSION_START_FAILED_CODE,
  PROVIDER_SESSION_STARTING_CODE,
  PROVIDER_TURN_IN_PROGRESS_CODE,
  SESSION_REATTACH_CONFLICT_CODE,
} from './provider.js';
import { SESSION_ENDED_REJECTION_CODE } from './session-lifecycle.js';

export const PROVIDER_PLAN_QUOTA_EXHAUSTED_CODE =
  'provider-plan-quota-exhausted';
export const CODEX_DECISION_UNACKNOWLEDGED_CODE =
  'engine-decision-unacknowledged';
export const CODEX_DECISION_REPLY_REFUSED_CODE = 'engine-decision-not-sent';
export const TRANSCRIPT_LINE_SKIPPED_CODE = 'transcript-line-skipped';
export const SESSION_RECOVERY_FAILED_CODE = 'session_recovery_failed';
export const SESSION_START_INDETERMINATE_CODE = 'SESSION_START_INDETERMINATE';
export const CONFINED_FULL_ACCESS_UNAVAILABLE_CODE =
  'confined_full_access_unavailable';
export const SESSION_START_IN_FLIGHT_CODE = 'session_start_in_flight';
export const RESOURCE_ENGINE_START_CAPACITY_CODE =
  'resource_engine_start_capacity';
export const ADOPTION_ENGINE_NOT_READY_CODE = 'continuation_engine_not_ready';
export const ADOPTION_CONTINUATION_IN_PROGRESS_CODE =
  'adoption_continuation_in_progress';

/** Fixed eligibility for a caller-requested retry; never an automatic replay instruction. */
export const PROVIDER_FAILURE_RETRYABLE = {
  warning: false,
  auth: false,
  rate_limited: true,
  quota_exhausted: false,
  model_unavailable: false,
  provider_error: false,
  engine_crashed: true,
  unavailable: true,
  timeout: true,
  cancelled: false,
  busy: true,
  input_unsupported: false,
  session_gone: false,
  permission_denied: false,
  conflict: false,
  indeterminate: false,
} as const;

export type ProviderFailureKind = keyof typeof PROVIDER_FAILURE_RETRYABLE;

export interface ProviderFailure {
  kind: ProviderFailureKind;
  retryable: boolean;
  /** Refused means no provider-visible effect; failed may have spent resources. */
  failurePhase: 'refused' | 'failed' | 'indeterminate';
  /** Earliest known retry time, as an ISO 8601 timestamp. */
  retryAfter?: string;
}

/** Existing diagnostic codes retain their wire spelling, including warning codes. */
export const PROVIDER_FAILURE_KINDS = {
  delegation_files_unsupported: 'input_unsupported',
  delegation_files_duplicate_name: 'input_unsupported',
  delegation_files_count: 'input_unsupported',
  delegation_files_size: 'input_unsupported',
  delegation_files_invalid_name: 'input_unsupported',
  delegation_files_invalid_data: 'input_unsupported',
  delegation_files_ref_invalid: 'input_unsupported',
  delegation_files_unavailable: 'unavailable',
  delegation_files_start_refused: 'provider_error',
  delegation_files_turn_refused: 'provider_error',
  delegation_files_outcome_unknown: 'indeterminate',
  delegation_files_cleanup_failed: 'provider_error',
  stage_not_found: 'input_unsupported',
  stage_expired: 'input_unsupported',
  stage_forbidden: 'permission_denied',
  stage_grant_invalid: 'permission_denied',
  stage_cancelled: 'cancelled',
  stage_incomplete: 'input_unsupported',
  stage_invalid_upload: 'input_unsupported',
  stage_capacity: 'busy',
  [PROVIDER_PLAN_QUOTA_EXHAUSTED_CODE]: 'quota_exhausted',
  [CODEX_DECISION_UNACKNOWLEDGED_CODE]: 'warning',
  [CODEX_DECISION_REPLY_REFUSED_CODE]: 'warning',
  [TRANSCRIPT_LINE_SKIPPED_CODE]: 'warning',
  [SESSION_RECOVERY_FAILED_CODE]: 'unavailable',
  [SESSION_START_INDETERMINATE_CODE]: 'indeterminate',
  [CONFINED_FULL_ACCESS_UNAVAILABLE_CODE]: 'permission_denied',
  [SESSION_START_IN_FLIGHT_CODE]: 'busy',
  [RESOURCE_ENGINE_START_CAPACITY_CODE]: 'busy',
  [ADOPTION_CONTINUATION_IN_PROGRESS_CODE]: 'busy',
  [ADOPTION_ENGINE_NOT_READY_CODE]: 'unavailable',
  foreground_invocation_unavailable: 'conflict',
  delegation_attempt_capacity: 'busy',
  continuation_place_refused: 'input_unsupported',
  'muse-exit-without-terminal': 'engine_crashed',
  'muse-spawn-failed': 'unavailable',
  'muse-terminal-not-completed': 'provider_error',
  [CONFINEMENT_REFUSAL_CODES[0]]: 'permission_denied',
  [CONFINEMENT_REFUSAL_CODES[1]]: 'permission_denied',
  [CONFINEMENT_REFUSAL_CODES[2]]: 'permission_denied',
  [CONTINUATION_WORKSPACE_REFUSAL_CODES[0]]: 'input_unsupported',
  [CONTINUATION_WORKSPACE_REFUSAL_CODES[1]]: 'input_unsupported',
  [CONTINUATION_WORKSPACE_REFUSAL_CODES[2]]: 'input_unsupported',
  [CONTINUATION_WORKSPACE_REFUSAL_CODES[3]]: 'input_unsupported',
  [CONTINUATION_WORKSPACE_REFUSAL_CODES[4]]: 'input_unsupported',
  [CONTINUATION_WORKSPACE_REFUSAL_CODES[5]]: 'input_unsupported',
  [CONTINUATION_WORKSPACE_REFUSAL_CODES[6]]: 'input_unsupported',
  [CLIENT_PROTOCOL_UNSUPPORTED_ERROR_CODE]: 'input_unsupported',
  [CLIENT_PROTOCOL_INVALID_ERROR_CODE]: 'input_unsupported',
  [EXECUTION_ENGINE_CHANGED_CODE]: 'conflict',
  [AUTH_RATE_LIMITED_ERROR_CODE]: 'rate_limited',
  [APPROVAL_FULL_ACCESS_NOT_GRANTED_CODE]: 'permission_denied',
  [FOREGROUND_MESSAGE_INDETERMINATE_CODE]: 'indeterminate',
  [PRINCIPAL_UNRESOLVED_CODE]: 'auth',
  [PROJECT_IDENTITY_NOT_PREPARED_CODE]: 'input_unsupported',
  [MODEL_OVERRIDE_UNSUPPORTED_CODE]: 'input_unsupported',
  [MODEL_NOT_ADVERTISED_CODE]: 'model_unavailable',
  [SESSION_REATTACH_CONFLICT_CODE]: 'conflict',
  [APPROVAL_ESCALATION_REQUIRES_RESTART_CODE]: 'warning',
  [ENGINE_SESSION_BINDING_DEAD_CODE]: 'session_gone',
  [ENGINE_TURN_FAILED_CODE]: 'provider_error',
  [ENGINE_SIGN_IN_REQUIRED_CODE]: 'auth',
  [MUSE_TURN_IDLE_TIMEOUT_CODE]: 'timeout',
  [MUSE_TURN_TOTAL_TIMEOUT_CODE]: 'timeout',
  [MUSE_LINGERING_CHILD_REAPED_CODE]: 'warning',
  [MUSE_HELD_TURN_UNFINISHED_CODE]: 'warning',
  [MUSE_TURN_SLOT_RELEASING_CODE]: 'busy',
  [MUSE_APPROVAL_EXPIRED_CODE]: 'warning',
  [MUSE_APPROVAL_DECIDE_FAILED_CODE]: 'warning',
  [MUSE_SERVE_UNAVAILABLE_CODE]: 'warning',
  [MUSE_APPROVAL_MODE_NOT_APPLIED_CODE]: 'warning',
  [ACP_APPROVAL_TAKEOVER_FAILED_CODE]: 'warning',
  [ACP_APPROVAL_GOVERNANCE_REFUSED_CODE]: 'permission_denied',
  [MUSE_SERVE_HOST_EXITED_CODE]: 'engine_crashed',
  [MUSE_SERVE_STOP_UNCONFIRMED_CODE]: 'warning',
  [PROVIDER_TURN_IN_PROGRESS_CODE]: 'busy',
  [PROVIDER_SESSION_STARTING_CODE]: 'busy',
  [PROVIDER_SESSION_START_FAILED_CODE]: 'unavailable',
  [CLIENT_TURN_IN_FLIGHT_CODE]: 'busy',
  [CLIENT_TURN_INPUT_CONFLICT_CODE]: 'conflict',
  [CLIENT_TURN_INPUT_UNSUPPORTED_CODE]: 'input_unsupported',
  [ATTACHMENT_INPUT_UNSUPPORTED_CODE]: 'input_unsupported',
  [SESSION_ENDED_REJECTION_CODE]: 'session_gone',
} as const satisfies Readonly<
  Record<string, ProviderFailureKind> &
    Record<DelegationFileRefusalCode, ProviderFailureKind>
>;

export type ProviderFailureCode = keyof typeof PROVIDER_FAILURE_KINDS;
