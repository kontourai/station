#!/usr/bin/env node
/**
 * Coverage over the resource-profiled Vitest corpus.
 *
 * The previous lane ran `vitest run --coverage --maxWorkers=1` over the whole
 * ~2,900-file corpus in one process. It reached its 25-minute deadline after
 * 33 files with the host at load 4.4 of 12 CPUs (#2325): it could not finish
 * as designed, and the host was not the constraint.
 *
 * This runs the same slices `full:regression` runs (eight ordinary hash shards
 * at the ordinary worker bound, then each serialized resource group with its
 * own isolation rules) with coverage enabled. Each slice writes istanbul JSON
 * to `coverage/shards/<slice>/coverage-final.json`; the slices are then merged
 * and the configured thresholds are evaluated on the merged report only.
 *
 * Fail-closed rules:
 * - The expected slice list comes from the corpus plan, never from what is on
 *   disk. A missing, empty, unreadable, or malformed slice refuses the merge,
 *   and so does an unexpected directory (a stale or foreign slice).
 * - `coverage/` is removed before any slice runs, so a previous run's output
 *   can never stand in for a slice that did not produce one.
 * - A slice whose tests failed writes no report (Vitest's default
 *   `reportOnFailure: false`), so it is also reported missing.
 * - Thresholds are read from the resolved Vitest config and must declare all
 *   four metrics. A merged report with nothing measured is refused rather than
 *   read as 100%.
 */
import { rmSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerProcessSignal } from './lib/owned-process.mjs';
import { corpusDescriptors, runVitestCorpus } from './run-vitest-corpus.mjs';

export const COVERAGE_OUTPUT_DIRECTORY = 'coverage';
export const COVERAGE_SHARD_DIRECTORY = 'coverage/shards';
export const COVERAGE_SHARD_REPORT = 'coverage-final.json';
export const COVERAGE_METRICS = Object.freeze([
  'lines',
  'statements',
  'functions',
  'branches',
]);
/**
 * Each slice's deadline is its canonical full-regression phase deadline times
 * this factor. V8 coverage slows execution and each slice converts every
 * included source file to istanbul form at the end. These are per-slice
 * fences against a wedged slice, not the lane's budget: the coordinated
 * `test-coverage` lane deadline bounds the whole run.
 */
export const COVERAGE_SLICE_TIMEOUT_SCALE = 1.5;

// istanbul is not a direct dependency. Resolve it through the declared
// `@vitest/coverage-v8`, which is the version that wrote the slice reports.
function istanbul() {
  const require = createRequire(import.meta.url);
  const fromCoverage = createRequire(
    require.resolve('@vitest/coverage-v8/package.json'),
  );
  return {
    libCoverage: fromCoverage('istanbul-lib-coverage'),
    libReport: fromCoverage('istanbul-lib-report'),
    reports: fromCoverage('istanbul-reports'),
  };
}

/**
 * Slice ids in plan order; every one must produce a report.
 * @param {ReadonlyArray<{ name: string; resultName?: string }>} [descriptors]
 * @returns {readonly string[]}
 */
export function coverageShardIds(descriptors = corpusDescriptors()) {
  const ids = descriptors.map(
    (descriptor) => descriptor.resultName ?? descriptor.name,
  );
  if (ids.length === 0) throw new Error('coverage plan has no slices');
  if (new Set(ids).size !== ids.length)
    throw new Error('coverage plan names a slice more than once');
  return Object.freeze(ids);
}

export class CoverageMergeRefused extends Error {
  constructor(problems) {
    super(
      `coverage merge refused: ${problems.length} problem(s)\n${problems
        .map((problem) => `  - ${problem}`)
        .join('\n')}`,
    );
    this.name = 'CoverageMergeRefused';
    this.problems = problems;
  }
}

const FILE_COVERAGE_KEYS = [
  'path',
  'statementMap',
  's',
  'fnMap',
  'f',
  'branchMap',
  'b',
];

function shardShapeProblem(id, data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data))
    return `slice ${id}: report is not an istanbul coverage object`;
  const entries = Object.entries(data);
  if (entries.length === 0) return `slice ${id}: report is empty`;
  for (const [file, coverage] of entries) {
    const missing = FILE_COVERAGE_KEYS.filter(
      (key) =>
        coverage === null ||
        typeof coverage !== 'object' ||
        coverage[key] === undefined,
    );
    if (missing.length > 0)
      return `slice ${id}: entry ${file} lacks ${missing.join(', ')}`;
  }
  return null;
}

/** One slice's parsed report, or the reason it cannot be merged. */
async function readShardReport(shardRoot, id) {
  const path = join(shardRoot, id, COVERAGE_SHARD_REPORT);
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    return {
      problem:
        error?.code === 'ENOENT'
          ? `slice ${id}: missing ${path}`
          : `slice ${id}: unreadable ${path}: ${error?.message ?? error}`,
    };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { problem: `slice ${id}: invalid JSON: ${error?.message ?? error}` };
  }
  const problem = shardShapeProblem(id, data);
  return problem ? { problem } : { data };
}

/**
 * Validate and merge every expected slice; hit counts add across slices.
 * Slices are merged one at a time (each is tens of megabytes), and every
 * problem is collected before refusing, so one run names all the slices it is
 * missing rather than the first.
 */
export async function mergeCoverageShards(
  { shardRoot, shardIds },
  { libCoverage } = istanbul(),
) {
  if (!Array.isArray(shardIds) || shardIds.length === 0)
    throw new CoverageMergeRefused(['no slices expected']);
  const problems = [];
  let present = [];
  try {
    present = (await readdir(shardRoot, { withFileTypes: true })).map(
      (entry) => entry.name,
    );
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  for (const name of present.filter((entry) => !shardIds.includes(entry)))
    problems.push(`unexpected entry ${name}: not a slice of this plan`);
  const map = libCoverage.createCoverageMap({});
  for (const id of shardIds) {
    const shard = await readShardReport(shardRoot, id);
    if (shard.problem) problems.push(shard.problem);
    else if (problems.length === 0) map.merge(shard.data);
  }
  if (problems.length > 0) throw new CoverageMergeRefused(problems);
  return map;
}

export function validateCoverageThresholds(thresholds) {
  const missing = COVERAGE_METRICS.filter(
    (metric) =>
      typeof thresholds?.[metric] !== 'number' ||
      !Number.isFinite(thresholds[metric]) ||
      thresholds[metric] < 0 ||
      thresholds[metric] > 100,
  );
  if (missing.length > 0)
    throw new Error(
      `coverage thresholds must declare a percentage for ${missing.join(', ')}`,
    );
  return Object.freeze(
    Object.fromEntries(
      COVERAGE_METRICS.map((metric) => [metric, thresholds[metric]]),
    ),
  );
}

/** The thresholds the repository's Vitest config declares. */
export async function loadCoverageThresholds({ root = process.cwd() } = {}) {
  const { resolveConfig } = await import('vitest/node');
  const { vitestConfig } = await resolveConfig({}, { root });
  return validateCoverageThresholds(vitestConfig.coverage?.thresholds);
}

/**
 * Compare the merged summary with each threshold. A summary that measured
 * nothing is a failure: istanbul reports 0 of 0 as 100%.
 */
export function evaluateCoverageThresholds(summary, thresholds) {
  const checked = validateCoverageThresholds(thresholds);
  const failures = [];
  const results = COVERAGE_METRICS.map((metric) => {
    const total = summary?.[metric]?.total;
    const pct = summary?.[metric]?.pct;
    const measured = Number.isFinite(total) && total > 0;
    const passed = measured && Number.isFinite(pct) && pct >= checked[metric];
    if (!measured)
      failures.push(`${metric}: nothing measured in the merged report`);
    else if (!passed)
      failures.push(
        `${metric}: ${pct}% does not meet the ${checked[metric]}% threshold`,
      );
    return { metric, pct, threshold: checked[metric], total, passed };
  });
  return { passed: failures.length === 0, results, failures };
}

/** Write the merged istanbul JSON, the JSON summary, and a text summary. */
export function writeMergedCoverageReports(
  map,
  directory,
  { libReport, reports } = istanbul(),
) {
  const context = libReport.createContext({ dir: directory, coverageMap: map });
  for (const name of ['json', 'json-summary', 'text-summary'])
    reports.create(name).execute(context);
}

/**
 * Merge already-produced shard reports and write the merged output, without
 * running any corpus. Shared by the serial local run below and by
 * `scripts/merge-coverage-shards.mjs`, the hosted merge job that downloads
 * shard reports uploaded by parallel `coverage-shard` matrix legs
 * (.github/workflows/ci-extended.yml, #2416) instead of running the corpus
 * itself. The same fail-closed rules apply either way: a missing, empty,
 * unreadable, or malformed slice refuses the merge.
 */
export async function mergeCoverageReports({
  outputDirectory,
  shardRoot,
  shardIds,
  log = (/** @type {string} */ line) => {
    process.stdout.write(`${line}\n`);
  },
}) {
  try {
    const map = await mergeCoverageShards({ shardRoot, shardIds });
    writeMergedCoverageReports(map, outputDirectory);
    return { mergeError: null, summary: map.getCoverageSummary().toJSON() };
  } catch (error) {
    const mergeError = error instanceof Error ? error.message : String(error);
    log(`[coverage-corpus] ${mergeError}`);
    return { mergeError, summary: null };
  }
}

/**
 * Run every slice with coverage, merge, then evaluate thresholds. Test
 * failures in one slice do not stop the others (their names are all worth
 * having from one run); cancellation and unsafe cleanup do.
 */
export async function runCoverageCorpus({
  root = process.cwd(),
  runCorpus = runVitestCorpus,
  loadThresholds = loadCoverageThresholds,
  signal,
  log = (/** @type {string} */ line) => {
    process.stdout.write(`${line}\n`);
  },
} = {}) {
  const outputDirectory = resolve(root, COVERAGE_OUTPUT_DIRECTORY);
  const shardRoot = resolve(root, COVERAGE_SHARD_DIRECTORY);
  const shardIds = coverageShardIds();
  // Read before any slice runs, so a config without thresholds costs nothing.
  const thresholds = await loadThresholds({ root });
  rmSync(outputDirectory, { recursive: true, force: true });

  const corpus = await runCorpus({
    root,
    signal,
    keepGoing: true,
    coverageRoot: shardRoot,
    timeoutScale: COVERAGE_SLICE_TIMEOUT_SCALE,
  });

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
    log(`[coverage-corpus] threshold: ${failure}`);
  const passed =
    corpus.passed && mergeError === null && thresholdResult?.passed === true;
  log(
    `[coverage-corpus] ${passed ? 'PASS' : 'FAIL'}: corpus ${corpus.passed ? 'passed' : 'failed'}; merge ${mergeError === null ? `of ${shardIds.length} slice(s) complete` : 'refused'}; thresholds ${thresholdResult ? (thresholdResult.passed ? 'met' : 'not met') : 'not evaluated'}`,
  );
  return {
    passed,
    corpus,
    mergeError,
    thresholds: thresholdResult,
  };
}

async function main() {
  const controller = new AbortController();
  const unregister = ['SIGINT', 'SIGTERM'].map((name) =>
    registerProcessSignal(name, () => controller.abort(name)),
  );
  try {
    if (process.argv.length > 2)
      throw new Error('usage: node scripts/run-coverage-corpus.mjs');
    const result = await runCoverageCorpus({ signal: controller.signal });
    process.exitCode = result.passed ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      `[coverage-corpus] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  } finally {
    for (const remove of unregister) remove();
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href)
  void main();
