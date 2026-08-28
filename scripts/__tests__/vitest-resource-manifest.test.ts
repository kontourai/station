import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import config from '../../vitest.config';
import { PROCESS_HEAVY_MAX_WORKERS } from '../run-vitest-corpus.mjs';
import {
  assertOrdinaryVitestSelection,
  buildVitestResourceGroups,
  DOGFOOD_RECONCILE_PREFIX,
  discoverVitestFiles,
  discoverVitestResourceGroups,
  hasDirectChildProcessImport,
  isDogfoodReconcileFile,
  ordinaryVitestExcludes,
  PROCESS_EXCLUSIVE_VITEST_FILES,
  PROCESS_HEAVY_VITEST_FILES,
  SHARED_OUTPUT_VITEST_FILES,
} from '../vitest-resource-manifest.mjs';

const temporaryRoots: string[] = [];
const REVIEWED_RESOURCE_HEAVY_VITEST_FILES = Object.freeze([
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

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe('Vitest resource manifest', () => {
  it('partitions Vitest discovery exactly once with no omitted files', () => {
    const discovered = discoverVitestFiles();
    const groups = discoverVitestResourceGroups();
    const classified = Object.values(groups).flat();

    expect(classified).toHaveLength(discovered.length);
    expect(new Set(classified).size).toBe(discovered.length);
    expect([...classified].sort()).toEqual(discovered);
    expect(groups.dogfoodReconcile.length).toBeGreaterThan(0);
    expect(groups.ordinary.length).toBeGreaterThan(0);
    expect(assertOrdinaryVitestSelection(groups)).toEqual(groups.ordinary);
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

    const discovered = discoverVitestFiles();
    const connectFiles = discovered.filter((file) =>
      file.startsWith('packages/connect/'),
    );
    expect([...connectFiles].sort()).toEqual([...trackedConnectTests].sort());

    const groups = discoverVitestResourceGroups();
    for (const file of connectFiles) {
      expect(groups.ordinary).toContain(file);
    }
  }, 70_000);

  it('keeps every current direct child-process importer out of ordinary', () => {
    const groups = discoverVitestResourceGroups();
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
    const groups = discoverVitestResourceGroups();
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
    const groups = discoverVitestResourceGroups();

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
    const file = 'src-server/runtime/bootstrap/__tests__/runtime-service-bootstrap.test.ts';
    const groups = discoverVitestResourceGroups();
    expect(groups.processHeavy.filter((entry) => entry === file)).toEqual([file]);
    expect(groups.ordinary).not.toContain(file);
    expect(groups.processExclusive).not.toContain(file);
    expect(groups.sharedOutput).not.toContain(file);
  }, 70_000);

  it('classifies Play-upload ownership exactly once as process exclusive', () => {
    const file = 'scripts/__tests__/play-upload-retry.test.ts';
    const groups = discoverVitestResourceGroups();
    expect(groups.processExclusive.filter((entry) => entry === file)).toEqual([file]);
    expect(groups.ordinary).not.toContain(file);
    expect(groups.processHeavy).not.toContain(file);
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
    const groups = discoverVitestResourceGroups();
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
