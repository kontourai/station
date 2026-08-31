import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertBundleDependencyProvenance,
  evaluateBundleBudget,
  measureEntryBundle,
  normalizeViteContentHashEntropy,
  shouldEnforceUiBundleBudget,
} from '../ui-bundle-budget.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const mergeDriver = join(repositoryRoot, 'scripts/merge-ui-bundle-budget.mjs');

describe('UI bundle budget merge-driver entry point', () => {
  const fixtures: string[] = [];
  afterEach(() => {
    while (fixtures.length > 0)
      rmSync(fixtures.pop()!, { recursive: true, force: true });
  });

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'station-ui-budget-driver-test-'));
    fixtures.push(root);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const fakeNpmModule = join(bin, 'npm.mjs');
    writeFileSync(
      fakeNpmModule,
      [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "if (process.env.FAKE_BUILD_FAIL === '1') process.exit(42);",
        'const output = process.env.STATION_BUILD_UI_DIR;',
        "mkdirSync(join(output, 'assets'), { recursive: true });",
        'writeFileSync(join(output, \'index.html\'), \'<script src="/assets/entry.js"></script><link rel="stylesheet" href="/assets/entry.css">\');',
        "writeFileSync(join(output, 'assets/entry.js'), 'console.log(\"merged tree\");\\n');",
        "writeFileSync(join(output, 'assets/entry.css'), 'body { color: rebeccapurple; }\\n');",
      ].join('\n'),
    );
    const npm = join(bin, 'npm');
    writeFileSync(
      npm,
      `#!/bin/sh\nexec "${process.execPath}" "${fakeNpmModule}" "$@"\n`,
    );
    chmodSync(npm, 0o755);
    writeFileSync(
      join(bin, 'npm.cmd'),
      `@echo off\r\n"${process.execPath}" "${fakeNpmModule}" %*\r\n`,
    );
    const paths = {
      ancestor: join(root, 'ancestor.json'),
      ours: join(root, 'ours.json'),
      theirs: join(root, 'theirs.json'),
    };
    writeFileSync(
      paths.ancestor,
      '{"entryJsGzipBytes":1,"entryCssGzipBytes":1}\n',
    );
    writeFileSync(paths.ours, 'OURS MUST SURVIVE FAILURE\n');
    writeFileSync(
      paths.theirs,
      '{"entryJsGzipBytes":3,"entryCssGzipBytes":3}\n',
    );
    return { bin, paths };
  }

  function invoke(
    subject: ReturnType<typeof fixture>,
    extraEnv: Record<string, string> = {},
  ) {
    return spawnSync(
      process.execPath,
      [
        mergeDriver,
        subject.paths.ancestor,
        subject.paths.ours,
        subject.paths.theirs,
        '7',
        'scripts/ui-bundle-budget.json',
      ],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          ...extraEnv,
          PATH: `${subject.bin}${delimiter}${process.env.PATH ?? ''}`,
        },
        windowsHide: true,
      },
    );
  }

  it('overwrites %A with the freshly measured merged-tree values', () => {
    const subject = fixture();
    const result = invoke(subject);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(subject.paths.ours, 'utf8'))).toEqual({
      entryJsGzipBytes: gzipSync('console.log("merged tree");\n').byteLength,
      entryCssGzipBytes: gzipSync('body { color: rebeccapurple; }\n')
        .byteLength,
    });
  });

  it('exits non-zero after a failed build without writing %A', () => {
    const subject = fixture();
    const before = readFileSync(subject.paths.ours, 'utf8');
    const result = invoke(subject, { FAKE_BUILD_FAIL: '1' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      're-measurement failed; conflict left unresolved',
    );
    expect(readFileSync(subject.paths.ours, 'utf8')).toBe(before);
  });
});

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
  it('normalizes only Vite content-hash entropy while preserving reference length', () => {
    const first =
      'import("./WorkspacePaneHost-Ab12_cdE.js");url("./font-Z9yX8wV7.woff2")';
    const second =
      'import("./WorkspacePaneHost-qR45-Tu6.js");url("./font-a1B2c3D4.woff2")';

    expect(
      normalizeViteContentHashEntropy(first, ['Ab12_cdE', 'Z9yX8wV7']),
    ).toBe(normalizeViteContentHashEntropy(second, ['qR45-Tu6', 'a1B2c3D4']));
    expect(
      normalizeViteContentHashEntropy(first, ['Ab12_cdE', 'Z9yX8wV7']),
    ).toHaveLength(first.length);
    expect(normalizeViteContentHashEntropy('module-station.js', [])).toBe(
      'module-station.js',
    );
    expect(
      normalizeViteContentHashEntropy('fixture-deadbeef.js', ['unrelated']),
    ).toBe('fixture-deadbeef.js');
  });

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

  it('does not treat path-sensitive Vite hash churn as JavaScript growth', () => {
    const dir = stageOutputDir();
    writeAsset(
      dir,
      'entry.js',
      'import("./lazy-Ab12_cdE.js");import("./other-Ab12_cdE.js");',
    );
    writeAsset(dir, 'lazy-Ab12_cdE.js', 'export {};');
    writeAsset(dir, 'main.css', 'body { color: black; }');
    writeFileSync(
      join(dir, 'index.html'),
      '<script src="/entry.js"></script><link rel="stylesheet" href="/main.css">',
    );
    const first = measureEntryBundle(dir);

    writeAsset(
      dir,
      'entry.js',
      'import("./lazy-qR45-Tu6.js");import("./other-a1B2c3D4.js");',
    );
    writeAsset(dir, 'lazy-qR45-Tu6.js', 'export {};');
    writeAsset(dir, 'other-a1B2c3D4.js', 'export {};');
    const second = measureEntryBundle(dir);

    expect(second.entryJsGzipBytes).toBe(first.entryJsGzipBytes);
    expect(second.entryJsRawGzipBytes).not.toBe(first.entryJsRawGzipBytes);
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
