// Builds a qualification failure-manifest group from a Playwright JSON
// report (the `json` reporter run-e2e-suite.mjs already writes). Test
// identities come from the report's suite tree; Playwright's own `stats`
// are the count they are reconciled against. Errors the report records
// outside any test (global setup or teardown, a spec that fails to load, an
// error "not a part of any test"), a worker that exited, and any failure of
// the e2e runner itself leave the group unexplained.
import { realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import {
  clipText,
  groupExplained,
  MANIFEST_BOUNDS,
} from './qualification-failure-manifest.mjs';

const WORKER_EXIT = /worker process exited unexpectedly/i;

function walk(suite, titles, visit) {
  const own =
    suite.file && suite.title === suite.file
      ? titles
      : [...titles, suite.title];
  for (const spec of suite.specs ?? []) visit(spec, own);
  for (const child of suite.suites ?? []) walk(child, own, visit);
}

/**
 * @param {unknown} report the parsed Playwright JSON report, or undefined
 * @param {{ group: string, exitStatus: number | null, runnerErrors?: { kind: string, message: string }[], cwd?: string, reportError?: string }} options
 */
export function playwrightGroup(
  report,
  { group, exitStatus, runnerErrors = [], cwd = process.cwd(), reportError },
) {
  const errors = [...runnerErrors];
  const fail = (kind, message) =>
    errors.push({ kind, message: clipText(message) });
  const failedTests = [];
  let workerExits = 0;
  // Playwright's rootDir is a real path; compare against the real cwd.
  let base = cwd;
  try {
    base = realpathSync(cwd);
  } catch {}
  if (reportError) fail('playwright-report-unreadable', reportError);
  const valid =
    report &&
    typeof report === 'object' &&
    Array.isArray(report.suites) &&
    report.stats &&
    typeof report.config?.rootDir === 'string';
  if (!reportError && !valid)
    fail(
      'playwright-report-invalid',
      'the Playwright JSON report has no suites, stats or rootDir',
    );
  if (valid) {
    for (const error of report.errors ?? [])
      fail('error-outside-tests', error?.message ?? String(error));
    for (const top of report.suites)
      walk(top, [], (spec, titles) => {
        for (const test of spec.tests ?? []) {
          for (const result of test.results ?? [])
            for (const error of [result.error, ...(result.errors ?? [])])
              if (WORKER_EXIT.test(error?.message ?? '')) workerExits += 1;
          if (test.status !== 'unexpected') continue;
          failedTests.push({
            file: relative(base, resolve(report.config.rootDir, spec.file))
              .split(sep)
              .join('/'),
            titlePath: [...titles, spec.title]
              .slice(0, MANIFEST_BOUNDS.titlePathDepth)
              .map(clipText),
            ...(test.projectName
              ? { project: clipText(test.projectName) }
              : {}),
          });
        }
      });
    if (workerExits > 0)
      fail(
        'worker-exited',
        `${workerExits} test result(s) report a worker that exited unexpectedly`,
      );
  }
  if (failedTests.length > MANIFEST_BOUNDS.failedTestsPerGroup)
    fail(
      'failed-tests-over-bound',
      `${failedTests.length} failed tests exceed the manifest bound`,
    );
  const entry = {
    group: clipText(group),
    exitStatus,
    signal: null,
    failedTests: failedTests.slice(0, MANIFEST_BOUNDS.failedTestsPerGroup),
    failedFiles: [],
    runnerErrors: errors.slice(0, MANIFEST_BOUNDS.runnerErrorsPerGroup),
    counts: {
      reporterFailedTests: Number.isSafeInteger(report?.stats?.unexpected)
        ? report.stats.unexpected
        : null,
      // Playwright reports no failed-file total; this is the distinct files
      // of its failed tests, so for Playwright only the test count is an
      // independent reconciliation.
      reporterFailedFiles: new Set(failedTests.map((test) => test.file)).size,
      unhandledErrors: Array.isArray(report?.errors)
        ? report.errors.length
        : null,
    },
    explained: false,
  };
  entry.explained = groupExplained(entry);
  return entry;
}
