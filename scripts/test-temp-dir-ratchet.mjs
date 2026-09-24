#!/usr/bin/env node
/**
 * Raw `mkdtemp` calls in test files may only decrease (#2421).
 *
 * Tests that `mkdtemp` into the per-user temp dir and remove the directory in
 * the test body, or not at all, leak it whenever that line is not reached. On
 * the dev host, where dozens of agent worktrees run the corpus, that reached
 * ~160k stale entries (~39 GB) and filled the disk.
 *
 * `trackTempDirs()` (src-server/__test-utils__/temp-dirs.ts) registers the
 * removal in a vitest hook when the tracker is created, so it runs on failure
 * too. This gate holds the number of raw `mkdtemp`/`mkdtempSync` calls per
 * test file at or below a checked-in baseline: a new raw call fails here, in
 * the file that adds it.
 *
 * Why a call-count ratchet and not a leak detector. A static "does this file
 * also call rm, or register an after-hook / finally" check was measured on
 * main at 4f2263d0d: it missed three of the six largest leakers named in
 * #2421 — task-graph-service.test.ts (a `finally` removed one harness
 * directory; 36 other calls had no cleanup), config.routes.test.ts (an
 * afterEach that removed a DIFFERENT directory) and provider-system.spec.ts
 * (an afterAll that removed only the LAST of one directory per test). A
 * presence check cannot tell which directory a cleanup removes, so it cannot
 * be the guard. A run-level check (diff the temp dir around a run) cannot
 * attribute entries on a host where other sessions write to the same
 * directory. Counting raw calls makes no claim about leaks at all; it routes
 * new code to the helper that removes in a hook.
 *
 * The baseline is per file, so a regression is attributed to the file that
 * made it. A count below its row is reported but does not fail: under a merge
 * queue, two changes that each lower the same row merge cleanly into a count
 * below both, and failing then would red whichever change gates next rather
 * than either author. `--update` records lower counts; it only lowers or
 * removes rows and refuses to raise one or add a file, so a rename or split of
 * a baselined file migrates it to trackTempDirs() instead.
 *
 * It sees `mkdtemp(` and `mkdtempSync(` calls by name. An aliased import
 * (`mkdtemp as mk`), `promisify(mkdtemp)` or passing the function by reference
 * are not counted: it steers authors to the helper, it is not a proof.
 *
 *   node scripts/test-temp-dir-ratchet.mjs [--update]
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const BASELINE_PATH = 'scripts/test-temp-dir-baseline.json';

export const SCAN_ROOTS = [
  'src-server',
  'src-shared',
  'src-ui',
  'packages',
  'scripts',
];

/** The same test-file shape `test-realtime-wait-gate.mjs` reads. */
const TEST_PATH = /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const CODE_PATH = /\.[cm]?[jt]sx?$/;

/**
 * Files that held raw calls when this gate was written and still do. If a
 * pathspec change drops one out of the scanned set the gate fails instead of
 * reporting green over a smaller tree (station#1559 class). One per root that
 * has any.
 */
export const SCOPE_SENTINELS = [
  'src-server/services/projects/__tests__/task-graph-service.dispatch-claim.test.ts',
  'packages/cli/src/__tests__/config.test.ts',
  'scripts/__tests__/sdk-error-message-ratchet.test.ts',
];

/** `mkdtemp(`, `mkdtempSync(`, `fs.mkdtemp(`, `fsp.mkdtemp (`. */
const RAW_CALL = /\bmkdtemp(?:Sync)?\s*\(/g;

export function listScannedFiles(cwd = process.cwd()) {
  // Tracked AND untracked-but-not-ignored: a brand-new test file is exactly
  // the case this gate exists for, and it is invisible to `git ls-files`
  // alone until it is committed.
  const output = execFileSync(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      ...SCAN_ROOTS,
    ],
    { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  );
  return [...new Set(output.split('\n'))]
    .filter((file) => CODE_PATH.test(file) && TEST_PATH.test(file))
    .sort();
}

/**
 * Raw calls in one source. Whole-line `//` and block-comment continuation
 * lines are skipped so prose that names the call does not count.
 */
export function countRawCalls(source) {
  let count = 0;
  for (const line of source.split('\n')) {
    const trimmed = line.trimStart();
    if (
      trimmed.startsWith('//') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('/*')
    ) {
      continue;
    }
    count += line.match(RAW_CALL)?.length ?? 0;
  }
  return count;
}

export function countFiles(files, read = (file) => readFileSync(file, 'utf8')) {
  const counts = {};
  for (const file of files) {
    let source;
    try {
      source = read(file);
    } catch (error) {
      // Listed by git but deleted in the working tree: nothing to count.
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    const count = countRawCalls(source);
    if (count > 0) counts[file] = count;
  }
  return counts;
}

export function evaluate(counts, files, baseline) {
  const allowed = baseline.files ?? {};
  const over = [];
  const under = [];
  for (const [file, count] of Object.entries(counts)) {
    const ceiling = allowed[file] ?? 0;
    if (count > ceiling) over.push({ file, count, ceiling });
  }
  for (const [file, ceiling] of Object.entries(allowed)) {
    const count = counts[file] ?? 0;
    if (count < ceiling) under.push({ file, count, ceiling });
  }
  const missingSentinels = SCOPE_SENTINELS.filter(
    (sentinel) => !files.includes(sentinel),
  );
  return {
    over,
    under,
    missingSentinels,
    total: Object.values(counts).reduce((sum, count) => sum + count, 0),
    ok: over.length === 0 && missingSentinels.length === 0,
  };
}

/** Lower-only: refuses any row that would rise or appear. */
export function lowerBaseline(counts, baseline) {
  const allowed = baseline.files ?? {};
  const refused = Object.entries(counts)
    .filter(([file, count]) => count > (allowed[file] ?? 0))
    .map(([file, count]) => ({ file, count, ceiling: allowed[file] ?? 0 }));
  if (refused.length > 0) return { ok: false, refused };
  const files = {};
  for (const file of Object.keys(allowed).sort()) {
    if (counts[file]) files[file] = counts[file];
  }
  return { ok: true, baseline: { ...baseline, files } };
}

function main(argv) {
  const files = listScannedFiles();
  const counts = countFiles(files);
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));

  if (argv.includes('--update')) {
    const lowered = lowerBaseline(counts, baseline);
    if (!lowered.ok) {
      console.error(
        'FAIL: --update only lowers the test temp-dir baseline; these files would rise:',
      );
      for (const row of lowered.refused) {
        console.error(`  ${row.file}: ${row.count} (baseline ${row.ceiling})`);
      }
      console.error(
        'Create the directories with trackTempDirs() from src-server/__test-utils__/temp-dirs.ts.',
      );
      return 1;
    }
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify(lowered.baseline, null, 2)}\n`,
    );
    console.log(`OK: wrote ${BASELINE_PATH}`);
    return 0;
  }

  const result = evaluate(counts, files, baseline);
  if (result.missingSentinels.length > 0) {
    console.error(
      `FAIL: test temp-dir ratchet scope lost these files: ${result.missingSentinels.join(', ')}`,
    );
    return 1;
  }
  if (result.over.length > 0) {
    console.error(
      'FAIL: raw mkdtemp calls in test files rose above the baseline (#2421):',
    );
    for (const row of result.over) {
      console.error(`  ${row.file}: ${row.count} (baseline ${row.ceiling})`);
    }
    console.error(
      'A raw mkdtemp is removed only if the test reaches its cleanup line, so a',
    );
    console.error(
      'failure leaks it into the shared temp dir. Use trackTempDirs() from',
    );
    console.error(
      'src-server/__test-utils__/temp-dirs.ts, which removes in an after-hook.',
    );
    return 1;
  }
  if (result.under.length > 0) {
    console.log(
      'NOTE: raw mkdtemp calls fell below the baseline; record the lower count with',
    );
    console.log('`node scripts/test-temp-dir-ratchet.mjs --update`:');
    for (const row of result.under) {
      console.log(`  ${row.file}: ${row.count} (baseline ${row.ceiling})`);
    }
  }
  console.log(
    `OK: ${result.total} raw mkdtemp calls across ${files.length} test files, at the baseline; new temp dirs use trackTempDirs().`,
  );
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(main(process.argv.slice(2)));
}
