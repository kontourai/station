#!/usr/bin/env node

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateProductLawManifest,
  formatProductLawReport,
  loadProductLawManifest,
  MAX_PRODUCT_LAW_RUNTIME_MS,
  PRODUCT_LAW_TIMEOUT_EXIT_CODE,
  productLawObservationTimeoutMs,
  renderProductLawSection,
  validateProductLawManifest,
} from './lib/product-laws.mjs';
import { buildFocusedVitestInvocation } from './run-focused-tests.mjs';

const ROOT = resolve(import.meta.dirname, '..');

/**
 * station#4132: the gate's EXIT CODE is the contract run-ci-fast consumes
 * (CI_FAST_INFRASTRUCTURE_EXIT_CODE) — exported and unit-tested because an
 * uncaught fault injection proved the inline mapping had no test power: the
 * classification was tested, the exit line was not, and a misclassified
 * timeout would have silently become a code failure again.
 */
export function productLawGateExitCode(status) {
  if (status === 'INFRASTRUCTURE_ERROR') return PRODUCT_LAW_TIMEOUT_EXIT_CODE;
  if (status === 'NOT_VERIFIED') return 2;
  return 1;
}
const MANIFEST_FILE = 'config/product-laws.json';
const PROJECTION_FILE = 'docs/reference/product-laws.md';
export const PRODUCT_LAW_KILL_GRACE_MS = 1_000;

function projectionErrors(rootDir, expected, readFile = readFileSync) {
  const projection = resolve(rootDir, PROJECTION_FILE);
  if (!existsSync(projection))
    return [`product-law projection is missing: ${PROJECTION_FILE}`];
  return readFile(projection, 'utf8') === expected
    ? []
    : [
        `product-law projection drifted from ${MANIFEST_FILE}; run node scripts/product-law-gate.mjs --write`,
      ];
}

/**
 * Inspect the JSON reporter, not source text or a file-level exit alone. The
 * selected title must appear exactly once and itself pass; skipped, absent, or
 * malformed results are explicitly NOT_VERIFIED.
 */
export function structuredLawObservationVerdict(report, selector) {
  const matches = (report?.testResults ?? [])
    .flatMap((result) => result.assertionResults ?? [])
    .filter((assertion) => assertion.title === selector);
  if (matches.length !== 1)
    return {
      status: 'NOT_VERIFIED',
      reason: `structured Vitest result named ${JSON.stringify(selector)} occurred ${matches.length} times`,
    };
  if (matches[0].status === 'passed') return { status: 'PASS' };
  if (matches[0].status === 'failed') {
    // Carry the assertion's own failure text: a FAIL whose only output is
    // the one-line summary is undiagnosable from CI (station#743 —
    // Windows-only failure with no way to read the assertion).
    const failureText = (matches[0].failureMessages ?? [])
      .join('\n')
      .slice(0, 4000)
      .trim();
    return failureText
      ? { status: 'FAIL', reason: failureText }
      : { status: 'FAIL' };
  }
  return {
    status: 'NOT_VERIFIED',
    reason: `structured Vitest result named ${JSON.stringify(selector)} was ${matches[0].status}`,
  };
}

export async function observeLawTest(
  { testFile, selector, timeoutMs = PRODUCT_LAW_OBSERVATION_TIMEOUT_MS },
  {
    rootDir = ROOT,
    spawnProcess = spawn,
    killGraceMs = PRODUCT_LAW_KILL_GRACE_MS,
  } = {},
) {
  const temporaryDir = mkdtempSync(join(tmpdir(), 'station-product-law-'));
  const reportFile = join(temporaryDir, 'vitest-report.json');
  try {
    const invocation = buildFocusedVitestInvocation([testFile], rootDir);
    const child = spawnProcess(
      invocation.command,
      [
        ...invocation.args,
        '--reporter=json',
        '--outputFile',
        reportFile,
        '--testNamePattern',
        selector,
      ],
      { cwd: invocation.root, stdio: 'ignore', windowsHide: true },
    );
    let timedOut = false;
    let escalated = false;
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        escalated = true;
        child.kill('SIGKILL');
      }, killGraceMs);
    }, timeoutMs);
    const childResult = new Promise((resolve) => {
      child.on('error', (error) => resolve({ error }));
      child.on('close', (exitCode, signal) => resolve({ exitCode, signal }));
    });
    let settleTimer;
    const result = await Promise.race([
      childResult,
      new Promise((resolve) => {
        settleTimer = setTimeout(
          () => resolve({ didNotSettle: true }),
          timeoutMs + killGraceMs + 100,
        );
      }),
    ]);
    clearTimeout(timer);
    clearTimeout(killTimer);
    clearTimeout(settleTimer);
    if (result.didNotSettle)
      return {
        status: 'NOT_VERIFIED',
        reason: `structured Vitest observation did not settle within ${timeoutMs + killGraceMs + 100}ms after SIGTERM/SIGKILL`,
      };
    if (timedOut)
      return {
        status: 'INFRASTRUCTURE_ERROR',
        reason: `structured Vitest observation timed out after ${timeoutMs}ms${escalated ? ' (SIGTERM escalated to SIGKILL)' : ''}`,
      };
    if (result.error || result.exitCode === null)
      return {
        status: 'NOT_VERIFIED',
        reason: `structured Vitest observation did not complete${result.error ? `: ${result.error.message}` : ''}`,
      };
    if (!existsSync(reportFile))
      return {
        status: 'NOT_VERIFIED',
        reason: 'structured Vitest observation produced no JSON report',
      };
    let report;
    try {
      report = JSON.parse(readFileSync(reportFile, 'utf8'));
    } catch (error) {
      return {
        status: 'NOT_VERIFIED',
        reason: `structured Vitest observation report was unreadable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const verdict = structuredLawObservationVerdict(report, selector);
    if (verdict.status === 'PASS' && result.exitCode !== 0)
      return {
        status: 'NOT_VERIFIED',
        reason: `structured Vitest observation exited ${result.exitCode} despite its selected test passing`,
      };
    return verdict;
  } finally {
    rmSync(temporaryDir, { recursive: true, force: true });
  }
}

export async function runProductLawGate({
  rootDir = ROOT,
  write = false,
  observe = (observation) => observeLawTest(observation, { rootDir }),
  readFile = readFileSync,
  writeFile = writeFileSync,
  now = Date.now,
  env = process.env,
} = {}) {
  const manifest = loadProductLawManifest({
    rootDir,
    manifestFile: MANIFEST_FILE,
    readFile,
  });
  const errors = validateProductLawManifest(manifest, { rootDir, readFile });
  const projection = renderProductLawSection(manifest);
  if (errors.length > 0) return { errors, report: null, projection };
  if (write) {
    writeFile(resolve(rootDir, PROJECTION_FILE), projection);
    return { errors, report: null, projection };
  }
  errors.push(...projectionErrors(rootDir, projection, readFile));
  if (errors.length > 0) return { errors, report: null, projection };

  const startedAt = now();
  const observationTimeoutMs = productLawObservationTimeoutMs(env);
  const report = await evaluateProductLawManifest(manifest, {
    observeLawTest: (observation) => {
      const remaining = MAX_PRODUCT_LAW_RUNTIME_MS - (now() - startedAt);
      if (remaining <= 0)
        return Promise.resolve({
          status: 'NOT_VERIFIED',
          reason: `product-law verification exceeded ${MAX_PRODUCT_LAW_RUNTIME_MS}ms`,
        });
      return observe({
        ...observation,
        timeoutMs: Math.min(observationTimeoutMs, remaining),
      });
    },
  });
  if (report.status !== 'PASS')
    errors.push(`product-law observations are ${report.status}`);
  return { errors, report, projection };
}

async function main() {
  try {
    const result = await runProductLawGate({
      write: process.argv.includes('--write'),
    });
    if (result.report)
      process.stdout.write(formatProductLawReport(result.report));
    if (result.errors.length > 0) {
      process.stderr.write(`${result.errors.join('\n')}\n`);
      process.exitCode = productLawGateExitCode(result.report?.status);
    }
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url))
  await main();
