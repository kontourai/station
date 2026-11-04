/**
 * #4519 round 1: which Tailscale the startup Serve check may believe.
 *
 * The fixtures are real files: a user-owned shell script that prints the
 * "Stopped" an attacker would want believed, put first on PATH or at a
 * trusted location. The trust decision is the production one
 * (`managedTrustedFileProblem` against root ownership); only the list of
 * fixed locations and, where noted, the process list are injected so the
 * test does not depend on what this machine has installed.
 */
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { inspectTrustedTailscaleServeExposure } from '../serve-exposure.js';
import {
  defaultTailscaleAuthorityProbe,
  resolveTailscaleAuthority,
  type TailscaleAuthorityProbe,
  tailscaleSigns,
  trustedTailscaleEnvironment,
  trustedTailscaleExecutables,
} from '../tailscale-authority.js';

const makeTempDir = trackTempDirs();
const posix = process.platform !== 'win32';

/** A user-owned `tailscale` that says Stopped and leaves a mark when run. */
function fakeTailscale() {
  const dir = makeTempDir('station-fake-tailscale-');
  const marker = join(dir, 'ran');
  const path = join(dir, 'tailscale');
  writeFileSync(
    path,
    `#!/bin/sh\ntouch '${marker}'\necho '{"BackendState":"Stopped"}'\n`,
  );
  chmodSync(path, 0o755);
  return { dir, path, marker };
}

/** The production probe with the fixed locations and signs replaced. */
function probe(
  overrides: Partial<TailscaleAuthorityProbe>,
): TailscaleAuthorityProbe {
  return { ...defaultTailscaleAuthorityProbe(process.platform), ...overrides };
}

describe('resolveTailscaleAuthority', () => {
  test.skipIf(!posix)(
    'a user-owned tailscale first on PATH is a sign, never an answer: the check refuses and never runs it',
    async () => {
      const fake = fakeTailscale();
      const signs = await tailscaleSigns(
        process.platform,
        `${fake.dir}:/usr/bin:/bin`,
        async () => [],
      );
      expect(signs).toContain(`${fake.path} on PATH`);
      const exposure = await inspectTrustedTailscaleServeExposure([43141], () =>
        resolveTailscaleAuthority(
          probe({ executables: [], signs: async () => signs }),
        ),
      );
      expect(exposure).toMatchObject({
        state: 'unverifiable',
        detail: expect.stringContaining(`${fake.path} on PATH`),
        remedy: expect.stringMatching(/^Install Tailscale /),
      });
      expect(existsSync(fake.marker)).toBe(false);
    },
  );

  test.skipIf(!posix || process.getuid?.() === 0)(
    'a user-owned file at a trusted location is not trusted either, and is not run',
    async () => {
      const fake = fakeTailscale();
      const authority = await resolveTailscaleAuthority(
        probe({ executables: [fake.path], signs: async () => [] }),
      );
      expect(authority.kind).toBe('untrusted');
      if (authority.kind !== 'untrusted') return;
      expect(authority.signs[0]).toMatch(/must be owned by root \(uid 0\)/);
      expect(existsSync(fake.marker)).toBe(false);
    },
  );

  test('only no trusted CLI and no sign at all is absence; an unreadable process list is a sign', async () => {
    expect(
      await resolveTailscaleAuthority(
        probe({ executables: [], signs: async () => [] }),
      ),
    ).toEqual({ kind: 'absent' });
    expect(
      await inspectTrustedTailscaleServeExposure([43141], () =>
        resolveTailscaleAuthority(
          probe({ executables: [], signs: async () => [] }),
        ),
      ),
    ).toEqual({ state: 'clear', reason: 'not-installed' });
    const unreadable = await resolveTailscaleAuthority(
      probe({ executables: [], signs: async () => null }),
    );
    expect(unreadable).toMatchObject({
      kind: 'untrusted',
      signs: ['the process list could not be read'],
    });
  });

  test('a trusted CLI answers, and one that then cannot run is unverifiable, not absent', async () => {
    const authority = await resolveTailscaleAuthority(
      probe({
        executables: ['/trusted/tailscale'],
        trustProblem: async () => null,
        run: async () => ({
          exitCode: null,
          stdout: '',
          stderr: '',
          unavailable: true,
        }),
      }),
    );
    expect(authority.kind).toBe('trusted');
    if (authority.kind !== 'trusted') return;
    expect(
      await inspectTrustedTailscaleServeExposure(
        [43141],
        async () => authority,
      ),
    ).toMatchObject({ state: 'unverifiable' });
  });

  test('a Tailscale process is a sign', async () => {
    const signs = await tailscaleSigns('linux', '', async () => [
      'launchd',
      'tailscaled',
    ]);
    expect(signs).toContain('the running process tailscaled');
  });
});

describe('the fixed locations and environment', () => {
  test('every trusted location is an absolute system path, never a PATH lookup', () => {
    expect(trustedTailscaleExecutables('darwin')).toEqual([
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    ]);
    expect(trustedTailscaleExecutables('win32')).toEqual([
      'C:\\Program Files\\Tailscale\\tailscale.exe',
    ]);
    expect(trustedTailscaleExecutables('linux')).toEqual([
      '/usr/bin/tailscale',
      '/usr/sbin/tailscale',
      '/usr/local/bin/tailscale',
      '/usr/local/sbin/tailscale',
      '/bin/tailscale',
      '/sbin/tailscale',
    ]);
  });

  test('the trusted CLI inherits no loader, Tailscale or PATH variable', () => {
    const env = trustedTailscaleEnvironment('linux', {
      HOME: '/home/casey',
      PATH: '/home/casey/bin:/usr/bin',
      LD_PRELOAD: '/home/casey/fake.so',
      TS_SOCKET: '/home/casey/fake.sock',
      DYLD_INSERT_LIBRARIES: '/home/casey/fake.dylib',
    });
    expect(env).toEqual({
      HOME: '/home/casey',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    });
    expect(trustedTailscaleEnvironment('darwin', {}).TAILSCALE_BE_CLI).toBe(
      '1',
    );
  });
});
