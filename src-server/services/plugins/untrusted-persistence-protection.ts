/**
 * #4828: after a conversation has read content written by others, Station
 * denies writes to known agent-instruction and git-hook locations by path, as
 * a best-effort early check against an injection persisting itself. This
 * does NOT contain git hook execution: a path check before a tool runs cannot
 * see every place git will run a hook from. Containment belongs to OS
 * confinement (#4860).
 *
 * The locations checked: agent-instruction files (`AGENTS.md`, `CLAUDE.md`
 * and their local or override forms, at any depth), engine instruction and
 * configuration directories (`.agents/`, `.claude/`, `.codex/`), a project's
 * `.mcp.json`, `.git/hooks/**` and `.git/config` (a worktree's or
 * submodule's under `.git/` too), the conventional hook folders `.githooks/`
 * and `.husky/`, and the `core.hooksPath` git reports for the repository
 * that contains an absolute write target.
 *
 * The staged pre-tool evaluator applies this. A file-write, move, rename or
 * copy tool with an endpoint at one of these is refused; a shell command
 * that names one, writes git configuration, gives git a global option that
 * configures it or points it elsewhere (`-c`, `--config-env`, `--git-dir`,
 * `--work-tree`, `--exec-path`, `--namespace`, or one Station does not
 * recognise), or assigns `GIT_DIR` or `GIT_CONFIG*`, is sent to the person.
 * Paths are compared by segment, case-insensitively, never by substring.
 * Tool names are compared without case or separators, so a loader's
 * `writeFile` and an engine's `write_file` are one operation.
 *
 * The hooks folder is what git itself reports for the worktree
 * (`git config --get core.hooksPath`, which reads configuration and runs no
 * hook, monitor or other program the repository names). When git cannot be
 * asked, every directory a raw `hooksPath` line names is checked instead,
 * and every `git config` shell command asks.
 *
 * Known gaps, each shown to run a planted hook (#4860):
 * - a `core.hooksPath` that names an absolute directory outside the
 *   repository, locally or globally;
 * - a bare repository's hooks (a receive hook runs on push);
 * - a repository nested inside another repository's hooks folder;
 * - a hooks folder reached through a symlink (paths compare lexically);
 * - a writable `[include]` file that retargets `core.hooksPath` (only the
 *   value at check time is known; git's lookup does not cover the included
 *   file, and the fallback does not read includes);
 * - git invoked inside a quoted `sh -c "…"` payload or through a shell alias.
 *
 * Also not covered: a write through any other link whose name is not
 * checked, a path a shell command builds at run time, a relative path's
 * effective hooks folder (only its name is checked), and an engine whose
 * writes do not reach Station's pre-tool evaluator (Codex's own file changes
 * and commands). A confined session's sandbox keeps `.git/hooks` and
 * `.git/config` read-only regardless of any mark
 * (src-server/security/confinement/seatbelt.ts, bubblewrap.ts,
 * src-server/providers/adapters/codex-confinement.ts).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Agent-instruction file names, at any depth. */
const INSTRUCTION_FILE_NAMES: ReadonlySet<string> = new Set([
  'agents.md',
  'agents.override.md',
  'claude.md',
  'claude.local.md',
  '.mcp.json',
]);

/**
 * Directories whose contents an engine loads as instructions or
 * configuration, or git runs as hooks by convention.
 */
const PROTECTED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  '.agents',
  '.claude',
  '.codex',
  '.githooks',
  '.husky',
]);

/** A tool name without case or separators: `writeFile` = `write_file`. */
function operationKey(toolName: string): string {
  return toolName.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Tools that write, move, rename or copy files, by their operation key: an
 * MCP tool's own name (never a loader's display name), an engine's built-in
 * name, or Station's.
 */
const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set(
  [
    // Claude Code
    'write',
    'edit',
    'multiedit',
    'notebookedit',
    // Station engine
    'fileEditor',
    // Codex, OpenCode and common MCP filesystem servers
    'apply_patch',
    'patch',
    'fs_write',
    'create_file',
    'str_replace_editor',
    'write_file',
    'edit_file',
    'file_write',
    'save_file',
    'delete_file',
    // Moves, renames and copies install a file as surely as a write.
    'move',
    'move_file',
    'rename',
    'rename_file',
    'copy',
    'copy_file',
  ].map(operationKey),
);

/** Editors whose `view` command reads; for any other tool it means nothing. */
const VIEW_COMMAND_TOOLS: ReadonlySet<string> = new Set(
  ['fileEditor', 'str_replace_editor'].map(operationKey),
);

/** Shell tools: the command is read, not the effect. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(
  ['bash', 'shell', 'exec_command', 'execute_command', 'run_shell_command'].map(
    operationKey,
  ),
);

/** Argument keys that name a file a write, move or copy touches. */
const PATH_KEYS = [
  'file_path',
  'path',
  'filePath',
  'filepath',
  'notebook_path',
  'abs_path',
  'source',
  'destination',
  'from',
  'to',
  'src',
  'dest',
  'target',
  'old_path',
  'new_path',
  'oldPath',
  'newPath',
] as const;

/** Argument keys that hold a list of such files. */
const PATH_LIST_KEYS = ['paths', 'files'] as const;

function pathSegments(candidate: string): string[] {
  return path.posix
    .normalize(candidate.replaceAll('\\', '/'))
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .map((segment) => segment.toLowerCase());
}

/** Whether a path names a protected location by its name alone. */
export function isUntrustedPersistencePath(candidate: string): boolean {
  if (!candidate) return false;
  const segments = pathSegments(candidate);
  const last = segments.at(-1);
  if (last !== undefined && INSTRUCTION_FILE_NAMES.has(last)) return true;
  // The directory itself or anything below it.
  if (segments.some((segment) => PROTECTED_DIRECTORY_NAMES.has(segment)))
    return true;
  const git = segments.indexOf('.git');
  if (git === -1) return false;
  const below = segments.slice(git + 1);
  // `.git/hooks/**`, and the hooks of a worktree or submodule git directory.
  if (below.includes('hooks')) return true;
  // `.git/config`, and a worktree's or submodule's `config`.
  return below.at(-1) === 'config' || below.at(-1) === 'config.worktree';
}

/** How long git may take to answer one configuration read. */
const GIT_CONFIG_TIMEOUT_MS = 3_000;

/**
 * The environment git reads configuration under: Station's own, without
 * anything that would point git at another repository, and with no prompt
 * or pager. System and global configuration stay in, because the effective
 * value is what a hook run in that worktree would see.
 */
function gitConfigEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_OPTIONAL_LOCKS: '0',
  };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'])
    delete env[key];
  return env;
}

type GitConfigAnswer =
  | { kind: 'set'; value: string }
  | { kind: 'unset' }
  | { kind: 'unavailable' };

/**
 * Asks git for the effective `core.hooksPath` of a worktree, with `~`
 * expanded (`--type=path`). A fixed argument list, no shell, a short
 * timeout. `git config` reads configuration only: it does not refresh the
 * index or run hooks, `core.fsmonitor` or any other program the repository
 * names (pinned by a test with a monitor that would leave a marker).
 */
function gitHooksPath(worktree: string): GitConfigAnswer {
  const result = spawnSync(
    'git',
    ['-C', worktree, 'config', '--type=path', '--get', 'core.hooksPath'],
    {
      encoding: 'utf8',
      env: gitConfigEnvironment(),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_CONFIG_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (result.error || result.signal) return { kind: 'unavailable' };
  if (result.status === 0) {
    const value = result.stdout.replace(/\r?\n$/, '');
    return value ? { kind: 'set', value } : { kind: 'unset' };
  }
  // `git config --get` answers 1 for a key that is not set; anything else
  // (no repository it trusts, a broken file) is not an answer.
  return result.status === 1 ? { kind: 'unset' } : { kind: 'unavailable' };
}

/** Whether git can be asked at all; checked once. */
let gitPresent: boolean | undefined;
function gitAvailable(): boolean {
  if (gitPresent === undefined) {
    const probe = spawnSync('git', ['--version'], {
      env: gitConfigEnvironment(),
      shell: false,
      stdio: 'ignore',
      timeout: GIT_CONFIG_TIMEOUT_MS,
      windowsHide: true,
    });
    gitPresent = !probe.error && probe.status === 0;
  }
  return gitPresent;
}

/** For tests: forget whether git was found. */
export function resetGitAvailabilityForTests(): void {
  gitPresent = undefined;
}

/** A worktree's root, its git directory and its common git directory. */
function repositoryOf(
  absolute: string,
): { root: string; gitDir: string; commonDir: string } | undefined {
  let root = path.dirname(absolute);
  let dotGit: string | undefined;
  for (let depth = 0; depth < 64; depth += 1) {
    const candidate = path.join(root, '.git');
    if (fs.existsSync(candidate)) {
      dotGit = candidate;
      break;
    }
    const parent = path.dirname(root);
    if (parent === root) return undefined;
    root = parent;
  }
  if (!dotGit) return undefined;
  let gitDir = dotGit;
  try {
    if (fs.statSync(dotGit).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
      if (pointer) gitDir = path.resolve(root, pointer[1]!.trim());
    }
  } catch {
    // Unreadable: the configuration files below are simply not found.
  }
  let commonDir = gitDir;
  try {
    commonDir = path.resolve(
      gitDir,
      fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim(),
    );
  } catch {
    // A main repository has no `commondir`.
  }
  return { root, gitDir, commonDir };
}

/**
 * When git cannot answer: every directory any `hooksPath` line in the
 * repository's or the user's configuration files could name, read
 * generously (with and without quotes, comments and a continuation), so a
 * value git would read differently is still covered.
 */
function rawHooksPathCandidates(repository: {
  gitDir: string;
  commonDir: string;
}): string[] {
  const home = os.homedir();
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  const candidates = new Set<string>();
  for (const file of [
    path.join(xdg, 'git', 'config'),
    path.join(home, '.gitconfig'),
    path.join(repository.commonDir, 'config'),
    path.join(repository.gitDir, 'config.worktree'),
  ]) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const match of text.matchAll(/hookspath\s*=([^\n]*)/gi)) {
      const raw = match[1]!.trim();
      for (const value of [
        raw,
        raw.replace(/^"|"$/g, ''),
        raw.split(/[#;]/)[0]!.trim(),
        raw.replace(/\\$/, '').replace(/^"/, '').trim(),
        // Escapes resolved, then quotes: `"a\"b"` is `a"b`.
        raw.replace(/\\(.)/g, '$1').replace(/^"|"$/g, ''),
      ])
        if (value) candidates.add(value);
    }
  }
  return [...candidates];
}

function expandHome(value: string): string {
  return value === '~' || value.startsWith('~/')
    ? path.join(os.homedir(), value.slice(1))
    : value;
}

/**
 * The hooks folders a write to an absolute path inside a repository could
 * plant a hook in: the effective `core.hooksPath` git reports, resolved as
 * git resolves it (relative to the worktree root). When git cannot answer,
 * every directory a raw `hooksPath` line names.
 */
function effectiveHooksDirectories(absolute: string): string[] {
  const repository = repositoryOf(absolute);
  if (!repository) return [];
  const answer = gitHooksPath(repository.root);
  if (answer.kind === 'set')
    return [path.resolve(repository.root, expandHome(answer.value))];
  if (answer.kind === 'unset') return [];
  return rawHooksPathCandidates(repository).map((value) =>
    path.resolve(repository.root, expandHome(value)),
  );
}

function isInside(directory: string, candidate: string): boolean {
  const relative = path.relative(
    directory.toLowerCase(),
    candidate.toLowerCase(),
  );
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

/** Whether a path is protected by name or is inside the effective hooks folder. */
function isProtectedTarget(candidate: string): boolean {
  if (isUntrustedPersistencePath(candidate)) return true;
  if (!path.isAbsolute(candidate)) return false;
  const absolute = path.resolve(candidate);
  return effectiveHooksDirectories(absolute).some((hooks) =>
    isInside(hooks, absolute),
  );
}

/** Paths an `apply_patch`-style envelope adds, updates, deletes or moves to. */
function patchTargets(patch: string): string[] {
  const targets: string[] = [];
  for (const line of patch.split('\n')) {
    const match =
      /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(
        line.trimEnd(),
      );
    if (match?.[1]) targets.push(match[1].trim());
  }
  return targets;
}

function writeTargets(toolArgs: unknown, viewReads: boolean): string[] {
  if (typeof toolArgs === 'string') return patchTargets(toolArgs);
  if (!toolArgs || typeof toolArgs !== 'object') return [];
  const record = toolArgs as Record<string, unknown>;
  // An editor's `view` reads; only its other commands write.
  if (viewReads && record.command === 'view') return [];
  const targets: string[] = [];
  for (const key of PATH_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) targets.push(value);
  }
  for (const key of PATH_LIST_KEYS) {
    const value = record[key];
    if (Array.isArray(value))
      for (const entry of value)
        if (typeof entry === 'string' && entry.length > 0) targets.push(entry);
  }
  for (const key of ['patch', 'patchText', 'input'] as const) {
    const value = record[key];
    if (typeof value === 'string') targets.push(...patchTargets(value));
  }
  return targets;
}

/**
 * Splits a shell command into words without running it: quotes are removed
 * and operators separate words. A word Station cannot see (a variable, a
 * substitution) stays as written and matches nothing.
 */
function shellWords(command: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  const flush = () => {
    if (current) words.push(current);
    current = '';
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === '\\' && quote === '"' && index + 1 < command.length)
        current += command[++index];
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '\\' && index + 1 < command.length)
      current += command[++index];
    else if (/\s|[;&|<>()`]/.test(char)) flush();
    else current += char;
  }
  flush();
  return words;
}

/** Git's global options that take no value and change nothing persistent. */
const GIT_FLAG_OPTIONS: ReadonlySet<string> = new Set([
  '-p',
  '--paginate',
  '-P',
  '--no-pager',
  '--no-replace-objects',
  '--no-lazy-fetch',
  '--no-optional-locks',
  '--no-advice',
  '--bare',
  '--literal-pathspecs',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
  '-v',
  '--version',
  '-h',
  '--help',
  '--html-path',
  '--man-path',
  '--info-path',
]);

/**
 * What a git invocation in these words does that Station sends to a person:
 * a global option that configures git, points it at another repository or
 * program (`-c`, `--config-env`, `--git-dir`, `--work-tree`, `--exec-path`,
 * `--namespace`), or any global option this does not recognise; then a
 * `git config` that sets a value, or any `git config` when git itself
 * cannot be asked (Station could not tell what it would change). Every
 * global option before the subcommand is read, not only the first.
 */
function gitConfigEffect(words: readonly string[]): string | undefined {
  for (let index = 0; index < words.length; index += 1) {
    const program = path.posix.basename(words[index]!.replaceAll('\\', '/'));
    if (program !== 'git' && program !== 'git.exe') continue;
    let next = index + 1;
    while (next < words.length && words[next]!.startsWith('-')) {
      const option = words[next]!;
      if (option === '-C') {
        // `-C <dir>` only changes where git starts.
        next += 2;
        continue;
      }
      if (GIT_FLAG_OPTIONS.has(option)) {
        next += 1;
        continue;
      }
      return `git ${option.split('=')[0]}`;
    }
    if (words[next] !== 'config') continue;
    if (!gitAvailable()) return 'git config';
    const rest = words.slice(next + 1);
    const reads = rest.some((word) =>
      /^--(get|get-all|get-regexp|get-urlmatch|list|show-origin|show-scope)$|^-l$/.test(
        word,
      ),
    );
    if (!reads) return '.git/config';
  }
  return undefined;
}

/** Whether a tool can reach a protected location at all, by name alone. */
export function isPersistenceRelevantTool(toolName: string): boolean {
  const name = operationKey(toolName);
  return FILE_WRITE_TOOLS.has(name) || SHELL_TOOLS.has(name);
}

export type UntrustedPersistenceVerdict =
  | { kind: 'write'; target: string }
  | { kind: 'shell'; target: string };

/**
 * Whether a tool call reaches a protected location. `toolName` must be the
 * operation's own name: an MCP tool's original name from the loader's
 * provenance, or an engine's or Station's built-in name, never a display
 * name a loader composed.
 */
export function untrustedPersistenceTarget(
  toolName: string,
  toolArgs: unknown,
): UntrustedPersistenceVerdict | undefined {
  const name = operationKey(toolName);
  if (FILE_WRITE_TOOLS.has(name)) {
    const target = writeTargets(toolArgs, VIEW_COMMAND_TOOLS.has(name)).find(
      isProtectedTarget,
    );
    return target === undefined ? undefined : { kind: 'write', target };
  }
  if (SHELL_TOOLS.has(name)) {
    const command =
      toolArgs && typeof toolArgs === 'object'
        ? (toolArgs as Record<string, unknown>).command
        : undefined;
    const text = Array.isArray(command)
      ? command.filter((part) => typeof part === 'string').join(' ')
      : typeof command === 'string'
        ? command
        : undefined;
    if (!text) return undefined;
    const words = shellWords(text);
    // `GIT_DIR=…`, `GIT_CONFIG_*=…` redirect or reconfigure git for the
    // command that follows, as an assignment or an `export`.
    const environment = words.find((word) =>
      /^GIT_(DIR|CONFIG[A-Z0-9_]*)=/.test(word),
    );
    if (environment)
      return { kind: 'shell', target: environment.split('=')[0]! };
    // `>file` and `--file=path` carry a path after a prefix.
    const candidates = words.flatMap((word) => {
      const equals = word.indexOf('=');
      return equals > 0 ? [word, word.slice(equals + 1)] : [word];
    });
    const target = candidates.find(isProtectedTarget);
    if (target !== undefined) return { kind: 'shell', target };
    const effect = gitConfigEffect(words);
    if (effect) return { kind: 'shell', target: effect };
  }
  return undefined;
}

/** ACP tool kinds that change files. */
const ACP_WRITE_KINDS: ReadonlySet<string> = new Set([
  'edit',
  'delete',
  'move',
]);

/**
 * #4828: an ACP tool call that changes files, read from its kind, its
 * reported locations and its input, whether or not the agent named it.
 */
export function acpPersistenceTarget(toolCall: {
  kind?: string | null;
  locations?: readonly { path?: unknown }[] | null;
  rawInput?: unknown;
}): UntrustedPersistenceVerdict | undefined {
  if (!toolCall.kind || !ACP_WRITE_KINDS.has(toolCall.kind)) return undefined;
  const targets = [
    ...(toolCall.locations ?? []).flatMap((location) =>
      typeof location?.path === 'string' ? [location.path] : [],
    ),
    ...writeTargets(toolCall.rawInput, false),
  ];
  const target = targets.find(isProtectedTarget);
  return target === undefined ? undefined : { kind: 'write', target };
}
