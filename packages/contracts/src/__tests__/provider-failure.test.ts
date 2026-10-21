import { describe, expect, it } from 'vitest';
import {
  PROVIDER_FAILURE_KINDS,
  PROVIDER_FAILURE_RETRYABLE,
  type ProviderFailureKind,
} from '../provider-failure.js';

// Independent wire expectations: changing a mapping or its retry semantics is
// a contract decision, even when the replacement is another valid kind.
const expected: ReadonlyArray<readonly [string, ProviderFailureKind, boolean]> =
  [
    ['foreground_invocation_unavailable', 'conflict', false],
    ['delegation_attempt_capacity', 'busy', true],
    ['continuation_place_refused', 'input_unsupported', false],
    ['SESSION_START_INDETERMINATE', 'indeterminate', false],
    ['delegation_files_unsupported', 'input_unsupported', false],
    ['delegation_files_duplicate_name', 'input_unsupported', false],
    ['delegation_files_count', 'input_unsupported', false],
    ['delegation_files_size', 'input_unsupported', false],
    ['delegation_files_invalid_name', 'input_unsupported', false],
    ['delegation_files_invalid_data', 'input_unsupported', false],
    ['delegation_files_ref_invalid', 'input_unsupported', false],
    ['delegation_files_unavailable', 'unavailable', true],
    ['delegation_files_start_refused', 'provider_error', false],
    ['delegation_files_turn_refused', 'provider_error', false],
    ['delegation_files_outcome_unknown', 'indeterminate', false],
    ['delegation_files_cleanup_failed', 'provider_error', false],
    ['stage_not_found', 'input_unsupported', false],
    ['stage_expired', 'input_unsupported', false],
    ['stage_forbidden', 'permission_denied', false],
    ['stage_grant_invalid', 'permission_denied', false],
    ['stage_cancelled', 'cancelled', false],
    ['stage_incomplete', 'input_unsupported', false],
    ['stage_invalid_upload', 'input_unsupported', false],
    ['stage_capacity', 'busy', true],
    ['continuation_engine_not_ready', 'unavailable', true],
    ['adoption_continuation_in_progress', 'busy', true],
    ['acp-approval-takeover-failed', 'warning', false],
    ['acp_approval_governance_refused', 'permission_denied', false],
    ['approval-escalation-requires-restart', 'warning', false],
    ['approval-full-access-not-granted', 'permission_denied', false],
    ['attachment_input_unsupported', 'input_unsupported', false],
    ['authentication_rate_limited', 'rate_limited', true],
    ['client_protocol_invalid', 'input_unsupported', false],
    ['client_protocol_unsupported', 'input_unsupported', false],
    ['client_turn_in_flight', 'busy', true],
    ['client_turn_input_conflict', 'conflict', false],
    ['client_turn_input_unsupported', 'input_unsupported', false],
    ['client_turn_settled', 'conflict', false],
    ['confined_full_access_unavailable', 'permission_denied', false],
    ['confinement_mechanism_unavailable', 'permission_denied', false],
    ['confinement_not_observed', 'permission_denied', false],
    ['confinement_workspace_incompatible', 'permission_denied', false],
    [
      'continuation_workspace_corrupt_worktree_binding',
      'input_unsupported',
      false,
    ],
    ['continuation_workspace_different_project', 'input_unsupported', false],
    ['continuation_workspace_direct_mismatch', 'input_unsupported', false],
    [
      'continuation_workspace_project_context_missing',
      'input_unsupported',
      false,
    ],
    ['continuation_workspace_unbound', 'input_unsupported', false],
    ['continuation_workspace_worktree_gone', 'input_unsupported', false],
    ['continuation_workspace_worktree_moved', 'input_unsupported', false],
    ['engine-decision-not-sent', 'warning', false],
    ['engine-decision-unacknowledged', 'warning', false],
    ['engine-session-binding-dead', 'session_gone', false],
    ['engine-turn-failed', 'provider_error', false],
    ['engine-sign-in-required', 'auth', false],
    ['execution_engine_changed', 'conflict', false],
    ['foreground_message_indeterminate', 'indeterminate', false],
    ['model-override-unsupported', 'input_unsupported', false],
    ['model_not_advertised', 'model_unavailable', false],
    ['muse-approval-decide-failed', 'warning', false],
    ['muse-approval-expired', 'warning', false],
    ['muse-approval-mode-not-applied', 'warning', false],
    ['muse-exit-without-terminal', 'engine_crashed', true],
    ['muse-held-turn-unfinished', 'warning', false],
    ['muse-lingering-child-reaped', 'warning', false],
    ['muse-serve-host-exited', 'engine_crashed', true],
    ['muse-serve-stop-unconfirmed', 'warning', false],
    ['muse-serve-unavailable', 'warning', false],
    ['muse-spawn-failed', 'unavailable', true],
    ['muse-terminal-not-completed', 'provider_error', false],
    ['muse-turn-idle-timeout', 'timeout', true],
    ['muse-turn-timeout', 'timeout', true],
    ['muse_turn_slot_releasing', 'busy', true],
    ['principal_unresolved', 'auth', false],
    ['project_identity_not_prepared', 'input_unsupported', false],
    ['provider-plan-quota-exhausted', 'quota_exhausted', false],
    ['provider_session_start_failed', 'unavailable', true],
    ['provider_session_starting', 'busy', true],
    ['provider_turn_in_progress', 'busy', true],
    ['resource_engine_start_capacity', 'busy', true],
    ['session-reattach-conflict', 'conflict', false],
    ['session_ended', 'session_gone', false],
    ['session_recovery_failed', 'unavailable', true],
    ['session_start_in_flight', 'busy', true],
    ['transcript-line-skipped', 'warning', false],
  ];

describe('provider failure wire contract', () => {
  it.each(expected)(
    '%s stays %s with retryable=%s',
    (code, kind, retryable) => {
      const mapping: Readonly<Record<string, ProviderFailureKind>> =
        PROVIDER_FAILURE_KINDS;
      const actualKind = mapping[code];
      expect({
        kind: actualKind,
        retryable:
          actualKind === undefined
            ? undefined
            : PROVIDER_FAILURE_RETRYABLE[actualKind],
      }).toEqual({ kind, retryable });
    },
  );

  it('pins every mapped diagnostic, including non-exported legacy codes', () => {
    expect(Object.keys(PROVIDER_FAILURE_KINDS).sort()).toEqual(
      expected.map(([code]) => code).sort(),
    );
  });
});
