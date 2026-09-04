#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
const ZERO_SHA = '0'.repeat(40);

export function classifyChangedPaths(paths) {
  const normalized = [...new Set(paths.filter(Boolean))];
  const nonDocs = normalized.filter((path) => !path.startsWith('docs/'));
  const dependencies = normalized.some(
    (changedPath) =>
      changedPath === '.npmrc' ||
      changedPath.endsWith('/.npmrc') ||
      changedPath === 'package.json' ||
      changedPath === 'package-lock.json' ||
      changedPath === 'npm-shrinkwrap.json' ||
      changedPath.endsWith('/package.json') ||
      changedPath.endsWith('/package-lock.json') ||
      changedPath.endsWith('/npm-shrinkwrap.json') ||
      changedPath === 'scripts/dependency-advisory-exceptions.json',
  );
  return {
    heavy: nonDocs.length > 0,
    container: nonDocs.length > 0,
    dependencies,
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
