import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import {
  classifyChangedPaths,
  classifyDesktopRustChangedPaths,
  classifyDesktopRustGitRange,
  classifyGalleryChangedPaths,
  classifyGalleryGitRange,
  classifyGitRange,
  classifyIosChangedPaths,
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
  execFileSync(
    'bash',
    ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', shell],
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

  // The input list is hand-maintained, so it is checked against what the
  // crate actually reads: every file it pulls in from outside src-desktop
  // must classify as relevant, or a change to it would skip the only Windows
  // compile. A new include_str!, path dependency, build.rs read or bundled
  // resource that the list does not cover fails here instead.
  test('covers every input the crate reads from outside src-desktop', () => {
    const crate = join(repoRoot, 'src-desktop');
    const outside = new Set<string>();
    const note = (absolute: string) => {
      const path = relative(repoRoot, absolute).split('\\').join('/');
      // Build outputs the workflow creates empty; nothing in Git to change.
      if (path.startsWith('dist-')) return;
      if (!path.startsWith('src-desktop/')) outside.add(path);
    };
    const sources = readdirSync(join(crate, 'src'), {
      recursive: true,
    }) as string[];
    for (const file of sources.filter((name) => name.endsWith('.rs'))) {
      const absolute = join(crate, 'src', file);
      for (const match of readFileSync(absolute, 'utf8').matchAll(
        /include_(?:str|bytes)!\("([^"]+)"\)/g,
      ))
        note(resolve(dirname(absolute), match[1]));
    }
    for (const match of readFileSync(
      join(crate, 'Cargo.toml'),
      'utf8',
    ).matchAll(/path\s*=\s*"([^"]+)"/g))
      note(join(resolve(crate, match[1]), 'Cargo.toml'));
    for (const match of readFileSync(join(crate, 'build.rs'), 'utf8').matchAll(
      /"(\.\.\/[^"]+)"/g,
    ))
      note(resolve(crate, match[1]));
    for (const config of readdirSync(crate).filter((name) =>
      /^tauri(\..+)?\.conf\.json$/.test(name),
    )) {
      const resources = JSON.parse(readFileSync(join(crate, config), 'utf8'))
        ?.bundle?.resources;
      const sourcesOf = Array.isArray(resources)
        ? resources
        : Object.keys(resources ?? {});
      for (const source of sourcesOf)
        if (String(source).startsWith('../'))
          note(join(resolve(crate, source), 'resource'));
    }

    // Pin the discovery itself, so a regex that stops matching cannot turn
    // this into a loop over nothing.
    expect([...outside].sort()).toEqual([
      'package.json',
      'packages/cli/src/commands/profile-store.ts',
      'patches/android-native-keyring-store/Cargo.toml',
      'schemas/resource',
    ]);
    for (const path of outside) {
      expect(
        existsSync(join(repoRoot, path)) || path.endsWith('/resource'),
      ).toBe(true);
      expect(
        classifyDesktopRustChangedPaths([path]).relevant,
        `${path} is read by the desktop crate`,
      ).toBe(true);
    }
  });

  test('runs the workflow step against a base-controlled classifier and fails closed', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-rust-change-range-'));
    try {
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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

describe('iOS relevance ignores test-only JavaScript sources', () => {
  test.each([
    'src-ui/src/components/__tests__/Button.test.tsx',
    'src-ui/src/components/Button.test.tsx',
    'src-ui/src/lib/format.spec.ts',
    'src-ui/src/__tests__/fixtures/session.json',
    'packages/sdk/src/__tests__/client.test.ts',
    'packages/connect/src/__tests__/pairing.test.ts',
    'packages/contracts/src/__tests__/fixtures/schema.json',
  ])('skips the macOS build for %s', (changedPath) => {
    expect(classifyIosChangedPaths([changedPath]).relevant).toBe(false);
  });

  test('a test-only change across several packages stays irrelevant', () => {
    expect(
      classifyIosChangedPaths([
        'src-ui/src/components/__tests__/Button.test.tsx',
        'packages/sdk/src/__tests__/client.test.ts',
        'docs/guides/testing.md',
      ]),
    ).toMatchObject({ relevant: false, changedFiles: 3 });
  });

  test('a test change beside a source change is still relevant', () => {
    expect(
      classifyIosChangedPaths([
        'src-ui/src/components/__tests__/Button.test.tsx',
        'src-ui/src/components/Button.tsx',
      ]).relevant,
    ).toBe(true);
  });

  test.each([
    // Production sources whose names merely resemble tests.
    'src-ui/src/lib/test-utils.ts',
    'src-ui/src/testing/harness.tsx',
    'src-ui/src/contest.ts',
    'packages/sdk/src/attest.ts',
    // Native and smoke inputs are never exempt, whatever they are called.
    'src-desktop/src/__tests__/lib.test.ts',
    'tests/ios-runtime-smoke/StationRuntimeSmokeTests.swift',
    'scripts/__tests__/ios-simulator-runtime-smoke.test.ts',
    // Package builds (`tsc` in build:sdk/build:connect) exclude only the
    // top-level src/__tests__, so these are compiled into the iOS build.
    'packages/connect/src/pairing.test.ts',
    'packages/sdk/src/client/__tests__/client.test.ts',
    'packages/contracts/src/schema.spec.tsx',
  ])('keeps %s relevant', (changedPath) => {
    expect(classifyIosChangedPaths([changedPath]).relevant).toBe(true);
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
      expect(
        classifyIosChangedPaths([`packages/${name}/src/__tests__/x.test.ts`])
          .relevant,
      ).toBe(false);
      expect(
        classifyIosChangedPaths([`packages/${name}/src/x.test.ts`]).relevant,
      ).toBe(true);
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
    const root = mkdtempSync(join(tmpdir(), 'station-gallery-change-range-'));
    try {
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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
