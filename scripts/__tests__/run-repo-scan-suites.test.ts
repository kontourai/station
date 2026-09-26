import { spawnSync } from 'node:child_process';
import { symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { ensureCliBundle, runRepoScans } from '../run-repo-scan-suites.mjs';
import { REPO_SCAN_SUITES } from '../test-impact-manifest.mjs';

const makeTempDir = trackTempDirs();

describe('repo-scans runner (#2176)', () => {
  it('hands the focused runner exactly REPO_SCAN_SUITES, once', async () => {
    const run = vi.fn(async (_args: string[]) => 0);
    await runRepoScans({ run });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toEqual([...REPO_SCAN_SUITES]);
    // A copy, so the runner cannot mutate the frozen list it was given.
    expect(run.mock.calls[0]?.[0]).not.toBe(REPO_SCAN_SUITES);
  });

  it.each([0, 1, 2])(
    'returns the focused runner exit code %i unchanged',
    async (code) => {
      await expect(runRepoScans({ run: async () => code })).resolves.toBe(code);
    },
  );

  it('propagates a runner that throws rather than reporting success', async () => {
    await expect(
      runRepoScans({
        run: async () => {
          throw new Error('vitest did not start');
        },
      }),
    ).rejects.toThrow('vitest did not start');
  });

  it('ensures the CLI bundle before handing off to the runner', async () => {
    const run = vi.fn(async (_args: string[]) => 0);
    const ensureCli = vi.fn(() => false);
    await runRepoScans({ run, ensureCli });
    expect(ensureCli).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('builds the missing CLI bundle once, then runs the scans', () => {
    const root = makeTempDir('station-repo-scans-dist-');
    const build = vi.fn();
    expect(ensureCliBundle({ root, exists: () => false, build })).toBe(true);
    expect(build).toHaveBeenCalledTimes(1);
    expect(build.mock.calls[0]?.[0]).toBe(root);
  });

  it('leaves a present CLI bundle alone', () => {
    const root = makeTempDir('station-repo-scans-dist-');
    const build = vi.fn();
    expect(ensureCliBundle({ root, exists: () => true, build })).toBe(false);
    expect(build).not.toHaveBeenCalled();
  });

  it('reaches the runner when invoked through a symlink, not only directly', () => {
    // Node resolves a symlinked main module to its target, so a plain
    // argv[1] === import.meta.url guard is false through a link and the CLI
    // would exit 0 having run nothing. `--list` reaches the same guard
    // without running Vitest.
    const runner = resolve(import.meta.dirname, '../run-repo-scan-suites.mjs');
    const link = join(makeTempDir('station-repo-scans-link-'), 'runner.mjs');
    symlinkSync(runner, link);
    for (const entry of [runner, link]) {
      const result = spawnSync(process.execPath, [entry, '--list'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      expect(result.status, entry).toBe(0);
      expect(result.stdout.trim().split('\n'), entry).toEqual([
        ...REPO_SCAN_SUITES,
      ]);
    }
  });
});
