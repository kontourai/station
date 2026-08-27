#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import qualificationSchema from '../schemas/daily-driver-qualification.schema.json' with {
  type: 'json',
};
import { createDailyDriverQualificationReport } from './lib/daily-driver-qualification.mjs';

const OBSERVATION_ENV = 'STATION_DAILY_DRIVER_UI_OBSERVATION_PATH';
const SOURCE_REVISION_ENV = 'STATION_DAILY_DRIVER_UI_SOURCE_REVISION';
const WRAPPER_ENV = 'STATION_DAILY_DRIVER_UI_OBSERVATION_WRAPPER';
const SPEC_PATH = 'tests/cross-runtime-chat-switching.spec.ts';
const PRODUCT_SUITE = 'product';
const PRODUCT_TEST_TITLE =
  'keeps deterministic Claude and Codex browser turns exact, settled, and project-bound';
const UI_QUALIFICATION_TIMEOUT_MS = 180_000;

const validateReport = new Ajv2020({ strict: true, allErrors: true }).compile(
  qualificationSchema,
);

function sourceRevision(root, runGit = execFileSync) {
  const revision = runGit('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  if (!/^[0-9a-f]{40}$/.test(revision))
    throw new Error('could not resolve a bounded source revision');
  return revision;
}

function assertCleanCheckout(root, runGit = execFileSync) {
  const status = runGit(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    { cwd: root, encoding: 'utf8' },
  ).trim();
  if (status)
    throw new Error(
      'daily-driver UI checkout must be clean before and after its isolated run',
    );
}

function executeFocusedPlaywright({
  root,
  observationPath,
  revision,
  timeoutMs,
}) {
  const { PW_BASE_URL: _inheritedBaseUrl, ...environment } = process.env;
  return spawnSync(
    process.execPath,
    [
      resolve(root, 'scripts/run-e2e-suite.mjs'),
      `--suite=${PRODUCT_SUITE}`,
      `--spec=${SPEC_PATH}`,
      `--grep=${PRODUCT_TEST_TITLE}`,
    ],
    {
      cwd: root,
      env: {
        ...environment,
        PLAYWRIGHT_BROWSERS_PATH: '0',
        [OBSERVATION_ENV]: observationPath,
        [SOURCE_REVISION_ENV]: revision,
        [WRAPPER_ENV]: '1',
      },
      stdio: 'inherit',
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
    },
  );
}

function producerTimedOut(result) {
  return result?.error?.code === 'ETIMEDOUT';
}

function assertRevisionBoundObservation(observation, revision) {
  if (!observation || observation.sourceRevision !== revision)
    throw new Error(
      'daily-driver UI observation did not bind to the launched checkout revision',
    );
}

/**
 * Runs the owned browser producer and ingests only its fresh temporary output.
 * Injection is test-only; the executable command accepts no observation path.
 */
export async function runDailyDriverUiQualification({
  root = resolve(import.meta.dirname, '..'),
  makeTemp = () => mkdtempSync(join(tmpdir(), 'station-daily-driver-ui-')),
  removeTemp = (directory) =>
    rmSync(directory, { recursive: true, force: true }),
  readFile = readFileSync,
  fileExists = existsSync,
  resolveRevision = sourceRevision,
  assertCheckoutClean = assertCleanCheckout,
  execute = executeFocusedPlaywright,
} = {}) {
  const directory = makeTemp();
  const observationPath = join(directory, 'observation.json');
  try {
    assertCheckoutClean(root);
    const revision = resolveRevision(root);
    let result;
    try {
      result = execute({
        root,
        observationPath,
        revision,
        timeoutMs: UI_QUALIFICATION_TIMEOUT_MS,
      });
    } finally {
      assertCheckoutClean(root);
    }
    if (producerTimedOut(result))
      throw new Error(
        `daily-driver UI Playwright producer timed out after ${UI_QUALIFICATION_TIMEOUT_MS}ms`,
      );
    if (result?.error || result?.status !== 0)
      throw new Error('daily-driver UI Playwright producer failed');
    if (!fileExists(observationPath))
      throw new Error(
        'daily-driver UI Playwright producer wrote no observation',
      );
    let observation;
    try {
      observation = JSON.parse(readFile(observationPath, 'utf8'));
    } catch {
      throw new Error('daily-driver UI observation is not valid JSON');
    }
    assertRevisionBoundObservation(observation, revision);
    if (resolveRevision(root) !== revision)
      throw new Error('daily-driver UI checkout revision changed during run');
    const report = await createDailyDriverQualificationReport({
      uiObservation: observation,
    });
    if (!validateReport(report))
      throw new Error(
        `invalid daily-driver UI qualification report: ${JSON.stringify(validateReport.errors)}`,
      );
    return report;
  } finally {
    removeTemp(directory);
  }
}

if (import.meta.main) {
  const report = await runDailyDriverUiQualification();
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
