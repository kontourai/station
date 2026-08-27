import { describe, expect, test } from 'vitest';
import {
  DEFAULT_CREDENTIAL_RECOVERY_POLICY,
  isAutomaticCredentialRecoveryEnabled,
  resolveCredentialProfileApplicationCapability,
} from '../connection-recovery.js';

describe('credential recovery contracts', () => {
  test('defaults automatic profile recovery off', () => {
    expect(DEFAULT_CREDENTIAL_RECOVERY_POLICY).toEqual({ automatic: false });
    expect(isAutomaticCredentialRecoveryEnabled()).toBe(false);
    expect(isAutomaticCredentialRecoveryEnabled({ automatic: false })).toBe(
      false,
    );
    expect(isAutomaticCredentialRecoveryEnabled({ automatic: true })).toBe(
      true,
    );
  });

  test('projects an absent application declaration as unsupported', () => {
    expect(resolveCredentialProfileApplicationCapability()).toBe('unsupported');
    expect(
      resolveCredentialProfileApplicationCapability({
        sameSession: true,
        application: 'restart_resume',
      }),
    ).toBe('restart_resume');
  });
});
