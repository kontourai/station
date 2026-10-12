import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { parse } from 'yaml';
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

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

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
        const dir = mkdtempSync(join(tmpdir(), 'station-ios-web-version-'));
        temps.push(dir);
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
        });
        return { status: result.status, output: readFileSync(output, 'utf8') };
      };
      const version = nightlyVersion(
        '0.1.11',
        new Date('2026-10-01T00:00:00Z'),
        build,
      );
      expect(run(version)).toEqual({
        status: 0,
        output: `version=${version}\n`,
      });
      expect(run('0.1.11').status).not.toBe(0);
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
