import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dump, load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { spawnSyncBounded } from '../lib/bounded-capture.mjs';

const makeTempDir = trackTempDirs();
type Workflow = {
  env?: Record<string, string>;
  jobs: Record<
    string,
    {
      env: Record<string, string>;
      steps?: Array<{ name?: string; env?: Record<string, string> }>;
    }
  >;
};

function guard(script: string, args: string[] = []) {
  const result = spawnSyncBounded(
    process.execPath,
    [resolve('scripts', script), ...args],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

describe('official author telemetry build boundary', () => {
  it('checks desktop and portable preview channel expressions, stamps representative server bundles as beta, and refuses invalid endpoints and non-official builds', () => {
    const result = guard('check-author-telemetry-build.mjs');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Author telemetry build guard: PASS');
  }, 240_000);

  it('refuses workflow leaks into PR and Docker jobs, widened release expressions, and missing injection', () => {
    const fixture = makeTempDir('station-author-workflows-');
    cpSync('.github/workflows', join(fixture, '.github/workflows'), {
      recursive: true,
    });
    const baseline = guard('check-author-telemetry-workflows.mjs', [fixture]);
    expect(baseline.status, baseline.stderr).toBe(0);
    const file = join(fixture, '.github/workflows/release.yml');
    const original = readFileSync(file, 'utf8');
    for (const mutate of [
      (workflow: Workflow) => {
        workflow.env = {
          STATION_AUTHOR_TELEMETRY_ENDPOINT: `\${{ vars.STATION_AUTHOR_TELEMETRY_ENDPOINT }}`,
        };
      },
      (workflow: Workflow) => {
        workflow.jobs.container.env.STATION_AUTHOR_TELEMETRY_ENDPOINT = `\${{ vars.STATION_AUTHOR_TELEMETRY_ENDPOINT }}`;
      },
      (workflow: Workflow) => {
        workflow.jobs['desktop-macos'].env.STATION_AUTHOR_TELEMETRY_ENDPOINT =
          `\${{ vars.STATION_AUTHOR_TELEMETRY_ENDPOINT }}`;
      },
      (workflow: Workflow) => {
        const build = workflow.jobs['desktop-macos'].steps?.find(
          (step) => step.name === 'Build an unsigned macOS staging candidate',
        );
        delete build?.env?.STATION_AUTHOR_TELEMETRY_ENDPOINT;
      },
      (workflow: Workflow) => {
        const build = workflow.jobs['desktop-macos'].steps?.find(
          (step) => step.name === 'Build an unsigned macOS staging candidate',
        );
        if (!build?.env) throw new Error('Missing macOS producer');
        build.env.STATION_CHANNEL = 'preview';
      },
    ]) {
      const workflow = load(original) as Workflow;
      mutate(workflow);
      writeFileSync(file, dump(workflow));
      const rejected = guard('check-author-telemetry-workflows.mjs', [fixture]);
      expect(rejected.status, rejected.stderr).toBe(1);
      expect(rejected.stderr).toMatch(
        /author endpoint (leaks|or build channel)/,
      );
      writeFileSync(file, original);
    }
    const portable = join(
      fixture,
      '.github/workflows/portable-server-archives.yml',
    );
    const portableOriginal = readFileSync(portable, 'utf8');
    const portableWorkflow = load(portableOriginal) as Workflow;
    const archive = portableWorkflow.jobs.archive.steps?.find(
      (step) => step.name === 'Build the archive',
    );
    expect(archive).toBeDefined();
    delete archive?.env?.STATION_AUTHOR_TELEMETRY_ENDPOINT;
    writeFileSync(portable, dump(portableWorkflow));
    const missingArchiveInjection = guard(
      'check-author-telemetry-workflows.mjs',
      [fixture],
    );
    expect(missingArchiveInjection.status, missingArchiveInjection.stderr).toBe(
      1,
    );
    expect(missingArchiveInjection.stderr).toContain(
      'archive/Build the archive',
    );
    writeFileSync(portable, portableOriginal);
    const pr = join(fixture, '.github/workflows/build-android.yml');
    const prOriginal = readFileSync(pr, 'utf8');
    writeFileSync(
      pr,
      `${prOriginal}\nenv:\n  STATION_AUTHOR_TELEMETRY_ENDPOINT: https://telemetry.example.invalid\n`,
    );
    const rejected = guard('check-author-telemetry-workflows.mjs', [fixture]);
    expect(rejected.status, rejected.stderr).toBe(1);
    expect(rejected.stderr).toContain(
      'author endpoint leaks outside an official producer',
    );
    writeFileSync(pr, prOriginal);
    expect(
      guard('check-author-telemetry-workflows.mjs', [fixture]).status,
    ).toBe(0);
  });
});
