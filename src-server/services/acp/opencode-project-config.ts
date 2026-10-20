/**
 * #3924: OpenCode project configuration is code OpenCode runs at launch.
 *
 * OpenCode loads `opencode.json` / `opencode.jsonc` and `.opencode/`
 * directories from every directory between the session's directory and the
 * project root (the git root; with no git root, up to the filesystem root),
 * checked against OpenCode 1.18.18. From them it imports plugins
 * (`.opencode/plugin(s)/`, a config `plugin` list) and custom tools
 * (`.opencode/tool(s)/`) at load, even for `opencode debug agent`, and starts
 * local MCP servers, formatters and language servers they declare. None of
 * that asks a person. So under Station's approval modes short of host full
 * access:
 *
 * - an edit to such a path, or to anything outside the project (OpenCode's
 *   global configuration lives there), is a person's to answer: no mode,
 *   session grant or OpenCode "always" answers it (`openCodeEditNeedsPerson`);
 * - a project that declares such code is not governed: Station refuses
 *   before it launches OpenCode, the preflight included, because that code
 *   would run outside any approval mode (`findOpenCodeProjectCode`).
 *
 * The user's own home directory and above are the user's scope, as are
 * OpenCode's global configuration directories: they are not scanned.
 */
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  parse as parsePath,
  relative,
  resolve,
  sep,
} from 'node:path';
import { type ParseError, parse } from 'jsonc-parser';

const CONFIG_FILE_NAMES = ['opencode.json', 'opencode.jsonc'] as const;
const CODE_DIR_NAMES = ['plugin', 'plugins', 'tool', 'tools'] as const;
/** A configuration file larger than this is not read, and is refused. */
export const OPENCODE_CONFIG_SCAN_MAX_BYTES = 1024 * 1024;

/** The real path of `path`, or of its deepest existing ancestor joined back. */
function realish(path: string): string {
  let existing = path;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return path;
    rest.unshift(basename(existing));
    existing = parent;
  }
  try {
    return join(realpathSync(existing), ...rest);
  } catch {
    return path;
  }
}

/**
 * The directory OpenCode treats as the project root for `cwd`: the nearest
 * ancestor holding `.git` (a directory or a worktree's file), or `undefined`.
 */
export function openCodeGitRoot(cwd: string): string | undefined {
  let dir = realish(resolve(cwd));
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Whether `path` is one OpenCode loads configuration or code from: any path
 * through a `.opencode` directory, or a file named `opencode.json(c)`, at any
 * depth (a session can start in a nested directory). Compared without case,
 * as a case-insensitive file system resolves it.
 */
export function isOpenCodeConfigPath(path: string): boolean {
  const parts = path.split(/[\\/]+/).map((part) => part.toLowerCase());
  const name = parts.at(-1) ?? '';
  return (
    parts.includes('.opencode') ||
    (CONFIG_FILE_NAMES as readonly string[]).includes(name)
  );
}

/**
 * The files an OpenCode edit permission request names, from the ACP
 * request's `rawInput` (OpenCode sends the permission's metadata there):
 * `filepath` (absolute) for `edit` and `write`, `files[].filePath` and
 * `movePath` for `apply_patch` (whose `filepath` joins relative paths and is
 * not used). `undefined` when no target can be read.
 */
export function openCodeEditTargets(rawInput: unknown): string[] | undefined {
  if (!rawInput || typeof rawInput !== 'object') return undefined;
  const input = rawInput as { filepath?: unknown; files?: unknown };
  if (Array.isArray(input.files)) {
    const targets: string[] = [];
    for (const file of input.files) {
      if (!file || typeof file !== 'object') return undefined;
      const { filePath, movePath } = file as {
        filePath?: unknown;
        movePath?: unknown;
      };
      if (typeof filePath !== 'string' || !isAbsolute(filePath))
        return undefined;
      targets.push(filePath);
      if (movePath !== undefined) {
        if (typeof movePath !== 'string' || !isAbsolute(movePath))
          return undefined;
        targets.push(movePath);
      }
    }
    return targets.length > 0 ? targets : undefined;
  }
  return typeof input.filepath === 'string' && isAbsolute(input.filepath)
    ? [input.filepath]
    : undefined;
}

/**
 * Whether an ACP permission request is an OpenCode file change, or a step
 * toward one: the `edit` tool kind, or a request whose input names a file
 * (`edit`, `write` and `apply_patch` metadata, and `external_directory` for
 * a file outside the project).
 */
export function isOpenCodeEditShaped(
  kind: unknown,
  rawInput: unknown,
): boolean {
  if (kind === 'edit') return true;
  if (!rawInput || typeof rawInput !== 'object') return false;
  const input = rawInput as { filepath?: unknown; files?: unknown };
  return input.filepath !== undefined || input.files !== undefined;
}

/**
 * `isInside` without letter case where the file system usually ignores it
 * (macOS, Windows), for paths whose case-variant spelling must still match.
 */
function isInsideIgnoringCase(path: string, root: string): boolean {
  return process.platform === 'darwin' || process.platform === 'win32'
    ? isInside(path.toLowerCase(), root.toLowerCase())
    : isInside(path, root);
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return (
    rel === '' ||
    (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  );
}

/**
 * Where a write to `target` lands, walked one component at a time with
 * `lstat`, or `undefined` when a person must decide. A symbolic link at or
 * below the project `root` is project content the agent could have written,
 * so it is not followed: a write through it, dangling or not, can land
 * anywhere (#3924). A link above the project (such as `/var` on macOS) is
 * resolved; one that cannot be resolved is refused. Components that do not
 * exist yet are taken as written: nothing beneath them can be a link.
 *
 * The path is judged as written, never normalized first: OpenCode hands the
 * same raw path to the file system, which resolves `link/..` through the
 * link, while `path.resolve` would collapse it away. So a path that is not
 * already absolute and normalized (a `.` or `..` segment, a repeated
 * separator) is refused rather than reinterpreted.
 */
function writeDestination(target: string, root: string): string | undefined {
  if (!isAbsolute(target) || normalize(target) !== target) return undefined;
  const absolute = target;
  const parts = absolute.split(sep).filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) return undefined;
  // A Windows 8.3 short name (`PROGRA~1`) names a directory by an alias the
  // checks below would not recognize.
  if (process.platform === 'win32' && parts.some((part) => /~\d/.test(part)))
    return undefined;
  let current = parsePath(absolute).root;
  for (const [index, part] of parts.entries()) {
    const candidate = join(current, part);
    let isLink: boolean;
    try {
      isLink = lstatSync(candidate).isSymbolicLink();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
      return join(candidate, ...parts.slice(index + 1));
    }
    if (!isLink) {
      current = candidate;
      continue;
    }
    if (isInside(candidate, root)) return undefined;
    try {
      current = realpathSync(candidate);
    } catch {
      return undefined;
    }
  }
  return current;
}

/**
 * OpenCode's global configuration locations, from the environment Station
 * launches it with: `$XDG_CONFIG_HOME/opencode` (else `~/.config/opencode`),
 * `OPENCODE_CONFIG_DIR` and the `OPENCODE_CONFIG` file. Usually outside the
 * project already; listed for a project that contains them (a session
 * started in the home directory).
 */
function openCodeGlobalConfigPaths(
  env: NodeJS.ProcessEnv,
  home: string,
): string[] {
  return [
    join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode'),
    env.OPENCODE_CONFIG_DIR,
    env.OPENCODE_CONFIG,
  ]
    .filter((path): path is string => !!path)
    .map((path) => realish(resolve(path)));
}

/**
 * Whether an OpenCode edit request must be answered by a person: a target
 * that cannot be read, one written through a symbolic link in the project,
 * one outside the project (the git root of `cwd`, else `cwd`), or an
 * OpenCode configuration path (project or global).
 */
export function openCodeEditNeedsPerson(
  rawInput: unknown,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): boolean {
  const targets = openCodeEditTargets(rawInput);
  if (!targets) return true;
  const root = openCodeGitRoot(cwd) ?? realish(resolve(cwd));
  const global = openCodeGlobalConfigPaths(env, home);
  return targets.some((target) => {
    const real = writeDestination(target, root);
    return (
      real === undefined ||
      !isInside(real, root) ||
      isOpenCodeConfigPath(relative(root, real)) ||
      isOpenCodeConfigPath(relative(root, resolve(target))) ||
      global.some((path) => isInsideIgnoringCase(real, path))
    );
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Entries of a config map (`mcp`, `formatter`, `lsp`) that run a command. */
function commandEntries(value: unknown, key: string): string[] {
  if (!isPlainObject(value)) return [];
  return Object.entries(value)
    .filter(([, entry]) => {
      if (!isPlainObject(entry)) return false;
      if (entry.enabled === false || entry.disabled === true) return false;
      return (
        entry.command !== undefined || (key === 'mcp' && entry.type === 'local')
      );
    })
    .map(([name]) => `${key} "${name}"`);
}

async function configFileFindings(path: string): Promise<string[]> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return [];
  }
  if (size > OPENCODE_CONFIG_SCAN_MAX_BYTES) {
    return [`${path} (too large for Station to check)`];
  }
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [`${path} (Station could not read it)`];
  }
  const errors: ParseError[] = [];
  const parsed: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isPlainObject(parsed)) {
    return [`${path} (Station could not parse it)`];
  }
  const found = [
    ...(Array.isArray(parsed.plugin) && parsed.plugin.length > 0
      ? ['plugin']
      : []),
    ...commandEntries(parsed.mcp, 'mcp'),
    ...commandEntries(parsed.formatter, 'formatter'),
    ...commandEntries(parsed.lsp, 'lsp'),
  ];
  return found.map((what) => `${path} (${what})`);
}

async function codeDirFindings(dotDir: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of CODE_DIR_NAMES) {
    const dir = join(dotDir, name);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    if (entries.length > 0) found.push(dir);
  }
  return found;
}

/**
 * The project-scoped OpenCode configuration under `cwd` that would run code
 * when OpenCode launches there: plugins and custom tools in `.opencode/`,
 * and `plugin`, local `mcp`, `formatter` and `lsp` commands in
 * `opencode.json(c)` (at each level and inside `.opencode/`). A file Station
 * cannot read, parse or bound is listed too: it cannot be shown to be safe.
 * Directories from `cwd` up to the git root (or the top, as OpenCode does
 * without one) are scanned, stopping before `home`.
 */
export async function findOpenCodeProjectCode(
  cwd: string,
  home: string = homedir(),
): Promise<string[]> {
  const start = realish(resolve(cwd));
  const stop = openCodeGitRoot(start);
  const homeDir = realish(resolve(home));
  const findings: string[] = [];
  let dir = start;
  for (;;) {
    if (isInside(homeDir, dir)) break;
    for (const name of CONFIG_FILE_NAMES) {
      findings.push(...(await configFileFindings(join(dir, name))));
    }
    const dotDir = join(dir, '.opencode');
    let isDir = false;
    try {
      isDir = statSync(dotDir).isDirectory();
    } catch {}
    if (isDir) {
      findings.push(...(await codeDirFindings(dotDir)));
      for (const name of CONFIG_FILE_NAMES) {
        findings.push(...(await configFileFindings(join(dotDir, name))));
      }
    }
    if (stop && dir === stop) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return findings;
}

/** The refusal reason for a project whose OpenCode configuration runs code. */
export function openCodeProjectCodeRefusal(
  findings: readonly string[],
): string {
  const shown = findings.slice(0, 5).join('; ');
  const more = findings.length > 5 ? `; and ${findings.length - 5} more` : '';
  return `this project's OpenCode configuration runs its own code when OpenCode starts, which no approval mode covers (${shown}${more})`;
}
