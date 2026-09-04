import { describe, expect, test } from 'vitest';
import {
  classifyChangedPaths,
  classifyGitRange,
  renderGithubOutputs,
} from '../classify-ci-change.mjs';

describe('exact CI change classification', () => {
  test.each([
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'patches/dependency.patch',
  ])('audits all workspaces for shared dependency input %s', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({
      heavy: true,
      container: true,
      dependencies: true,
      dependencyScopes: ['root', 'sdk', 'shared'],
    });
  });
  test('schedules heavy lanes when a runtime file follows more than 300 docs files', () => {
    const paths = [
      ...Array.from({ length: 350 }, (_, index) => `docs/page-${index}.md`),
      'src-server/index.ts',
    ];
    expect(classifyChangedPaths(paths)).toEqual({
      heavy: true,
      container: true,
      dependencies: false,
      dependencyScopes: [],
      classification: 'runtime-or-workflow',
      changedFiles: 351,
    });
  });

  test('keeps more than 300 docs-only files off heavy lanes', () => {
    const paths = Array.from(
      { length: 350 },
      (_, index) => `docs/page-${index}.md`,
    );
    expect(classifyChangedPaths(paths)).toEqual({
      heavy: false,
      container: false,
      dependencies: false,
      dependencyScopes: [],
      classification: 'docs-only',
      changedFiles: 350,
    });
  });

  test('renders literal workflow outputs', () => {
    expect(
      renderGithubOutputs(classifyChangedPaths(['.github/workflows/ci.yml'])),
    ).toBe(
      [
        'heavy=true',
        'container=true',
        'dependencies=false',
        'classification=runtime-or-workflow',
        'changed-files=1',
      ].join('\n'),
    );
  });

  test('fails closed to heavy scheduled work when the before SHA is missing', () => {
    expect(
      classifyGitRange({
        before: '0'.repeat(40),
        after: 'a'.repeat(40),
      }),
    ).toEqual({
      heavy: true,
      container: true,
      dependencies: true,
      dependencyScopes: ['root', 'sdk', 'shared'],
      classification: 'missing-before-fail-closed',
      changedFiles: null,
    });
  });

  test.each([
    'package.json',
    'package-lock.json',
    'packages/sdk/package.json',
    'packages/shared/package-lock.json',
    'packages/shared/npm-shrinkwrap.json',
    '.npmrc',
    'packages/sdk/.npmrc',
    'scripts/dependency-advisory-exceptions.json',
  ])('requires the advisory scan for %s', (changedPath) => {
    expect(classifyChangedPaths([changedPath]).dependencies).toBe(true);
  });

  // Each audited scope costs two concurrent registry-bound `npm audit`
  // processes, so scanning all three when one changed is what pushed the step
  // past its own timeout (#1417). Attribution is what makes the narrowing
  // safe, so it is asserted per scope rather than by counting.
  test.each([
    ['package.json', ['root']],
    ['package-lock.json', ['root']],
    ['packages/sdk/package.json', ['sdk']],
    ['packages/sdk/package-lock.json', ['sdk']],
    ['packages/shared/package-lock.json', ['shared']],
  ])('attributes %s to %s', (changedPath, expected) => {
    expect(classifyChangedPaths([changedPath]).dependencyScopes).toEqual(
      expected,
    );
  });

  test('unions the scopes when several change', () => {
    expect(
      classifyChangedPaths([
        'packages/shared/package.json',
        'packages/sdk/package-lock.json',
      ]).dependencyScopes,
    ).toEqual(['sdk', 'shared']);
  });

  // The narrowing must fail OPEN to every scope for any input it cannot
  // attribute. A dependency input in a package that is not itself audited
  // still feeds the root lockfile, registry configuration can change
  // resolution anywhere beneath it, and the exceptions file changes how every
  // scope's findings are judged. Each of these would be a silent coverage
  // hole if it resolved to a narrower list.
  test.each([
    ['packages/contracts/package.json', 'a workspace that is not audited'],
    ['packages/cli/package-lock.json', 'another unaudited workspace'],
    ['.npmrc', 'root registry configuration'],
    ['packages/sdk/.npmrc', 'nested registry configuration'],
    ['scripts/dependency-advisory-exceptions.json', 'the exceptions file'],
  ])('widens to every scope for %s (%s)', (changedPath) => {
    expect(classifyChangedPaths([changedPath]).dependencyScopes).toEqual([
      'root',
      'sdk',
      'shared',
    ]);
  });

  test('one unattributable input widens a change that would otherwise narrow', () => {
    expect(
      classifyChangedPaths([
        'packages/sdk/package.json',
        'packages/contracts/package.json',
      ]).dependencyScopes,
    ).toEqual(['root', 'sdk', 'shared']);
  });

  test('selects no scope only when no dependency input changed', () => {
    const classified = classifyChangedPaths(['src-server/routes/foo.ts']);
    expect(classified.dependencies).toBe(false);
    expect(classified.dependencyScopes).toEqual([]);
  });
});
