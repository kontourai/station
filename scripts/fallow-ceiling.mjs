#!/usr/bin/env node
// Dead-code ceiling (docs/guides/code-quality.md#dead-code-ceiling).
//
//   node scripts/fallow-ceiling.mjs            check the tree against the ceiling
//   node scripts/fallow-ceiling.mjs --write    record the tree's counts as the new ceiling
//   node scripts/fallow-ceiling.mjs --report <fallow-dead-code.json>   check a saved report
//
// The ceiling is counts per fallow dead-code category plus the total, never
// file paths, symbols or line numbers, so moving or editing code that keeps
// its findings cannot fail it. A category fails only when its count grows
// past the recorded count plus headroom; the headroom absorbs findings that
// independently green pull requests add in the same merge-queue batch, so
// the next PR in the queue is not failed for someone else's growth.
//
// Exit status: 0 within the ceiling (or written); 1 a category or the total
// grew past its ceiling; 2 the analysis could not run or its report is
// malformed. A failed analysis is never read as zero findings.
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokedDirectly } from './lib/module-entry.mjs';

export const CEILING_FILE = 'scripts/fallow-dead-code-ceiling.json';
/** Fallow's dead-code exit status when it reports findings. */
const FINDINGS_EXIT = 1;
/** The merge queue builds up to three entries together (AGENTS.md). */
export const HEADROOM_MINIMUM = 3;
export const HEADROOM_FRACTION = 0.05;

/** Findings a category may add over its recorded count before it fails. */
export function headroom(recorded) {
  return Math.max(HEADROOM_MINIMUM, Math.ceil(recorded * HEADROOM_FRACTION));
}

/** The `fallow dead-code --format json` report this script understands. */
export const REPORT_KIND = 'dead-code';
export const REPORT_SCHEMA_VERSION = 10;
/**
 * The summary folds these finding arrays into one `unused_dependencies`
 * count; every other summary count names the array of the same key.
 */
const DEPENDENCY_ARRAYS = [
  'unused_dependencies',
  'unused_dev_dependencies',
  'unused_optional_dependencies',
];

/**
 * Per-category counts and the total from a fallow dead-code report. The
 * report must be the kind and schema version this script was written for,
 * every count must agree with its findings array, the total must be the sum
 * of the categories, and every category the ceiling records must be present:
 * an incomplete or different report is refused, never read as zero.
 * @param {any} report
 * @param {readonly string[]} [required] categories the ceiling records
 */
export function countsFromReport(report, required = []) {
  if (report?.kind !== REPORT_KIND)
    throw new Error(
      `the report is kind ${JSON.stringify(report?.kind)}, not ${REPORT_KIND}`,
    );
  if (report.schema_version !== REPORT_SCHEMA_VERSION)
    throw new Error(
      `the report has schema version ${JSON.stringify(report.schema_version)}; this script reads version ${REPORT_SCHEMA_VERSION}`,
    );
  const summary = report.summary;
  if (!summary || typeof summary !== 'object')
    throw new Error('the fallow report has no summary');
  const counts = {};
  for (const [category, value] of Object.entries(summary)) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`the fallow report has an invalid ${category} count`);
    counts[category] = value;
  }
  if (!Object.hasOwn(counts, 'total_issues'))
    throw new Error('the fallow report has no total_issues count');
  for (const category of required)
    if (!Object.hasOwn(counts, category))
      throw new Error(
        `the fallow report has no ${category} count, which the ceiling records`,
      );
  let sum = 0;
  for (const [category, count] of Object.entries(counts)) {
    if (category === 'total_issues') continue;
    sum += count;
    const arrays =
      category === 'unused_dependencies' ? DEPENDENCY_ARRAYS : [category];
    if (!arrays.some((key) => Array.isArray(report[key]))) continue;
    const listed = arrays.reduce(
      (total, key) =>
        total + (Array.isArray(report[key]) ? report[key].length : 0),
      0,
    );
    if (listed !== count)
      throw new Error(
        `the fallow report counts ${count} ${category} but lists ${listed}`,
      );
  }
  for (const [key, value] of Object.entries(report))
    if (
      Array.isArray(value) &&
      !DEPENDENCY_ARRAYS.includes(key) &&
      value.length &&
      key.startsWith('unused_') &&
      !Object.hasOwn(counts, key)
    )
      throw new Error(`the fallow report lists ${key} but has no count for it`);
  if (sum !== counts.total_issues)
    throw new Error(
      `the fallow report totals ${counts.total_issues} but its categories sum to ${sum}`,
    );
  return counts;
}

/**
 * Compare observed counts with the recorded ones. A category the ceiling
 * does not record (a new fallow category) is held at zero plus headroom.
 */
export function compareWithCeiling(observed, recorded) {
  const grown = [];
  const lowered = [];
  for (const [category, count] of Object.entries(observed)) {
    const base = recorded[category] ?? 0;
    const ceiling = base + headroom(base);
    if (count > ceiling)
      grown.push({ category, count, recorded: base, ceiling });
    else if (count < base) lowered.push({ category, count, recorded: base });
  }
  return { grown, lowered };
}

function fallowLauncher() {
  return fileURLToPath(import.meta.resolve('fallow/bin/fallow'));
}

/** Run fallow dead-code over the whole tree, without any baseline. */
export function analyzeDeadCode(root, { launcher = fallowLauncher() } = {}) {
  // Fallow writes only inside the project or the system temp directory.
  const directory = mkdtempSync(
    join(realpathSync(tmpdir()), 'fallow-ceiling-'),
  );
  try {
    const output = join(directory, 'dead-code.json');
    const result = spawnSync(
      process.execPath,
      [
        launcher,
        'dead-code',
        '--format',
        'json',
        '--quiet',
        '--output-file',
        output,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (result.error)
      throw new Error(`fallow did not run: ${result.error.message}`);
    if (result.status !== 0 && result.status !== FINDINGS_EXIT) {
      let reason = (result.stderr || result.stdout || '').trim().slice(0, 800);
      try {
        const refusal = JSON.parse(result.stdout);
        if (typeof refusal?.message === 'string') reason = refusal.message;
      } catch {
        // Not a JSON refusal; keep the raw text.
      }
      throw new Error(`fallow dead-code exited ${result.status}: ${reason}`);
    }
    return JSON.parse(readFileSync(output, 'utf8'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function fallowVersion(launcher) {
  const result = spawnSync(process.execPath, [launcher, '--version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  // The first line is the version; later lines name local cache paths.
  const version = /^fallow \S+/.exec(result.stdout ?? '');
  return result.status === 0 && version ? version[0] : 'unknown';
}

export function main(
  argv = process.argv.slice(2),
  { root = process.cwd() } = {},
) {
  const write = argv.includes('--write');
  const reportIndex = argv.indexOf('--report');
  const unknown = argv.filter(
    (arg, index) =>
      arg !== '--write' && arg !== '--report' && index !== reportIndex + 1,
  );
  if (unknown.length || (reportIndex >= 0 && !argv[reportIndex + 1]))
    throw new Error(
      'usage: fallow-ceiling.mjs [--write] [--report <fallow-dead-code.json>]',
    );
  const launcher = fallowLauncher();
  const report =
    reportIndex >= 0
      ? JSON.parse(readFileSync(resolve(root, argv[reportIndex + 1]), 'utf8'))
      : analyzeDeadCode(root, { launcher });
  const ceilingPath = resolve(root, CEILING_FILE);
  if (write) {
    const observed = countsFromReport(report);
    mkdirSync(dirname(ceilingPath), { recursive: true });
    writeFileSync(
      ceilingPath,
      `${JSON.stringify(
        {
          description:
            'Recorded fallow dead-code counts per category. A category fails when it exceeds its count plus max(3, 5%). Regenerate with npm run fallow:baseline; see docs/guides/code-quality.md#dead-code-ceiling.',
          fallow: fallowVersion(launcher),
          counts: Object.fromEntries(
            Object.entries(observed).filter(([, count]) => count > 0),
          ),
        },
        null,
        2,
      )}\n`,
    );
    console.log(
      `[fallow-ceiling] recorded ${observed.total_issues} dead-code findings in ${CEILING_FILE}`,
    );
    return 0;
  }
  const recorded = JSON.parse(readFileSync(ceilingPath, 'utf8'));
  if (!recorded?.counts || typeof recorded.counts !== 'object')
    throw new Error(`${CEILING_FILE} has no counts`);
  const observed = countsFromReport(report, Object.keys(recorded.counts));
  const { grown, lowered } = compareWithCeiling(observed, recorded.counts);
  for (const entry of grown)
    console.log(
      `[fallow-ceiling] GROWN ${entry.category}: ${entry.count} > ceiling ${entry.ceiling} (recorded ${entry.recorded} + headroom)`,
    );
  for (const entry of lowered)
    console.log(
      `[fallow-ceiling] lowered ${entry.category}: ${entry.count} < recorded ${entry.recorded}; record it with npm run fallow:baseline`,
    );
  console.log(
    `[fallow-ceiling] ${grown.length ? 'FAIL' : 'OK'}: ${observed.total_issues} dead-code findings; ceiling total ${(recorded.counts.total_issues ?? 0) + headroom(recorded.counts.total_issues ?? 0)}`,
  );
  return grown.length ? 1 : 0;
}

if (invokedDirectly(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(
      `fallow-ceiling: NOT_VERIFIED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 2;
  }
}
