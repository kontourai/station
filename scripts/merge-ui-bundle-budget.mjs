#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertBundleDependencyProvenance,
  measureEntryBundle,
} from './ui-bundle-budget.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Git supplies ancestor/current/other/marker-size/path as %O %A %B %L %P.
 * Per gitattributes(5), a successful custom driver must overwrite %A, so only
 * oursPath is the output below; the other arguments are retained and validated
 * to keep the configured five-placeholder contract explicit.
 *
 * This deliberately performs a clean UI build during a merge. That is slow,
 * but the ceiling is exact-to-actual and caching could silently reuse a stale
 * measurement. If building or measuring fails, %A is never touched: Git keeps
 * the conflict for a human, who can build and write the measured numbers.
 */
export function runUiBundleBudgetMergeDriver(
  { ancestorPath, oursPath, theirsPath, markerSize, mergedPath },
  {
    root = packageRoot,
    build = ({ outputSetting }) =>
      execFileSync('npm', ['run', 'build:ui'], {
        cwd: root,
        env: {
          ...process.env,
          // vite.config.ts resolves this setting from src-ui/ back to the
          // repository root, so it must be root-relative rather than absolute.
          STATION_BUILD_UI_DIR: outputSetting,
          STATION_UI_BUNDLE_BUDGET: 'observe',
        },
        stdio: 'inherit',
        windowsHide: true,
      }),
    measure = measureEntryBundle,
    verifyDependencies = assertBundleDependencyProvenance,
    write = writeFileSync,
  } = {},
) {
  if (
    !ancestorPath ||
    !oursPath ||
    !theirsPath ||
    !/^\d+$/.test(markerSize) ||
    !mergedPath
  ) {
    throw new Error(
      'expected merge-driver arguments: <ancestor %O> <ours %A> <theirs %B> <marker-size %L> <path %P>',
    );
  }

  const outputDir = mkdtempSync(join(root, 'dist-ui-merge-'));
  try {
    verifyDependencies(root);
    build({ outputDir, outputSetting: relative(root, outputDir) });
    const measured = measure(outputDir);
    const budget = {
      entryJsGzipBytes: measured.entryJsGzipBytes,
      entryCssGzipBytes: measured.entryCssGzipBytes,
    };
    write(oursPath, `${JSON.stringify(budget, null, 2)}\n`, 'utf8');
    console.log(
      `[merge-ui-bundle-budget] ${mergedPath}: measured JS ${budget.entryJsGzipBytes}, CSS ${budget.entryCssGzipBytes} gzip bytes`,
    );
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [ancestorPath, oursPath, theirsPath, markerSize, mergedPath] =
    process.argv.slice(2);
  try {
    runUiBundleBudgetMergeDriver({
      ancestorPath,
      oursPath,
      theirsPath,
      markerSize,
      mergedPath,
    });
  } catch (error) {
    console.error(
      `[merge-ui-bundle-budget] re-measurement failed; conflict left unresolved: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
