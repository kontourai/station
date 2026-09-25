#!/usr/bin/env node
/**
 * Hosted merge job entry point for the parallel coverage lane
 * (.github/workflows/ci-extended.yml, #2416).
 *
 * The coverage corpus needs nothing from the physical fleet host, so each
 * corpus slice (`coverageShardIds()` in run-coverage-corpus.mjs) now runs in
 * its own hosted `coverage-shard` matrix job via:
 *
 *   node scripts/run-vitest-corpus.mjs --group=<name> [--shard=<k>/<n>] \
 *     --coverage-root=coverage/shards
 *
 * and uploads its `coverage/shards/<slice>/coverage-final.json`. This script
 * is the `coverage-merge` job: it runs no tests of its own. The workflow
 * downloads every shard artifact and re-creates `coverage/shards/<slice>/`
 * before calling this script, which then applies the exact same fail-closed
 * rules the previous serial lane applied to a live run:
 *
 * - The expected slice list comes from the corpus plan
 *   (`coverageShardIds()`), never from what is on disk.
 * - A missing, empty, unreadable, or malformed slice refuses the merge. A
 *   slice job whose tests failed wrote no report (Vitest's default
 *   `reportOnFailure: false`) and looks identical, on disk, to a slice job
 *   that never ran at all -- both are reported missing.
 * - Thresholds are evaluated on the merged report only, and are read from
 *   the resolved Vitest config; a merged report with nothing measured is
 *   refused rather than read as 100%.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  COVERAGE_OUTPUT_DIRECTORY,
  COVERAGE_SHARD_DIRECTORY,
  coverageShardIds,
  evaluateCoverageThresholds,
  loadCoverageThresholds,
  mergeCoverageReports,
} from './run-coverage-corpus.mjs';

export async function mergeCoverageCorpus({
  root = process.cwd(),
  loadThresholds = loadCoverageThresholds,
  log = (/** @type {string} */ line) => {
    process.stdout.write(`${line}\n`);
  },
} = {}) {
  const outputDirectory = resolve(root, COVERAGE_OUTPUT_DIRECTORY);
  const shardRoot = resolve(root, COVERAGE_SHARD_DIRECTORY);
  const shardIds = coverageShardIds();
  const thresholds = await loadThresholds({ root });
  const { mergeError, summary } = await mergeCoverageReports({
    outputDirectory,
    shardRoot,
    shardIds,
    log,
  });
  const thresholdResult = summary
    ? evaluateCoverageThresholds(summary, thresholds)
    : null;
  for (const failure of thresholdResult?.failures ?? [])
    log(`[coverage-merge] threshold: ${failure}`);
  const passed = mergeError === null && thresholdResult?.passed === true;
  log(
    `[coverage-merge] ${passed ? 'PASS' : 'FAIL'}: merge ${mergeError === null ? `of ${shardIds.length} slice(s) complete` : 'refused'}; thresholds ${thresholdResult ? (thresholdResult.passed ? 'met' : 'not met') : 'not evaluated'}`,
  );
  return { passed, mergeError, thresholds: thresholdResult };
}

async function main() {
  if (process.argv.length > 2)
    throw new Error('usage: node scripts/merge-coverage-shards.mjs');
  const result = await mergeCoverageCorpus();
  process.exitCode = result.passed ? 0 : 1;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  main().catch((error) => {
    process.stderr.write(
      `[coverage-merge] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  });
}
