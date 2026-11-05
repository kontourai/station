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
import { appendFileSync, chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { inspectTrustedTailscaleServeExposure } from '../serve-exposure.js';
import {
  defaultTailscaleAuthorityProbe,
  foreignTailscaleDaemons,
  resolveTailscaleAuthority,
  type TailscaleAuthorityProbe,
  tailscaleSigns,
  trustedFileFingerprint,
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

describe('round 2: re-verifying the trusted CLI before each run', () => {
  /** A trusted-by-stub CLI at a real file, whose identity the real fingerprint reads. */
  function verifiedCli() {
    const fake = fakeTailscale();
    let trustChecks = 0;
    let trusted = true;
    const runs: string[][] = [];
    const authorityProbe = probe({
      executables: [fake.path],
      trustProblem: async () => {
        trustChecks += 1;
        return trusted ? null : `${fake.path} is not signed by Tailscale Inc.`;
      },
      run: async (_executable, args) => {
        runs.push([...args]);
        return {
          exitCode: 0,
          stdout: '{"BackendState":"Stopped"}',
          stderr: '',
        };
      },
      foreignDaemons: async () => [],
    });
    return {
      fake,
      authorityProbe,
      runs,
      trustChecks: () => trustChecks,
      distrust: () => {
        trusted = false;
      },
    };
  }

  test.skipIf(!posix)(
    'an unchanged CLI runs without a new trust check; a replaced one is checked again and refused if no longer trusted',
    async () => {
      const cli = verifiedCli();
      const authority = await resolveTailscaleAuthority(cli.authorityProbe);
      if (authority.kind !== 'trusted') throw new Error(authority.kind);
      expect(cli.trustChecks()).toBe(1);
      expect((await authority.command(['status', '--json'])).exitCode).toBe(0);
      expect(cli.trustChecks()).toBe(1);

      // The file changes after verification (size, mtime and ctime move).
      appendFileSync(cli.fake.path, '# replaced\n');
      cli.distrust();
      const result = await authority.command(['status', '--json']);
      expect(cli.trustChecks()).toBe(2);
      expect(result.exitCode).toBeNull();
      expect(result.detail).toContain('changed since Station verified it');
      expect(cli.runs).toHaveLength(1);
      // The cached authority's check is unverifiable, not clear.
      expect(
        await inspectTrustedTailscaleServeExposure(
          [43141],
          async () => authority,
        ),
      ).toMatchObject({
        state: 'unverifiable',
        detail: expect.stringContaining('changed since Station verified it'),
      });
      expect(cli.runs).toHaveLength(1);
    },
  );

  test.skipIf(!posix)(
    'a changed CLI that is still trusted is re-verified once, then runs',
    async () => {
      const cli = verifiedCli();
      const authority = await resolveTailscaleAuthority(cli.authorityProbe);
      if (authority.kind !== 'trusted') throw new Error(authority.kind);
      appendFileSync(cli.fake.path, '# updated\n');
      expect((await authority.command(['status', '--json'])).exitCode).toBe(0);
      expect((await authority.command(['status', '--json'])).exitCode).toBe(0);
      expect(cli.trustChecks()).toBe(2);
      expect(cli.runs).toHaveLength(2);
    },
  );

  test.skipIf(!posix)(
    'the fingerprint reads the file identity and is null when it is gone',
    () => {
      const fake = fakeTailscale();
      const before = trustedFileFingerprint('linux', fake.path);
      expect(before).toMatch(/^\d+:\d+:\d+:\d+:\d+$/);
      appendFileSync(fake.path, '#\n');
      expect(trustedFileFingerprint('linux', fake.path)).not.toBe(before);
      expect(
        trustedFileFingerprint('linux', join(fake.dir, 'missing')),
      ).toBeNull();
    },
  );
});

describe('round 2: a tailscaled the trusted CLI does not answer for', () => {
  const entries = (rows: Array<[number, number, string]>) => async () =>
    rows.map(([pid, uid, path]) => ({ pid, uid, path }));

  test('on Linux only a root-owned tailscaled at a system path is the system daemon', async () => {
    expect(
      await foreignTailscaleDaemons(
        'linux',
        entries([
          [1, 0, '/sbin/init'],
          [40, 0, '/usr/sbin/tailscaled'],
        ]),
      ),
    ).toEqual([]);
    expect(
      await foreignTailscaleDaemons(
        'linux',
        entries([
          [40, 0, '/usr/sbin/tailscaled'],
          [77, 1000, '/home/casey/go/bin/tailscaled'],
          // A user process cannot pass for the system one by its argv[0].
          [78, 1000, '/usr/sbin/tailscaled'],
          [79, 0, '/opt/tailscale/tailscaled'],
        ]),
      ),
    ).toEqual([
      '`tailscaled` process 77 (/home/casey/go/bin/tailscaled, uid 1000)',
      '`tailscaled` process 78 (/usr/sbin/tailscaled, uid 1000)',
      '`tailscaled` process 79 (/opt/tailscale/tailscaled, uid 0)',
    ]);
  });

  test('on macOS, where the app runs its daemon as a network extension, every tailscaled is foreign', async () => {
    expect(
      await foreignTailscaleDaemons(
        'darwin',
        entries([
          [
            5,
            0,
            '/Library/SystemExtensions/X/io.tailscale.ipn.macsys.network-extension.systemextension/Contents/MacOS/io.tailscale.ipn.macsys.network-extension',
          ],
          [6, 501, '/Applications/Tailscale.app/Contents/MacOS/Tailscale'],
          [9, 0, '/opt/homebrew/opt/tailscale/bin/tailscaled'],
        ]),
      ),
    ).toEqual([
      '`tailscaled` process 9 (/opt/homebrew/opt/tailscale/bin/tailscaled, uid 0)',
    ]);
    expect(
      await foreignTailscaleDaemons('darwin', async () => null),
    ).toBeNull();
  });

  test('a foreign tailscaled refuses even when the trusted CLI says Stopped, and the CLI is not asked', async () => {
    const runs: string[][] = [];
    const authority = await resolveTailscaleAuthority(
      probe({
        executables: ['/trusted/tailscale'],
        trustProblem: async () => null,
        fingerprint: () => 'same',
        run: async (_executable, args) => {
          runs.push([...args]);
          return {
            exitCode: 0,
            stdout: '{"BackendState":"Stopped"}',
            stderr: '',
          };
        },
        foreignDaemons: async () => [
          '`tailscaled` process 77 (/home/casey/go/bin/tailscaled, uid 1000)',
        ],
      }),
    );
    expect(
      await inspectTrustedTailscaleServeExposure(
        [43141],
        async () => authority,
      ),
    ).toMatchObject({
      state: 'unverifiable',
      detail: expect.stringContaining('/home/casey/go/bin/tailscaled'),
      remedy: expect.stringContaining('Stop that `tailscaled`'),
    });
    expect(runs).toEqual([]);
  });

  test.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
    'the real process list is readable here',
    async () => {
      expect(await foreignTailscaleDaemons()).not.toBeNull();
    },
  );
});

/*
 * #4515: on Windows the installer's CLI is held to #4524's owner and ACL
 * rule. The descriptors are the owner and DACL Windows 11 (26200) reports
 * for a real Tailscale install, read on the test host with Get-Acl's
 * GetSecurityDescriptorSddlForm('Owner, Access'), the form
 * ConvertSecurityDescriptorToStringSecurityDescriptorW gives. The Win32
 * reader is the only part substituted; the rule and the probe are the
 * production ones.
 */
describe('#4515: the Windows CLI is held to the owner and ACL rule', () => {
  const TI = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';
  const CLI = 'C:\\Program Files\\Tailscale\\tailscale.exe';
  const FOLDER = 'C:\\Program Files\\Tailscale';
  const INSTALLED: Record<string, string> = {
    'C:\\': `O:${TI}D:PAI(A;;LC;;;AU)(A;OICIIO;SDGXGWGR;;;AU)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)(A;;0x1000a1;;;S-1-15-3-65536-1888954469-739942743-1668119174-2468466756-4239452838-1296943325-355587736-700089176)`,
    'C:\\Program Files': `O:${TI}D:PAI(A;OICIIO;GA;;;CO)(A;OICIIO;GA;;;SY)(A;;0x1301bf;;;SY)(A;OICIIO;GA;;;BA)(A;;0x1301bf;;;BA)(A;OICIIO;GXGR;;;BU)(A;;0x1200a9;;;BU)(A;CIIO;GA;;;${TI})(A;;FA;;;${TI})(A;;0x1200a9;;;AC)(A;OICIIO;GXGR;;;AC)(A;;0x1200a9;;;S-1-15-2-2)(A;OICIIO;GXGR;;;S-1-15-2-2)`,
    [FOLDER]:
      'O:SYD:P(A;;FA;;;SY)(A;OICIIO;GA;;;SY)(A;;FA;;;BA)(A;OICIIO;GA;;;BA)(A;;0x1200a9;;;BU)(A;OICIIO;GXGR;;;BU)',
    [CLI]: 'O:SYD:(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;0x1200a9;;;BU)',
  };

  function windowsProbe(
    descriptors: Record<string, string>,
    options: { installed?: boolean; reparse?: string } = {},
  ): TailscaleAuthorityProbe {
    const system = {
      exists: (path: string) => path === CLI && options.installed !== false,
      windowsSecurity: () => ({
        readMachineKey: () => {
          throw new Error('not read here');
        },
        machineKeySddl: () => {
          throw new Error('not read here');
        },
        pathSddl: (path: string) => {
          const sddl = descriptors[path];
          if (sddl === undefined) throw new Error(`no descriptor for ${path}`);
          return sddl;
        },
        isReparsePoint: (path: string) => path === options.reparse,
      }),
    };
    return {
      ...defaultTailscaleAuthorityProbe('win32', system),
      // The process list and file identity are this test's, not Windows'.
      signs: async () => [],
      fingerprint: () => 'unchanged',
      run: async () => ({
        exitCode: 0,
        stdout: '{"BackendState":"Stopped"}',
        stderr: '',
      }),
    };
  }

  test('the installer-made CLI is trusted', async () => {
    const authority = await resolveTailscaleAuthority(windowsProbe(INSTALLED));
    expect(authority.kind).toBe('trusted');
  });

  test.each([
    [
      'folder lets Users change it',
      { ...INSTALLED, [FOLDER]: `${INSTALLED[FOLDER]}(A;;0x1301bf;;;BU)` },
      'C:\\Program Files\\Tailscale lets Users',
    ],
    [
      'owner is a user',
      {
        ...INSTALLED,
        [CLI]:
          'O:S-1-5-21-2612459134-1529638752-2094432294-1001D:(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;0x1200a9;;;BU)',
      },
      `${CLI} must be owned by Administrators, SYSTEM or TrustedInstaller`,
    ],
    [
      'access list grants Everyone write',
      { ...INSTALLED, [CLI]: `${INSTALLED[CLI]}(A;;FW;;;WD)` },
      `${CLI} lets`,
    ],
  ])(
    'a CLI whose %s is not trusted, and is a sign',
    async (_name, descriptors, sign) => {
      const authority = await resolveTailscaleAuthority(
        windowsProbe(descriptors),
      );
      expect(authority.kind).toBe('untrusted');
      if (authority.kind !== 'untrusted') throw new Error('expected untrusted');
      expect(authority.signs.join('\n')).toContain(sign);
      expect(authority.remedy).toContain(CLI);
    },
  );

  test('a reparse point in the chain is not trusted', async () => {
    const authority = await resolveTailscaleAuthority(
      windowsProbe(INSTALLED, { reparse: FOLDER }),
    );
    expect(authority.kind).toBe('untrusted');
    if (authority.kind !== 'untrusted') throw new Error('expected untrusted');
    expect(authority.signs.join('\n')).toContain(
      `${FOLDER} is a symbolic link, junction or other reparse point`,
    );
  });

  test('permissions Station cannot read are not trusted', async () => {
    const { [FOLDER]: _folder, ...unreadable } = INSTALLED;
    const authority = await resolveTailscaleAuthority(windowsProbe(unreadable));
    expect(authority.kind).toBe('untrusted');
  });

  test('no CLI at the fixed location is not a sign by itself', async () => {
    const authority = await resolveTailscaleAuthority(
      windowsProbe(INSTALLED, { installed: false }),
    );
    expect(authority.kind).toBe('absent');
  });
});
