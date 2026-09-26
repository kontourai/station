#!/usr/bin/env node
/**
 * `tsc`, holding a host-wide typecheck slot and compiling incrementally.
 *
 * Usage: `node scripts/tsc-slot.mjs <tsc arguments>` — the arguments are
 * tsc's own, unchanged. Every `typecheck:*` package script runs its compiler
 * through this runner, so the slot cap in `scripts/lib/typecheck-host-slots.mjs`
 * holds for the aggregate, the pre-push hook, `ci:fast` and ad-hoc runs alike.
 *
 * Two things are added and nothing is removed:
 *
 * 1. A slot. The compiler is loaded IN THIS PROCESS after the slot is taken,
 *    so the slot holder is the compiler itself: its exit releases the slot
 *    and its death (crash, SIGKILL, OOM) leaves a record the next waiter
 *    reclaims. A wrapper that spawned tsc could die and leave an orphaned
 *    compiler running outside the cap.
 * 2. `--incremental --tsBuildInfoFile <cache>/<project>.tsbuildinfo`, unless
 *    the caller already chose incremental settings, uses a mode where they do
 *    not apply (`--build`, `--watch`, ...), or sets
 *    `STATION_TYPECHECK_INCREMENTAL=0`. TypeScript validates the build info
 *    against every input file's content hash and the compiler options, and
 *    re-reports stored diagnostics for unchanged files, so a warm run reports
 *    exactly what a cold one would. An unreadable build info file is treated
 *    as absent (a full compile). The cache lives under the repository's
 *    git-ignored `node_modules/.cache/`, one file per project, so two
 *    projects never share one.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokedDirectly } from './lib/module-entry.mjs';
import {
  acquireTypecheckSlot,
  SLOT_HELD_ENV,
} from './lib/typecheck-host-slots.mjs';

const INCREMENTAL_ENV = 'STATION_TYPECHECK_INCREMENTAL';
const BUILDINFO_DIR_ENV = 'STATION_TSBUILDINFO_DIR';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Modes where the incremental flags are wrong or meaningless. */
const NON_COMPILE_FLAGS = new Set([
  '--build',
  '-b',
  '--watch',
  '-w',
  '--init',
  '--help',
  '-h',
  '--all',
  '--version',
  '-v',
  '--showConfig',
  '--listFilesOnly',
]);

/**
 * Modes that compile nothing (help, version, init, showConfig) or never
 * exit (watch). They run without a slot: a watcher holding one would pin it
 * for as long as the terminal stays open.
 */
const SLOTLESS_FLAGS = new Set([
  '--watch',
  '-w',
  '--init',
  '--help',
  '-h',
  '--all',
  '--version',
  '-v',
  '--showConfig',
]);

/** @param {string[]} args */
export function needsSlot(args) {
  return !args.some((arg) => SLOTLESS_FLAGS.has(flagName(arg)));
}

const CALLER_INCREMENTAL_FLAGS = new Set([
  '--incremental',
  '-i',
  '--tsBuildInfoFile',
  '--composite',
]);

function flagName(arg) {
  return arg.split('=')[0];
}

/** The tsconfig tsc will read for these arguments, relative to `cwd`. */
export function projectConfigPath(args, cwd) {
  let project = 'tsconfig.json';
  for (let index = 0; index < args.length; index += 1) {
    const name = flagName(args[index]);
    if (name === '-p' || name === '--project') {
      project = args[index].includes('=')
        ? args[index].slice(args[index].indexOf('=') + 1)
        : (args[index + 1] ?? project);
    }
  }
  const absolute = resolve(cwd, project);
  try {
    if (statSync(absolute).isDirectory())
      return join(absolute, 'tsconfig.json');
  } catch {
    // tsc reports a missing project itself.
  }
  return absolute;
}

/**
 * One build info file per project config. Paths inside the repository map
 * to a readable name (`packages__shared__tsconfig.json.tsbuildinfo`); a
 * config elsewhere gets a digest of its absolute path.
 */
function buildInfoPathFor(configPath, { repoRoot, cacheDir }) {
  const rel = relative(repoRoot, configPath);
  const name =
    rel && !rel.startsWith('..') && !isAbsolute(rel)
      ? rel.replace(/[\\/]+/g, '__').replace(/[^A-Za-z0-9._-]/g, '_')
      : `external-${createHash('sha256').update(configPath).digest('hex').slice(0, 16)}`;
  return join(cacheDir, `${name}.tsbuildinfo`);
}

/**
 * The tsc argument list this runner executes.
 *
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, repoRoot?: string }} [options]
 * @returns {{ args: string[], buildInfoFile: string | null }}
 */
export function planTscArgs(
  args,
  { cwd = process.cwd(), env = process.env, repoRoot = REPO_ROOT } = {},
) {
  const names = args.map(flagName);
  if (
    env[INCREMENTAL_ENV] === '0' ||
    names.some((name) => NON_COMPILE_FLAGS.has(name)) ||
    names.some((name) => CALLER_INCREMENTAL_FLAGS.has(name))
  ) {
    return { args: [...args], buildInfoFile: null };
  }
  const cacheDir =
    env[BUILDINFO_DIR_ENV] ||
    join(repoRoot, 'node_modules', '.cache', 'station-tsbuildinfo');
  const buildInfoFile = buildInfoPathFor(projectConfigPath(args, cwd), {
    repoRoot,
    cacheDir,
  });
  return {
    args: [...args, '--incremental', '--tsBuildInfoFile', buildInfoFile],
    buildInfoFile,
  };
}

function describeProject(args, cwd) {
  const config = projectConfigPath(args, cwd);
  const rel = relative(REPO_ROOT, config);
  return rel && !rel.startsWith('..') ? rel.replaceAll('\\', '/') : config;
}

async function main(argv = process.argv.slice(2)) {
  const cwd = process.cwd();
  const plan = planTscArgs(argv, { cwd });
  if (plan.buildInfoFile)
    mkdirSync(dirname(plan.buildInfoFile), { recursive: true });

  const require = createRequire(join(REPO_ROOT, 'package.json'));
  const compiler = require.resolve('typescript/lib/tsc.js');
  if (!existsSync(compiler))
    throw new Error(`TypeScript not found: ${compiler}`);

  if (needsSlot(argv)) {
    let slot;
    try {
      slot = await acquireTypecheckSlot({ label: describeProject(argv, cwd) });
    } catch (error) {
      process.stderr.write(`${error?.message ?? error}\n`);
      process.exitCode = 1;
      return;
    }
    // tsc ends with process.exit(); the `exit` event is the one hook that
    // runs on that path, and on an uncaught exception too.
    process.once('exit', slot.release);
    process.env[SLOT_HELD_ENV] = `${slot.dir}#${slot.index}`;
  }
  process.argv = [process.argv[0], compiler, ...plan.args];
  require(compiler);
}

if (invokedDirectly(import.meta)) {
  await main();
}
