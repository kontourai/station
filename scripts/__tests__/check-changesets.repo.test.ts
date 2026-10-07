import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { checkChangesets } from '../check-changesets.mjs';

const root = resolve(import.meta.dirname, '../..');
const makeTempDir = trackTempDirs();

function releaseWorkspace(changeset?: string) {
  const cwd = makeTempDir('station-release-plan-');
  mkdirSync(join(cwd, '.changeset'));
  writeFileSync(
    join(cwd, 'pnpm-workspace.yaml'),
    'packages:\n  - packages/*\n',
  );
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify({
      name: 'release-fixture',
      private: true,
      workspaces: ['packages/*'],
    }),
  );
  writeFileSync(
    join(cwd, '.changeset/config.json'),
    JSON.stringify({
      changelog: false,
      commit: false,
      fixed: [],
      linked: [],
      access: 'restricted',
      baseBranch: 'main',
      updateInternalDependencies: 'patch',
      ignore: [],
      privatePackages: { version: false, tag: false },
    }),
  );
  for (const [name, isPrivate] of [
    ['public', false],
    ['private', true],
  ] as const) {
    const directory = join(cwd, 'packages', name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({
        name: `@fixture/${name}`,
        version: '1.0.0',
        private: isPrivate,
      }),
    );
  }
  if (changeset !== undefined)
    writeFileSync(join(cwd, '.changeset/change.md'), changeset);
  return cwd;
}

/**
 * #2781: the suite a `.changeset/**` edit selects. It runs the same release
 * planner as `ci:fast`'s check-changesets static gate over the repository's
 * own changesets and config, so a changeset that names an unknown package or
 * bumps wrongly fails here, in the pull request's affected selection, instead
 * of deferring the whole selection as an unknown path.
 */
test('the repository changesets parse and plan a release', async () => {
  const plan = await checkChangesets(root);
  expect(Number.isInteger(plan.changesets)).toBe(true);
  expect(plan.changesets).toBeGreaterThanOrEqual(0);
  expect(Array.isArray(plan.packages)).toBe(true);
});

test('no pending changesets produce no releases', async () => {
  expect(await checkChangesets(releaseWorkspace())).toEqual({
    changesets: 0,
    packages: [],
  });
});

test('a private-only note is valid when private package versioning is disabled', async () => {
  const cwd = releaseWorkspace(
    '---\n"@fixture/private": minor\n---\nPrivate change.\n',
  );
  expect(await checkChangesets(cwd)).toEqual({ changesets: 1, packages: [] });
});

test('a public package note produces a nonempty release plan', async () => {
  const cwd = releaseWorkspace(
    '---\n"@fixture/public": minor\n---\nPublic change.\n',
  );
  expect(await checkChangesets(cwd)).toEqual({
    changesets: 1,
    packages: ['@fixture/public'],
  });
});

test('the real planner rejects a note naming an unknown package', async () => {
  const cwd = releaseWorkspace(
    '---\n"@fixture/missing": patch\n---\nUnknown package.\n',
  );
  await expect(checkChangesets(cwd)).rejects.toThrow();
});

test('the real reader rejects malformed changeset metadata', async () => {
  const cwd = releaseWorkspace(
    '---\n[invalid: frontmatter\n---\nInvalid note.\n',
  );
  await expect(checkChangesets(cwd)).rejects.toThrow();
});
