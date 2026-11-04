import { describe, expect, test } from 'vitest';
import type { InstallProvenance } from '../install-provenance.js';
import { managedUpdateRefusalFor } from '../managed-update-policy.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const desktopBundle = (channel: string) =>
  ({
    installKind: 'desktop-bundle',
    stampPath: '/Applications/Station.app/stamp.json',
    channel,
    sha: SHA,
    ref: 'origin/main',
    repository: 'https://github.com/kontourai/station.git',
  }) as unknown as InstallProvenance;
const sourceCheckout = {
  installKind: 'source-checkout',
  gitRoot: '/src/station',
  branch: 'main',
  sha: SHA,
} as unknown as InstallProvenance;

describe('managedUpdateRefusalFor (#4522)', () => {
  test('no limit and an empty limit refuse nothing', () => {
    expect(managedUpdateRefusalFor(sourceCheckout, null)).toBeNull();
    expect(managedUpdateRefusalFor(desktopBundle('nightly'), {})).toBeNull();
  });

  test('off refuses every install kind', () => {
    for (const provenance of [sourceCheckout, desktopBundle('stable')])
      expect(managedUpdateRefusalFor(provenance, { mode: 'off' })).toEqual({
        code: 'managed-policy-updates-refused',
        sentence: "This machine's managed policy turns off Station updates",
      });
  });

  test('a disallowed nightly refuses a nightly desktop bundle only', () => {
    expect(
      managedUpdateRefusalFor(desktopBundle('nightly'), { allowNightly: false })
        ?.sentence,
    ).toBe(
      "This machine's managed policy makes the nightly channel unavailable",
    );
    expect(
      managedUpdateRefusalFor(desktopBundle('stable'), { allowNightly: false }),
    ).toBeNull();
  });

  test('a mirror refuses the git-based updates, which cannot use it', () => {
    const mirror = { feedUrl: 'https://mirror.example/secret/' };
    for (const provenance of [sourceCheckout, desktopBundle('stable')]) {
      const refusal = managedUpdateRefusalFor(provenance, mirror);
      expect(refusal?.code).toBe('managed-policy-updates-refused');
      expect(refusal?.sentence).not.toContain('secret');
    }
  });
});
