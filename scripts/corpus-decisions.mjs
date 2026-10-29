#!/usr/bin/env node
/**
 * Runs Corpus's decision-registry commands at Station's Corpus pin.
 *
 * `check` validates every record in docs/decisions and the generated index.
 * Because corpus.json declares `decisions.adr`, it also runs the ADR freeze:
 * any file added under docs/adr since the merge base of the base ref fails.
 * The base is ci:fast's own (`fastBase`): fast-checks statics sets it to the
 * pull request or merge-group base, and it is origin/main locally. Without a
 * base the freeze would only be reported as SKIP.
 *
 * `index` rewrites docs/decisions/index.md.
 *
 * Corpus is not published to npm. This uses the codeload tarball at the same
 * commit as docs-kit.yml's corpus-ref; the Corpus pin test keeps them equal.
 * It is a Node wrapper rather than an npm script so the base needs no shell
 * expansion, which cmd.exe does not do.
 */
import { spawnSync } from 'node:child_process';
import { invokedDirectly } from './lib/module-entry.mjs';
import { npmInvocation } from './lib/npm-cli.mjs';
import { fastBase } from './run-ci-fast.mjs';

export const CORPUS_PIN = 'b8ecf4cd4c6482bb804cdeea617ebe2d9b78ab05';
const CORPUS_PACKAGE = `https://codeload.github.com/kontourai/corpus/tar.gz/${CORPUS_PIN}`;

/** The npm arguments for one subcommand; refuses anything else. */
export function corpusDecisionsNpmArgs(subcommand, env = process.env) {
  const corpus = ['exec', '--yes', `--package=${CORPUS_PACKAGE}`, '--'];
  if (subcommand === 'check')
    return [...corpus, 'corpus', 'decisions', 'check', '--base', fastBase(env)];
  if (subcommand === 'index')
    return [...corpus, 'corpus', 'decisions', 'index'];
  throw new Error(
    `usage: node scripts/corpus-decisions.mjs check|index (got ${subcommand ?? 'nothing'})`,
  );
}

/**
 * @param {string | undefined} subcommand
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   spawn?: (
 *     command: string,
 *     args: string[],
 *     options: import('node:child_process').SpawnSyncOptions,
 *   ) => { status: number | null, signal?: NodeJS.Signals | null, error?: Error },
 * }} [options]
 */
export function runCorpusDecisions(
  subcommand,
  { env = process.env, spawn = spawnSync } = {},
) {
  const invocation = npmInvocation(corpusDecisionsNpmArgs(subcommand, env), {
    env,
  });
  const result = spawn(invocation.command, invocation.args, {
    stdio: 'inherit',
    env,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  // A signal-terminated run has no status; it is not a pass.
  return Number.isInteger(result.status) ? result.status : 1;
}

if (invokedDirectly(import.meta.url)) {
  try {
    process.exitCode = runCorpusDecisions(process.argv[2]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
