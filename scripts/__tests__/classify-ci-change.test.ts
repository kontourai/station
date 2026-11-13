import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import {
  removeTempDirs,
  trackTempDirs,
} from '../../src-server/__test-utils__/temp-dirs.js';
import {
  classifyChangedPaths,
  classifyDesktopRustChangedPaths,
  classifyDesktopRustGitRange,
  classifyGalleryChangedPaths,
  classifyGalleryGitRange,
  classifyGitRange,
  classifyIosChangedPaths,
  classifyIosGitRange,
  classifyIosPostMergeChangedPaths,
  classifyIosPostMergeGitRange,
  IOS_POST_MERGE_PREFIXES,
  renderGithubOutputs,
} from '../classify-ci-change.mjs';
import { runWorkflowShell } from './fixtures/workflow-shell.js';

function withFixtureCleanup(root: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    try {
      removeTempDirs([root]);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Workflow assertion failed and fixture cleanup failed',
      );
    }
    throw error;
  }
  removeTempDirs([root]);
}

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

const desktopRustRelevanceShell = parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      '../../.github/workflows/windows-pr-verification.yml',
    ),
    'utf8',
  ),
).jobs['windows-pr-portable'].steps.find(
  (step: { id?: string }) => step.id === 'rust_relevance',
).run;

const galleryRelevanceShell = parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      '../../.github/workflows/gallery-pr-check.yml',
    ),
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
  shell: string = iosRelevanceShell,
) {
  const runnerTemp = join(root, '.runner-temp');
  const githubOutput = join(root, '.github-output');
  mkdirSync(runnerTemp, { recursive: true });
  writeFileSync(githubOutput, '');
  const result = runWorkflowShell(shell, root, {
    BASE_SHA: before,
    GITHUB_EVENT_NAME: eventName,
    GITHUB_OUTPUT: githubOutput,
    HEAD_SHA: after,
    RUNNER_TEMP: runnerTemp,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Workflow shell exited ${result.status} (${result.signal ?? 'no signal'})\n${result.stdout}\n${result.stderr}`,
      { cause: result.error },
    );
  }
  return readFileSync(githubOutput, 'utf8').trim();
}

// Removed in an after-hook whether the test passed or not (#2421).
const makeTempDir = trackTempDirs();

describe('exact CI change classification', () => {
  test('separates candidate-only iOS changes from base-only divergence and direct pushes', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-ios-change-range-'));
    withFixtureCleanup(root, () => {
      git(root, ['init', '--initial-branch=main']);
      git(root, ['config', 'user.email', 'fixture@example.test']);
      git(root, ['config', 'user.name', 'Fixture']);
      const legacyBase = commitFile(
        root,
        'scripts/classify-ci-change.mjs',
        `console.log(['heavy=true', 'container=true', 'dependencies=false', 'classification=runtime-or-workflow', 'changed-files=1'].join('\\n'));\n`,
        'initial legacy classifier',
      );
      const divergenceBase = commitFile(
        root,
        'src-ui/src/platform/inherited.ts',
        'export {};\n',
        'inherited native shell',
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
      git(root, [
        'mv',
        'src-ui/src/platform/inherited.ts',
        'docs/inherited.ts',
      ]);
      git(root, ['commit', '-m', 'move native shell source into docs']);
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
      // A UI-only candidate no longer builds before landing, on either event.
      const candidateUiHead = commitFile(
        root,
        'src-ui/src/components/candidate-only.tsx',
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
      ).toMatchObject({ relevant: false, changedFiles: 2 });
      for (const event of ['pull_request_target', 'merge_group'])
        expect(
          runIosRelevanceShell(root, event, currentBase, candidateUiHead),
        ).toBe('relevant=false');
      const candidateNativeHead = commitFile(
        root,
        'src-desktop/src/candidate-only.rs',
        'fn main() {}\n',
        'candidate native',
      );
      expect(
        classifyIosGitRange({
          before: currentBase,
          after: candidateNativeHead,
          mode: 'candidate',
          cwd: root,
        }),
      ).toMatchObject({ relevant: true, changedFiles: 3 });
      for (const event of ['pull_request_target', 'merge_group'])
        expect(
          runIosRelevanceShell(root, event, currentBase, candidateNativeHead),
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
      // A main push answers the post-merge question over exactly what it
      // added: a script-only push builds nothing.
      expect(runIosRelevanceShell(root, 'push', currentBase, pushScript)).toBe(
        'relevant=false',
      );
      // Dispatch always builds.
      expect(
        runIosRelevanceShell(
          root,
          'workflow_dispatch',
          currentBase,
          pushScript,
        ),
      ).toBe('relevant=true');
      const pushUi = commitFile(
        root,
        'src-ui/src/components/push-only.tsx',
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
      ).toMatchObject({ relevant: false, changedFiles: 1 });
      // The merge group skipped this UI-only tree, so main builds it.
      expect(
        classifyIosPostMergeGitRange({
          before: pushScript,
          after: pushUi,
          mode: 'direct',
          cwd: root,
        }),
      ).toMatchObject({ relevant: true, changedFiles: 1 });
      expect(runIosRelevanceShell(root, 'push', pushScript, pushUi)).toBe(
        'relevant=true',
      );
      // One push can carry several squashed PRs. If any of them is native,
      // the merge group already built this exact tree, so main does not.
      const pushNative = commitFile(
        root,
        'src-desktop/src/push-only.rs',
        'fn main() {}\n',
        'push native',
      );
      expect(runIosRelevanceShell(root, 'push', pushScript, pushNative)).toBe(
        'relevant=false',
      );
      expect(runIosRelevanceShell(root, 'push', pushUi, pushNative)).toBe(
        'relevant=false',
      );
      // Fail closed on push too: a previous main without the post-merge
      // scope (this change's own first push) and an unknown `before` build.
      expect(runIosRelevanceShell(root, 'push', legacyBase, pushScript)).toBe(
        'relevant=true',
      );
      expect(
        runIosRelevanceShell(root, 'push', 'a'.repeat(40), pushScript),
      ).toBe('relevant=true');
      expect(
        classifyIosPostMergeGitRange({
          before: 'a'.repeat(40),
          after: pushScript,
          mode: 'direct',
          cwd: root,
        }),
      ).toMatchObject({
        relevant: true,
        classification: 'classifier-error-fail-closed',
      });

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
    });
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

const repoRoot = resolve(import.meta.dirname, '../..');

describe('desktop Rust relevance for the Windows PR floor', () => {
  test.each([
    'src-desktop/src/lib.rs',
    'src-desktop/Cargo.lock',
    'src-desktop/tauri.windows.conf.json',
    'src-desktop/.cargo/config.toml',
    'experiments/mobile-device/tauri-host/Cargo.toml',
    'experiments/mobile-device/tauri-host/Cargo.lock',
    'rust-toolchain.toml',
    'tools/.cargo/config.toml',
    'patches/android-native-keyring-store/src/lib.rs',
    'package.json',
    'packages/cli/src/commands/profile-store.ts',
    'schemas/station-config.schema.json',
    '.github/workflows/windows-pr-verification.yml',
    'scripts/classify-ci-change.mjs',
    'scripts/prepare-desktop-rust-resources.mjs',
    'scripts/lib/desktop-node-runtime.mjs',
    'scripts/lib/portable-server-archive.mjs',
    'config/portable-server-node-runtime.json',
  ])('compiles for %s', (changedPath) => {
    expect(classifyDesktopRustChangedPaths([changedPath]).relevant).toBe(true);
  });

  test.each([
    'src-ui/src/App.tsx',
    'src-server/routes/foo.ts',
    'docs/guides/testing.md',
    'patches/some-npm-package.patch',
    'packages/cli/src/commands/other.ts',
    'packages/cli/package.json',
    '.github/workflows/build-ios.yml',
    'scripts/run-ci-fast.mjs',
  ])('skips the compile for %s', (changedPath) => {
    expect(classifyDesktopRustChangedPaths([changedPath]).relevant).toBe(false);
  });

  test('one Rust input makes a mixed change relevant', () => {
    expect(
      classifyDesktopRustChangedPaths([
        'src-ui/src/App.tsx',
        'src-desktop/src/tray.rs',
      ]).relevant,
    ).toBe(true);
  });

  test('runs the workflow step against a base-controlled classifier and fails closed', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-rust-change-range-'));
    withFixtureCleanup(root, () => {
      git(root, ['init', '--initial-branch=main']);
      git(root, ['config', 'user.email', 'fixture@example.test']);
      git(root, ['config', 'user.name', 'Fixture']);
      // A base whose classifier predates the desktop-rust scope prints the
      // default classifier's lines, which the step must refuse.
      const legacyBase = commitFile(
        root,
        'scripts/classify-ci-change.mjs',
        `console.log(['heavy=true', 'container=true', 'dependencies=false', 'classification=runtime-or-workflow', 'changed-files=1'].join('\\n'));\n`,
        'legacy classifier',
      );
      git(root, ['checkout', '-b', 'ui-candidate']);
      const uiHead = commitFile(
        root,
        'src-ui/candidate.ts',
        'export {};\n',
        'candidate UI',
      );
      expect(
        runIosRelevanceShell(
          root,
          'pull_request_target',
          legacyBase,
          uiHead,
          desktopRustRelevanceShell,
        ),
      ).toBe('relevant=true');

      git(root, ['checkout', 'main']);
      const currentBase = commitFile(
        root,
        'scripts/classify-ci-change.mjs',
        readFileSync(
          resolve(import.meta.dirname, '../classify-ci-change.mjs'),
          'utf8',
        ),
        'current classifier',
      );
      git(root, ['checkout', '-b', 'ui-only', currentBase]);
      const uiOnly = commitFile(
        root,
        'src-ui/only.ts',
        'export {};\n',
        'UI only',
      );
      expect(
        runIosRelevanceShell(
          root,
          'pull_request_target',
          currentBase,
          uiOnly,
          desktopRustRelevanceShell,
        ),
      ).toBe('relevant=false');
      expect(
        runIosRelevanceShell(
          root,
          'merge_group',
          currentBase,
          uiOnly,
          desktopRustRelevanceShell,
        ),
      ).toBe('relevant=false');

      const rustToo = commitFile(
        root,
        'src-desktop/src/lib.rs',
        'fn main() {}\n',
        'Rust',
      );
      expect(
        runIosRelevanceShell(
          root,
          'pull_request_target',
          currentBase,
          rustToo,
          desktopRustRelevanceShell,
        ),
      ).toBe('relevant=true');

      // An unresolvable base cannot supply a classifier: compile anyway.
      expect(
        runIosRelevanceShell(
          root,
          'pull_request_target',
          'a'.repeat(40),
          uiOnly,
          desktopRustRelevanceShell,
        ),
      ).toBe('relevant=true');
      expect(
        classifyDesktopRustGitRange({
          before: 'a'.repeat(40),
          after: uiOnly,
          mode: 'candidate',
          cwd: root,
        }),
      ).toMatchObject({
        relevant: true,
        classification: 'classifier-error-fail-closed',
      });
    });
  });

  test('refuses an unknown scope instead of answering with the default classifier', () => {
    const result = spawnSync(
      process.execPath,
      [
        resolve(import.meta.dirname, '../classify-ci-change.mjs'),
        '--scope',
        'not-a-scope',
        '--before',
        'a'.repeat(40),
        '--after',
        'b'.repeat(40),
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
  });
});

/**
 * Where a change gets its iOS build: `before` (the PR and merge-group build,
 * `--scope ios`), `after` (only the coalesced main push build,
 * `--scope ios-post-merge`), or `never`. The two scopes are disjoint by
 * construction, and asserting both answers catches a revert of either.
 */
function iosBuildPoint(paths: string[]) {
  const before = classifyIosChangedPaths(paths).relevant;
  const after = classifyIosPostMergeChangedPaths(paths).relevant;
  if (before && after) throw new Error(`both scopes claim ${paths.join(', ')}`);
  return before ? 'before' : after ? 'after' : 'never';
}

describe('iOS builds native inputs before landing and the rest of the UI after', () => {
  test.each([
    // The workflow, its router, the smoke and its fixtures.
    '.github/workflows/build-ios.yml',
    'scripts/classify-ci-change.mjs',
    'scripts/ios-simulator-runtime-smoke.mjs',
    'scripts/__tests__/ios-simulator-runtime-smoke.test.ts',
    'tests/ios-runtime-smoke/StationRuntimeSmokeTests.swift',
    'tests/ios-runtime-smoke/project.yml',
    // The native crate, iOS project/config, Rust and Cargo anywhere.
    'src-desktop/src/lib.rs',
    'src-desktop/tauri.ios.conf.json',
    'src-desktop/gen/apple/project.yml',
    'src-desktop/Info.ios.plist',
    'src-desktop/Cargo.lock',
    'src-desktop/src/__tests__/lib.test.ts',
    'rust-toolchain.toml',
    'experiments/mobile-device/tauri-host/Cargo.toml',
    '.cargo/config.toml',
    'patches/android-native-keyring-store/src/lib.rs',
    'patches/some-npm-package.patch',
    // Dependency/toolchain manifests and native-client build inputs.
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.nvmrc',
    'vite.config.ts',
    'scripts/write-native-client-build-manifest.mjs',
    'scripts/lib/desktop-build-manifest.mjs',
    'scripts/write-ios-build-manifest.mjs',
    'scripts/lib/ios-launch-screen.mjs',
    'scripts/ios-channel-icons.mjs',
    // The src-ui slice that is the native shell and its boot path.
    'src-ui/src/platform/native/tauri.ts',
    'src-ui/src/platform/native/pluginBundleCapability.js',
    'src-ui/src/platform/PlatformSessionGate.tsx',
    'src-ui/public/favicon.png',
    'src-ui/public/startup-theme.js',
    'src-ui/index.html',
    'src-ui/src/main.tsx',
    'src-ui/src/boot.ts',
    'src-ui/src/build-info.ts',
    'src-ui/tsconfig.json',
  ])('builds %s before landing', (changedPath) => {
    expect(iosBuildPoint([changedPath])).toBe('before');
  });

  test.each([
    // Ordinary product UI, including the pairing screens the smoke drives:
    // every Linux lane builds and renders them, so iOS builds them on main.
    'src-ui/src/App.tsx',
    'src-ui/src/components/MobileWelcomeBoundary.tsx',
    'src-ui/src/views/connections-hub/ConnectStationDialog.tsx',
    'src-ui/src/index.css',
    'src-ui/src/i18n/en.ts',
    // Production sources whose names merely resemble tests.
    'src-ui/src/lib/test-utils.ts',
    'src-ui/src/testing/harness.tsx',
    'src-ui/src/contest.ts',
    'packages/sdk/src/attest.ts',
    // The packages the bundle compiles. Package builds (`tsc` in
    // build:sdk/build:connect) exclude only the top-level src/__tests__, so
    // these test-named files are compiled and still count.
    'packages/connect/src/pairing.ts',
    'packages/contracts/src/plugin.ts',
    'packages/sdk/src/client/index.ts',
    'packages/connect/src/pairing.test.ts',
    'packages/sdk/src/client/__tests__/client.test.ts',
    'packages/contracts/src/schema.spec.tsx',
  ])('builds %s only after landing', (changedPath) => {
    expect(iosBuildPoint([changedPath])).toBe('after');
  });

  test.each([
    // Test-only sources no build compiles.
    'src-ui/src/components/__tests__/Button.test.tsx',
    'src-ui/src/components/Button.test.tsx',
    'src-ui/src/lib/format.spec.ts',
    'src-ui/src/__tests__/fixtures/session.json',
    'src-ui/src/platform/__tests__/installedAppZoom.test.ts',
    'packages/sdk/src/__tests__/client.test.ts',
    'packages/connect/src/__tests__/pairing.test.ts',
    'packages/contracts/src/__tests__/fixtures/schema.json',
    // Outside both scopes.
    'docs/guides/testing.md',
    'src-server/routes/foo.ts',
    'packages/cli/src/commands/other.ts',
    'scripts/run-ci-fast.mjs',
    '.github/workflows/windows-pr-verification.yml',
  ])('never builds iOS for %s', (changedPath) => {
    expect(iosBuildPoint([changedPath])).toBe('never');
  });

  test('a test-only change across several packages builds nothing', () => {
    expect(
      classifyIosChangedPaths([
        'src-ui/src/components/__tests__/Button.test.tsx',
        'packages/sdk/src/__tests__/client.test.ts',
        'docs/guides/testing.md',
      ]),
    ).toMatchObject({ relevant: false, changedFiles: 3 });
    expect(
      classifyIosPostMergeChangedPaths([
        'src-ui/src/components/__tests__/Button.test.tsx',
        'packages/sdk/src/__tests__/client.test.ts',
        'docs/guides/testing.md',
      ]),
    ).toMatchObject({ relevant: false, changedFiles: 3 });
  });

  test('a test change beside a UI source change builds after landing', () => {
    expect(
      iosBuildPoint([
        'src-ui/src/components/__tests__/Button.test.tsx',
        'src-ui/src/components/Button.tsx',
      ]),
    ).toBe('after');
  });

  // The rule that keeps main from rebuilding a merge-group tree: one native
  // path anywhere in the range means the candidate was built before landing.
  test('one native input moves a whole UI range to the merge-group build', () => {
    expect(
      iosBuildPoint([
        'src-ui/src/App.tsx',
        'packages/sdk/src/client/index.ts',
        'src-desktop/src/lib.rs',
      ]),
    ).toBe('before');
    expect(
      iosBuildPoint([
        'src-ui/src/App.tsx',
        'src-ui/src/platform/native/tauri.ts',
      ]),
    ).toBe('before');
  });

  test('changes only the iOS answer, not the shared heavy/container classification', () => {
    const testOnly = ['src-ui/src/components/Button.test.tsx'];
    expect(classifyChangedPaths(testOnly)).toMatchObject({
      heavy: true,
      container: true,
      classification: 'runtime-or-workflow',
    });
    expect(classifyIosChangedPaths(testOnly).relevant).toBe(false);
  });

  // The push trigger's paths filter decides whether the post-merge
  // classifier even runs, so it must cover every post-merge prefix. Read the
  // workflow rather than trust the comment that says so.
  test('the push paths filter names every post-merge prefix', () => {
    const workflow = parse(
      readFileSync(join(repoRoot, '.github/workflows/build-ios.yml'), 'utf8'),
    ) as { on: { push?: { branches?: string[]; paths?: string[] } } };
    expect(workflow.on.push?.branches).toEqual(['main']);
    expect(IOS_POST_MERGE_PREFIXES).toEqual([
      'src-ui/',
      'packages/connect/',
      'packages/contracts/',
      'packages/sdk/',
    ]);
    expect([...(workflow.on.push?.paths ?? [])].sort()).toEqual(
      IOS_POST_MERGE_PREFIXES.map((prefix) => `${prefix}**`).sort(),
    );
  });

  // Every script the macOS job runs on its default (non-dispatch) path is a
  // native-client build input: a change to one must build before landing.
  test('every script the iOS build job runs is a pre-landing input', () => {
    const workflow = parse(
      readFileSync(join(repoRoot, '.github/workflows/build-ios.yml'), 'utf8'),
    ) as {
      jobs: Record<string, { steps: Array<{ if?: string; run?: string }> }>;
    };
    const scripts = new Set<string>();
    for (const step of workflow.jobs['build-ios-verification'].steps) {
      if (
        String(step.if ?? '').startsWith(
          "github.event_name == 'workflow_dispatch'",
        )
      )
        continue;
      for (const match of String(step.run ?? '').matchAll(
        /\bscripts\/[\w./-]+\.mjs\b/g,
      ))
        scripts.add(match[0]);
    }
    const packageScripts = (
      JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    for (const match of packageScripts['build:native-client'].matchAll(
      /\bscripts\/[\w./-]+\.mjs\b/g,
    ))
      scripts.add(match[0]);
    expect([...scripts].sort()).toEqual([
      'scripts/ios-channel-icons.mjs',
      'scripts/ios-simulator-runtime-smoke.mjs',
      'scripts/write-ios-build-manifest.mjs',
      'scripts/write-native-client-build-manifest.mjs',
    ]);
    for (const script of scripts)
      expect(iosBuildPoint([script]), script).toBe('before');
  });
});

describe('package test exemptions match what the package builds exclude', () => {
  // S5's packages/ exemption is only safe for paths the tsc builds in
  // build:native-client never compile. Read their tsconfigs rather than trust
  // the classifier's comment: if a build starts compiling src/__tests__, the
  // exemption must shrink with it.
  test.each(['sdk', 'connect'])(
    'packages/%s excludes its top-level src/__tests__ from the build',
    (name) => {
      const tsconfig = JSON.parse(
        readFileSync(
          resolve(import.meta.dirname, `../../packages/${name}/tsconfig.json`),
          'utf8',
        ),
      ) as { exclude?: string[] };
      expect(
        (tsconfig.exclude ?? []).some((pattern) =>
          ['src/__tests__', 'src/__tests__/**'].includes(pattern),
        ),
      ).toBe(true);
      expect(iosBuildPoint([`packages/${name}/src/__tests__/x.test.ts`])).toBe(
        'never',
      );
      expect(iosBuildPoint([`packages/${name}/src/x.test.ts`])).toBe('after');
    },
  );
});

describe('gallery relevance for the PR gallery check (#2428)', () => {
  test.each([
    'src-ui/src/components/plugins/PluginsPage.tsx',
    'src-ui/src/index.css',
    'src-server/routes/plugins.ts',
    'packages/contracts/src/plugin.ts',
    'packages/sdk/src/client/index.ts',
    'src-shared/format.ts',
    'examples/plugins/demo/plugin.json',
    'package.json',
    'pnpm-lock.yaml',
    'patches/some-npm-package.patch',
    'vite.config.ts',
    'playwright.config.ts',
    'tests/screenshots.spec.ts',
    'tests/helpers/screenshot-capture-sequence.ts',
    'tests/screenshots.baseline.json',
    'tests/screenshots.baseline/plugins.png',
    'scripts/run-e2e-suite.mjs',
    'scripts/screenshot-diff.mjs',
    'src-desktop/tauri.conf.json',
    '.github/workflows/gallery-pr-check.yml',
    '.github/workflows/nightly-gallery.yml',
    'station',
    '.nvmrc',
    // Unknown territory runs the capture: the scope is an exclusion list.
    'a-new-top-level-dir/thing.ts',
  ])('captures for %s', (changedPath) => {
    expect(classifyGalleryChangedPaths([changedPath]).relevant).toBe(true);
  });

  test.each([
    'docs/guides/testing.md',
    '.changeset/quiet-owls.md',
    'README.md',
    'CONTRIBUTING.md',
    'src-ui/AGENTS.md',
    'src-server/CLAUDE.md',
    '.github/workflows/build-ios.yml',
    '.github/CODEOWNERS',
    '.githooks/pre-push',
    '.veritas/GOVERNANCE.md',
    'src-desktop/src/lib.rs',
    'src-desktop/Cargo.lock',
    'src-desktop/tauri.windows.conf.json',
    'src-ui/src/components/__tests__/PluginsPage.test.tsx',
    'src-ui/src/lib/format.test.ts',
    'src-server/routes/plugins.test.ts',
    'scripts/__tests__/screenshot-diff.test.ts',
    'tests/some-journey.spec.ts',
  ])('skips the capture for %s', (changedPath) => {
    expect(classifyGalleryChangedPaths([changedPath]).relevant).toBe(false);
  });

  test('one gallery input makes a mixed change relevant', () => {
    expect(
      classifyGalleryChangedPaths([
        'docs/guides/testing.md',
        'src-desktop/src/tray.rs',
        'src-ui/src/App.tsx',
      ]).relevant,
    ).toBe(true);
    expect(
      classifyGalleryChangedPaths([
        'docs/guides/testing.md',
        'src-desktop/src/tray.rs',
      ]).relevant,
    ).toBe(false);
  });

  // src-desktop/ is excluded on the premise that the web build the capture
  // drives reads nothing from it except what vite.config.ts imports. Derive
  // that set from the config instead of trusting the classifier's comment, so
  // a new import from the desktop tree cannot silently skip the capture.
  test('covers every file vite.config.ts imports from src-desktop', () => {
    const config = readFileSync(join(repoRoot, 'vite.config.ts'), 'utf8');
    const imported = [
      ...config.matchAll(/from\s+['"]\.\/(src-desktop\/[^'"]+)['"]/g),
    ].map((match) => match[1]);
    expect(imported).toEqual(['src-desktop/tauri.conf.json']);
    for (const path of imported) {
      expect(existsSync(join(repoRoot, path))).toBe(true);
      expect(
        classifyGalleryChangedPaths([path]).relevant,
        `${path} is read by the web build`,
      ).toBe(true);
    }
  });

  test('runs the workflow step against a base-controlled classifier and fails closed', () => {
    const root = makeTempDir('station-gallery-change-range-');
    withFixtureCleanup(root, () => {
      git(root, ['init', '--initial-branch=main']);
      git(root, ['config', 'user.email', 'fixture@example.test']);
      git(root, ['config', 'user.name', 'Fixture']);
      // A base whose classifier predates the gallery scope exits 2 on the
      // unknown scope. That is this very PR's situation, so it must capture.
      const legacyBase = commitFile(
        root,
        'scripts/classify-ci-change.mjs',
        `console.error('Unknown CI classification scope'); process.exitCode = 2;\n`,
        'legacy classifier',
      );
      git(root, ['checkout', '-b', 'docs-candidate']);
      const docsHead = commitFile(
        root,
        'docs/candidate.md',
        '# docs\n',
        'candidate docs',
      );
      expect(
        runIosRelevanceShell(
          root,
          'pull_request_target',
          legacyBase,
          docsHead,
          galleryRelevanceShell,
        ),
      ).toBe('relevant=true');

      git(root, ['checkout', 'main']);
      const currentBase = commitFile(
        root,
        'scripts/classify-ci-change.mjs',
        readFileSync(
          resolve(import.meta.dirname, '../classify-ci-change.mjs'),
          'utf8',
        ),
        'current classifier',
      );
      git(root, ['checkout', '-b', 'docs-only', currentBase]);
      const docsOnly = commitFile(
        root,
        'docs/only.md',
        '# docs\n',
        'docs only',
      );
      expect(
        runIosRelevanceShell(
          root,
          'pull_request_target',
          currentBase,
          docsOnly,
          galleryRelevanceShell,
        ),
      ).toBe('relevant=false');

      const uiToo = commitFile(
        root,
        'src-ui/src/App.tsx',
        'export {};\n',
        'UI',
      );
      expect(
        runIosRelevanceShell(
          root,
          'pull_request_target',
          currentBase,
          uiToo,
          galleryRelevanceShell,
        ),
      ).toBe('relevant=true');

      // An unresolvable base cannot supply a classifier: capture anyway.
      expect(
        runIosRelevanceShell(
          root,
          'pull_request_target',
          'a'.repeat(40),
          docsOnly,
          galleryRelevanceShell,
        ),
      ).toBe('relevant=true');
      expect(
        classifyGalleryGitRange({
          before: 'a'.repeat(40),
          after: docsOnly,
          mode: 'candidate',
          cwd: root,
        }),
      ).toMatchObject({
        relevant: true,
        classification: 'classifier-error-fail-closed',
      });
    });
  });
});
