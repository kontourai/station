/**
 * The programs a person can run as a `command` terminal session (#3994): a
 * Project package script by name, or a shell command an agent asked to run
 * and a person approved. Station resolves the executable here; a request
 * names only the script or carries the exact command the person saw.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ShellLaunch } from './shell-host.js';

/**
 * A program that cannot be resolved, for a reason the caller may be told.
 * Every message is authored here; the only interpolations are the requested
 * script name and the package manager's name.
 */
export class TerminalProgramUnavailable extends Error {}

export type TerminalCommandProgram =
  | { kind: 'script'; name: string }
  | { kind: 'run'; command: string };

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface PackageScript {
  name: string;
  /** The script's command line, for display; Station runs it by name. */
  command: string;
}

/** A larger `package.json` is refused rather than read. */
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const MAX_PACKAGE_SCRIPTS = 200;
export const MAX_SCRIPT_NAME_CHARS = 256;

const LOCKFILES: readonly [string, PackageManager][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
];

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readPackageJson(
  root: string,
): Promise<Record<string, unknown> | null> {
  const path = join(root, 'package.json');
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return null;
  }
  if (size > MAX_PACKAGE_JSON_BYTES)
    throw new TerminalProgramUnavailable('package.json is too large to read');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new TerminalProgramUnavailable('package.json is not valid JSON');
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

/**
 * The scripts `root/package.json` declares, in its order, and the package
 * manager that runs them: `packageManager` when it names one, else the
 * lockfile beside it, else npm. No `package.json`: no scripts.
 */
export async function readPackageScripts(root: string): Promise<{
  packageManager: PackageManager;
  scripts: PackageScript[];
}> {
  const pkg = await readPackageJson(root);
  const declared =
    pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const scripts = Object.entries(declared)
    .filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' &&
        entry[0].length > 0 &&
        entry[0].length <= MAX_SCRIPT_NAME_CHARS &&
        // `run -x` would be read as an option, not a script.
        !entry[0].startsWith('-'),
    )
    .slice(0, MAX_PACKAGE_SCRIPTS)
    .map(([name, command]) => ({ name, command }));
  return { packageManager: await packageManagerFor(root, pkg), scripts };
}

async function packageManagerFor(
  root: string,
  pkg: Record<string, unknown> | null,
): Promise<PackageManager> {
  const named =
    typeof pkg?.packageManager === 'string'
      ? pkg.packageManager.split('@')[0]
      : undefined;
  if (
    named === 'npm' ||
    named === 'pnpm' ||
    named === 'yarn' ||
    named === 'bun'
  )
    return named;
  for (const [file, manager] of LOCKFILES)
    if (await exists(join(root, file))) return manager;
  return 'npm';
}

/**
 * The launch for `program` in `cwd`. A script must be one `cwd/package.json`
 * declares now; its package manager is found on the augmented PATH. A run is
 * the platform shell with the command as its one argument.
 */
export async function resolveTerminalCommandLaunch(
  program: TerminalCommandProgram,
  cwd: string,
  deps: {
    findBinary(name: string): Promise<string | null | undefined>;
    path(): Promise<string>;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
  },
): Promise<ShellLaunch> {
  const env = { PATH: await deps.path() };
  const platform = deps.platform ?? process.platform;
  const comspec = (deps.env ?? process.env).COMSPEC ?? 'cmd.exe';
  if (program.kind === 'run') {
    // cmd.exe reads its line verbatim (spawnCommandProcess passes it so):
    // `/s /c "…"` strips the outer quotes and keeps the person's own.
    return platform === 'win32'
      ? {
          file: comspec,
          args: ['/d', '/s', '/c', `"${program.command}"`],
          env,
        }
      : { file: '/bin/sh', args: ['-c', program.command], env };
  }
  const { packageManager, scripts } = await readPackageScripts(cwd);
  if (!scripts.some((script) => script.name === program.name))
    throw new TerminalProgramUnavailable(
      `No package script named "${program.name}"`,
    );
  const file = await deps.findBinary(packageManager);
  if (!file)
    throw new TerminalProgramUnavailable(`${packageManager} is not installed`);
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    // Windows package managers are batch shims, which only cmd.exe runs
    // (spawning one directly fails with EINVAL). cmd interprets the line, so
    // a name it would read as syntax is refused rather than escaped.
    if (!CMD_LITERAL_SCRIPT_NAME.test(program.name) || /[%"]/.test(file))
      throw new TerminalProgramUnavailable(
        `"${program.name}" cannot run on Windows: its name has characters the Windows command processor would interpret`,
      );
    return {
      file: comspec,
      args: ['/d', '/s', '/c', `""${file}" run ${program.name}"`],
      env,
    };
  }
  return { file, args: ['run', program.name], env };
}

/** A script name cmd.exe reads as one literal word. */
const CMD_LITERAL_SCRIPT_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.:+@/-]*$/;
