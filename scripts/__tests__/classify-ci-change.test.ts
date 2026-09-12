import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import {
  classifyChangedPaths,
  classifyGitRange,
  classifyIosGitRange,
  renderGithubOutputs,
} from '../classify-ci-change.mjs';

function git(root: string, args: string[]) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
}

function commitFile(
  root: string,
  path: string,
  contents: string,
  message: string,
) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
  git(root, ['add', path]);
  git(root, ['commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

const iosRelevanceShell = parse(
  readFileSync(
    resolve(import.meta.dirname, '../../.github/workflows/build-ios.yml'),
    'utf8',
  ),
).jobs.classify.steps.find(
  (step: { id?: string }) => step.id === 'relevance',
).run;

function runIosRelevanceShell(
  root: string,
  eventName: string,
  before: string,
  after: string,
) {
  const runnerTemp = join(root, '.runner-temp');
  const githubOutput = join(root, '.github-output');
  mkdirSync(runnerTemp, { recursive: true });
  writeFileSync(githubOutput, '');
  execFileSync(
    'bash',
    ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', iosRelevanceShell],
    {
      cwd: root,
      env: {
        ...process.env,
        BASE_SHA: before,
        GITHUB_EVENT_NAME: eventName,
        GITHUB_OUTPUT: githubOutput,
        HEAD_SHA: after,
        RUNNER_TEMP: runnerTemp,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  return readFileSync(githubOutput, 'utf8').trim();
}

describe('exact CI change classification', () => {
  test('separates candidate-only iOS changes from base-only divergence and direct pushes', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-ios-change-range-'));
    try {
      git(root, ['init', '--initial-branch=main']);
      git(root, ['config', 'user.email', 'fixture@example.test']);
      git(root, ['config', 'user.name', 'Fixture']);
      commitFile(
        root,
        'scripts/classify-ci-change.mjs',
        `console.log(['heavy=true', 'container=true', 'dependencies=false', 'classification=runtime-or-workflow', 'changed-files=1'].join('\\n'));\n`,
        'initial legacy classifier',
      );
      const divergenceBase = commitFile(
        root,
        'src-ui/inherited.ts',
        'export {};\n',
        'inherited UI',
      );

      git(root, ['checkout', '-b', 'candidate']);
      const scriptHead = commitFile(
        root,
        'scripts/verification-only.mjs',
        'export {};\n',
        'candidate script',
      );

      git(root, ['checkout', 'main']);
      const advancedBase = commitFile(
        root,
        'src-ui/base-only.ts',
        'export {};\n',
        'base UI',
      );
      expect(
        runIosRelevanceShell(
          root,
          'pull_request_target',
          advancedBase,
          scriptHead,
        ),
      ).toBe('relevant=true');
      const currentClassifierSource = readFileSync(
        resolve(import.meta.dirname, '../classify-ci-change.mjs'),
        'utf8',
      );
      const currentBase = commitFile(
        root,
        'scripts/classify-ci-change.mjs',
        currentClassifierSource,
        'current classifier',
      );

      expect(
        classifyIosGitRange({
          before: currentBase,
          after: scriptHead,
          mode: 'candidate',
          cwd: root,
        }),
      ).toMatchObject({ relevant: false, changedFiles: 1 });
      expect(
        runIosRelevanceShell(
          root,
          'pull_request_target',
          currentBase,
          scriptHead,
        ),
      ).toBe('relevant=false');

      git(root, ['checkout', '-b', 'rename-candidate', divergenceBase]);
      mkdirSync(join(root, 'docs'), { recursive: true });
      git(root, ['mv', 'src-ui/inherited.ts', 'docs/inherited.ts']);
      git(root, ['commit', '-m', 'move UI source into docs']);
      const renamedHead = git(root, ['rev-parse', 'HEAD']);
      expect(
        classifyIosGitRange({
          before: currentBase,
          after: renamedHead,
          mode: 'candidate',
          cwd: root,
        }),
      ).toMatchObject({ relevant: true, changedFiles: 2 });
      expect(
        classifyGitRange({
          before: divergenceBase,
          after: renamedHead,
          cwd: root,
        }),
      ).toMatchObject({ heavy: true, classification: 'runtime-or-workflow' });

      git(root, ['checkout', 'candidate']);
      const candidateUiHead = commitFile(
        root,
        'src-ui/candidate-only.ts',
        'export {};\n',
        'candidate UI',
      );
      expect(
        classifyIosGitRange({
          before: currentBase,
          after: candidateUiHead,
          mode: 'candidate',
          cwd: root,
        }),
      ).toMatchObject({ relevant: true, changedFiles: 2 });
      expect(
        runIosRelevanceShell(root, 'merge_group', currentBase, candidateUiHead),
      ).toBe('relevant=true');

      git(root, ['checkout', 'main']);
      const pushScript = commitFile(
        root,
        'scripts/push-only.mjs',
        'export {};\n',
        'push script',
      );
      expect(
        classifyIosGitRange({
          before: currentBase,
          after: pushScript,
          mode: 'direct',
          cwd: root,
        }),
      ).toMatchObject({ relevant: false, changedFiles: 1 });
      expect(runIosRelevanceShell(root, 'push', currentBase, pushScript)).toBe(
        'relevant=true',
      );
      const pushUi = commitFile(
        root,
        'src-ui/push-only.ts',
        'export {};\n',
        'push UI',
      );
      expect(
        classifyIosGitRange({
          before: pushScript,
          after: pushUi,
          mode: 'direct',
          cwd: root,
        }),
      ).toMatchObject({ relevant: true, changedFiles: 1 });

      expect(
        classifyIosGitRange({
          before: 'a'.repeat(40),
          after: pushUi,
          mode: 'candidate',
          cwd: root,
        }),
      ).toMatchObject({
        relevant: true,
        classification: 'classifier-error-fail-closed',
      });
      expect(
        classifyIosGitRange({
          before: pushScript,
          after: pushUi,
          mode: 'unknown',
          cwd: root,
        }),
      ).toMatchObject({
        relevant: true,
        classification: 'classifier-error-fail-closed',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
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
