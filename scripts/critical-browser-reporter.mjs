import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { PR_BROWSER_SMOKE_CONTRACT } from '../tests/e2e-manifest.mjs';

/**
 * @param {{ journeys: Array<{path: string}>, requiredObservations: Array<{path: string, title: string}> }} contract
 * @param {{ before: {head: string, trackedDiffSha256: string, clean: boolean}, after: {head: string, trackedDiffSha256: string, clean: boolean}, expected?: string, requireClean?: boolean }} [identity]
 */
export function evaluateCriticalBrowserEvidence(
  observations,
  suiteStatus,
  contract = PR_BROWSER_SMOKE_CONTRACT,
  identity,
) {
  const missingFiles = contract.journeys
    .map((entry) => entry.path)
    .filter((path) => !observations.some((entry) => entry.file === path));
  const missingObservations = contract.requiredObservations.filter(
    (required) =>
      observations.filter(
        (entry) =>
          entry.file === required.path && entry.title === required.title,
      ).length !== 1,
  );
  const incomplete = observations.filter(
    (entry) =>
      entry.expectedStatus !== 'passed' ||
      entry.results.length !== 1 ||
      entry.results[0] !== 'passed',
  );
  const identityErrors = [];
  if (identity) {
    if (
      !/^[0-9a-f]{40}$/.test(identity.expected ?? '') ||
      identity.before?.head !== identity.expected
    )
      identityErrors.push(
        'expected source is missing or does not match the checkout',
      );
    if (JSON.stringify(identity.before) !== JSON.stringify(identity.after))
      identityErrors.push('source changed while the browser suite ran');
    if (identity.requireClean && !identity.after?.clean)
      identityErrors.push('CI checkout is not clean');
  }
  return {
    status:
      identityErrors.length || missingFiles.length || missingObservations.length
        ? 'NOT_VERIFIED'
        : suiteStatus !== 'passed' || incomplete.length
          ? 'FAIL'
          : 'PASS',
    identityErrors,
    missingFiles,
    missingObservations,
    incomplete,
  };
}

function sourceIdentity() {
  const options = {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  };
  const head = execFileSync('git', ['rev-parse', 'HEAD'], options).trim();
  const diff = execFileSync(
    'git',
    ['diff', '--no-ext-diff', 'HEAD', '--'],
    options,
  );
  const status = execFileSync(
    'git',
    ['status', '--porcelain', '--untracked-files=normal'],
    options,
  );
  return {
    head,
    trackedDiffSha256: createHash('sha256').update(diff).digest('hex'),
    clean: status.trim() === '',
  };
}

export default class CriticalBrowserReporter {
  onBegin(_config, suite) {
    this.suite = suite;
    this.source = sourceIdentity();
  }
  async onEnd(result) {
    const observations = this.suite.allTests().map((test) => ({
      file: relative(process.cwd(), test.location.file).replaceAll('\\', '/'),
      title: test.title,
      expectedStatus: test.expectedStatus,
      results: test.results.map((entry) => entry.status),
    }));
    const after = sourceIdentity();
    const expectedSource =
      process.env.STATION_REQUIRED_SOURCE_SHA ||
      process.env.GITHUB_SHA ||
      (!process.env.CI ? this.source.head : undefined);
    const verdict = evaluateCriticalBrowserEvidence(
      observations,
      result.status,
      PR_BROWSER_SMOKE_CONTRACT,
      {
        before: this.source,
        after,
        expected: expectedSource,
        requireClean: Boolean(process.env.CI),
      },
    );
    const receipt = {
      kind: 'station.critical-browser-evidence',
      observedAt: new Date().toISOString(),
      source: this.source,
      expectedSource,
      immutableSource: after.clean,
      ...verdict,
      observations,
    };
    const path = process.env.STATION_CRITICAL_BROWSER_REPORT;
    if (!path)
      throw new Error('Critical browser evidence output path is missing');
    mkdirSync(dirname(path), { recursive: true });
    receipt.screenshots = [];
    for (const test of this.suite.allTests()) {
      const width = /at (320|390|412)x844/.exec(test.title)?.[1];
      if (!width) continue;
      for (const attachment of test.results.flatMap(
        (entry) => entry.attachments,
      )) {
        if (
          attachment.name !== 'mobile-primary-context' ||
          !attachment.path ||
          attachment.contentType !== 'image/png'
        )
          continue;
        const scoped = relative(
          process.env.STATION_E2E_OUTPUT_DIR,
          attachment.path,
        );
        if (
          scoped.startsWith('..') ||
          !lstatSync(attachment.path).isFile() ||
          lstatSync(attachment.path).size > 1024 * 1024
        )
          continue;
        const destination = join(
          dirname(path),
          `${basename(path, '.json')}-${width}.png`,
        );
        copyFileSync(attachment.path, destination);
        receipt.screenshots.push(destination);
      }
    }
    writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(
      `Critical browser evidence: ${verdict.status} (${observations.length} observations); ${path}`,
    );
    return { status: verdict.status === 'PASS' ? result.status : 'failed' };
  }
}
