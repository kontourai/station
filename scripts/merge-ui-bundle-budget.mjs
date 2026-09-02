#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Git supplies ancestor/current/other/marker-size/path as %O %A %B %L %P.
 * Per gitattributes(5), a successful custom driver must overwrite %A, so only
 * oursPath is the output below; the other arguments are retained and validated
 * to keep the configured five-placeholder contract explicit.
 *
 * ## Why this driver does not build
 *
 * A merge driver runs while Git is still computing the merge. With the default
 * `ort` strategy the result is assembled in memory and the working tree is only
 * written once every path has been resolved — so at the moment this driver is
 * invoked, the working tree is the pre-merge HEAD ("ours") tree, and nothing
 * from the other side has landed yet. That was verified by instrumenting the
 * driver (station#1107): a marker file added on the incoming side was absent
 * from the working tree at driver time, and every "measured" number the old
 * build-in-driver design produced was byte-equal to the ours side's own
 * pre-merge value — a multi-minute build that resolved to take-ours under a
 * log line calling it the merged tree.
 *
 * The merged tree does not exist anywhere a driver can build it. So this
 * driver writes a PROVISIONAL resolution and says so: the higher of each field
 * across the two sides. That value can never be below either parent's measured
 * actual, and if the merged tree costs more than both parents combined the
 * pre-push `npm run build:ui` gate fails on the excess exactly as it would
 * have on any other stale number. The build after the merge is the measurement;
 * this is only what lets the merge complete without a human typing a number
 * they have not measured either.
 *
 * If either side is not the JSON shape the gate reads, %A is never touched:
 * Git keeps the conflict for a human.
 */
export const PROVISIONAL_NOTE =
  'provisional (max of both sides; a merge driver cannot see the merged tree) — ' +
  'run `npm run build:ui` after the merge and record what it measures';

const FIELDS = ['entryJsGzipBytes', 'entryCssGzipBytes'];

function readBudget(path, label) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `${label} side is not parseable JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const field of FIELDS) {
    const value = parsed?.[field];
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(
        `${label} side has no non-negative integer ${field} (got ${JSON.stringify(value)})`,
      );
    }
  }
  return parsed;
}

export function resolveProvisionalBudget(ours, theirs) {
  const budget = {};
  for (const field of FIELDS)
    budget[field] = Math.max(ours[field], theirs[field]);
  return budget;
}

export function runUiBundleBudgetMergeDriver(
  { ancestorPath, oursPath, theirsPath, markerSize, mergedPath },
  { write = writeFileSync, log = console.log } = {},
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

  const ours = readBudget(oursPath, 'ours');
  const theirs = readBudget(theirsPath, 'theirs');
  const budget = resolveProvisionalBudget(ours, theirs);
  write(oursPath, `${JSON.stringify(budget, null, 2)}\n`, 'utf8');
  log(
    `[merge-ui-bundle-budget] ${mergedPath}: JS ${budget.entryJsGzipBytes}, CSS ${budget.entryCssGzipBytes} gzip bytes — ${PROVISIONAL_NOTE}`,
  );
  return budget;
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
      `[merge-ui-bundle-budget] provisional resolution declined; conflict left unresolved: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
