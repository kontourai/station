#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import qualificationSchema from '../schemas/daily-driver-qualification.schema.json' with {
  type: 'json',
};
import { DAILY_DRIVER_PROFILES } from './daily-driver-profiles.mjs';
import { createDailyDriverQualificationReport } from './lib/daily-driver-qualification.mjs';
import { mergeDailyDriverScenarioObservations } from './lib/daily-driver-scenario-observation.mjs';

const OBSERVATION_DIR_ENV = 'STATION_DAILY_DRIVER_SCENARIO_OBSERVATION_DIR';
const SOURCE_REVISION_ENV = 'STATION_DAILY_DRIVER_SCENARIO_SOURCE_REVISION';
const WRAPPER_ENV = 'STATION_DAILY_DRIVER_SCENARIO_OBSERVATION_WRAPPER';
const QUALIFICATION_RUNS = Object.freeze([
  {
    spec: 'tests/daily-driver-scenarios.spec.ts',
    grep: 'daily-driver scenario qualification',
  },
  {
    spec: 'tests/daily-driver-switching.spec.ts',
    grep: 'Agent handoff uses the Continue-with dialog',
  },
]);
const PRODUCT_SUITE = 'product';
/**
 * Scenario journeys plus the actual Continue-with handoff UI behind one
 * isolated build and launch of this checkout — deliberately wider than the
 * exact-confirmation bridge's three minutes, still bounded.
 */
const SCENARIO_QUALIFICATION_TIMEOUT_MS = 900_000;

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
      'daily-driver scenario checkout must be clean before and after its isolated run',
    );
}

function executeFocusedPlaywright({
  root,
  observationDir,
  revision,
  timeoutMs,
}) {
  const { PW_BASE_URL: _inheritedBaseUrl, ...environment } = process.env;
  const startedAt = Date.now();
  let result = { status: 0, signal: null, error: undefined };
  for (const run of QUALIFICATION_RUNS) {
    const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
    result = spawnSync(
      process.execPath,
      [
        resolve(root, 'scripts/run-e2e-suite.mjs'),
        `--suite=${PRODUCT_SUITE}`,
        `--spec=${run.spec}`,
        `--grep=${run.grep}`,
      ],
      {
        cwd: root,
        env: {
          ...environment,
          PLAYWRIGHT_BROWSERS_PATH: '0',
          [OBSERVATION_DIR_ENV]: observationDir,
          [SOURCE_REVISION_ENV]: revision,
          [WRAPPER_ENV]: '1',
        },
        stdio: 'inherit',
        timeout: remainingMs,
        killSignal: 'SIGTERM',
      },
    );
    if (result.error || result.status !== 0) return result;
  }
  return result;
}

function producerTimedOut(result) {
  return result?.error?.code === 'ETIMEDOUT';
}

function readScenarioArtifacts(directory, readFile, listFiles) {
  const files = listFiles(directory)
    .filter((name) => name.endsWith('.json'))
    .sort();
  if (files.length === 0)
    throw new Error(
      'daily-driver scenario Playwright producer wrote no observations',
    );
  return files.map((name) => {
    try {
      return JSON.parse(readFile(join(directory, name), 'utf8'));
    } catch {
      throw new Error(
        `daily-driver scenario observation '${name}' is not valid JSON`,
      );
    }
  });
}

const REQUIRED_BROWSER_SCENARIOS = Object.freeze([
  'liveness-settlement',
  'conversation-agreement',
  'transcript-stability',
  'performance-stress',
]);

/** The public producer is complete only when every intended journey wrote its row. */
function assertRequiredScenarioCoverage(observation) {
  const observed = new Map(
    observation.observations.map((item) => [
      `${item.profile}|${item.scenario}`,
      item,
    ]),
  );
  const required = DAILY_DRIVER_PROFILES.flatMap((profile) =>
    REQUIRED_BROWSER_SCENARIOS.map((scenario) => `${profile.id}|${scenario}`),
  );
  required.push('claude-default|agent-engine-handoff');
  const missing = required.filter((key) => !observed.has(key));
  if (missing.length > 0)
    throw new Error(
      `daily-driver scenario producer is missing required coverage: ${missing.join(', ')}`,
    );
  const handoff = observed.get('claude-default|agent-engine-handoff');
  if (
    handoff?.targetProfile !== 'codex-default' ||
    handoff.classification !== 'handoff_visible' ||
    handoff.expectationMet !== true
  )
    throw new Error(
      'daily-driver scenario producer did not prove the required Claude Code to Codex handoff',
    );
}

/**
 * Runs the owned browser producer and ingests only its fresh temporary
 * output directory. Injection is test-only; the executable command accepts
 * no observation path.
 *
 * @param {{
 *   root?: string,
 *   makeTemp?: () => string,
 *   removeTemp?: (directory: string) => void,
 *   readFile?: (path: string, encoding: 'utf8') => string,
 *   listFiles?: (directory: string) => string[],
 *   resolveRevision?: (root: string) => string,
 *   assertCheckoutClean?: (root: string) => void,
 *   execute?: (input: {
 *     root: string,
 *     observationDir: string,
 *     revision: string,
 *     timeoutMs: number,
 *   }) => {
 *     status?: number | null,
 *     signal?: string | null,
 *     error?: (Error & { code?: string }) | undefined,
 *   },
 * }} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function runDailyDriverScenarioQualification({
  root = resolve(import.meta.dirname, '..'),
  makeTemp = () =>
    mkdtempSync(join(tmpdir(), 'station-daily-driver-scenarios-')),
  removeTemp = (directory) =>
    rmSync(directory, { recursive: true, force: true }),
  readFile = readFileSync,
  listFiles = readdirSync,
  resolveRevision = sourceRevision,
  assertCheckoutClean = assertCleanCheckout,
  execute = executeFocusedPlaywright,
} = {}) {
  const directory = makeTemp();
  try {
    assertCheckoutClean(root);
    const revision = resolveRevision(root);
    let result;
    try {
      result = execute({
        root,
        observationDir: directory,
        revision,
        timeoutMs: SCENARIO_QUALIFICATION_TIMEOUT_MS,
      });
    } finally {
      assertCheckoutClean(root);
    }
    if (producerTimedOut(result))
      throw new Error(
        `daily-driver scenario Playwright producer timed out after ${SCENARIO_QUALIFICATION_TIMEOUT_MS}ms`,
      );
    if (result?.error || result?.status !== 0)
      throw new Error('daily-driver scenario Playwright producer failed');
    const artifacts = readScenarioArtifacts(directory, readFile, listFiles);
    const observation = mergeDailyDriverScenarioObservations(artifacts);
    if (observation.sourceRevision !== revision)
      throw new Error(
        'daily-driver scenario observation did not bind to the launched checkout revision',
      );
    if (resolveRevision(root) !== revision)
      throw new Error(
        'daily-driver scenario checkout revision changed during run',
      );
    assertRequiredScenarioCoverage(observation);
    const report = await createDailyDriverQualificationReport({
      uiScenarioObservation: observation,
    });
    if (!validateReport(report))
      throw new Error(
        `invalid daily-driver scenario qualification report: ${JSON.stringify(validateReport.errors)}`,
      );
    return report;
  } finally {
    removeTemp(directory);
  }
}

if (import.meta.main) {
  const report = await runDailyDriverScenarioQualification();
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
