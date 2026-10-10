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
 * 1. A slot. On POSIX, execve replaces this process with the native compiler;
 *    the next waiter reclaims its record after exit. On Windows, an owned Job
 *    binds the compiler's lifetime to this slot holder and waits for settlement
 *    before releasing the slot. Neither path leaves an orphan outside the cap.
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
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  toNamespacedPath,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSyncBounded } from './lib/bounded-capture.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';
import {
  acquireTypecheckSlot,
  resolveSlotCount,
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

function nativeCompiler() {
  const require = createRequire(join(REPO_ROOT, 'package.json'));
  const compilerRequire = createRequire(
    require.resolve('typescript/package.json'),
  );
  const platformPackage = compilerRequire.resolve(
    `@typescript/typescript-${process.platform}-${process.arch}/package.json`,
  );
  return toNamespacedPath(
    join(
      dirname(platformPackage),
      'lib',
      process.platform === 'win32' ? 'tsc.exe' : 'tsc',
    ),
  );
}

function bunCompiler(argv, cwd) {
  const args = argv.filter((arg) => arg !== '--noEmit');
  if (
    !argv.includes('--noEmit') ||
    args.length !== 2 ||
    !['-p', '--project'].includes(args[0]) ||
    args[1].startsWith('-')
  )
    throw new Error(
      'Bun diagnostics require --noEmit and an explicit -p project.',
    );
  const manifest = join(cwd, 'package.json');
  if (
    existsSync(manifest) &&
    JSON.parse(readFileSync(manifest, 'utf8')).scripts?.check
  )
    throw new Error(
      'Bun diagnostics cannot run where a package check script shadows the checker.',
    );
  const result = spawnSyncBounded(
    process.env.STATION_BUN_EXECUTABLE || 'bun',
    [
      '-p',
      'JSON.stringify({version:Bun.version,typescript:process.versions.typescript,executable:process.execPath})',
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Bun runtime probe failed: ${result.stderr}`);
  const runtime = JSON.parse(result.stdout);
  if (runtime.version !== '1.4.3' || runtime.typescript !== '7.0.2')
    throw new Error('Bun diagnostics require Bun 1.4.3 with TypeScript 7.0.2.');
  const threads = Math.max(
    1,
    Math.min(4, Math.floor(availableParallelism() / resolveSlotCount())),
  );
  return {
    compiler: runtime.executable,
    args: [
      'check',
      '--threads',
      String(threads),
      '--all',
      '--noEmit',
      '-p',
      resolve(cwd, args[1]),
    ],
    buildInfoFile: null,
  };
}

async function runWindowsCompiler(compiler, args, cwd) {
  const {
    executeOwnedCommand,
    terminateSuiteExecution,
    waitForSuiteSettlement,
  } = await import('./lib/owned-process.mjs');
  // Windows has no execve. The owned-command Job kills the compiler if this
  // slot holder dies, and completion waits for the entire Job to settle.
  const execution = executeOwnedCommand(
    compiler,
    args,
    undefined,
    'typecheck',
    { cwd, env: process.env, stdio: 'inherit', windowsHide: true },
  );
  let interrupted = false;
  let cleanup;
  const stop = () => {
    cleanup ??= terminateSuiteExecution(execution, {
      processLabel: 'typecheck',
      waitForSuiteSettlement,
      terminationGraceMs: 2000,
      terminationForceMs: 2000,
    });
    return cleanup;
  };
  const onSignal = () => {
    interrupted = true;
    void stop();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const result = await execution.completion;
    if (execution.isAlive()) await stop();
    if (cleanup) {
      const settled = await cleanup;
      if (!settled.settled || settled.errors.length)
        throw new Error('Compiler process tree did not settle');
    }
    if (result.error) throw result.error;
    process.exitCode = interrupted || result.signal ? 1 : (result.status ?? 1);
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

async function main(argv = process.argv.slice(2)) {
  const cwd = process.cwd();
  const bun = argv.includes('--bun');
  argv = argv.filter((arg) => arg !== '--bun');
  const plan = bun
    ? bunCompiler(argv, cwd)
    : { compiler: nativeCompiler(), ...planTscArgs(argv, { cwd }) };
  if (plan.buildInfoFile)
    mkdirSync(dirname(plan.buildInfoFile), { recursive: true });
  if (!existsSync(plan.compiler))
    throw new Error(`Compiler not found: ${plan.compiler}`);

  if (needsSlot(argv)) {
    let slot;
    try {
      slot = await acquireTypecheckSlot({ label: describeProject(argv, cwd) });
    } catch (error) {
      process.stderr.write(`${error?.message ?? error}\n`);
      process.exitCode = 1;
      return;
    }
    process.once('exit', slot.release);
    process.env[SLOT_HELD_ENV] = `${slot.dir}#${slot.index}`;
  }
  if (process.platform !== 'win32') {
    // Keep the slot holder's PID: killing it must also kill the compiler.
    // execve bypasses Node's exit hook; the next waiter reclaims its record.
    process.execve(plan.compiler, [plan.compiler, ...plan.args], process.env);
    return;
  }
  await runWindowsCompiler(plan.compiler, plan.args, cwd);
}

if (invokedDirectly(import.meta.url)) {
  await main();
}
