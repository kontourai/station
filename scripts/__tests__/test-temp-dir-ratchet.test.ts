import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  countFiles,
  countRawCalls,
  evaluate,
  listScannedFiles,
  lowerBaseline,
  SCOPE_SENTINELS,
} from '../test-temp-dir-ratchet.mjs';

const makeTempDir = trackTempDirs();

// Fixture sources are assembled from this name so this file does not itself
// contain the raw call shape the gate counts.
const MK = 'mkdtemp';

describe('test temp-dir ratchet source matching', () => {
  test.each([
    `const dir = ${MK}Sync(join(tmpdir(), 'x-'));`,
    `const dir = await ${MK}(join(tmpdir(), 'x-'));`,
    `const dir = fs.${MK}Sync(join(tmpdir(), 'x-'));`,
    `const dir = await fsp.${MK} (join(tmpdir(), 'x-'));`,
  ])('counts the raw call: %s', (source) => {
    expect(countRawCalls(source)).toBe(1);
  });

  test('counts every call on a line', () => {
    expect(
      countRawCalls(
        `const [a, b] = [${MK}Sync(join(tmpdir(), 'a-')), ${MK}Sync(join(tmpdir(), 'b-'))];`,
      ),
    ).toBe(2);
  });

  test('does not count the helper, an import, or prose', () => {
    expect(countRawCalls("const dir = makeTempDir('x-');")).toBe(0);
    expect(countRawCalls("import { mkdtempSync } from 'node:fs';")).toBe(0);
    expect(countRawCalls(`// ${MK}Sync(join(tmpdir(), "x-")) leaked`)).toBe(0);
    expect(countRawCalls(` * a raw ${MK}( call is removed only if…`)).toBe(0);
  });
});

describe('test temp-dir ratchet decisions', () => {
  const allSentinels = SCOPE_SENTINELS;

  test('a file above its row, and a new file, are both over', () => {
    const result = evaluate(
      { 'a.test.ts': 3, 'new.test.ts': 1 },
      allSentinels,
      { files: { 'a.test.ts': 2 } },
    );
    expect(result.ok).toBe(false);
    expect(result.over).toEqual([
      { file: 'a.test.ts', count: 3, ceiling: 2 },
      { file: 'new.test.ts', count: 1, ceiling: 0 },
    ]);
  });

  test('a file below its row, including one gone entirely, is reported but not a failure', () => {
    const result = evaluate({ 'a.test.ts': 1 }, allSentinels, {
      files: { 'a.test.ts': 2, 'gone.test.ts': 4 },
    });
    // Under a merge queue two lowerings of one row merge below both; failing
    // would red whichever change gates next, not either author.
    expect(result.ok).toBe(true);
    expect(result.under).toEqual([
      { file: 'a.test.ts', count: 1, ceiling: 2 },
      { file: 'gone.test.ts', count: 0, ceiling: 4 },
    ]);
  });

  test('a lost sentinel fails rather than reporting green', () => {
    expect(evaluate({}, allSentinels.slice(1), { files: {} }).ok).toBe(false);
  });

  test('--update lowers and drops rows but never raises or adds one', () => {
    expect(
      lowerBaseline(
        { 'a.test.ts': 1 },
        { note: 'kept', files: { 'a.test.ts': 2, 'gone.test.ts': 4 } },
      ),
    ).toEqual({
      ok: true,
      baseline: { note: 'kept', files: { 'a.test.ts': 1 } },
    });
    expect(
      lowerBaseline({ 'a.test.ts': 3 }, { files: { 'a.test.ts': 2 } }),
    ).toMatchObject({ ok: false });
    expect(lowerBaseline({ 'new.test.ts': 1 }, { files: {} })).toMatchObject({
      ok: false,
    });
  });
});

describe('test temp-dir ratchet scope honesty', () => {
  test('the scanned set is the tracked test files under the scan roots', () => {
    // Independent re-derivation, so a bug in the gate's lister cannot agree
    // with itself (station#1559 class).
    const tracked = execFileSync(
      'git',
      [
        'ls-files',
        '--',
        'src-server',
        'src-shared',
        'src-ui',
        'packages',
        'scripts',
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    )
      .split('\n')
      .filter((file) => /\.[cm]?[jt]sx?$/.test(file))
      .filter((file) => /(^|\/)__tests__\/|\.(test|spec)\./.test(file));
    const scanned = new Set(listScannedFiles());
    for (const file of tracked) expect(scanned.has(file)).toBe(true);
    for (const sentinel of SCOPE_SENTINELS)
      expect(scanned.has(sentinel)).toBe(true);
  });

  test('this repository is at its checked-in baseline', () => {
    const files = listScannedFiles();
    const baseline = JSON.parse(
      readFileSync('scripts/test-temp-dir-baseline.json', 'utf8'),
    );
    expect(evaluate(countFiles(files), files, baseline)).toMatchObject({
      over: [],
      under: [],
      missingSentinels: [],
      ok: true,
    });
  });
});

/**
 * The gate's REJECTION path, run as a real child process against a throwaway
 * git repository. The pure functions above say what it DECIDES; only these
 * say what it does with that decision — the `FAIL:` sentence and the exit
 * status. Bounded, single-shot children; classified process-heavy in
 * `scripts/vitest-resource-manifest.mjs`.
 */
describe('test temp-dir ratchet at the process boundary', () => {
  const RATCHET = resolve(import.meta.dirname, '../test-temp-dir-ratchet.mjs');
  const RAW = `const d = ${MK}Sync(join(tmpdir(), 'x-'));\n`;

  /** Every sentinel present with one raw call, and a matching baseline. */
  function repo(
    files: Record<string, string>,
    baseline: Record<string, number>,
    { stage = true }: { stage?: boolean } = {},
  ): string {
    const dir = makeTempDir('test-temp-dir-ratchet-');
    execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
    const all = {
      ...Object.fromEntries(SCOPE_SENTINELS.map((path) => [path, RAW])),
      'scripts/test-temp-dir-baseline.json': `${JSON.stringify({
        files: {
          ...Object.fromEntries(SCOPE_SENTINELS.map((path) => [path, 1])),
          ...baseline,
        },
      })}\n`,
      ...files,
    };
    for (const [path, contents] of Object.entries(all)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), contents);
    }
    if (stage) {
      execFileSync('git', ['add', '-A'], { cwd: dir, windowsHide: true });
    }
    return dir;
  }

  function run(dir: string, ...args: string[]) {
    return spawnSync(process.execPath, [RATCHET, ...args], {
      cwd: dir,
      encoding: 'utf8',
      windowsHide: true,
    });
  }

  test('exits 0 at the baseline', () => {
    const result = run(repo({}, {}));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OK: 3 raw mkdtemp calls');
  });

  test('exits 1 and names a new test file that adds a raw call', () => {
    const result = run(
      repo({ 'src-server/feature/__tests__/leaky.test.ts': RAW }, {}),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'FAIL: raw mkdtemp calls in test files rose',
    );
    expect(result.stderr).toContain(
      'src-server/feature/__tests__/leaky.test.ts: 1 (baseline 0)',
    );
    expect(result.stderr).toContain('trackTempDirs()');
  });

  test('sees a new file that is not yet staged', () => {
    const result = run(
      repo(
        { 'packages/cli/src/__tests__/leaky.test.ts': RAW },
        {},
        { stage: false },
      ),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'packages/cli/src/__tests__/leaky.test.ts: 1 (baseline 0)',
    );
  });

  test('exits 0 and asks for --update when a file falls below its row', () => {
    const result = run(
      repo(
        { 'scripts/__tests__/migrated.test.ts': "makeTempDir('x-');\n" },
        { 'scripts/__tests__/migrated.test.ts': 2 },
      ),
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('fell below the baseline');
    expect(result.stdout).toContain(
      'scripts/__tests__/migrated.test.ts: 0 (baseline 2)',
    );
  });

  test('--update records the lower count, then the gate passes', () => {
    const dir = repo(
      { 'scripts/__tests__/migrated.test.ts': RAW },
      { 'scripts/__tests__/migrated.test.ts': 2 },
    );
    const update = run(dir, '--update');
    expect(update.status).toBe(0);
    const written = JSON.parse(
      readFileSync(join(dir, 'scripts/test-temp-dir-baseline.json'), 'utf8'),
    );
    expect(written.files['scripts/__tests__/migrated.test.ts']).toBe(1);
    expect(run(dir).status).toBe(0);
  });

  test('--update refuses to raise a row', () => {
    const dir = repo({ 'src-server/__tests__/leaky.test.ts': RAW }, {});
    const update = run(dir, '--update');
    expect(update.status).toBe(1);
    expect(update.stderr).toContain('--update only lowers');
    expect(update.stderr).toContain('src-server/__tests__/leaky.test.ts: 1');
  });

  test('exits 1 when the scan stops reaching a sentinel', () => {
    const dir = repo({}, {});
    execFileSync('git', ['rm', '-q', '--cached', SCOPE_SENTINELS[0]], {
      cwd: dir,
      windowsHide: true,
    });
    writeFileSync(join(dir, '.gitignore'), `${SCOPE_SENTINELS[0]}\n`);
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('scope lost these files');
    expect(result.stderr).toContain(SCOPE_SENTINELS[0]);
  });
});
