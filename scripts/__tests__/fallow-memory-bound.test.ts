import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  DEFAULT_FALLOW_MEMORY_MAX_MIB,
  planFallowMemoryCap,
  wrapFallowCommand,
} from '../lib/fallow-memory-bound.mjs';
import { runFallowAnalysis } from '../run-fallow-audit.mjs';

/**
 * #5111: one fallow audit peaks near 5.5 GiB and OOM-killed the Station
 * engine that ran it. Each fallow child runs inside its own memory budget
 * where the host can enforce one, and exceeding it fails the run by name.
 */

const makeTempDir = trackTempDirs();
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('where a fallow child gets a memory budget', () => {
  test('Linux with a working systemd user manager runs it capped at the default budget', () => {
    const probe = vi.fn((_budgetMib: number): number | null => 259);
    const plan = planFallowMemoryCap({ env: {}, platform: 'linux', probe });
    expect(plan).toEqual({
      kind: 'capped',
      budgetMib: DEFAULT_FALLOW_MEMORY_MAX_MIB,
      // One thread: the audit's base and head analyses run in turn.
      threads: 1,
      systemdVersion: 259,
    });
    expect(probe).toHaveBeenCalledWith(DEFAULT_FALLOW_MEMORY_MAX_MIB);
  });

  test('STATION_FALLOW_MEMORY_MAX_MIB sets the budget the probe and the scope use', () => {
    const probe = vi.fn((_budgetMib: number): number | null => 259);
    const plan = planFallowMemoryCap({
      env: { STATION_FALLOW_MEMORY_MAX_MIB: '4096' },
      platform: 'linux',
      probe,
    });
    expect(plan).toMatchObject({ kind: 'capped', budgetMib: 4096 });
    expect(probe).toHaveBeenCalledWith(4096);
  });

  test('Linux whose user manager cannot start a capped scope runs it uncapped with a warning', () => {
    const plan = planFallowMemoryCap({
      env: {},
      platform: 'linux',
      probe: () => null,
    });
    expect(plan).toMatchObject({ kind: 'uncapped', threads: 1 });
    expect(plan.warning).toMatch(
      /without its 5120 MiB memory budget: \/usr\/bin\/systemd-run could not start a memory-capped user scope/,
    );
  });

  test.each(['darwin', 'win32'] as const)(
    '%s runs it uncapped with a warning and never probes',
    (platform) => {
      const probe = vi.fn((_budgetMib: number): number | null => 259);
      const plan = planFallowMemoryCap({ env: {}, platform, probe });
      expect(plan).toMatchObject({ kind: 'uncapped', threads: 1 });
      expect(plan.warning).toContain(`need Linux, not ${platform}`);
      expect(probe).not.toHaveBeenCalled();
    },
  );

  test('hosted CI keeps running it uncapped and silent, even on Linux with systemd', () => {
    const probe = vi.fn((_budgetMib: number): number | null => 259);
    const plan = planFallowMemoryCap({
      env: { GITHUB_ACTIONS: 'true' },
      platform: 'linux',
      probe,
    });
    expect(plan).toEqual({
      kind: 'uncapped',
      budgetMib: DEFAULT_FALLOW_MEMORY_MAX_MIB,
      threads: 2,
      warning: null,
    });
    expect(probe).not.toHaveBeenCalled();
    const command = wrapFallowCommand(plan, '/node', ['fallow', 'audit'], '');
    expect(command).toEqual({ executable: '/node', args: ['fallow', 'audit'] });
  });

  test('a malformed or impossibly small budget is refused, not replaced', () => {
    const probe = () => 259;
    expect(() =>
      planFallowMemoryCap({
        env: { STATION_FALLOW_MEMORY_MAX_MIB: '6G' },
        platform: 'linux',
        probe,
      }),
    ).toThrow('STATION_FALLOW_MEMORY_MAX_MIB must be a whole number of MiB');
    expect(() =>
      planFallowMemoryCap({
        env: { STATION_FALLOW_MEMORY_MAX_MIB: '512' },
        platform: 'linux',
        probe,
      }),
    ).toThrow(/^code-health gate needs more than 512 MiB/);
  });

  test('a capped command runs the analyzer through the scope wrapper inside a MemoryMax scope', () => {
    const command = wrapFallowCommand(
      { kind: 'capped', budgetMib: 6144, threads: 1, systemdVersion: 259 },
      '/node',
      ['fallow', 'audit'],
      '/run/memory.events',
    );
    expect(command.executable).toBe('/usr/bin/systemd-run');
    const separator = command.args.indexOf('--');
    expect(command.args.slice(0, separator)).toEqual([
      '--user',
      '--scope',
      '--quiet',
      '--no-ask-password',
      '--expand-environment=no',
      '--property=MemoryMax=6144M',
      '--property=MemorySwapMax=0',
      '--property=OOMPolicy=continue',
    ]);
    expect(command.args.slice(separator + 2)).toEqual([
      expect.stringMatching(/fallow-memory-scope\.mjs$/),
      '/run/memory.events',
      '',
      '/node',
      'fallow',
      'audit',
    ]);
    // Before systemd 254 a scope's argv is already literal.
    expect(
      wrapFallowCommand(
        { kind: 'capped', budgetMib: 6144, threads: 1, systemdVersion: 252 },
        '/node',
        [],
        '',
      ).args,
    ).not.toContain('--expand-environment=no');
  });
});

describe.skipIf(process.platform === 'win32')(
  'a fallow child killed at its budget',
  () => {
    function fakeAnalyzer(directory: string, source: string) {
      const path = join(directory, 'fake-fallow.mjs');
      writeFileSync(path, source);
      return path;
    }

    function fakeScope(directory: string, oomKills: number) {
      const cgroup = join(directory, 'cgroup');
      mkdirSync(cgroup);
      writeFileSync(
        join(cgroup, 'memory.events'),
        `low 0\nhigh 0\nmax 12\noom ${oomKills}\noom_kill ${oomKills}\noom_group_kill 0\n`,
      );
      writeFileSync(join(cgroup, 'memory.peak'), `${2048 * 1024 ** 2}\n`);
      return cgroup;
    }

    test('fails the run with what it needs when the scope recorded an OOM kill', async () => {
      const scratch = makeTempDir('fallow-memory-oom-');
      vi.stubEnv('STATION_FALLOW_CACHE_DIR', join(scratch, 'fallow'));
      // The launcher reports a SIGKILLed analyzer as exit 137.
      const fallowEntry = fakeAnalyzer(scratch, 'process.exit(137);\n');
      await expect(
        runFallowAnalysis(scratch, 'audit', join(scratch, 'audit.json'), [], {
          fallowEntry,
          memoryCap: {
            kind: 'capped',
            budgetMib: 2048,
            threads: 1,
            launcher: 'direct',
            cgroupDirectory: fakeScope(scratch, 1),
          },
        }),
      ).rejects.toThrow(
        /^code-health gate needs more than 2048 MiB; fallow audit was OOM-killed at its memory budget\. Set STATION_FALLOW_MEMORY_MAX_MIB higher/,
      );
      expect(readdirSync(join(scratch, 'fallow'))).toEqual([]);
    });

    test('the same exit without an OOM kill stays a plain analyzer failure', async () => {
      const scratch = makeTempDir('fallow-memory-no-oom-');
      vi.stubEnv('STATION_FALLOW_CACHE_DIR', join(scratch, 'fallow'));
      const fallowEntry = fakeAnalyzer(scratch, 'process.exit(137);\n');
      const failure = runFallowAnalysis(
        scratch,
        'audit',
        join(scratch, 'audit.json'),
        [],
        {
          fallowEntry,
          memoryCap: {
            kind: 'capped',
            budgetMib: 2048,
            threads: 1,
            launcher: 'direct',
            cgroupDirectory: fakeScope(scratch, 0),
          },
        },
      );
      await expect(failure).rejects.toThrow(/did not complete \(status=137/);
      await expect(failure).rejects.not.toThrow(/needs more than/);
    });

    test.each([
      [1, 'capped'],
      [2, 'uncapped'],
    ] as const)(
      'the analyzer receives the plan thread count (%i, %s) and its report is read through the wrapper',
      async (threads, kind) => {
        const scratch = makeTempDir('fallow-memory-threads-');
        vi.stubEnv('STATION_FALLOW_CACHE_DIR', join(scratch, 'fallow'));
        // Writes its argv as the report, as fallow writes --output-file.
        const fallowEntry = fakeAnalyzer(
          scratch,
          "import { writeFileSync } from 'node:fs';\nconst argv = process.argv.slice(2);\nwriteFileSync(argv[argv.indexOf('--output-file') + 1], JSON.stringify({ argv }));\n",
        );
        const report = await runFallowAnalysis(
          scratch,
          'audit',
          join(scratch, 'audit.json'),
          ['--gate', 'new-only'],
          {
            fallowEntry,
            memoryCap: {
              kind,
              budgetMib: 2048,
              threads,
              launcher: 'direct',
              cgroupDirectory: fakeScope(scratch, 0),
              warning: null,
            },
          },
        );
        expect(report.argv.slice(0, 3)).toEqual([
          'audit',
          '--threads',
          String(threads),
        ]);
        expect(report.argv.slice(-2)).toEqual(['--gate', 'new-only']);
      },
    );
  },
);

// Only where this host can start a capped user scope: a real kernel OOM kill.
const realCap = (() => {
  try {
    return planFallowMemoryCap({ env: {} });
  } catch {
    return null;
  }
})();

describe.skipIf(realCap?.kind !== 'capped')(
  'a real memory-capped user scope',
  () => {
    test('the kernel kills an analyzer that outgrows its budget and the run reports the budget', async () => {
      const scratch = makeTempDir('fallow-memory-real-');
      vi.stubEnv('STATION_FALLOW_CACHE_DIR', join(scratch, 'fallow'));
      // Touches up to 1 GiB, far past a 192 MiB scope.
      const fallowEntry = join(scratch, 'hungry.mjs');
      writeFileSync(
        fallowEntry,
        'const held = [];\nfor (let i = 0; i < 32; i++) held.push(Buffer.alloc(32 * 1024 ** 2, 1));\nprocess.exit(0);\n',
      );
      await expect(
        runFallowAnalysis(scratch, 'audit', join(scratch, 'audit.json'), [], {
          fallowEntry,
          memoryCap: { ...realCap, budgetMib: 192 },
        }),
      ).rejects.toThrow(
        /^code-health gate needs more than 192 MiB; fallow audit was OOM-killed at its memory budget\./,
      );
      expect(existsSync(join(scratch, 'audit.json'))).toBe(false);
    }, 30_000);
  },
);
