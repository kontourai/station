#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
const ZERO_SHA = '0'.repeat(40);

/**
 * The audited scopes, and the directory each one's dependency inputs live in.
 * Order is the scan order; `ALL_DEPENDENCY_SCOPES` is what an input we cannot
 * attribute falls back to.
 */
/**
 * Directory prefixes MUST end in `/` (the repository root is the empty
 * string). `scopesForDependencyInput` compares them against a path's
 * slash-terminated directory, so a prefix written without the trailing slash
 * would still audit correctly but would never attribute anything -- every
 * input under it would fall through to widening. That fails open rather than
 * leaving a hole, which is why it would otherwise go unnoticed.
 */
export const DEPENDENCY_SCOPE_ROOTS = Object.freeze({
  root: '',
  sdk: 'packages/sdk/',
  shared: 'packages/shared/',
});
export const ALL_DEPENDENCY_SCOPES = Object.freeze(
  Object.keys(DEPENDENCY_SCOPE_ROOTS),
);

const DEPENDENCY_FILES = new Set([
  '.npmrc',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'npm-shrinkwrap.json',
]);

const IOS_VERIFICATION_FILES = new Set([
  '.github/workflows/build-ios.yml',
  'scripts/classify-ci-change.mjs',
  'scripts/ios-simulator-runtime-smoke.mjs',
  'scripts/__tests__/ios-simulator-runtime-smoke.test.ts',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
]);
const IOS_VERIFICATION_PREFIXES = Object.freeze([
  'src-desktop/',
  'src-ui/',
  'packages/connect/',
  'packages/contracts/',
  'packages/sdk/',
  'tests/ios-runtime-smoke/',
  'patches/',
]);

/**
 * What `cargo test --manifest-path src-desktop/Cargo.toml --no-run` reads on
 * the Windows PR floor, so a change outside this set cannot alter its verdict.
 * Beyond the crate itself: build.rs reads the root package.json's
 * engines.node, lib.rs `include_str!`s a CLI source file, the Android keyring
 * patch is a path dependency cargo must resolve on every target, and
 * tauri.windows.conf.json bundles schemas/ as a resource tauri-build checks.
 * Any Cargo manifest, lockfile, toolchain file or `.cargo/` config anywhere
 * counts too, so a new crate or toolchain pin is compiled rather than
 * silently skipped. Grow this list when the crate grows a new outside input
 * (an `include_*!`, a `path =` dependency, a build.rs read, a resource).
 */
const DESKTOP_RUST_FILES = new Set([
  '.github/workflows/windows-pr-verification.yml',
  'scripts/classify-ci-change.mjs',
  'package.json',
  'packages/cli/src/commands/profile-store.ts',
]);
const DESKTOP_RUST_PREFIXES = Object.freeze([
  'src-desktop/',
  'patches/android-native-keyring-store/',
  'schemas/',
]);
const DESKTOP_RUST_BASENAMES = new Set([
  'Cargo.toml',
  'Cargo.lock',
  'rust-toolchain',
  'rust-toolchain.toml',
]);

function isDesktopRustInput(changedPath) {
  if (DESKTOP_RUST_FILES.has(changedPath)) return true;
  if (DESKTOP_RUST_PREFIXES.some((prefix) => changedPath.startsWith(prefix)))
    return true;
  if (changedPath.startsWith('.cargo/') || changedPath.includes('/.cargo/'))
    return true;
  const base = changedPath.slice(changedPath.lastIndexOf('/') + 1);
  return DESKTOP_RUST_BASENAMES.has(base);
}

function isDependencyInput(changedPath) {
  if (changedPath.startsWith('patches/')) return true;
  if (changedPath === 'scripts/dependency-advisory-exceptions.json')
    return true;
  const base = changedPath.slice(changedPath.lastIndexOf('/') + 1);
  return DEPENDENCY_FILES.has(base);
}

/**
 * Which audited scopes a changed dependency input belongs to.
 *
 * `null` means "cannot attribute this one", and the caller must widen to every
 * scope. That is the case for a nested `.npmrc` (registry configuration can
 * change resolution anywhere beneath it), for the exceptions file (it changes
 * how every scope's findings are evaluated), and for any dependency input in a
 * package that is not itself audited -- a workspace whose lockfile feeds one
 * must not silently go unscanned because this mapping had not heard of it.
 *
 * Note what this does NOT protect on its own: widening widens to the scopes
 * named HERE, so a scope the audit runs but this map has never heard of would
 * be filtered out of every selection, including the fail-closed ones. That is
 * why `DEPENDENCY_SCOPE_ROOTS` is exported and the audit derives its scope
 * list from it rather than keeping a second copy.
 */
function scopesForDependencyInput(changedPath) {
  if (changedPath === 'scripts/dependency-advisory-exceptions.json')
    return null;
  const base = changedPath.slice(changedPath.lastIndexOf('/') + 1);
  if (
    changedPath.startsWith('patches/') ||
    base === '.npmrc' ||
    base === 'pnpm-lock.yaml' ||
    base === 'pnpm-workspace.yaml'
  )
    return null;
  const directory = changedPath.slice(0, changedPath.lastIndexOf('/') + 1);
  for (const [scope, root] of Object.entries(DEPENDENCY_SCOPE_ROOTS)) {
    if (directory === root) return [scope];
  }
  return null;
}

export function classifyChangedPaths(paths) {
  const normalized = [...new Set(paths.filter(Boolean))];
  const nonDocs = normalized.filter((path) => !path.startsWith('docs/'));
  const dependencyInputs = normalized.filter(isDependencyInput);
  const dependencies = dependencyInputs.length > 0;

  // Scan the scopes whose inputs actually changed, which is what the
  // scheduled `dependency-advisory` workflow already documents this scan as
  // doing. Anything unattributable widens to every scope.
  //
  // Be honest about what this gives up. Scanning all three meant a PR that
  // touched ANY dependency input incidentally re-audited the other two, so an
  // advisory disclosed hours earlier against an untouched scope could be
  // caught by an unrelated PR. That opportunistic catch is what narrowing
  // trades away, and the scheduled scan (four slots a day) is what replaces it -- a bounded delay,
  // not an equivalence.
  const selected = new Set();
  for (const changedPath of dependencyInputs) {
    const scopes = scopesForDependencyInput(changedPath);
    if (scopes === null) {
      for (const scope of ALL_DEPENDENCY_SCOPES) selected.add(scope);
      break;
    }
    for (const scope of scopes) selected.add(scope);
  }
  const dependencyScopes = ALL_DEPENDENCY_SCOPES.filter((scope) =>
    selected.has(scope),
  );

  return {
    heavy: nonDocs.length > 0,
    container: nonDocs.length > 0,
    dependencies,
    dependencyScopes,
    classification:
      normalized.length === 0
        ? 'no-changes'
        : nonDocs.length === 0
          ? 'docs-only'
          : 'runtime-or-workflow',
    changedFiles: normalized.length,
  };
}

export function changedPathsForGitRange({
  before,
  after,
  mode = 'direct',
  cwd = process.cwd(),
  gitCommand = execFileSync,
}) {
  if (!SHA.test(before) || !SHA.test(after) || before === ZERO_SHA)
    throw new Error(
      'before and after must be existing full lowercase Git SHAs',
    );
  if (!['candidate', 'direct'].includes(mode))
    throw new Error('Git change range mode must be candidate or direct');
  const start =
    mode === 'candidate'
      ? gitCommand('git', ['merge-base', '--', before, after], {
          cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        }).trim()
      : before;
  if (!SHA.test(start)) throw new Error('Git change range has no merge base');
  const output = gitCommand(
    'git',
    ['diff', '--no-renames', '--name-only', '-z', `${start}..${after}`, '--'],
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // GitHub's Compare API and native path filters expose at most 300 files.
      // The full checkout is authoritative; an unexpectedly huge diff fails
      // closed at this explicit memory bound instead of silently truncating.
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    },
  );
  return [...new Set(output.split('\0').filter(Boolean))].sort();
}

/**
 * Test-only sources the iOS app's build never compiles, so a change confined
 * to them cannot alter the simulator build or the runtime the XCUITest drives.
 * The two roots are exempt for different reasons, and each is only as wide as
 * its reason:
 *
 * - src-ui/ reaches the app through `vite build`, which follows imports from
 *   the entry, and no non-test module imports a test file. So `__tests__/`
 *   directories and `*.test`/`*.spec` TypeScript names anywhere under it.
 * - packages/ reaches it through `build:native-client`'s `build:sdk` and
 *   `build:connect`, which run `tsc` over every file under `src/` minus each
 *   tsconfig's `exclude`. Those exclude only the top-level `src/__tests__`,
 *   so a co-located `src/foo.test.ts` or a nested `src/x/__tests__/` IS
 *   compiled (and fails without Vitest globals). Only a package's top-level
 *   `src/__tests__/` is exempt.
 *
 * Never src-desktop/, the smoke's own tests/ios-runtime-smoke/, or the listed
 * smoke test. Test helpers named anything else still count.
 */
const SRC_UI_TEST_ONLY_SOURCE =
  /^src-ui\/(?:.*\/)?(?:__tests__\/|[^/]+\.(test|spec)\.tsx?$)/;
const PACKAGE_EXCLUDED_TESTS = /^packages\/[^/]+\/src\/__tests__\//;

function isIosTestOnlyPath(path) {
  return (
    SRC_UI_TEST_ONLY_SOURCE.test(path) || PACKAGE_EXCLUDED_TESTS.test(path)
  );
}

export function classifyIosChangedPaths(paths) {
  const normalized = [...new Set(paths.filter(Boolean))];
  return {
    relevant: normalized.some(
      (path) =>
        IOS_VERIFICATION_FILES.has(path) ||
        (IOS_VERIFICATION_PREFIXES.some((prefix) => path.startsWith(prefix)) &&
          !isIosTestOnlyPath(path)),
    ),
    classification: 'classified',
    changedFiles: normalized.length,
  };
}

export function classifyDesktopRustChangedPaths(paths) {
  const normalized = [...new Set(paths.filter(Boolean))];
  return {
    relevant: normalized.some(isDesktopRustInput),
    classification: 'classified',
    changedFiles: normalized.length,
  };
}

function classifyScopedGitRange(classifyPaths, options) {
  try {
    return classifyPaths(changedPathsForGitRange(options));
  } catch (error) {
    return {
      relevant: true,
      classification: 'classifier-error-fail-closed',
      changedFiles: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function classifyIosGitRange(options) {
  return classifyScopedGitRange(classifyIosChangedPaths, options);
}

export function classifyDesktopRustGitRange(options) {
  return classifyScopedGitRange(classifyDesktopRustChangedPaths, options);
}

/** `--scope` values that answer a single relevant=true|false question. */
const RELEVANCE_SCOPES = Object.freeze({
  ios: { label: 'iOS', classify: classifyIosGitRange },
  'desktop-rust': {
    label: 'desktop Rust',
    classify: classifyDesktopRustGitRange,
  },
});

export function classifyGitRange({ before, after, cwd = process.cwd() }) {
  if (!SHA.test(before) || !SHA.test(after))
    throw new Error('before and after must be full lowercase Git SHAs');
  if (before === ZERO_SHA)
    return {
      heavy: true,
      container: true,
      dependencies: true,
      dependencyScopes: [...ALL_DEPENDENCY_SCOPES],
      classification: 'missing-before-fail-closed',
      changedFiles: null,
    };
  return classifyChangedPaths(
    changedPathsForGitRange({ before, after, mode: 'direct', cwd }),
  );
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function renderGithubOutputs(result) {
  return [
    `heavy=${result.heavy}`,
    `container=${result.container}`,
    `dependencies=${result.dependencies}`,
    `classification=${result.classification}`,
    `changed-files=${result.changedFiles ?? 'unknown'}`,
  ].join('\n');
}

function main(args) {
  const scope = argumentValue(args, '--scope');
  if (scope !== undefined) {
    // An unknown scope must not fall through to the default classifier: its
    // heavy=/container= lines would be read as some other scope's answer.
    // Refusing leaves the caller's malformed-output path to fail closed.
    const relevance = Object.hasOwn(RELEVANCE_SCOPES, scope)
      ? RELEVANCE_SCOPES[scope]
      : undefined;
    if (!relevance) {
      console.error(`Unknown CI classification scope: ${scope}`);
      process.exitCode = 2;
      return;
    }
    const result = relevance.classify({
      before: argumentValue(args, '--before') ?? '',
      after: argumentValue(args, '--after') ?? '',
      mode: argumentValue(args, '--mode') ?? '',
    });
    if (result.error)
      console.error(`${relevance.label} CI classification: ${result.error}`);
    console.log(`relevant=${result.relevant}`);
    return;
  }
  let result;
  try {
    result = classifyGitRange({
      before: argumentValue(args, '--before') ?? ZERO_SHA,
      after: argumentValue(args, '--after') ?? '',
    });
  } catch (error) {
    result = {
      heavy: true,
      container: true,
      dependencies: true,
      dependencyScopes: [...ALL_DEPENDENCY_SCOPES],
      classification: 'classifier-error-fail-closed',
      changedFiles: null,
    };
    console.error(
      `CI change classification failed closed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  console.log(renderGithubOutputs(result));
}

let isMain = false;
try {
  isMain =
    realpathSync(resolve(process.argv[1] ?? '')) ===
    realpathSync(fileURLToPath(import.meta.url));
} catch {
  // A missing entry path cannot be this module's executable invocation.
}
if (isMain) main(process.argv.slice(2));
