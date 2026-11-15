// A Vitest reporter that records, for the qualification failure manifest,
// exactly which tests failed (file and full title path), which test modules
// failed outside any test (a load or suite error), and how many unhandled
// errors the run saw. It writes one JSON file at the path the corpus runner
// passes as `--outputFile.stationFailures=<path>` and nothing to the terminal,
// so it changes neither which tests run nor the run's output. The path is a
// Vitest option rather than an environment variable so that test workers,
// which inherit Vitest's environment, never learn it. The corpus runner
// reconciles these identities against Vitest's own JSON reporter counts.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, sep } from 'node:path';

/** The `outputFile` key that names this reporter's target. */
export const FAILURE_REPORT_OUTPUT_KEY = 'stationFailures';

function repoPath(moduleId) {
  return relative(process.cwd(), moduleId).split(sep).join('/');
}

function titlePath(test) {
  const titles = [test.name];
  for (
    let parent = test.parent;
    parent?.type === 'suite';
    parent = parent.parent
  )
    titles.unshift(parent.name);
  return titles;
}

function* suitesOf(collection) {
  for (const child of collection) {
    if (child.type !== 'suite') continue;
    yield child;
    yield* suitesOf(child.children);
  }
}

export default class VitestFailureReporter {
  /** @type {string | undefined} */
  target;

  onInit(vitest) {
    try {
      const value = vitest?.config?.outputFile?.[FAILURE_REPORT_OUTPUT_KEY];
      this.target =
        typeof value === 'string' && value !== '' ? value : undefined;
    } catch {
      this.target = undefined;
    }
  }

  // A throw from a reporter changes Vitest's exit status, so nothing here
  // may escape: on any failure it records only that it failed, which the
  // corpus runner turns into an unexplained manifest entry.
  onTestRunEnd(testModules, unhandledErrors, reason) {
    const target = this.target;
    if (!target) return;
    try {
      writeReport(target, testModules, unhandledErrors, reason);
    } catch (error) {
      try {
        writeFileSync(
          target,
          `${JSON.stringify({
            schemaVersion: 1,
            reporterError: String(
              error instanceof Error ? error.message : error,
            ).slice(0, 2_000),
          })}\n`,
        );
      } catch {}
    }
  }
}

function writeReport(target, testModules, unhandledErrors, reason) {
  const failedTests = [];
  const failedFiles = [];
  for (const module of testModules) {
    const file = repoPath(module.moduleId);
    let tests = 0;
    for (const test of module.children.allTests()) {
      tests += 1;
      if (test.result().state === 'failed')
        failedTests.push({ file, titlePath: titlePath(test) });
    }
    if (module.errors().length > 0)
      failedFiles.push({ file, reason: tests === 0 ? 'load' : 'suite' });
    else if (
      [...suitesOf(module.children)].some((suite) => suite.errors().length)
    )
      failedFiles.push({ file, reason: 'suite' });
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(
    target,
    `${JSON.stringify({
      schemaVersion: 1,
      reason: String(reason ?? 'unknown'),
      failedTests,
      failedFiles,
      unhandledErrors: unhandledErrors.length,
    })}\n`,
  );
}
