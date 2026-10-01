/**
 * Runs inside an ordinary test worker, after `vitest.setup.ts` has scrubbed
 * the triggering event (#2922). The real-ledger freshness checks read the
 * job's mode through `JOB_ENV`; this probe proves that mode survives the
 * scrub by checking a repository whose pull request stales its own record.
 * `documentation-freshness.test.ts` starts it under each workflow event and
 * states the outcome it expects; in an ordinary run it checks that the
 * outcome agrees with the mode the job's environment selects.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { isEventScopedVariable } from '../lib/ci-event-environment.mjs';
import {
  checkDocumentationFreshness,
  documentationFreshnessMode,
} from '../lib/documentation-freshness.mjs';
import { JOB_ENV } from './helpers/freshness-env.js';
import { writeReviewLedger } from './helpers/review-ledger-fixture.js';

const makeTempDir = trackTempDirs();
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

it('checks the real repository in the job event mode while the worker stays scrubbed', async () => {
  expect(Object.keys(process.env).filter(isEventScopedVariable)).toEqual([]);
  const root = makeTempDir('station-freshness-job-env-');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: root, env, windowsHide: true });
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write('guide.md', '# Guide\n');
  write('owner.ts', 'export const owner = 1;\n');
  writeReviewLedger(root, [
    {
      path: 'guide.md',
      kind: 'current',
      state: 'source-reviewed',
      summary: 'Checked the owner.',
      limits: 'Fixture only.',
      documentDigest: hash('# Guide\n'),
      sources: [
        { path: 'owner.ts', digest: hash('export const owner = 1;\n') },
      ],
      checks: ['Fixture evidence.'],
    },
  ]);
  const commit = (message: string) => {
    git(['add', '-A']);
    git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-qm',
      message,
    ]);
  };
  git(['init', '-q', '-b', 'main']);
  commit('fresh main');
  git(['switch', '-qc', 'pr']);
  write('owner.ts', 'export const owner = 2;\n');
  commit('the pull request changes a reviewed source');
  // The job's base, as the workflow derives it, names the fixture's main.
  const jobEnv = {
    ...JOB_ENV,
    ...(JOB_ENV.STATION_CI_FAST_BASE ? { STATION_CI_FAST_BASE: 'main' } : {}),
  };
  const result = await checkDocumentationFreshness({ root, env: jobEnv });
  const blocks = result.blocking.map((entry) => entry.path);
  const expected = process.env.STATION_FRESHNESS_PROBE_EXPECT;
  if (expected === 'blocks') expect(blocks).toEqual(['guide.md']);
  else if (expected === 'advisory') {
    expect(blocks).toEqual([]);
    expect(result.advisory.map((entry) => entry.path)).toEqual(['guide.md']);
  } else
    expect(blocks).toEqual(
      documentationFreshnessMode(jobEnv).mode === 'advisory'
        ? []
        : ['guide.md'],
    );
});
