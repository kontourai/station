/**
 * #4828: after a conversation has read content written by others, the agent
 * may not write where an injected instruction would outlive the conversation:
 * agent-instruction files (`AGENTS.md`, `CLAUDE.md` and their local or
 * override forms, at any depth), engine instruction and configuration
 * directories (`.agents/`, `.claude/`, `.codex/`), a project's `.mcp.json`,
 * and a repository's hooks and configuration: `.git/hooks/**`, `.git/config`
 * (a worktree's or submodule's under `.git/` too), the conventional hook
 * folders `.githooks/` and `.husky/`, and the repository's effective
 * `core.hooksPath`.
 *
 * The staged pre-tool evaluator applies this. A file-write, move, rename or
 * copy tool with either endpoint at one of these is refused; a shell command
 * that names one, writes git configuration, or runs git with configuration
 * that executes programs (`-c core.hooksPath`, `core.fsmonitor`,
 * `core.sshCommand`, an alias, `GIT_CONFIG*` or `GIT_DIR`) is sent to the
 * person, because Station cannot tell what a shell command does. Paths are
 * compared by segment, case-insensitively (macOS and Windows checkouts are
 * case-insensitive), never by substring. Tool names are compared without
 * case or separators, so a loader's `writeFile` and an engine's `write_file`
 * are one operation.
 *
 * The effective hooks folder is read from the repository's own configuration
 * files (and the user's global one) by parsing them: no git command or other
 * program the repository could control runs. It is resolved for an absolute
 * target only; a relative one is protected by name.
 *
 * Not covered here: a write through a link whose name is not protected, a
 * path a shell command builds at run time, a hooks path set through an
 * `include` or the system configuration, and an engine whose writes do not
 * reach Station's pre-tool evaluator (Codex's own file changes and commands).
 * A confined session's sandbox keeps `.git/hooks` and `.git/config` read-only
 * regardless of any mark (src-server/security/confinement/seatbelt.ts,
 * bubblewrap.ts, src-server/providers/adapters/codex-confinement.ts).
 */
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

/** The last `core.hooksPath` a git configuration file sets, if any. */
function hooksPathIn(file: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  let section = '';
  let found: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[\s*([^\]\s"]+)(?:\s+"[^"]*")?\s*\]/.exec(line);
    if (header) {
      section = header[1]!.toLowerCase();
      continue;
    }
    if (section !== 'core') continue;
    const entry = /^hookspath\s*=\s*(.*)$/i.exec(line);
    if (!entry) continue;
    let value = entry[1]!;
    if (value.startsWith('"')) {
      const end = value.indexOf('"', 1);
      value = end === -1 ? value.slice(1) : value.slice(1, end);
    } else {
      value = value.replace(/\s[#;].*$/, '').trim();
    }
    found = value;
  }
  return found;
}

/**
 * The repository's effective hooks folder for an absolute path inside it:
 * the last `core.hooksPath` its global, local and worktree configuration
 * files set, resolved as git resolves it (relative to the worktree root).
 * Read by parsing those files; nothing runs.
 */
function effectiveHooksDirectory(absolute: string): string | undefined {
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
      if (!pointer) return undefined;
      gitDir = path.resolve(root, pointer[1]!.trim());
    }
  } catch {
    return undefined;
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
  const home = os.homedir();
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  let value: string | undefined;
  for (const file of [
    path.join(xdg, 'git', 'config'),
    path.join(home, '.gitconfig'),
    path.join(commonDir, 'config'),
    path.join(gitDir, 'config.worktree'),
  ])
    value = hooksPathIn(file) ?? value;
  if (!value) return undefined;
  if (value === '~' || value.startsWith('~/'))
    value = path.join(home, value.slice(1));
  return path.resolve(root, value);
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
  const hooks = effectiveHooksDirectory(path.resolve(candidate));
  return hooks !== undefined && isInside(hooks, path.resolve(candidate));
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

/** Configuration keys that make git run a program the value names. */
function runsProgram(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower === 'core.hookspath' ||
    lower === 'core.fsmonitor' ||
    lower === 'core.sshcommand' ||
    lower.startsWith('alias.')
  );
}

/**
 * What a git invocation in these words does that persists or runs a
 * program: `git config` setting a value, or `-c`/`--config-env` with a key
 * that runs one. `undefined` when neither.
 */
function gitConfigEffect(words: readonly string[]): string | undefined {
  for (let index = 0; index < words.length; index += 1) {
    if (path.posix.basename(words[index]!) !== 'git') continue;
    let next = index + 1;
    while (next < words.length && words[next]!.startsWith('-')) {
      const option = words[next]!;
      let setting: string | undefined;
      if (option === '-c' || option === '--config-env') {
        setting = words[next + 1];
        next += 1;
      } else if (option.startsWith('-c')) setting = option.slice(2);
      else if (option.startsWith('--config-env='))
        setting = option.slice('--config-env='.length);
      else if (option === '-C') next += 1;
      if (setting !== undefined) {
        const key = setting.split('=')[0] ?? '';
        if (runsProgram(key)) return `git -c ${key}`;
      }
      next += 1;
    }
    if (words[next] !== 'config') continue;
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
