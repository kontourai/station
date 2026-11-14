// A Vitest reporter that records, for the qualification failure manifest,
// exactly which tests failed (file and full title path), which test modules
// failed outside any test (a load or suite error), and how many unhandled
// errors the run saw. It writes one JSON file at the path named by
// STATION_VITEST_FAILURE_REPORT and nothing to the terminal, so it changes
// neither which tests run nor the run's output. The corpus runner reconciles
// these identities against Vitest's own JSON reporter counts.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, sep } from 'node:path';

export const FAILURE_REPORT_ENV = 'STATION_VITEST_FAILURE_REPORT';

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
  onTestRunEnd(testModules, unhandledErrors, reason) {
    const target = process.env[FAILURE_REPORT_ENV];
    if (!target) return;
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
}
