import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  needsVersionPr,
  versionPrOperation,
} from '../version-pr-operation.mjs';
import { runWorkflowShell } from './fixtures/workflow-shell.js';

const makeTempDir = trackTempDirs();
const workflow = load(
  readFileSync(resolve('.github/workflows/publish-packages.yml'), 'utf8'),
) as {
  permissions: Record<string, string>;
  jobs: Record<
    string,
    {
      steps: Array<{
        name?: string;
        id?: string;
        if?: string;
        uses?: string;
        run?: string;
        with?: Record<string, string>;
        env?: Record<string, string>;
      }>;
    }
  >;
};
const steps = workflow.jobs.publish.steps;
const pending = [
  { id: 'repair', releases: [{ name: '@fixture/one', type: 'patch' }] },
];

function expression(
  source: string,
  versionPr: boolean,
  publish: boolean,
  appToken = 'app-fixture',
) {
  const env = { PUBLISH_RUN: String(publish) };
  const github = { token: 'workflow-fixture' };
  const context = {
    'version-operation': { outputs: { 'version-pr': String(versionPr) } },
    'version-token': { outputs: { token: appToken } },
  };
  const code = source
    .slice(3, -2)
    .replace(
      /steps\.([a-z-]+)\.outputs\.([a-z-]+)/g,
      (_, step, output) =>
        `steps[${JSON.stringify(step)}].outputs[${JSON.stringify(output)}]`,
    );
  return new Function('env', 'steps', 'github', `return (${code});`)(
    env,
    context,
    github,
  );
}

describe('version PR credential boundary', () => {
  test('missing App credentials stop the actual workflow guard before the action', () => {
    const guard = steps.find(
      (step) => step.name === 'Require version PR installation token',
    );
    if (!guard?.run) throw new Error('Missing token guard');
    const script = `${guard.run}\nprintf 'ACTION_REACHED\\n'`;
    const missing = runWorkflowShell(
      script,
      process.cwd(),
      { VERSION_PR_TOKEN: '' },
      10_000,
    );
    expect(missing.status).toBe(1);
    expect(missing.stdout).not.toContain('ACTION_REACHED');
    const present = runWorkflowShell(
      script,
      process.cwd(),
      { VERSION_PR_TOKEN: 'app-fixture-secret' },
      10_000,
    );
    expect(present.status).toBe(0);
    expect(present.stdout).toContain('ACTION_REACHED');
    expect(present.stdout + present.stderr).not.toContain('app-fixture-secret');
  });
  test('uses the real installed changeset reader for a version request', async () => {
    const root = makeTempDir('station-version-pr-operation-');
    mkdirSync(join(root, '.changeset'));
    writeFileSync(
      join(root, '.changeset', 'repair.md'),
      '---\n"@fixture/one": patch\n---\nA fix.\n',
    );
    expect(await versionPrOperation(root, 'push', 'refs/heads/main')).toBe(
      true,
    );
    expect(
      await versionPrOperation(root, 'workflow_dispatch', 'refs/heads/main'),
    ).toBe(true);
  });

  test('does not mint App authority for empty, empty-release or consumed prerelease state', () => {
    expect(needsVersionPr([], undefined)).toBe(false);
    expect(needsVersionPr([{ id: 'empty', releases: [] }], undefined)).toBe(
      false,
    );
    expect(
      needsVersionPr([{ ...pending[0], id: 'pre/repair' }], { mode: 'pre' }),
    ).toBe(false);
    expect(needsVersionPr(pending, { mode: 'pre' })).toBe(true);
  });

  test('refuses malformed state rather than falling back to workflow credentials', () => {
    expect(() => needsVersionPr(null, undefined)).toThrow(
      'Invalid changeset state',
    );
    expect(() => needsVersionPr([{ id: 'bad' }], undefined)).toThrow(
      'Invalid changeset releases',
    );
  });

  test.each([
    ['pull_request', 'refs/heads/main'],
    ['pull_request_target', 'refs/heads/main'],
    ['workflow_dispatch', 'refs/heads/feature'],
    ['push', 'refs/heads/feature'],
  ])(
    'refuses untrusted operation %s at %s before reading packages',
    async (event, ref) => {
      await expect(versionPrOperation('/unused', event, ref)).rejects.toThrow(
        'trusted main event',
      );
    },
  );

  test.each([false, true])(
    'App-authenticated versioning cannot publish even with publish intent %s',
    (publish) => {
      const action = steps.find((step) => step.id === 'changesets');
      expect(action?.with).toBeTruthy();
      expect(
        expression(action?.with?.['github-token'] ?? '', true, publish),
      ).toBe('app-fixture');
      expect(
        expression(action?.with?.['publish-script'] ?? '', true, publish),
      ).toBe('');
    },
  );

  test('keeps deliberate publishing on the workflow credential and OIDC path', () => {
    const action = steps.find((step) => step.id === 'changesets');
    expect(expression(action?.with?.['github-token'] ?? '', false, true)).toBe(
      'workflow-fixture',
    );
    expect(
      expression(action?.with?.['publish-script'] ?? '', false, true),
    ).toBe('npm run publish-packages');
    expect(
      expression(action?.with?.['publish-script'] ?? '', false, false),
    ).toBe('');
    expect(workflow.permissions['id-token']).toBe('write');
  });

  test('requires an App token before the action and retains narrow installation permissions', () => {
    const plan = steps.findIndex((step) => step.id === 'version-operation');
    const mint = steps.findIndex((step) => step.id === 'version-token');
    const guard = steps.findIndex(
      (step) => step.name === 'Require version PR installation token',
    );
    const action = steps.findIndex((step) => step.id === 'changesets');
    expect(plan).toBeLessThan(mint);
    expect(mint).toBeLessThan(guard);
    expect(guard).toBeLessThan(action);
    expect(steps[mint].if).toBe(
      "steps.version-operation.outputs.version-pr == 'true'",
    );
    expect(steps[guard].if).toBe(steps[mint].if);
    expect(steps[guard].env?.VERSION_PR_TOKEN).toBe(
      `\${{ steps.version-token.outputs.token }}`,
    );
    expect(steps[guard].run).toContain('test -n "$VERSION_PR_TOKEN"');
    expect(steps[guard].run).toContain('exit 1');
    expect(steps[mint].with).toMatchObject({
      repositories: 'station',
      'permission-contents': 'write',
      'permission-pull-requests': 'write',
    });
    expect(
      Object.keys(steps[mint].with ?? {})
        .filter((key) => key.startsWith('permission-'))
        .sort(),
    ).toEqual(['permission-contents', 'permission-pull-requests']);
  });
});
