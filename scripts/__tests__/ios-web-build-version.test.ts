import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { nightlyVersion } from '../lib/nightly-build-identity.mjs';

/**
 * #2675: an iOS build's Apple marketing version is the bare X.Y.Z, but its
 * web bundle's build identity (STATION_BUILD_VERSION, read only by
 * vite.config.ts) is what a client compares with its server. These tests
 * follow that value from each caller into the TestFlight build job.
 */
const WORKFLOWS = resolve(import.meta.dirname, '../../.github/workflows');
type Workflow = {
  on: { workflow_call?: { inputs: Record<string, unknown> } };
  jobs: Record<
    string,
    {
      env?: Record<string, string>;
      outputs?: Record<string, string>;
      steps?: Array<{ id?: string; run?: string }>;
      uses?: string;
      with?: Record<string, string>;
    }
  >;
};
const workflow = (name: string) =>
  parse(readFileSync(join(WORKFLOWS, name), 'utf8')) as Workflow;

const makeTempDir = trackTempDirs();

describe('iOS web bundle build identity', () => {
  test('the TestFlight build stamps the web bundle with web_build_version when given', () => {
    const delivery = workflow('testflight-delivery.yml');
    expect(delivery.on.workflow_call?.inputs).toHaveProperty(
      'web_build_version',
    );
    expect(delivery.jobs.deliver.env?.STATION_BUILD_VERSION).toBe(
      `\${{ inputs.web_build_version || inputs.marketing_version }}`,
    );
  });

  test('the Nightly stage passes the cohort Nightly version, not the bare marketing version', () => {
    const stage = workflow('nightly-native-stage.yml');
    const ios = Object.values(stage.jobs).find(
      (job) =>
        job.uses === './.github/workflows/testflight-delivery.yml' &&
        job.with?.delivery === 'build',
    );
    expect(ios?.with?.web_build_version).toBe(
      `\${{ needs.plan-cohort.outputs.web_build_version }}`,
    );
    expect(stage.jobs['plan-cohort'].outputs?.web_build_version).toBe(
      `\${{ steps.web_identity.outputs.version }}`,
    );
  });

  test.each([0, 2])(
    "the plan step emits the cohort's desktop Nightly version (build %s) and refuses a bare one",
    (build) => {
      const step = workflow('nightly-native-stage.yml').jobs[
        'plan-cohort'
      ].steps?.find((candidate) => candidate.id === 'web_identity');
      expect(step?.run).toBeTruthy();
      const run = (version: string) => {
        const dir = makeTempDir('station-ios-web-version-');
        writeFileSync(
          join(dir, 'cohort-plan.json'),
          JSON.stringify({ versionIdentities: { desktop: { version } } }),
        );
        const output = join(dir, 'output');
        writeFileSync(output, '');
        const result = spawnSync('bash', ['-e', '-c', step?.run ?? ''], {
          cwd: dir,
          env: { ...process.env, GITHUB_OUTPUT: output },
          encoding: 'utf8',
          windowsHide: true,
        });
        return {
          status: result.status,
          output: readFileSync(output, 'utf8'),
          stdout: result.stdout,
        };
      };
      const version = nightlyVersion(
        '0.1.11',
        new Date('2026-10-01T00:00:00Z'),
        build,
      );
      expect(run(version)).toMatchObject({
        status: 0,
        output: `version=${version}\n`,
      });
      // The refusal is explicit and names the value, not a silent set -e.
      const refused = run('0.1.11');
      expect(refused.status).toBe(1);
      expect(refused.output).toBe('');
      expect(refused.stdout).toContain(
        "::error::cohort desktop version '0.1.11' is not a Nightly version",
      );
    },
  );

  test('a Beta or stable release passes its full release version', () => {
    const release = workflow('release.yml');
    const ios = Object.values(release.jobs).find(
      (job) => job.uses === './.github/workflows/testflight-delivery.yml',
    );
    expect(ios?.with?.web_build_version).toBe(
      `\${{ needs.preflight.outputs.version }}`,
    );
  });
});
