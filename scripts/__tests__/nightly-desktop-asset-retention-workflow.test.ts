import {
  chmodSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { NIGHTLY_DESKTOP_PRUNE_VARIABLE } from '../lib/publish-nightly-desktop.mjs';
import {
  CURRENT,
  realisticListing,
} from './fixtures/nightly-desktop-release.mjs';
import { runWorkflowShell } from './fixtures/workflow-shell';

/**
 * #3593: the retention step's wiring, read from the parsed workflow and
 * executed: its own `run` and `env`, with the repository variable resolved
 * the way Actions would, against a `gh` stand-in that records every call.
 */

type Step = {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  'continue-on-error'?: boolean;
};
const repoRoot = resolve(import.meta.dirname, '../..');
const workflow = load(
  readFileSync(
    join(repoRoot, '.github/workflows/nightly-native-cohort.yml'),
    'utf8',
  ),
) as { jobs: Record<string, { steps: Step[] }> };
const steps = workflow.jobs['promote-macos'].steps;
const RETENTION = 'Prune versioned desktop downloads past the retention window';
const index = (name: string) => steps.findIndex((step) => step.name === name);
const retention = steps[index(RETENTION)];
// Pinned literally beside the exported constant it must equal.
const VARIABLE = 'STATION_NIGHTLY_DESKTOP_PRUNE';

it('runs only after the publication and its recorded claims, and never fails the job', () => {
  expect(NIGHTLY_DESKTOP_PRUNE_VARIABLE).toBe(VARIABLE);
  const publish = index('Upload both desktops, then publish latest.json last');
  const claims = steps.findIndex((step) => step.id === 'macos_provider_state');
  expect(publish).toBeGreaterThanOrEqual(0);
  expect(claims).toBeGreaterThan(publish);
  expect(index(RETENTION)).toBeGreaterThan(claims);
  expect(retention.if).toBe(
    "${{ steps.publisher.outputs.desktop_needed == 'true' && steps.macos_provider_state.outcome == 'success' }}",
  );
  expect(retention['continue-on-error']).toBe(true);
});

/** Resolves only the expression shapes the step may use; anything else throws. */
function resolveEnv(env: Record<string, string>, vars: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => {
      const variable = /^\$\{\{ vars\.([A-Z_]+) \}\}$/.exec(value);
      if (variable) return [key, vars[variable[1]] ?? ''];
      if (value === '${{ secrets.GITHUB_TOKEN }}') return [key, 'fake-token'];
      throw new Error(`unexpected step env ${key}: ${value}`);
    }),
  );
}

describe.skipIf(process.platform === 'win32')(
  'the step as Actions runs it',
  () => {
    const makeTempDir = trackTempDirs();
    const execute = (vars: Record<string, string>, failingGh = false) => {
      const root = makeTempDir('nightly-desktop-retention-');
      const bin = join(root, 'bin');
      mkdirSync(bin);
      mkdirSync(join(root, 'cohort'));
      symlinkSync(join(repoRoot, 'scripts'), join(root, 'scripts'), 'junction');
      writeFileSync(
        join(root, 'cohort/cohort-plan.json'),
        JSON.stringify({
          versionIdentities: {
            desktop: { releaseTag: 'nightly-desktop', version: CURRENT },
          },
        }),
      );
      const stateFile = join(root, 'gh-state.json');
      writeFileSync(stateFile, JSON.stringify(realisticListing()));
      const gh = join(bin, 'gh');
      writeFileSync(
        gh,
        failingGh
          ? '#!/bin/sh\necho "gh: HTTP 500" >&2\nexit 1\n'
          : `#!/bin/sh\nexec "${process.execPath}" "${join(repoRoot, 'scripts/__tests__/fixtures/nightly-desktop-release.mjs')}" "$@"\n`,
      );
      chmodSync(gh, 0o755);
      const result = runWorkflowShell(
        retention.run!,
        root,
        {
          ...resolveEnv(retention.env!, vars),
          PATH: `${bin}:${process.env.PATH}`,
          FAKE_GH_STATE: stateFile,
        },
        60_000,
      );
      const log = (JSON.parse(readFileSync(stateFile, 'utf8')).log ??
        []) as string[][];
      return {
        result,
        deletes: log.filter((args) => args.includes('DELETE')),
        reads: log.length,
      };
    };

    it('deletes only when the repository variable is exactly enabled', () => {
      const enabled = execute({ [VARIABLE]: 'enabled' });
      expect(enabled.result.status).toBe(0);
      expect(enabled.result.stdout).toContain('(deleting)');
      expect(enabled.deletes).toHaveLength(25);
      for (const value of [undefined, 'true', 'Enabled']) {
        const run = execute(value === undefined ? {} : { [VARIABLE]: value });
        expect(run.result.status).toBe(0);
        expect(run.result.stdout).toContain('(report only)');
        expect(run.reads).toBeGreaterThan(0);
        expect(run.deletes).toEqual([]);
      }
    });

    it('exits 0 with a warning when GitHub fails', () => {
      const failed = execute({ [VARIABLE]: 'enabled' }, true);
      expect(failed.result.status).toBe(0);
      expect(failed.result.stdout).toContain(
        '::warning title=Nightly desktop retention::',
      );
      expect(failed.deletes).toEqual([]);
    });
  },
);
