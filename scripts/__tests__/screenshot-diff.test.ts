import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  baselineImagesDir,
  buildDiffImage,
  DEFAULT_BASELINE_PATH,
  DEFAULT_GALLERY_DIR,
  hashScreenshot,
  parseScreenshotDiffArgs,
  runBaseline,
  runDiff,
} from '../screenshot-diff.mjs';

const SCRIPT_PATH = resolve(import.meta.dirname, '../screenshot-diff.mjs');

/** A solid-color PNG buffer — sha256-exact comparison needs no special
 * discriminating shape; any two distinct colors hash differently. */
function solidPng(width: number, height: number, [r, g, b]: number[]) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (width * y + x) << 2;
      png.data[idx] = r;
      png.data[idx + 1] = g;
      png.data[idx + 2] = b;
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function runScript(args: string[], cwd: string) {
  try {
    const stdout = execFileSync('node', [SCRIPT_PATH, ...args], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const execError = error as {
      status: number | null;
      stdout?: string;
      stderr?: string;
    };
    return {
      status: execError.status ?? 1,
      stdout: execError.stdout ?? '',
      stderr: execError.stderr ?? '',
    };
  }
}

describe('pixelSha256 / hashScreenshot', () => {
  it('is deterministic for identical pixels', () => {
    const png = solidPng(40, 30, [30, 60, 90]);
    expect(hashScreenshot(png)).toEqual(hashScreenshot(png));
  });

  it('produces a 64 lowercase-hex-char sha256', () => {
    const { sha256 } = hashScreenshot(solidPng(40, 30, [30, 60, 90]));
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for any distinct pixel content', () => {
    const a = hashScreenshot(solidPng(40, 30, [30, 60, 90]));
    const b = hashScreenshot(solidPng(40, 30, [30, 60, 91]));
    expect(a.sha256).not.toBe(b.sha256);
  });

  it('reports the decoded width/height', () => {
    const { width, height } = hashScreenshot(solidPng(41, 33, [0, 0, 0]));
    expect(width).toBe(41);
    expect(height).toBe(33);
  });
});

describe('buildDiffImage', () => {
  it('finds zero differing pixels for identical buffers', () => {
    const png = PNG.sync.read(solidPng(10, 10, [10, 20, 30]));
    const { differing, total } = buildDiffImage(
      png.data,
      png.data,
      png.width,
      png.height,
    );
    expect(differing).toBe(0);
    expect(total).toBe(100);
  });

  it('counts exactly the pixels that differ', () => {
    const base = PNG.sync.read(solidPng(10, 10, [10, 20, 30])).data;
    const changed = PNG.sync.read(solidPng(10, 10, [10, 20, 30])).data;
    // Flip 3 pixels.
    for (const i of [0, 4, 8]) {
      changed[i * 4] = 255;
    }
    const { differing } = buildDiffImage(base, changed, 10, 10);
    expect(differing).toBe(3);
  });
});

describe('baselineImagesDir', () => {
  it('strips .json and uses the manifest basename as a sibling directory', () => {
    expect(baselineImagesDir('tests/screenshots.baseline.json')).toBe(
      'tests/screenshots.baseline',
    );
  });
});

describe('parseScreenshotDiffArgs', () => {
  it('requires a recognized mode', () => {
    expect(() => parseScreenshotDiffArgs([])).toThrow(/Usage/);
    expect(() => parseScreenshotDiffArgs(['bogus'])).toThrow(/Usage/);
  });

  it('applies defaults', () => {
    const options = parseScreenshotDiffArgs(['diff']);
    expect(options.gallery).toBe(DEFAULT_GALLERY_DIR);
    expect(options.baseline).toBe(DEFAULT_BASELINE_PATH);
    expect(options.allowPartial).toBe(false);
    expect(options.screens).toBeNull();
    expect(options.diffDir).toBeNull();
  });

  it('parses --screens as a trimmed, comma-separated list', () => {
    const options = parseScreenshotDiffArgs([
      'diff',
      '--screens= home , agents ,',
    ]);
    expect(options.screens).toEqual(['home', 'agents']);
  });

  it('no longer accepts --threshold (exact comparison has none)', () => {
    expect(() => parseScreenshotDiffArgs(['diff', '--threshold=10'])).toThrow(
      /Unrecognized option/,
    );
  });

  it('accepts --diff-dir and --allow-partial', () => {
    const options = parseScreenshotDiffArgs([
      'baseline',
      '--diff-dir=/tmp/x',
      '--allow-partial',
    ]);
    expect(options.diffDir).toBe('/tmp/x');
    expect(options.allowPartial).toBe(true);
  });

  it('rejects an unrecognized option', () => {
    expect(() => parseScreenshotDiffArgs(['diff', '--bogus=1'])).toThrow(
      /Unrecognized option/,
    );
  });
});

describe('runBaseline and runDiff (in-process)', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function writeCapture(
    galleryDir: string,
    screens: { name: string; ok: boolean; error?: string }[],
    selection: string[] | null,
  ) {
    for (const screen of screens) {
      if (screen.ok) {
        writeFileSync(
          join(galleryDir, `${screen.name}.png`),
          screen.name === 'b'
            ? solidPng(120, 80, [200, 40, 40])
            : solidPng(120, 80, [50, 100, 150]),
        );
      }
    }
    writeFileSync(
      join(galleryDir, 'capture.json'),
      JSON.stringify({
        schemaVersion: 1,
        runId: null,
        capturedAt: '2026-01-01T00:00:00.000Z',
        selection,
        screens: screens.map((s) => ({
          file: `${s.name}.png`,
          ok: s.ok,
          name: s.name,
          error: s.error ?? null,
        })),
      }),
    );
  }

  it('writes a baseline from a full, all-ok capture (REPLACE)', () => {
    dir = mkdtempSync(join(tmpdir(), 'screenshot-diff-'));
    writeCapture(
      dir,
      [
        { name: 'a', ok: true },
        { name: 'b', ok: true },
      ],
      null,
    );
    const baselinePath = join(dir, 'baseline.json');
    const result = runBaseline(
      { gallery: dir, baseline: baselinePath, allowPartial: false },
      { log: () => {} },
    );
    expect(result).toEqual({
      updated: 2,
      preservedVolatile: 0,
      total: 2,
      replaced: true,
    });
  });

  it('refuses a partial-selection capture without --allow-partial', () => {
    dir = mkdtempSync(join(tmpdir(), 'screenshot-diff-'));
    writeCapture(dir, [{ name: 'a', ok: true }], ['a']);
    const baselinePath = join(dir, 'baseline.json');
    expect(() =>
      runBaseline(
        { gallery: dir, baseline: baselinePath, allowPartial: false },
        { log: () => {} },
      ),
    ).toThrow(/targeted run/);
  });

  it('refuses a full capture with a failed screen without --allow-partial', () => {
    dir = mkdtempSync(join(tmpdir(), 'screenshot-diff-'));
    writeCapture(
      dir,
      [
        { name: 'a', ok: true },
        { name: 'b', ok: false, error: 'boom' },
      ],
      null,
    );
    const baselinePath = join(dir, 'baseline.json');
    expect(() =>
      runBaseline(
        { gallery: dir, baseline: baselinePath, allowPartial: false },
        { log: () => {} },
      ),
    ).toThrow(/failed screen/);
  });

  it('--allow-partial MERGES: only captured screens change, others survive untouched', () => {
    dir = mkdtempSync(join(tmpdir(), 'screenshot-diff-'));
    const baselinePath = join(dir, 'baseline.json');

    writeCapture(
      dir,
      [
        { name: 'a', ok: true },
        { name: 'b', ok: true },
      ],
      null,
    );
    runBaseline(
      { gallery: dir, baseline: baselinePath, allowPartial: false },
      { log: () => {} },
    );

    // A targeted rerun of only 'a', with a failed 'c' thrown in — 'b' must
    // survive untouched and 'c' must never be written.
    writeCapture(
      dir,
      [
        { name: 'a', ok: true },
        { name: 'c', ok: false, error: 'boom' },
      ],
      ['a', 'c'],
    );
    const result = runBaseline(
      { gallery: dir, baseline: baselinePath, allowPartial: true },
      { log: () => {} },
    );
    expect(result).toEqual({
      updated: 1,
      preservedVolatile: 0,
      total: 2,
      replaced: false,
    });
  });

  it('a REPLACE run preserves a hand-marked volatile entry and never overwrites it with a hash', () => {
    dir = mkdtempSync(join(tmpdir(), 'screenshot-diff-'));
    const baselinePath = join(dir, 'baseline.json');
    writeCapture(
      dir,
      [
        { name: 'a', ok: true },
        { name: 'b', ok: true },
      ],
      null,
    );
    runBaseline(
      { gallery: dir, baseline: baselinePath, allowPartial: false },
      { log: () => {} },
    );
    const manifest = JSON.parse(readFileSync(baselinePath, 'utf8'));
    manifest.screens = manifest.screens.map((entry: { name: string }) =>
      entry.name === 'b'
        ? { name: 'b', volatile: true, reason: 'test reason' }
        : entry,
    );
    writeFileSync(baselinePath, JSON.stringify(manifest));

    // Full REPLACE rerun — 'b' must survive as the SAME volatile entry, not
    // get overwritten with a freshly computed hash.
    writeCapture(
      dir,
      [
        { name: 'a', ok: true },
        { name: 'b', ok: true },
      ],
      null,
    );
    const result = runBaseline(
      { gallery: dir, baseline: baselinePath, allowPartial: false },
      { log: () => {} },
    );
    expect(result.preservedVolatile).toBe(1);
    const after = JSON.parse(readFileSync(baselinePath, 'utf8'));
    const bEntry = after.screens.find((s: { name: string }) => s.name === 'b');
    expect(bEntry).toEqual({
      name: 'b',
      volatile: true,
      reason: 'test reason',
    });
  });

  it('REPLACE refuses when it would drop more than half of the existing baseline, without --force-replace', () => {
    dir = mkdtempSync(join(tmpdir(), 'screenshot-diff-'));
    const baselinePath = join(dir, 'baseline.json');
    writeCapture(
      dir,
      [
        { name: 'a', ok: true },
        { name: 'b', ok: true },
        { name: 'c', ok: true },
        { name: 'd', ok: true },
      ],
      null,
    );
    runBaseline(
      { gallery: dir, baseline: baselinePath, allowPartial: false },
      { log: () => {} },
    );
    // A near-empty REPLACE capture — only 1 of the previous 4 screens — is
    // the realistic shape of a baseline-conflict resolution that collapsed
    // the manifest array, not an intentional mass screen retirement.
    writeCapture(dir, [{ name: 'a', ok: true }], null);
    expect(() =>
      runBaseline(
        { gallery: dir, baseline: baselinePath, allowPartial: false },
        { log: () => {} },
      ),
    ).toThrow(/more than half/);
    // The refused attempt must leave the existing baseline untouched.
    const after = JSON.parse(readFileSync(baselinePath, 'utf8'));
    expect(after.screens).toHaveLength(4);
  });

  it('REPLACE allows dropping more than half of the existing baseline with --force-replace', () => {
    dir = mkdtempSync(join(tmpdir(), 'screenshot-diff-'));
    const baselinePath = join(dir, 'baseline.json');
    writeCapture(
      dir,
      [
        { name: 'a', ok: true },
        { name: 'b', ok: true },
        { name: 'c', ok: true },
        { name: 'd', ok: true },
      ],
      null,
    );
    runBaseline(
      { gallery: dir, baseline: baselinePath, allowPartial: false },
      { log: () => {} },
    );
    writeCapture(dir, [{ name: 'a', ok: true }], null);
    const result = runBaseline(
      {
        gallery: dir,
        baseline: baselinePath,
        allowPartial: false,
        forceReplace: true,
      },
      { log: () => {} },
    );
    expect(result).toEqual({
      updated: 1,
      preservedVolatile: 0,
      total: 1,
      replaced: true,
    });
  });

  it('REPLACE does not refuse at exactly half (only a MORE-than-half drop is refused)', () => {
    dir = mkdtempSync(join(tmpdir(), 'screenshot-diff-'));
    const baselinePath = join(dir, 'baseline.json');
    writeCapture(
      dir,
      [
        { name: 'a', ok: true },
        { name: 'b', ok: true },
        { name: 'c', ok: true },
        { name: 'd', ok: true },
      ],
      null,
    );
    runBaseline(
      { gallery: dir, baseline: baselinePath, allowPartial: false },
      { log: () => {} },
    );
    writeCapture(
      dir,
      [
        { name: 'a', ok: true },
        { name: 'b', ok: true },
      ],
      null,
    );
    const result = runBaseline(
      { gallery: dir, baseline: baselinePath, allowPartial: false },
      { log: () => {} },
    );
    expect(result.total).toBe(2);
  });

  it('diff reports unchanged for an identical rerun, counted as comparisons', () => {
    dir = mkdtempSync(join(tmpdir(), 'screenshot-diff-'));
    const baselinePath = join(dir, 'baseline.json');
    writeCapture(
      dir,
      [
        { name: 'a', ok: true },
        { name: 'b', ok: true },
      ],
      null,
    );
    runBaseline(
      { gallery: dir, baseline: baselinePath, allowPartial: false },
      { log: () => {} },
    );
    const result = runDiff(
      { gallery: dir, baseline: baselinePath, screens: null },
      { log: () => {} },
    );
    expect(result.exitCode).toBe(0);
    expect(result.comparisons).toBe(2);
    expect(result.rows.every((r) => r.status === 'unchanged')).toBe(true);
  });

  it('diff reports changed/new/capture-failed/missing-from-gallery correctly, and only "changed" is named', () => {
    dir = mkdtempSync(join(tmpdir(), 'screenshot-diff-'));
    const baselinePath = join(dir, 'baseline.json');
    writeCapture(
      dir,
      [
        { name: 'a', ok: true },
        { name: 'b', ok: true },
      ],
      null,
    );
    runBaseline(
      { gallery: dir, baseline: baselinePath, allowPartial: false },
      { log: () => {} },
    );

    // 'a' changes pixels, 'b' fails to capture this run, 'c' is new.
    writeCapture(
      dir,
      [
        { name: 'a', ok: true },
        { name: 'b', ok: false, error: 'crashed' },
        { name: 'c', ok: true },
      ],
      null,
    );
    writeFileSync(join(dir, 'a.png'), solidPng(120, 80, [1, 2, 3]));
    const result = runDiff(
      { gallery: dir, baseline: baselinePath, screens: null },
      { log: () => {} },
    );
    const byName = Object.fromEntries(
      result.rows.map((r) => [r.name, r.status]),
    );
    expect(byName.a).toBe('changed');
    expect(byName.b).toBe('capture-failed');
    expect(byName.c).toBe('new');
    expect(result.exitCode).toBe(1);
    // `failing` deliberately covers every exit-driving status
    // (changed/capture-failed/missing-from-gallery), not only visual
    // regressions — both 'a' (changed) and 'b' (capture-failed) belong here.
    expect(result.failing.map((r) => r.name).sort()).toEqual(['a', 'b']);
    expect(
      result.rows.filter((r) => r.status === 'changed').map((r) => r.name),
    ).toEqual(['a']);
  });

  it('a baseline-only screen missing from this capture is "missing-from-gallery" and fails the run', () => {
    dir = mkdtempSync(join(tmpdir(), 'screenshot-diff-'));
    const baselinePath = join(dir, 'baseline.json');
    writeCapture(
      dir,
      [
        { name: 'a', ok: true },
        { name: 'b', ok: true },
      ],
      null,
    );
    runBaseline(
      { gallery: dir, baseline: baselinePath, allowPartial: false },
      { log: () => {} },
    );
    // A capture that never even mentions 'b' (e.g. it was retired from
    // SCREENS since the baseline was cut).
    writeCapture(dir, [{ name: 'a', ok: true }], null);
    const result = runDiff(
      { gallery: dir, baseline: baselinePath, screens: null },
      { log: () => {} },
    );
    const row = result.rows.find((r) => r.name === 'b');
    expect(row?.status).toBe('missing-from-gallery');
    expect(result.exitCode).toBe(1);
  });

  it('an all-volatile scope is a vacuous-OK refusal (exit 1) — the row itself still reads skipped-volatile, not changed/capture-failed', () => {
    dir = mkdtempSync(join(tmpdir(), 'screenshot-diff-'));
    const baselinePath = join(dir, 'baseline.json');
    writeFileSync(
      baselinePath,
      JSON.stringify({
        schemaVersion: 2,
        screens: [{ name: 'v', volatile: true, reason: 'flaky rendering' }],
      }),
    );
    writeCapture(dir, [{ name: 'v', ok: true }], null);
    const result = runDiff(
      { gallery: dir, baseline: baselinePath, screens: null },
      { log: () => {} },
    );
    // The row's own status is unaffected: it is still named loudly as
    // 'skipped-volatile', never folded into 'changed'/'capture-failed'.
    expect(result.rows).toEqual([
      {
        name: 'v',
        status: 'skipped-volatile',
        detail: 'flaky rendering',
      },
    ]);
    expect(result.comparisons).toBe(0);
    // But zero actual comparisons happened anywhere in scope, so the RUN
    // as a whole refuses rather than reporting a vacuous OK (station#4464
    // review finding: this used to exit 0).
    expect(result.exitCode).toBe(1);
    expect(result.failing).toEqual([]);
  });

  it('a vacuous (zero-comparison) diff is refused even with no failing rows: all-new scope', () => {
    dir = mkdtempSync(join(tmpdir(), 'screenshot-diff-'));
    const baselinePath = join(dir, 'baseline.json');
    // An empty baseline — e.g. a mishandled merge conflict, or a REPLACE
    // written from an empty capture — makes every screen read as 'new'.
    writeFileSync(
      baselinePath,
      JSON.stringify({ schemaVersion: 2, screens: [] }),
    );
    writeCapture(
      dir,
      [
        { name: 'a', ok: true },
        { name: 'b', ok: true },
      ],
      null,
    );
    const result = runDiff(
      { gallery: dir, baseline: baselinePath, screens: null },
      { log: () => {} },
    );
    expect(result.rows.every((r) => r.status === 'new')).toBe(true);
    expect(result.comparisons).toBe(0);
    expect(result.exitCode).toBe(1);
  });

  it('a genuinely empty scope (nothing to compare anywhere) stays OK — there is nothing to have silently skipped', () => {
    dir = mkdtempSync(join(tmpdir(), 'screenshot-diff-'));
    const baselinePath = join(dir, 'baseline.json');
    writeFileSync(
      baselinePath,
      JSON.stringify({ schemaVersion: 2, screens: [] }),
    );
    writeCapture(dir, [], null);
    const result = runDiff(
      { gallery: dir, baseline: baselinePath, screens: null },
      { log: () => {} },
    );
    expect(result.rows).toEqual([]);
    expect(result.comparisons).toBe(0);
    expect(result.exitCode).toBe(0);
  });

  it('a mix of at least one real comparison alongside new/volatile rows still reports OK', () => {
    dir = mkdtempSync(join(tmpdir(), 'screenshot-diff-'));
    const baselinePath = join(dir, 'baseline.json');
    writeCapture(dir, [{ name: 'a', ok: true }], null);
    runBaseline(
      { gallery: dir, baseline: baselinePath, allowPartial: false },
      { log: () => {} },
    );
    // 'a' has a real baseline entry (a real comparison); 'c' is new.
    writeCapture(
      dir,
      [
        { name: 'a', ok: true },
        { name: 'c', ok: true },
      ],
      null,
    );
    const result = runDiff(
      { gallery: dir, baseline: baselinePath, screens: null },
      { log: () => {} },
    );
    expect(result.comparisons).toBe(1);
    expect(result.exitCode).toBe(0);
  });

  it('--screens validity is CAPTURE membership, not a union with the baseline', () => {
    dir = mkdtempSync(join(tmpdir(), 'screenshot-diff-'));
    const baselinePath = join(dir, 'baseline.json');
    // Baseline knows about 'a' and 'z'; capture only ever produced 'a'.
    writeCapture(
      dir,
      [
        { name: 'a', ok: true },
        { name: 'z', ok: true },
      ],
      null,
    );
    runBaseline(
      { gallery: dir, baseline: baselinePath, allowPartial: false },
      { log: () => {} },
    );
    writeCapture(dir, [{ name: 'a', ok: true }], null);

    // 'z' is a real, valid baseline name — but it is NOT in this run's
    // capture, so requesting it must fail loudly (exit path), not silently
    // resolve to a "missing-from-gallery" exit-0 row (the bug the arbiter
    // caught in the original union-based check).
    expect(() =>
      runDiff(
        { gallery: dir, baseline: baselinePath, screens: ['z'] },
        { log: () => {} },
      ),
    ).toThrow(/unknown screen/i);
  });

  it('--screens scopes the comparison to exactly the requested names', () => {
    dir = mkdtempSync(join(tmpdir(), 'screenshot-diff-'));
    const baselinePath = join(dir, 'baseline.json');
    writeCapture(
      dir,
      [
        { name: 'a', ok: true },
        { name: 'b', ok: true },
      ],
      null,
    );
    runBaseline(
      { gallery: dir, baseline: baselinePath, allowPartial: false },
      { log: () => {} },
    );
    writeCapture(
      dir,
      [
        { name: 'a', ok: true },
        { name: 'b', ok: true },
      ],
      null,
    );
    const result = runDiff(
      { gallery: dir, baseline: baselinePath, screens: ['a'] },
      { log: () => {} },
    );
    expect(result.rows.map((r) => r.name)).toEqual(['a']);
  });

  it('refuses an UNSCOPED diff over a partial gallery', () => {
    dir = mkdtempSync(join(tmpdir(), 'screenshot-diff-'));
    const baselinePath = join(dir, 'baseline.json');
    writeCapture(
      dir,
      [
        { name: 'a', ok: true },
        { name: 'b', ok: true },
      ],
      null,
    );
    runBaseline(
      { gallery: dir, baseline: baselinePath, allowPartial: false },
      { log: () => {} },
    );
    // A targeted rerun of only 'a' — selection is non-null.
    writeCapture(dir, [{ name: 'a', ok: true }], ['a']);
    expect(() =>
      runDiff(
        { gallery: dir, baseline: baselinePath, screens: null },
        { log: () => {} },
      ),
    ).toThrow(/partial gallery/i);
    // A SCOPED diff over that same partial gallery remains legitimate.
    const scoped = runDiff(
      { gallery: dir, baseline: baselinePath, screens: ['a'] },
      { log: () => {} },
    );
    expect(scoped.exitCode).toBe(0);
  });

  it('a corrupt (non-hex, wrong-length) baseline sha256 throws rather than ever comparing as a match', () => {
    dir = mkdtempSync(join(tmpdir(), 'screenshot-diff-'));
    const baselinePath = join(dir, 'baseline.json');
    writeFileSync(
      baselinePath,
      JSON.stringify({
        schemaVersion: 2,
        screens: [{ name: 'a', width: 120, height: 80, sha256: 'not-hex' }],
      }),
    );
    writeCapture(dir, [{ name: 'a', ok: true }], null);
    expect(() =>
      runDiff(
        { gallery: dir, baseline: baselinePath, screens: null },
        { log: () => {} },
      ),
    ).toThrow(/corrupt or missing sha256/);
  });
});

describe('screenshot-diff.mjs as a real child process (exit codes)', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function seed() {
    // realpathSync: macOS symlinks /tmp -> /private/tmp, and the
    // pathToFileURL(resolve(argv[1])) guard compares against
    // import.meta.url, which the module loader resolves through symlinks —
    // an un-realpath'd /tmp path would make the spaced-path test below
    // exercise that mismatch instead of the space-encoding fix it targets.
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'screenshot-diff-cli-')));
    const galleryDir = join(dir, 'gallery');
    mkdirSync(galleryDir, { recursive: true });
    writeFileSync(join(galleryDir, 'a.png'), solidPng(60, 40, [10, 20, 30]));
    writeFileSync(join(galleryDir, 'b.png'), solidPng(60, 40, [200, 10, 10]));
    writeFileSync(
      join(galleryDir, 'capture.json'),
      JSON.stringify({
        schemaVersion: 1,
        runId: null,
        capturedAt: '2026-01-01T00:00:00.000Z',
        selection: null,
        screens: [
          { file: 'a.png', ok: true, name: 'a', error: null },
          { file: 'b.png', ok: true, name: 'b', error: null },
        ],
      }),
    );
    const baselinePath = join(dir, 'tests', 'screenshots.baseline.json');
    return { galleryDir, baselinePath };
  }

  it('baseline mode exits 0 and writes the manifest', () => {
    const { galleryDir, baselinePath } = seed();
    const result = runScript(
      ['baseline', `--gallery=${galleryDir}`, `--out=${baselinePath}`],
      dir,
    );
    expect(result.status).toBe(0);
    const manifest = JSON.parse(readFileSync(baselinePath, 'utf8'));
    expect(manifest.screens).toHaveLength(2);
  });

  it('a clean diff exits 0', () => {
    const { galleryDir, baselinePath } = seed();
    runScript(
      ['baseline', `--gallery=${galleryDir}`, `--out=${baselinePath}`],
      dir,
    );
    const result = runScript(
      ['diff', `--gallery=${galleryDir}`, `--baseline=${baselinePath}`],
      dir,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/OK: 2\/2 compared/);
  });

  it('a real pixel change exits 1 and names the screen', () => {
    const { galleryDir, baselinePath } = seed();
    runScript(
      ['baseline', `--gallery=${galleryDir}`, `--out=${baselinePath}`],
      dir,
    );
    writeFileSync(join(galleryDir, 'a.png'), solidPng(60, 40, [1, 1, 1]));
    const result = runScript(
      ['diff', `--gallery=${galleryDir}`, `--baseline=${baselinePath}`],
      dir,
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/FAILED \(1\): a/);
  });

  it('an --screens name absent from this capture exits 1 (not a silent exit-0 pass)', () => {
    const { galleryDir, baselinePath } = seed();
    runScript(
      ['baseline', `--gallery=${galleryDir}`, `--out=${baselinePath}`],
      dir,
    );
    const result = runScript(
      [
        'diff',
        `--gallery=${galleryDir}`,
        `--baseline=${baselinePath}`,
        '--screens=nonexistent',
      ],
      dir,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unknown screen/i);
  });

  it('an !ok screen exits 1 as a capture failure, never informational', () => {
    const { galleryDir, baselinePath } = seed();
    runScript(
      ['baseline', `--gallery=${galleryDir}`, `--out=${baselinePath}`],
      dir,
    );
    writeFileSync(
      join(galleryDir, 'capture.json'),
      JSON.stringify({
        schemaVersion: 1,
        runId: null,
        capturedAt: '2026-01-01T00:00:00.000Z',
        selection: null,
        screens: [
          { file: 'a.png', ok: true, name: 'a', error: null },
          { file: 'b.png', ok: false, name: 'b', error: 'browser crashed' },
        ],
      }),
    );
    const result = runScript(
      ['diff', `--gallery=${galleryDir}`, `--baseline=${baselinePath}`],
      dir,
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/capture-failed/);
    expect(result.stdout).toMatch(/FAILED \(1\): b/);
  });

  it('an unscoped diff over a partial gallery exits 1 with a clear refusal', () => {
    const { galleryDir, baselinePath } = seed();
    runScript(
      ['baseline', `--gallery=${galleryDir}`, `--out=${baselinePath}`],
      dir,
    );
    writeFileSync(
      join(galleryDir, 'capture.json'),
      JSON.stringify({
        schemaVersion: 1,
        runId: null,
        capturedAt: '2026-01-01T00:00:00.000Z',
        selection: ['a'],
        screens: [{ file: 'a.png', ok: true, name: 'a', error: null }],
      }),
    );
    const result = runScript(
      ['diff', `--gallery=${galleryDir}`, `--baseline=${baselinePath}`],
      dir,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/partial gallery/i);
  });

  it('a diff against an empty baseline is a vacuous-OK refusal, exit 1, not "OK: 0/0"', () => {
    const { galleryDir, baselinePath } = seed();
    mkdirSync(join(baselinePath, '..'), { recursive: true });
    writeFileSync(
      baselinePath,
      JSON.stringify({ schemaVersion: 2, screens: [] }),
    );
    const result = runScript(
      ['diff', `--gallery=${galleryDir}`, `--baseline=${baselinePath}`],
      dir,
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/REFUSED/);
    expect(result.stdout).not.toMatch(/OK: 0\/0/);
  });

  it('a near-empty REPLACE is refused without --force-replace and allowed with it', () => {
    const { galleryDir, baselinePath } = seed();
    // Extend the seeded 2-screen gallery to 4, so dropping to 1 is a real
    // more-than-half drop (not the exactly-half boundary).
    writeFileSync(join(galleryDir, 'c.png'), solidPng(60, 40, [10, 200, 10]));
    writeFileSync(join(galleryDir, 'd.png'), solidPng(60, 40, [10, 10, 200]));
    writeFileSync(
      join(galleryDir, 'capture.json'),
      JSON.stringify({
        schemaVersion: 1,
        runId: null,
        capturedAt: '2026-01-01T00:00:00.000Z',
        selection: null,
        screens: [
          { file: 'a.png', ok: true, name: 'a', error: null },
          { file: 'b.png', ok: true, name: 'b', error: null },
          { file: 'c.png', ok: true, name: 'c', error: null },
          { file: 'd.png', ok: true, name: 'd', error: null },
        ],
      }),
    );
    runScript(
      ['baseline', `--gallery=${galleryDir}`, `--out=${baselinePath}`],
      dir,
    );
    // A near-empty REPLACE capture — the realistic shape of a
    // baseline-conflict resolution that collapsed the manifest array.
    writeFileSync(
      join(galleryDir, 'capture.json'),
      JSON.stringify({
        schemaVersion: 1,
        runId: null,
        capturedAt: '2026-01-01T00:00:00.000Z',
        selection: null,
        screens: [{ file: 'a.png', ok: true, name: 'a', error: null }],
      }),
    );
    const refused = runScript(
      ['baseline', `--gallery=${galleryDir}`, `--out=${baselinePath}`],
      dir,
    );
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/more than half/);
    const untouched = JSON.parse(readFileSync(baselinePath, 'utf8'));
    expect(untouched.screens).toHaveLength(4);

    const forced = runScript(
      [
        'baseline',
        `--gallery=${galleryDir}`,
        `--out=${baselinePath}`,
        '--force-replace',
      ],
      dir,
    );
    expect(forced.status).toBe(0);
    const after = JSON.parse(readFileSync(baselinePath, 'utf8'));
    expect(after.screens).toHaveLength(1);
  });

  it('executes correctly from a path containing a space (pathToFileURL direct-run guard)', () => {
    const { galleryDir, baselinePath } = seed();
    runScript(
      ['baseline', `--gallery=${galleryDir}`, `--out=${baselinePath}`],
      dir,
    );
    const spacedDir = join(dir, 'a directory with spaces');
    mkdirSync(spacedDir, { recursive: true });
    const spacedScript = join(spacedDir, 'screenshot-diff.mjs');
    copyFileSync(SCRIPT_PATH, spacedScript);
    chmodSync(spacedScript, 0o755);
    // Node's ESM resolver walks up from the script looking for
    // `node_modules` to resolve its bare `pngjs` import — symlink the repo's
    // real one in so this copy resolves it from an isolated temp root.
    symlinkSync(
      resolve(import.meta.dirname, '../../node_modules'),
      join(spacedDir, 'node_modules'),
    );
    const stdout = execFileSync(
      'node',
      [
        spacedScript,
        'diff',
        `--gallery=${galleryDir}`,
        `--baseline=${baselinePath}`,
      ],
      { cwd: dir, encoding: 'utf8', windowsHide: true },
    );
    expect(stdout).toMatch(/OK: 2\/2 compared/);
  });
});
