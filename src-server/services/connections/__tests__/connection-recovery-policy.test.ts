import { describe, expect, test } from 'vitest';
import {
  classifyConnectionFailure,
  decideConnectionRecovery,
  MAX_RECOVERY_HORIZON_MS,
  selectCredentialRecoveryCandidate,
} from '../connection-recovery-policy.js';

const capable = { sameSession: true } as const;
const now = new Date('2026-07-29T12:00:00.000Z');

describe('connection recovery decision table', () => {
  test('authentication requires reconnect', () => {
    const failure = classifyConnectionFailure({
      message: 'Authentication token expired',
    });
    expect(
      decideConnectionRecovery({ capability: capable, failure, now }),
    ).toEqual({
      decision: 'reconnect',
    });
  });

  test('rate limit waits for an explicit reset and retries once reset has passed', () => {
    const failure = classifyConnectionFailure({
      message: '429 too many requests',
      details: { resetAt: '2026-07-29T12:01:00.000Z', scope: 'provider' },
    });
    expect(
      decideConnectionRecovery({ capability: capable, failure, now }),
    ).toEqual({
      decision: 'wait-until-reset',
      dueAt: '2026-07-29T12:01:00.000Z',
    });
    expect(
      decideConnectionRecovery({
        capability: capable,
        failure: {
          ...failure,
          timing: { resetAt: '2026-07-29T11:59:00.000Z' },
        },
        now,
      }),
    ).toEqual({ decision: 'retry-now', dueAt: '2026-07-29T11:59:00.000Z' });
  });

  test('#3157: an adapter usage-limit report is a rate limit whose reset decides the wait', () => {
    // Provider wording that matches none of the text patterns: only the
    // explicit flag classifies it.
    const message = "You've hit your limit · resets 1pm";
    expect(classifyConnectionFailure({ message }).kind).toBe('unknown');
    const failure = classifyConnectionFailure({
      message,
      code: 'engine-turn-failed',
      details: {
        usageLimit: true,
        scope: 'account',
        resetAt: '2026-07-29T13:00:00.000Z',
      },
    });
    expect(failure).toEqual({
      kind: 'rate-limit',
      scope: 'account',
      timing: { resetAt: '2026-07-29T13:00:00.000Z' },
      usageLimit: true,
    });
    expect(
      decideConnectionRecovery({ capability: capable, failure, now }),
    ).toEqual({
      decision: 'wait-until-reset',
      dueAt: '2026-07-29T13:00:00.000Z',
    });
    // The same stop without a provider reset stays manual.
    expect(
      decideConnectionRecovery({
        capability: capable,
        failure: classifyConnectionFailure({
          message,
          details: { usageLimit: true, scope: 'account' },
        }),
        now,
      }),
    ).toEqual({ decision: 'manual' });
  });

  test('account, provider, and server capacity stay scoped and never switch accounts', () => {
    for (const scope of ['account', 'provider', 'server'] as const) {
      const failure = classifyConnectionFailure({
        message: 'capacity unavailable',
        details: { scope, retryAfterMs: 1_000 },
      });
      expect(failure.scope).toBe(scope);
      expect(
        decideConnectionRecovery({ capability: capable, failure, now })
          .decision,
      ).toBe('wait-until-reset');
    }
  });

  test('unknown reset and absent adapter capability do not dispatch recovery', () => {
    const failure = classifyConnectionFailure({
      message: 'capacity unavailable',
    });
    expect(
      decideConnectionRecovery({ capability: capable, failure, now }),
    ).toEqual({
      decision: 'manual',
    });
    expect(decideConnectionRecovery({ failure, now })).toEqual({
      decision: 'unsupported',
    });
  });

  test('normalizes parseable reset timestamps to comparable ISO values', () => {
    const failure = classifyConnectionFailure({
      message: 'provider capacity unavailable',
      details: {
        scope: 'provider',
        resetAt: 'Tue, 29 Jul 2026 12:01:00 GMT',
      },
    });
    expect(
      decideConnectionRecovery({ capability: capable, failure, now }),
    ).toEqual({
      decision: 'wait-until-reset',
      dueAt: '2026-07-29T12:01:00.000Z',
    });
  });

  test('fails closed for fractional, negative, and horizon-exceeding provider timing', () => {
    for (const timing of [
      { retryAfterMs: -1 },
      { retryAfterMs: 1.5 },
      { retryAfterMs: MAX_RECOVERY_HORIZON_MS + 1 },
      { resetAt: 'not-a-timestamp' },
      {
        resetAt: new Date(
          now.getTime() + MAX_RECOVERY_HORIZON_MS + 1,
        ).toISOString(),
      },
    ]) {
      const failure = classifyConnectionFailure({
        message: 'provider capacity unavailable',
        details: timing,
      });
      expect(
        decideConnectionRecovery({ capability: capable, failure, now }),
      ).toEqual({ decision: 'manual' });
    }
  });
});

describe('credential recovery selection', () => {
  const exhaustedAccount = {
    kind: 'capacity' as const,
    scope: 'account' as const,
    timing: {},
  };
  const selectable = {
    capability: { sameSession: true, application: 'restart_resume' } as const,
    failure: exhaustedAccount,
    policy: { automatic: true } as const,
    group: {
      profileRefs: ['profile-primary', 'profile-recovery'],
      enrolledProfileRefs: ['profile-recovery'],
    },
    activeProfileRef: 'profile-primary',
    candidateProfileRef: 'profile-recovery',
  };

  test('selects only an explicitly enrolled different profile for account exhaustion', () => {
    expect(selectCredentialRecoveryCandidate(selectable)).toEqual({
      outcome: 'selected',
      candidateProfileRef: 'profile-recovery',
    });
  });

  test('#2966: refuses a candidate whose env overlay routes differently from the active profile', () => {
    const routedPrimary = {
      ref: 'profile-primary',
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8318' },
    };
    expect(
      selectCredentialRecoveryCandidate({
        ...selectable,
        profiles: [routedPrimary, { ref: 'profile-recovery' }],
      }),
    ).toEqual({ outcome: 'refused', reason: 'environment_mismatch' });
    expect(
      selectCredentialRecoveryCandidate({
        ...selectable,
        profiles: [
          routedPrimary,
          {
            ref: 'profile-recovery',
            env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8318' },
          },
        ],
      }),
    ).toEqual({ outcome: 'selected', candidateProfileRef: 'profile-recovery' });
    const invalid = { ANTHROPIC_AUTH_TOKEN: 'x' };
    expect(
      selectCredentialRecoveryCandidate({
        ...selectable,
        profiles: [
          { ref: 'profile-primary', env: invalid },
          { ref: 'profile-recovery', env: invalid },
        ],
      }),
    ).toEqual({ outcome: 'refused', reason: 'environment_mismatch' });
  });

  test('defaults automatic switching off', () => {
    expect(
      selectCredentialRecoveryCandidate({
        ...selectable,
        policy: undefined,
      }),
    ).toEqual({ outcome: 'refused', reason: 'automatic_disabled' });
  });

  test('fails closed for non-enrollment, same profile, unsupported application, and non-exhaustion', () => {
    expect(
      selectCredentialRecoveryCandidate({
        ...selectable,
        group: {
          ...selectable.group,
          enrolledProfileRefs: [],
        },
      }),
    ).toEqual({ outcome: 'refused', reason: 'not_enrolled' });
    expect(
      selectCredentialRecoveryCandidate({
        ...selectable,
        candidateProfileRef: 'profile-primary',
        group: {
          ...selectable.group,
          enrolledProfileRefs: ['profile-primary', 'profile-recovery'],
        },
      }),
    ).toEqual({ outcome: 'refused', reason: 'same_profile' });
    expect(
      selectCredentialRecoveryCandidate({
        ...selectable,
        capability: { sameSession: true, application: 'unsupported' },
      }),
    ).toEqual({ outcome: 'refused', reason: 'unsupported' });
    expect(
      selectCredentialRecoveryCandidate({
        ...selectable,
        failure: { kind: 'unknown', scope: 'unknown', timing: {} },
      }),
    ).toEqual({ outcome: 'refused', reason: 'not_exhausted' });
  });

  test('refuses authentication and provider/server/unknown scopes without candidate identity', () => {
    for (const failure of [
      {
        kind: 'authentication' as const,
        scope: 'unknown' as const,
        timing: {},
      },
      { kind: 'capacity' as const, scope: 'provider' as const, timing: {} },
      { kind: 'capacity' as const, scope: 'server' as const, timing: {} },
      { kind: 'capacity' as const, scope: 'unknown' as const, timing: {} },
    ]) {
      const selection = selectCredentialRecoveryCandidate({
        ...selectable,
        failure,
      });
      expect(selection).toEqual({
        outcome: 'refused',
        reason:
          failure.kind === 'authentication'
            ? 'authentication'
            : 'ineligible_scope',
      });
      expect(selection).not.toHaveProperty('candidateProfileRef');
    }
  });
});
