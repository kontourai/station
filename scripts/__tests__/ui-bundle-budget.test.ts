import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertBundleDependencyProvenance,
  evaluateBundleBudget,
  measureEntryBundle,
  shouldEnforceUiBundleBudget,
} from '../ui-bundle-budget.mjs';

describe('bundle dependency provenance', () => {
  const roots: string[] = [];
  afterEach(() => {
    while (roots.length > 0)
      rmSync(roots.pop()!, { recursive: true, force: true });
  });

  const root = () => {
    const value = mkdtempSync(join(tmpdir(), 'ui-bundle-provenance-'));
    roots.push(value);
    mkdirSync(join(value, 'packages/contracts'), { recursive: true });
    writeFileSync(
      join(value, 'package.json'),
      `${JSON.stringify({ name: 'bundle-fixture', workspaces: ['packages/contracts'] })}\n`,
    );
    writeFileSync(
      join(value, 'packages/contracts/package.json'),
      `${JSON.stringify({ name: '@kontourai/station-contracts', main: 'index.js' })}\n`,
    );
    writeFileSync(join(value, 'packages/contracts/index.js'), 'export {};\n');
    return value;
  };

  it('accepts a real node_modules whose contracts link resolves into this worktree', () => {
    const repo = root();
    mkdirSync(join(repo, 'node_modules/@kontourai'), { recursive: true });
    symlinkSync(
      join(repo, 'packages/contracts'),
      join(repo, 'node_modules/@kontourai/station-contracts'),
      'dir',
    );
    expect(assertBundleDependencyProvenance(repo)).toEqual({
      contractsPath: realpathSync(join(repo, 'packages/contracts')),
    });
  });

  it('rejects a node_modules directory symlinked from another worktree', () => {
    const repo = root();
    const foreign = root();
    mkdirSync(join(foreign, 'node_modules'), { recursive: true });
    symlinkSync(
      join(foreign, 'node_modules'),
      join(repo, 'node_modules'),
      'dir',
    );
    expect(() => assertBundleDependencyProvenance(repo)).toThrow(
      /node_modules must be a real directory owned by this worktree/u,
    );
  });

  it('rejects a contracts workspace link that resolves into another worktree', () => {
    const repo = root();
    const foreign = root();
    mkdirSync(join(repo, 'node_modules/@kontourai'), { recursive: true });
    symlinkSync(
      join(foreign, 'packages/contracts'),
      join(repo, 'node_modules/@kontourai/station-contracts'),
      'dir',
    );
    expect(() => assertBundleDependencyProvenance(repo)).toThrow(
      /rejected @kontourai\/station-contracts.*outside the active worktree/u,
    );
  });

  it('rejects a worktree whose own packages/contracts entry resolves outside it', () => {
    const repo = root();
    const foreign = root();
    rmSync(join(repo, 'packages/contracts'), { recursive: true });
    symlinkSync(
      join(foreign, 'packages/contracts'),
      join(repo, 'packages/contracts'),
      'dir',
    );
    mkdirSync(join(repo, 'node_modules/@kontourai'), { recursive: true });
    symlinkSync(
      join(repo, 'packages/contracts'),
      join(repo, 'node_modules/@kontourai/station-contracts'),
      'dir',
    );

    expect(() => assertBundleDependencyProvenance(repo)).toThrow(
      /declared workspace outside the active worktree/u,
    );
  });

  it('reports a stable repair when the installed contracts link is missing', () => {
    const repo = root();
    mkdirSync(join(repo, 'node_modules'), { recursive: true });
    expect(() => assertBundleDependencyProvenance(repo)).toThrow(
      /workspace dependency provenance is invalid.*Run npm ci in this worktree/u,
    );
  });
});

describe('initial UI bundle budget', () => {
  it('excludes only the explicit reference diagnostic build', () => {
    expect(shouldEnforceUiBundleBudget({})).toBe(true);
    expect(
      shouldEnforceUiBundleBudget({
        VITE_STATION_INTERACTIVE_WORKSPACE_PERFORMANCE: '1',
      }),
    ).toBe(false);
    expect(
      shouldEnforceUiBundleBudget({
        VITE_STATION_INTERACTIVE_WORKSPACE_PERFORMANCE: 'true',
      }),
    ).toBe(true);
  });

  it('passes within both budgets and fails a seeded entry breach', () => {
    const budget = { entryJsGzipBytes: 320, entryCssGzipBytes: 40 };
    expect(
      evaluateBundleBudget(
        { entryJsGzipBytes: 319, entryCssGzipBytes: 40 },
        budget,
      ),
    ).toEqual({ ok: true, failures: [] });

    const breached = evaluateBundleBudget(
      { entryJsGzipBytes: 321, entryCssGzipBytes: 40 },
      budget,
    );
    expect(breached.ok).toBe(false);
    expect(breached.failures[0]).toContain('entry JS gzip 321 exceeds 320');
  });
});

describe('measureEntryBundle (station#1218)', () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    while (temporaryRoots.length > 0) {
      const dir = temporaryRoots.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function stageOutputDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ui-bundle-budget-test-'));
    temporaryRoots.push(dir);
    return dir;
  }

  function writeAsset(dir: string, relPath: string, bytes: string): number {
    writeFileSync(join(dir, relPath), bytes);
    return gzipSync(Buffer.from(bytes)).byteLength;
  }

  // AC4: fixtures a built index.html with MULTIPLE scripts, MULTIPLE
  // stylesheets, and MULTIPLE modulepreloads, mirroring the #926 vite
  // 8/rolldown build that triggered this issue (44 eager modulepreload
  // chunks, 6 stylesheets). Asserts the gate sums every one of them, not
  // just the first. This must fail against the pre-fix implementation,
  // which used a non-global `String.match` and only ever captured the
  // first `<script src>` and first `<link rel="stylesheet">` — see the
  // red-output transcript pasted in the PR description.
  it('sums every eager script, stylesheet, and modulepreload asset, not just the first', () => {
    const dir = stageOutputDir();

    const entryJsBytes = writeAsset(dir, 'entry.js', 'x'.repeat(5000));
    const chunkABytes = writeAsset(dir, 'chunk-a.js', 'y'.repeat(3000));
    const chunkBBytes = writeAsset(dir, 'chunk-b.js', 'z'.repeat(2000));
    const mainCssBytes = writeAsset(dir, 'main.css', 'a'.repeat(1000));
    const vendorCssBytes = writeAsset(dir, 'vendor.css', 'b'.repeat(1500));

    writeFileSync(
      join(dir, 'index.html'),
      `<!DOCTYPE html>
<html>
  <head>
    <script type="module" crossorigin src="/entry.js"></script>
    <link rel="stylesheet" crossorigin href="/main.css">
    <link rel="stylesheet" crossorigin href="/vendor.css">
    <link rel="modulepreload" crossorigin href="/chunk-a.js">
    <link rel="modulepreload" crossorigin href="/chunk-b.js">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`,
    );

    const measured = measureEntryBundle(dir);

    expect(measured.entryJsGzipBytes).toBe(
      entryJsBytes + chunkABytes + chunkBBytes,
    );
    expect(measured.entryCssGzipBytes).toBe(mainCssBytes + vendorCssBytes);
    expect(measured.assetCount).toBe(5);
  });

  // AC1 dedup judgment call: the same chunk can be referenced both as a
  // <script src> and as a modulepreload (a real vite shape — the entry
  // script itself is sometimes also listed as a modulepreload target).
  // Its bytes must be counted once, not twice.
  it('deduplicates an asset referenced as both a script src and a modulepreload', () => {
    const dir = stageOutputDir();
    const entryJsBytes = writeAsset(dir, 'entry.js', 'x'.repeat(4000));
    const cssBytes = writeAsset(dir, 'main.css', 'a'.repeat(800));

    writeFileSync(
      join(dir, 'index.html'),
      `<!DOCTYPE html>
<html>
  <head>
    <script type="module" crossorigin src="/entry.js"></script>
    <link rel="modulepreload" crossorigin href="/entry.js">
    <link rel="stylesheet" crossorigin href="/main.css">
  </head>
  <body></body>
</html>`,
    );

    const measured = measureEntryBundle(dir);

    expect(measured.entryJsGzipBytes).toBe(entryJsBytes);
    expect(measured.entryCssGzipBytes).toBe(cssBytes);
    expect(measured.assetCount).toBe(2);
  });

  it('does not treat a commit-only index metadata change as JavaScript growth', () => {
    const dir = stageOutputDir();
    writeAsset(dir, 'entry.js', 'const product = "station";');
    writeAsset(dir, 'main.css', 'body { color: black; }');

    const renderIndex = (commit: string) => `<!DOCTYPE html>
<html>
  <head>
    <meta name="station-build-version" content="0.1.0">
    <meta name="station-build-commit" content="${commit}">
    <script type="module" src="/entry.js"></script>
    <link rel="stylesheet" href="/main.css">
  </head>
  <body></body>
</html>`;

    writeFileSync(join(dir, 'index.html'), renderIndex('1e676ad3'));
    const first = measureEntryBundle(dir);
    writeFileSync(join(dir, 'index.html'), renderIndex('e38fd265'));
    const second = measureEntryBundle(dir);

    expect(second).toEqual(first);
  });

  // AC1 gzip judgment call: per-file gzip summed, never concatenate-then-gzip.
  // A shared dictionary across concatenated sources compresses better than
  // any real browser transfer (each file is its own HTTP response/stream),
  // so this pins the two-file sum against the correct, worse-than-naive
  // number.
  it('gzips each file individually and sums, rather than concatenating then gzipping', () => {
    const dir = stageOutputDir();
    // Two files that compress very differently together than apart: highly
    // repetitive content shares almost nothing across the file boundary if
    // gzip'd separately, but would if concatenated first.
    const bytesA = writeAsset(dir, 'chunk-a.js', 'a'.repeat(10000));
    const bytesB = writeAsset(dir, 'chunk-b.js', 'a'.repeat(10000));

    writeFileSync(
      join(dir, 'index.html'),
      `<!DOCTYPE html>
<html>
  <head>
    <script type="module" crossorigin src="/chunk-a.js"></script>
    <link rel="modulepreload" crossorigin href="/chunk-b.js">
    <link rel="stylesheet" crossorigin href="/main.css">
  </head>
  <body></body>
</html>`,
    );
    writeAsset(dir, 'main.css', 'a'.repeat(100));

    const measured = measureEntryBundle(dir);
    const concatenatedGzip = gzipSync(
      Buffer.from('a'.repeat(10000) + 'a'.repeat(10000)),
    ).byteLength;

    expect(measured.entryJsGzipBytes).toBe(bytesA + bytesB);
    // The per-file sum must not equal (and here, must exceed) the
    // concatenate-then-gzip number, which is the trap AC1 explicitly rules
    // out.
    expect(measured.entryJsGzipBytes).toBeGreaterThan(concatenatedGzip);
  });

  // AC2: an asset graph shape the gate cannot interpret must fail loudly,
  // never silently measure a subset. Here the referenced script uses a
  // scheme this gate does not understand (an absolute external URL, not a
  // root-relative build output path) — the old code's `?.[1]` optional
  // chaining would have quietly produced `undefined` and only complained via
  // the misleading missing-entry-point message; the fix must throw
  // specifically because the graph shape is unexpected, not just because a
  // match is absent.
  it('fails loudly when a script reference is not a root-relative build path', () => {
    const dir = stageOutputDir();
    writeAsset(dir, 'main.css', 'a'.repeat(100));
    writeFileSync(
      join(dir, 'index.html'),
      `<!DOCTYPE html>
<html>
  <head>
    <script type="module" crossorigin src="https://cdn.example.com/entry.js"></script>
    <link rel="stylesheet" crossorigin href="/main.css">
  </head>
  <body></body>
</html>`,
    );

    expect(() => measureEntryBundle(dir)).toThrow(/not a root-relative path/);
  });

  // AC2: zero stylesheets is also an unparseable/unexpected graph shape (the
  // gate has always required at least one of each) and must fail rather than
  // measure JS alone and report a partial, misleadingly-green result.
  it('fails loudly when the built index.html has no stylesheet reference at all', () => {
    const dir = stageOutputDir();
    writeAsset(dir, 'entry.js', 'x'.repeat(1000));
    writeFileSync(
      join(dir, 'index.html'),
      `<!DOCTYPE html>
<html>
  <head>
    <script type="module" crossorigin src="/entry.js"></script>
  </head>
  <body></body>
</html>`,
    );

    expect(() => measureEntryBundle(dir)).toThrow(
      /at least one entry script and one stylesheet/,
    );
  });
});
