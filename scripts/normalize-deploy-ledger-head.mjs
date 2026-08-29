#!/usr/bin/env node
/**
 * Peels generated deploy-ledger commit-backs from a nightly candidate SHA.
 *
 * The rolling nightly tags point at the source SHA that shipped. Ledger
 * records are committed to main afterwards, so a later scheduled run may see
 * a ledger-only commit at HEAD even though no source changed. This deliberately
 * recognizes only the exact generated record shape; an arbitrary docs commit,
 * a mixed change, or a merge remains a new candidate and builds normally.
 */

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEPLOY_LEDGER_JSON_PATH,
  DEPLOY_LEDGER_MD_PATH,
} from './deploy-ledger.mjs';

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const GENERATED_LEDGER_SUBJECT =
  /^docs\(ledger\): record (?:nightly-android|nightly-npm|nightly-desktop|stable-desktop|stable-npm) .+ from run [1-9][0-9]*$/;
const GENERATED_LEDGER_PATHS = new Set([
  DEPLOY_LEDGER_JSON_PATH,
  DEPLOY_LEDGER_MD_PATH,
]);

function assertSha(sha, name) {
  if (typeof sha !== 'string' || !SHA_PATTERN.test(sha)) {
    throw new Error(`${name} must be a 40-character lowercase hexadecimal SHA`);
  }
}

/**
 * A generated ledger commit has one direct parent and modifies precisely the
 * pair that deploy-ledger-commit.mjs stages. We refuse to peel a merge rather
 * than silently following one parent past an unrelated merged change.
 */
export function isGeneratedDeployLedgerCommit(commit) {
  if (
    !commit ||
    !Array.isArray(commit.parents) ||
    commit.parents.length !== 1 ||
    typeof commit.subject !== 'string' ||
    !GENERATED_LEDGER_SUBJECT.test(commit.subject) ||
    !Array.isArray(commit.changedPaths) ||
    commit.changedPaths.length !== GENERATED_LEDGER_PATHS.size
  ) {
    return false;
  }
  return (
    new Set(commit.changedPaths).size === GENERATED_LEDGER_PATHS.size &&
    commit.changedPaths.every((path) => GENERATED_LEDGER_PATHS.has(path))
  );
}

/**
 * Walk only consecutive generated ledger commits along their direct parent
 * chain. Dependency injection keeps the safety rule unit-testable without a
 * mutable Git fixture or child process.
 */
export function normalizeDeployLedgerHead(
  headSha,
  inspectCommit,
  stopSha = '',
) {
  assertSha(headSha, 'head SHA');
  if (typeof inspectCommit !== 'function') {
    throw new Error('inspectCommit must be a function');
  }
  if (stopSha !== '') assertSha(stopSha, 'stop SHA');

  let normalizedSha = headSha;
  while (true) {
    // The rolling tag is the authoritative last-successful marker. Stop
    // before inspecting it: it may itself be a ledger commit, and peeling
    // through it would turn L2 -> L1 -> C into a false change against L1.
    if (normalizedSha === stopSha) return normalizedSha;
    const commit = inspectCommit(normalizedSha);
    if (!isGeneratedDeployLedgerCommit(commit)) return normalizedSha;
    normalizedSha = commit.parents[0];
    assertSha(normalizedSha, 'ledger commit parent SHA');
  }
}

function runGit(repoRoot, args) {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`,
    );
  }
  return result.stdout;
}

export function inspectCommitFromGit(repoRoot, sha) {
  const metadata = runGit(repoRoot, ['show', '-s', '--format=%P%x00%s', sha]);
  const separator = metadata.indexOf('\0');
  if (separator < 0) throw new Error(`git did not return metadata for ${sha}`);
  const parentText = metadata.slice(0, separator).trim();
  const subject = metadata.slice(separator + 1).trimEnd();
  const changedPaths = runGit(repoRoot, [
    'diff-tree',
    '--no-commit-id',
    '--no-renames',
    '--name-only',
    '-r',
    sha,
  ])
    .split('\n')
    .filter(Boolean);
  return {
    parents: parentText === '' ? [] : parentText.split(/\s+/),
    subject,
    changedPaths,
  };
}

function usage() {
  return [
    'usage: node scripts/normalize-deploy-ledger-head.mjs \\',
    '         --head-sha <40-hex> [--stop-sha <40-hex-or-empty>] [--repo-root <path>]',
    '',
    'Writes the source candidate after peeling consecutive generated ledger commits.',
  ].join('\n');
}

export function main(argv, { inspectCommit = inspectCommitFromGit } = {}) {
  let headSha = null;
  let stopSha = '';
  let repoRoot = process.cwd();
  const seenFlags = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !['--head-sha', '--stop-sha', '--repo-root'].includes(flag) ||
      value === undefined ||
      seenFlags.has(flag)
    ) {
      console.error(usage());
      return 1;
    }
    seenFlags.add(flag);
    if (flag === '--head-sha') headSha = value;
    else if (flag === '--stop-sha') stopSha = value;
    else repoRoot = value;
  }
  if (headSha === null) {
    console.error(usage());
    return 1;
  }
  try {
    process.stdout.write(
      `${normalizeDeployLedgerHead(headSha, (sha) => inspectCommit(repoRoot, sha), stopSha)}\n`,
    );
    return 0;
  } catch (error) {
    console.error(`::error::${error.message}`);
    return 1;
  }
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exit(main(process.argv.slice(2)));
}
