import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';

const root = resolve(import.meta.dirname, '../..');
const makeTempDir = trackTempDirs();
function repository() {
  const directory = makeTempDir('station-fast-checks-plan-');
  for (const file of [
    'scripts/fast-checks-shard.mjs',
    'scripts/lib/fast-checks-shards.mjs',
    'scripts/lib/module-entry.mjs',
  ]) {
    mkdirSync(join(directory, file, '..'), { recursive: true });
    copyFileSync(join(root, file), join(directory, file));
  }
  return { directory, head: 'a'.repeat(40) };
}
function planFor(head: string, files: string[], deferred = false) {
  return {
    schemaVersion: 1,
    kind: 'station-fast-checks-plan',
    base: 'base-sha',
    headSha: head,
    shardCount: 4,
    deferredLanes: deferred ? [{ id: 'test-full', reasons: ['fixture'] }] : [],
    groups: files.length ? [{ resourceGroup: 'ordinary', files }] : [],
    fileCount: files.length,
  };
}
function cli(
  args: string[],
  { cwd, env = {} }: { cwd: string; env?: Record<string, string> },
) {
  return spawnSync(
    process.execPath,
    ['scripts/fast-checks-shard.mjs', ...args],
    {
      cwd,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', ...env },
      timeout: 30_000,
      windowsHide: true,
    },
  );
}

describe('adaptive planner outputs (child process)', () => {
  // Literal boundaries protect the initial 40-file threshold independently
  // of the implementation constant. The fixture supplies selection only;
  // shard count and GitHub outputs come from the production CLI.
  test.each([
    [0, 1],
    [39, 1],
    [40, 1],
    [41, 2],
    [80, 2],
    [81, 3],
    [120, 3],
    [121, 4],
    [200, 4],
  ])('%i selected files produce %i shards', (fileCount, expected) => {
    const { directory, head } = repository();
    const selected = planFor(
      head,
      Array.from({ length: fileCount }, (_, i) => `a/file-${i}.test.ts`),
      fileCount === 0,
    );
    writeFileSync(
      join(directory, 'scripts/run-ci-fast.mjs'),
      'export const fastBase = () => "base-sha";',
    );
    writeFileSync(
      join(directory, 'scripts/run-changed-verification.mjs'),
      `export const planChangedVerificationShards = async () => (${JSON.stringify(selected)});`,
    );
    const output = join(directory, 'github-output');
    const result = cli(['plan', '--out=plan.json'], {
      cwd: directory,
      env: {
        GITHUB_OUTPUT: output,
        STATION_FAST_CHECKS_ADAPTIVE_SHARDS: 'true',
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(
      JSON.parse(readFileSync(join(directory, 'plan.json'), 'utf8')).shardCount,
    ).toBe(expected);
    expect(readFileSync(output, 'utf8')).toBe(
      `shards=${JSON.stringify(Array.from({ length: expected }, (_, i) => i + 1))}\nshard-count=${expected}\n`,
    );
  });

  test('the old base workflow receives a four-way plan without the adaptive opt-in', () => {
    const { directory, head } = repository();
    const selected = planFor(head, ['a/a.test.ts']);
    writeFileSync(
      join(directory, 'scripts/run-ci-fast.mjs'),
      'export const fastBase = () => "base-sha";',
    );
    writeFileSync(
      join(directory, 'scripts/run-changed-verification.mjs'),
      `export const planChangedVerificationShards = async () => (${JSON.stringify(selected)});`,
    );
    const result = cli(['plan', '--out=plan.json'], { cwd: directory });
    expect(result.status, result.stderr).toBe(0);
    expect(
      JSON.parse(readFileSync(join(directory, 'plan.json'), 'utf8')).shardCount,
    ).toBe(4);
  });

  test('a failed selection exits 2 and emits no successful plan', () => {
    const { directory } = repository();
    writeFileSync(
      join(directory, 'scripts/run-ci-fast.mjs'),
      'export const fastBase = () => "base-sha";',
    );
    writeFileSync(
      join(directory, 'scripts/run-changed-verification.mjs'),
      'export const planChangedVerificationShards = async () => { throw new Error("selection failed"); };',
    );
    const result = cli(['plan', '--out=plan.json'], { cwd: directory });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('selection failed');
    expect(readdirSync(directory)).not.toContain('plan.json');
  });
});
