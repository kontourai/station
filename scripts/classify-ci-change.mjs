#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
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
  // trades away, and the daily scan is what replaces it -- a bounded delay,
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
  const output = execFileSync(
    'git',
    ['diff', '--name-only', '-z', before, after, '--'],
    // GitHub's Compare API and native path filters expose at most 300 files.
    // The full checkout is authoritative; an unexpectedly huge diff fails
    // closed at this explicit memory bound instead of silently truncating.
    { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  return classifyChangedPaths(output.split('\0'));
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

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
