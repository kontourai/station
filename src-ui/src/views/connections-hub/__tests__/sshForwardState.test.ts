import { describe, expect, test } from 'vitest';
import {
  deriveSshForwardProbeState,
  sshForwardLifecycleLabel,
  sshForwardProvenanceWarning,
} from '../sshForwardState';

describe('SSH forward reconnect state', () => {
  test('warns when the authenticated remote reports a different sha', () => {
    expect(
      sshForwardProvenanceWarning('aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'),
    ).toContain('Version mismatch');
    expect(sshForwardProvenanceWarning('same', 'same')).toBeNull();
    expect(sshForwardProvenanceWarning('same', undefined)).toContain(
      'Provenance unknown',
    );
  });

  test('names a dead forward honestly instead of calling the host offline', () => {
    expect(
      sshForwardLifecycleLabel({
        transport: 'ssh-forward',
        launcherError: 'launcher closed',
        probe: 'unreached',
      }),
    ).toBe('Launcher closed');
  });

  test('names an unknown native launch after restart', () => {
    expect(
      sshForwardLifecycleLabel({
        transport: 'ssh-forward',
        launcherUnknown: true,
        probe: 'unreached',
      }),
    ).toBe('Launcher closed');
  });

  // archive#3711: the label was previously derived from a boolean fed by the
  // query's `isSuccess`, which is also false while LOADING — so a row claimed
  // "Host offline" on its own first render, before any probe completed, and
  // asserted a power/network state this device never observes.
  test('claims nothing while the probe is still checking', () => {
    expect(
      sshForwardLifecycleLabel({
        transport: 'ssh-forward',
        probe: 'checking',
      }),
    ).toBeNull();
  });

  test('a failed probe reports its own failed request, never the host power state', () => {
    const label = sshForwardLifecycleLabel({
      transport: 'ssh-forward',
      probe: 'unreached',
    });
    expect(label).toBe("Can't reach this Station");
    expect(label).not.toMatch(/offline/i);
  });

  test('a reached host renders no lifecycle label', () => {
    expect(
      sshForwardLifecycleLabel({
        transport: 'ssh-forward',
        probe: 'reached',
      }),
    ).toBeNull();
  });

  // The derivation the caller uses verbatim — including the discriminating
  // case the original boolean could not represent: a query that is neither
  // success nor error is still CHECKING, and must not read as unreached.
  test('deriveSshForwardProbeState keeps loading distinct from unreached', () => {
    expect(
      deriveSshForwardProbeState({ isSuccess: false, isError: false }),
    ).toBe('checking');
    expect(
      deriveSshForwardProbeState({ isSuccess: false, isError: true }),
    ).toBe('unreached');
    expect(
      deriveSshForwardProbeState({ isSuccess: true, isError: false }),
    ).toBe('reached');
  });
});
