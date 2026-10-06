/**
 * Pull-request and merge-queue test runs see the same environment (#2922).
 *
 * PR #2934 nearly shipped a test that passed in PR fast-checks and failed in
 * the merge queue: the code under test read `GITHUB_EVENT_NAME`, which is
 * `pull_request_target` in one and `merge_group` in the other.
 * `vitest.setup.ts` now removes the event's variables from every worker.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAll } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  EVENT_SCOPED_STATION_VARIABLES,
  isEventScopedVariable,
  scrubEventScopedEnvironment,
} from '../lib/ci-event-environment.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PROBE = 'scripts/__tests__/ci-event-environment.probe.test.ts';
const makeTempDir = trackTempDirs();

/** What a merge-queue job hands its steps, as far as a test could see it. */
const MERGE_QUEUE_ENVIRONMENT = {
  GITHUB_ACTIONS: 'true',
  CI: 'true',
  GITHUB_EVENT_NAME: 'merge_group',
  GITHUB_REF: 'refs/heads/gh-readonly-queue/main/pr-1-abc',
  GITHUB_BASE_REF: '',
  GITHUB_SHA: 'a'.repeat(40),
  STATION_CI_FAST_BASE: 'b'.repeat(40),
};

describe('scrubEventScopedEnvironment', () => {
  it('removes the event and its derived Station variables, and nothing else', () => {
    const env: Record<string, string> = {
      ...MERGE_QUEUE_ENVIRONMENT,
      PATH: '/usr/bin',
      STATION_HOME: '/tmp/home',
      STATION_DOCS_FRESHNESS: 'advisory',
    };
    expect(scrubEventScopedEnvironment(env)).toEqual([
      'GITHUB_BASE_REF',
      'GITHUB_EVENT_NAME',
      'GITHUB_REF',
      'GITHUB_SHA',
      'STATION_CI_FAST_BASE',
    ]);
    expect(env).toEqual({
      GITHUB_ACTIONS: 'true',
      CI: 'true',
      PATH: '/usr/bin',
      STATION_HOME: '/tmp/home',
      // A runner's own explicit choice, identical in every event.
      STATION_DOCS_FRESHNESS: 'advisory',
    });
  });
});

/** Workflow env names whose value is computed from the triggering event. */
function eventDerivedWorkflowVariables(): Set<string> {
  const names = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'env' && entry && typeof entry === 'object') {
        for (const [name, expression] of Object.entries(entry))
          if (
            /\bgithub\.(?:event|sha|ref|head_ref|base_ref)\b/.test(
              String(expression),
            )
          )
            names.add(name);
      } else visit(entry);
    }
  };
  const directory = join(ROOT, '.github/workflows');
  for (const file of readdirSync(directory).filter((name) =>
    /\.ya?ml$/.test(name),
  ))
    loadAll(readFileSync(join(directory, file), 'utf8'), visit);
  return names;
}

describe('the scrub list is derived from the workflows', () => {
  it('names every Station variable a workflow computes from the event', () => {
    const derived = [...eventDerivedWorkflowVariables()].filter((name) =>
      name.startsWith('STATION_'),
    );
    // The derivation must see the variable this issue is about, or it has
    // stopped reading the workflows and the next check would pass vacuously.
    expect(derived).toContain('STATION_CI_FAST_BASE');
    expect(derived.filter((name) => !isEventScopedVariable(name))).toEqual([]);
  });

  it('lists no Station variable a workflow does not derive from the event', () => {
    const derived = eventDerivedWorkflowVariables();
    expect(
      EVENT_SCOPED_STATION_VARIABLES.filter((name) => !derived.has(name)),
    ).toEqual([]);
  });
});

describe('a worker started under a merge-queue environment', () => {
  it('runs the probe with the event removed and GITHUB_ACTIONS kept', {
    timeout: 120_000,
  }, () => {
    const report = join(makeTempDir('station-event-probe-'), 'report.json');
    const result = spawnSync(
      process.execPath,
      [
        join(ROOT, 'node_modules/vitest/vitest.mjs'),
        'run',
        PROBE,
        '--reporter=json',
        `--outputFile=${report}`,
      ],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          ...MERGE_QUEUE_ENVIRONMENT,
          STATION_EVENT_PROBE_EXPECT_ACTIONS: '1',
        },
        timeout: 110_000,
        windowsHide: true,
      },
    );
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(result.error, output).toBeUndefined();
    const parsed = JSON.parse(readFileSync(report, 'utf8'));
    const failures = parsed.testResults.flatMap(
      (suite: {
        assertionResults: {
          status: string;
          title: string;
          failureMessages: string[];
        }[];
      }) =>
        suite.assertionResults
          .filter((assertion) => assertion.status !== 'passed')
          .map((assertion) => ({
            title: assertion.title,
            message: assertion.failureMessages.join('\n').split('\n')[0],
          })),
    );
    expect(failures).toEqual([]);
    expect(result.status, output).toBe(0);
    // Both probe cases ran: a probe that was filtered out or skipped would
    // also exit 0.
    expect(parsed.numPassedTests).toBe(2);
  });
});
