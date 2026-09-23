import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BaseSequencer } from 'vitest/node';
import config from '../../vitest.config';
import { PROCESS_HEAVY_MAX_WORKERS } from '../run-vitest-corpus.mjs';
import {
  assertOrdinaryVitestSelection,
  buildVitestResourceGroups,
  COORDINATOR_EXCLUSIVE_VITEST_FILES,
  CREDENTIAL_LEDGER_EXCLUSIVE_VITEST_FILES,
  DOGFOOD_RECONCILE_PREFIX,
  discoverVitestFiles,
  discoverVitestResourceGroups,
  hasDirectChildProcessImport,
  isDogfoodReconcileFile,
  ordinaryVitestExcludes,
  PROCESS_EXCLUSIVE_VITEST_FILES,
  PROCESS_HEAVY_VITEST_FILES,
  QUARANTINE_MAX_DAYS,
  QUARANTINE_MAX_ENTRIES,
  QUARANTINED_VITEST_FILES,
  quarantinedVitestFiles,
  SHARED_OUTPUT_VITEST_FILES,
  vitestQuarantineErrors,
} from '../vitest-resource-manifest.mjs';

const temporaryRoots: string[] = [];
const REVIEWED_RESOURCE_HEAVY_VITEST_FILES = Object.freeze([
  'scripts/__tests__/classify-ci-change.test.ts',
  'src-server/runtime/bootstrap/__tests__/runtime-service-bootstrap.test.ts',
  'scripts/__tests__/verification-reporter.test.ts',
  'packages/cli/src/__tests__/service.test.ts',
  'src-server/services/checkpoints/__tests__/checkpoint-restore.test.ts',
  'packages/cli/src/__tests__/config.test.ts',
  'src-server/services/orchestration/__tests__/credential-recovery-module.test.ts',
  'src-server/runtime/bootstrap/__tests__/native-engine-adoption.test.ts',
  'src-ui/src/__tests__/vite-sdk-client-alias.test.ts',
]);

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), 'station-vitest-resource-'));
  temporaryRoots.push(root);
  return root;
}

async function ordinaryShardFiles(
  files: readonly string[],
  index: number,
  count: number,
) {
  // Delegate the mapping to Vitest's installed BaseSequencer. `vitest list`
  // deliberately reports all discovered files and does not apply --shard.
  const sequencer = new BaseSequencer({
    config: { root: process.cwd(), shard: { index, count } },
  } as never);
  const selected = await sequencer.shard(
    files.map((moduleId) => ({ moduleId })) as never,
  );
  return selected.map((spec) => spec.moduleId).sort();
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

// One repository discovery for the whole file. Every no-argument
// `discoverVitestResourceGroups()` shells out to `vitest list --filesOnly`
// and then re-proves the compact ordinary selection with a second `vitest
// list`; twelve cases each paid both (6-13s apiece inside the two-worker
// process-heavy pool), and the answer cannot differ between them because
// none of these cases mutates the tree. Cases that discover a synthetic
// root still call the functions directly with their own options.
let repositoryDiscovery: {
  readonly files: readonly string[];
  readonly groups: ReturnType<typeof discoverVitestResourceGroups>;
};

beforeAll(() => {
  repositoryDiscovery = Object.freeze({
    files: discoverVitestFiles(),
    groups: discoverVitestResourceGroups(),
  });
}, 70_000);

describe('Vitest resource manifest', () => {
  it('partitions Vitest discovery exactly once with no omitted files', () => {
    const discovered = repositoryDiscovery.files;
    const groups = repositoryDiscovery.groups;
    const classified = Object.values(groups).flat();

    expect(classified).toHaveLength(discovered.length);
    expect(new Set(classified).size).toBe(discovered.length);
    expect([...classified].sort()).toEqual(discovered);
    expect(groups.dogfoodReconcile.length).toBeGreaterThan(0);
    expect(groups.ordinary.length).toBeGreaterThan(0);
    expect(assertOrdinaryVitestSelection(groups)).toEqual(groups.ordinary);
  }, 70_000);

  it('proves eight ordinary slices cover the canonical corpus exactly once', async () => {
    // Vitest sorts a SHA-1 path projection and slices that ordered set. This
    // calls the installed selector itself—not a reimplementation—so changes
    // in discovery count or Vitest shard semantics force an explicit mapping
    // review instead of silently moving #1156's failing slice elsewhere.
    const ordinary = repositoryDiscovery.groups.ordinary;
    // Every assertion below is relative to `ordinary.length`, so an empty
    // corpus would satisfy all of them; pin the floor independently.
    expect(ordinary.length).toBeGreaterThan(0);
    const eighths = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        ordinaryShardFiles(ordinary, index + 1, 8),
      ),
    );
    const allEighths = eighths.flat();

    expect(allEighths).toHaveLength(ordinary.length);
    expect(new Set(allEighths).size).toBe(ordinary.length);
    expect([...new Set(allEighths)].sort()).toEqual([...ordinary].sort());

    // Vitest guarantees deterministic coverage for one chosen shard count;
    // it does not promise that two adjacent eighths equal a separately
    // computed quarter when the corpus size changes. Eight-way coverage is
    // the canonical contract and is proved above without a legacy partition.
  }, 70_000);

  // station#3465 disposition, made assertable in code (coordinator review):
  // packages/connect's whole test suite already rides the no-exclusion path
  // into the ordinary resource group (confirmed by hand during that issue's
  // investigation) — pin it so a future accidental exclusion reds a named
  // test instead of silently shrinking coverage again.
  it('keeps every packages/connect test file in the ordinary group (station#3465)', () => {
    // Exact independent oracle, not a floor (station#3465 review, second
    // pass): a real `git ls-files` call over the package directory is a
    // second, separate enumeration from `discoverVitestFiles()` (which
    // shells to `vitest list --filesOnly`) — up to 8 connect files could
    // have silently dropped out of vitest's own discovery and a `> 30` floor
    // would not notice, the same shape as this repo's own
    // `> 300`-vs-420-leaves precedent.
    const trackedConnectTests = execFileSync(
      'git',
      ['ls-files', 'packages/connect/**/*.test.*'],
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(trackedConnectTests.length).toBeGreaterThan(0);

    const discovered = repositoryDiscovery.files;
    const connectFiles = discovered.filter((file) =>
      file.startsWith('packages/connect/'),
    );
    expect([...connectFiles].sort()).toEqual([...trackedConnectTests].sort());

    const groups = repositoryDiscovery.groups;
    for (const file of connectFiles) {
      expect(groups.ordinary).toContain(file);
    }
  }, 70_000);

  it('keeps every current direct child-process importer out of ordinary', () => {
    const groups = repositoryDiscovery.groups;
    for (const file of PROCESS_HEAVY_VITEST_FILES) {
      expect(groups.processHeavy).toContain(file);
    }
    for (const file of PROCESS_EXCLUSIVE_VITEST_FILES) {
      expect(groups.processExclusive).toContain(file);
    }
    for (const file of SHARED_OUTPUT_VITEST_FILES) {
      expect(groups.sharedOutput).toContain(file);
    }
    expect(groups.ordinary).not.toContain(
      'src-ui/src/contexts/__tests__/ApiBaseContext.test.tsx',
    );
  }, 70_000);

  it('classifies the policy documentation reader exactly once as shared output', () => {
    const policyReader = 'scripts/__tests__/verification-policy-gate.test.ts';
    const groups = repositoryDiscovery.groups;
    expect(
      SHARED_OUTPUT_VITEST_FILES.filter((file) => file === policyReader),
    ).toEqual([policyReader]);
    expect(groups.sharedOutput.filter((file) => file === policyReader)).toEqual(
      [policyReader],
    );
    expect(groups.ordinary).not.toContain(policyReader);
    expect(groups.processHeavy).not.toContain(policyReader);
    expect(groups.processExclusive).not.toContain(policyReader);
  }, 70_000);

  it('keeps reviewed indirect and host-resource seams in the two-worker group', () => {
    const groups = repositoryDiscovery.groups;

    expect(PROCESS_HEAVY_MAX_WORKERS).toBe(2);
    expect(PROCESS_HEAVY_VITEST_FILES).toEqual(
      expect.arrayContaining(REVIEWED_RESOURCE_HEAVY_VITEST_FILES),
    );
    expect(groups.processHeavy).toEqual(
      expect.arrayContaining(REVIEWED_RESOURCE_HEAVY_VITEST_FILES),
    );
    for (const file of REVIEWED_RESOURCE_HEAVY_VITEST_FILES) {
      expect(groups.ordinary).not.toContain(file);
    }
  }, 70_000);

  it('classifies runtime bootstrap exactly once as process heavy', () => {
    const file =
      'src-server/runtime/bootstrap/__tests__/runtime-service-bootstrap.test.ts';
    const groups = repositoryDiscovery.groups;
    expect(groups.processHeavy.filter((entry) => entry === file)).toEqual([
      file,
    ]);
    expect(groups.ordinary).not.toContain(file);
    expect(groups.processExclusive).not.toContain(file);
    expect(groups.sharedOutput).not.toContain(file);
  }, 70_000);

  it('classifies Play-upload ownership exactly once as process exclusive', () => {
    const file = 'scripts/__tests__/play-upload-retry.test.ts';
    const groups = repositoryDiscovery.groups;
    expect(groups.processExclusive.filter((entry) => entry === file)).toEqual([
      file,
    ]);
    expect(groups.ordinary).not.toContain(file);
    expect(groups.processHeavy).not.toContain(file);
    expect(groups.sharedOutput).not.toContain(file);
  }, 70_000);

  it('classifies the multi-worker remote-home bootstrap exactly once as process exclusive', () => {
    const file =
      'src-server/routes/environments/__tests__/remote-home-transfer-decision.test.ts';
    const groups = repositoryDiscovery.groups;
    expect(groups.processExclusive.filter((entry) => entry === file)).toEqual([
      file,
    ]);
    expect(groups.ordinary).not.toContain(file);
    expect(groups.processHeavy).not.toContain(file);
    expect(groups.sharedOutput).not.toContain(file);
  }, 70_000);

  it('classifies the credential DDL proof exactly once in its exclusive phase', () => {
    const file =
      'src-server/services/orchestration/__tests__/credential-application-ledger.test.ts';
    const groups = repositoryDiscovery.groups;
    expect(CREDENTIAL_LEDGER_EXCLUSIVE_VITEST_FILES).toEqual([file]);
    expect(
      groups.credentialLedgerExclusive.filter((entry) => entry === file),
    ).toEqual([file]);
    expect(groups.ordinary).not.toContain(file);
    expect(groups.processHeavy).not.toContain(file);
    expect(groups.processExclusive).not.toContain(file);
    expect(groups.sharedOutput).not.toContain(file);
  }, 70_000);

  it('classifies the verification coordinator exactly once in its exclusive phase', () => {
    const file = 'scripts/__tests__/verification-coordinator.test.ts';
    const groups = repositoryDiscovery.groups;
    expect(COORDINATOR_EXCLUSIVE_VITEST_FILES).toEqual([file]);
    expect(
      groups.coordinatorExclusive.filter((entry) => entry === file),
    ).toEqual([file]);
    expect(groups.ordinary).not.toContain(file);
    expect(groups.processHeavy).not.toContain(file);
    expect(groups.processExclusive).not.toContain(file);
    expect(groups.credentialLedgerExclusive).not.toContain(file);
    expect(groups.sharedOutput).not.toContain(file);
  }, 70_000);

  it('recognizes bare and import-equals child-process forms before they can enter ordinary', () => {
    for (const source of [
      "import { spawn } from 'child_process'; void spawn;",
      "const child = require('child_process'); void child;",
      "import child = require('child_process'); void child;",
      "const child = await import('child_process'); void child;",
      "import child = require('node:child_process'); void child;",
    ]) {
      expect(hasDirectChildProcessImport(source)).toBe(true);
    }
    expect(
      hasDirectChildProcessImport('const text = "import(\'child_process\')";'),
    ).toBe(false);
  });

  it('proves the compact ordinary selection matches exactly and stays below Windows argv limits', () => {
    const groups = repositoryDiscovery.groups;
    const excludes = ordinaryVitestExcludes();
    expect(excludes).toContain(`${DOGFOOD_RECONCILE_PREFIX}*.test.ts`);
    expect(excludes).toContain(`${DOGFOOD_RECONCILE_PREFIX}/**`);
    expect(assertOrdinaryVitestSelection(groups)).toEqual(groups.ordinary);
    const argv = [
      process.execPath,
      'node_modules/vitest/vitest.mjs',
      'run',
      '--maxWorkers=4',
      ...excludes.map((pattern) => `--exclude=${pattern}`),
    ].join('\0');
    expect(Buffer.byteLength(argv)).toBeLessThan(32_767);
  }, 70_000);

  it('uses Vitest configuration to exclude sibling worktrees from discovery', () => {
    expect((config.test as { exclude?: string[] }).exclude).toContain(
      '**/station-worktrees/**',
    );
  });

  it('rejects a direct child-process importer that was not reviewed into a bounded process group', () => {
    const root = temporaryRoot();
    const ordinary = 'ordinary.test.ts';
    const heavy = 'heavy.test.ts';
    const dogfood = `${DOGFOOD_RECONCILE_PREFIX}.test.ts`;
    for (const path of [ordinary, heavy, dogfood]) {
      const target = join(root, path);
      const directory = target.slice(0, target.lastIndexOf('/'));
      if (directory) mkdirSync(directory, { recursive: true });
      writeFileSync(
        target,
        path === ordinary
          ? "import { spawn } from 'node:child_process'; void spawn;\n"
          : 'export {};\n',
      );
    }
    expect(() =>
      buildVitestResourceGroups([ordinary, heavy, dogfood], {
        root,
        manifest: {
          processHeavy: { files: [heavy] },
          processExclusive: { files: [] },
          coordinatorExclusive: { files: [] },
          credentialLedgerExclusive: { files: [] },
          sharedOutput: { files: [] },
        },
      }),
    ).toThrow(/needs an explicit resource classification/);
  });

  it('rejects duplicate or undiscovered manifest paths rather than silently selecting a subset', () => {
    const root = temporaryRoot();
    const first = 'first.test.ts';
    const dogfood = `${DOGFOOD_RECONCILE_PREFIX}.test.ts`;
    for (const path of [first, dogfood]) {
      const target = join(root, path);
      const directory = target.slice(0, target.lastIndexOf('/'));
      if (directory) mkdirSync(directory, { recursive: true });
      writeFileSync(target, 'export {};\n');
    }
    expect(() =>
      buildVitestResourceGroups([first, dogfood], {
        root,
        manifest: {
          processHeavy: { files: [first] },
          processExclusive: { files: [] },
          coordinatorExclusive: { files: [] },
          credentialLedgerExclusive: { files: [] },
          sharedOutput: { files: [first] },
        },
      }),
    ).toThrow(/must be disjoint/);
    expect(() =>
      buildVitestResourceGroups([first, dogfood], {
        root,
        manifest: {
          processHeavy: { files: ['missing.test.ts'] },
          processExclusive: { files: [] },
          coordinatorExclusive: { files: [] },
          credentialLedgerExclusive: { files: [] },
          sharedOutput: { files: [] },
        },
      }),
    ).toThrow(/is not discovered/);
  });

  it('recognizes the historical dogfood group without allowing overlap', () => {
    expect(isDogfoodReconcileFile(`${DOGFOOD_RECONCILE_PREFIX}.test.ts`)).toBe(
      true,
    );
    expect(
      isDogfoodReconcileFile(
        `${DOGFOOD_RECONCILE_PREFIX}/installer-process.test.ts`,
      ),
    ).toBe(true);
    expect(isDogfoodReconcileFile('scripts/__tests__/ordinary.test.ts')).toBe(
      false,
    );
  });
});

describe('test quarantine policy', () => {
  const now = new Date('2026-09-22T15:30:00Z');
  const SHA = '8e40e858a1b2c3d4e5f60718293a4b5c6d7e8f90';
  function entry(overrides: Record<string, unknown> = {}) {
    return {
      file: 'scripts/__tests__/flaky-example.test.ts',
      issue: 'https://github.com/kontourai/station/issues/2400',
      expires: '2026-10-06',
      evidence: `commit ${SHA} passed in https://github.com/kontourai/station/actions/runs/35756143372 and failed in run 35756143999`,
      ...overrides,
    };
  }
  const tracked = [
    'scripts/__tests__/flaky-example.test.ts',
    ...Array.from(
      { length: 6 },
      (_, index) => `scripts/__tests__/flaky-${index}.test.ts`,
    ),
  ];
  const errors = (entries: unknown[]) =>
    vitestQuarantineErrors(entries, { now, trackedFiles: tracked });

  it('accepts the checked-in list and a fully evidenced entry (false-positive control)', () => {
    expect(vitestQuarantineErrors(QUARANTINED_VITEST_FILES, { now })).toEqual(
      [],
    );
    expect(QUARANTINE_MAX_DAYS).toBe(14);
    expect(QUARANTINE_MAX_ENTRIES).toBe(5);
    // Fourteen days out is the furthest allowed expiry.
    expect(errors([entry({ expires: '2026-10-06' })])).toEqual([]);
    expect(errors([entry({ expires: '2026-09-23' })])).toEqual([]);
    expect(quarantinedVitestFiles([entry()])).toEqual([
      'scripts/__tests__/flaky-example.test.ts',
    ]);
  });

  it('turns red from the expiry date onward', () => {
    expect(errors([entry({ expires: '2026-09-22' })])).toEqual([
      expect.stringMatching(/quarantine expired on 2026-09-22/),
    ]);
    expect(errors([entry({ expires: '2026-08-01' })])).toEqual([
      expect.stringMatching(/quarantine expired on 2026-08-01/),
    ]);
  });

  it('refuses an expiry more than fourteen days out or not a calendar date', () => {
    expect(errors([entry({ expires: '2026-10-07' })])).toEqual([
      expect.stringMatching(/2026-10-07 is more than 14 days away/),
    ]);
    for (const expires of ['2026-02-30', '2026-9-30', 'next week', 20261001])
      expect(errors([entry({ expires })]), String(expires)).toEqual([
        expect.stringMatching(/expires must be a calendar date/),
      ]);
  });

  it('requires the full URL of a station issue', () => {
    for (const issue of [
      '#2400',
      '2400',
      'https://github.com/kontourai/station-archive/issues/2400',
      'http://github.com/kontourai/station/issues/2400',
      'https://github.com/kontourai/station/pull/2400',
      undefined,
    ])
      expect(errors([entry({ issue })]), String(issue)).toEqual([
        expect.stringMatching(
          /issue must be the URL of the open 'flaky' issue/,
        ),
      ]);
  });

  it('requires evidence of a same-commit disagreement: one SHA and two distinct runs', () => {
    for (const evidence of [
      'flaky on CI',
      `commit ${SHA} failed in run 35756143372`,
      `commit ${SHA} run 35756143372 and run 35756143372 disagreed`,
      'run 35756143372 passed and run 35756143999 failed',
      `commit ${SHA.slice(0, 12)} run 35756143372 run 35756143999`,
      undefined,
    ])
      expect(errors([entry({ evidence })]), String(evidence)).toEqual([
        expect.stringMatching(/evidence must cite the commit SHA/),
      ]);
  });

  it('bounds the list and rejects malformed, duplicate, or untracked files', () => {
    const six = Array.from({ length: 6 }, (_, index) =>
      entry({ file: `scripts/__tests__/flaky-${index}.test.ts` }),
    );
    expect(errors(six)).toEqual([
      'quarantine holds 6 entries; at most 5 are allowed',
    ]);
    expect(errors(six.slice(0, 5))).toEqual([]);
    expect(errors([entry(), entry()])).toEqual([
      expect.stringMatching(/file is quarantined twice/),
    ]);
    expect(errors([entry({ file: 'scripts/__tests__/gone.test.ts' })])).toEqual(
      [expect.stringMatching(/not a tracked Vitest test file/)],
    );
    for (const file of ['../escape.test.ts', '/abs.test.ts', 'README.md'])
      expect(errors([entry({ file })]), file).toEqual([
        expect.stringMatching(/file must be a repository-relative test path/),
      ]);
    expect(errors([entry({ owner: 'someone' })])).toEqual([
      expect.stringMatching(/must have exactly the keys/),
    ]);
    const { evidence: _omitted, ...missing } = entry();
    expect(errors([missing])[0]).toMatch(/must have exactly the keys/);
    expect(vitestQuarantineErrors({} as never)).toEqual([
      'quarantine must be an array',
    ]);
  });
});
