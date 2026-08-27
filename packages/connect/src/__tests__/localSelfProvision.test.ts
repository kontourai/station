import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  attemptLocalSelfProvision,
  attemptLocalSelfProvisionOnce,
  attemptLocalSelfProvisionOnceWithOutcome,
  resetLocalSelfProvisionLatchForTests,
  retryLocalSelfProvisionAfterRejection,
} from '../core/localSelfProvision';

beforeEach(() => {
  resetLocalSelfProvisionLatchForTests();
});

describe('attemptLocalSelfProvision', () => {
  test('invokes the single native command with the profile name and returns true on success', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);

    const result = await attemptLocalSelfProvision({
      invoke,
      profileName: 'local',
    });

    expect(result).toBe(true);
    expect(invoke).toHaveBeenCalledWith('station_local_self_provision', {
      profileName: 'local',
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test('a native command failure returns false rather than throwing', async () => {
    const invoke = vi
      .fn()
      .mockRejectedValue(new Error('local grant forbidden'));

    const result = await attemptLocalSelfProvision({
      invoke,
      profileName: 'local',
    });

    expect(result).toBe(false);
  });

  test('the boot-latched outcome retains a replacement-write failure for the native shell to explain', async () => {
    const error = {
      code: 'credential_replacement_write_failed',
      message: 'keychain write denied',
    };
    const invoke = vi.fn().mockRejectedValue(error);

    await expect(
      attemptLocalSelfProvisionOnceWithOutcome({
        invoke,
        profileName: 'local',
      }),
    ).resolves.toEqual({ provisioned: false, error });
    // The detailed API keeps the same one-attempt-per-boot safety boundary.
    await expect(
      attemptLocalSelfProvisionOnceWithOutcome({
        invoke,
        profileName: 'local',
      }),
    ).resolves.toEqual({ provisioned: false });
  });
});

describe('attemptLocalSelfProvisionOnce', () => {
  test('only attempts once per boot, even after a successful first attempt', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const deps = { invoke, profileName: 'local' };

    expect(await attemptLocalSelfProvisionOnce(deps)).toBe(true);
    expect(await attemptLocalSelfProvisionOnce(deps)).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test('the latch is consumed even when the attempt itself fails', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('not eligible'));
    const deps = { invoke, profileName: 'local' };

    expect(await attemptLocalSelfProvisionOnce(deps)).toBe(false);
    expect(await attemptLocalSelfProvisionOnce(deps)).toBe(false);
    // The second call never re-invokes: the latch consumed on the first
    // attempt, success or not — a caller decides separately whether to
    // re-arm it (e.g. a fresh app boot, never within one session).
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe('retryLocalSelfProvisionAfterRejection', () => {
  // station#1866: the boot-time latch is untouched by the rejection-retry
  // path, and the rejection-retry path has its OWN one-shot so a
  // genuinely-rejecting server cannot cause a mint loop.
  test('the rejection-retry guard is independent of the boot latch and fires at most once', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const deps = { invoke, profileName: 'local' };

    // The boot-time attempt consumes ITS latch first.
    expect(await attemptLocalSelfProvisionOnce(deps)).toBe(true);
    // The rejection-retry path is still reachable — it has its own guard,
    // independent of `attemptedThisBoot`. This is the fix: re-provisioning
    // reachable from an authentication refusal even after the boot attempt.
    expect(await retryLocalSelfProvisionAfterRejection(deps)).toBe(true);
    // But only ONCE — a second observed rejection does not re-mint, which
    // is what stops a genuinely-rejecting server from looping.
    expect(await retryLocalSelfProvisionAfterRejection(deps)).toBe(false);
    // Two total invocations: one boot, one rejection-retry.
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  test('a failed rejection-retry still consumes the guard (no mint loop on a rejecting server)', async () => {
    const invoke = vi
      .fn()
      .mockRejectedValue(new Error('local grant forbidden'));
    const deps = { invoke, profileName: 'local' };

    expect(await retryLocalSelfProvisionAfterRejection(deps)).toBe(false);
    expect(await retryLocalSelfProvisionAfterRejection(deps)).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
