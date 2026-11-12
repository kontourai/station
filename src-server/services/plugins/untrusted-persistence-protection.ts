/**
 * #4828: after a conversation has read content written by others, the agent
 * may not write where an injected instruction would outlive the conversation:
 * agent-instruction files (`AGENTS.md`, `CLAUDE.md` and their local or
 * override forms, at any depth), engine instruction and configuration
 * directories (`.agents/`, `.claude/`, `.codex/`), a project's `.mcp.json`,
 * and a repository's hooks and configuration (`.git/hooks/**`, `.git/config`,
 * including a worktree's or submodule's under `.git/`).
 *
 * The staged pre-tool evaluator applies this. A file-write tool whose target
 * is one of these is refused; a shell command that names one is sent to the
 * person, because Station cannot tell a shell read from a write. Paths are
 * compared by segment, case-insensitively (macOS and Windows checkouts are
 * case-insensitive), never by substring.
 *
 * Not covered here: a write through a link whose name is not protected, a
 * shell command that builds the path at run time, and an engine whose writes
 * do not reach Station's pre-tool evaluator (Codex's own file changes and
 * commands). A confined session's sandbox keeps `.git/hooks` and
 * `.git/config` read-only regardless of any mark
 * (src-server/security/confinement/seatbelt.ts, bubblewrap.ts,
 * src-server/providers/adapters/codex-confinement.ts).
 */
import path from 'node:path';

/** Agent-instruction file names, at any depth. */
const INSTRUCTION_FILE_NAMES: ReadonlySet<string> = new Set([
  'agents.md',
  'agents.override.md',
  'claude.md',
  'claude.local.md',
  '.mcp.json',
]);

/** Directories whose contents an engine loads as instructions or configuration. */
const INSTRUCTION_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  '.agents',
  '.claude',
  '.codex',
]);

/**
 * File-write tools, by the name the config-protection stage reads (an MCP
 * tool's own name, without its server prefix), lowercased.
 */
const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  // Claude Code
  'write',
  'edit',
  'multiedit',
  'notebookedit',
  // Station engine
  'fileeditor',
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
]);

/** Shell tools: the command is read, not the effect. */
const SHELL_TOOLS: ReadonlySet<string> = new Set([
  'bash',
  'shell',
  'exec_command',
  'execute_command',
  'run_shell_command',
]);

const PATH_KEYS = [
  'file_path',
  'path',
  'filePath',
  'filepath',
  'notebook_path',
  'abs_path',
] as const;

/** Whether a path names a protected location. */
export function isUntrustedPersistencePath(candidate: string): boolean {
  if (!candidate) return false;
  const segments = path.posix
    .normalize(candidate.replaceAll('\\', '/'))
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .map((segment) => segment.toLowerCase());
  const last = segments.at(-1);
  if (last !== undefined && INSTRUCTION_FILE_NAMES.has(last)) return true;
  // The directory itself or anything below it.
  if (segments.some((segment) => INSTRUCTION_DIRECTORY_NAMES.has(segment)))
    return true;
  const git = segments.indexOf('.git');
  if (git === -1) return false;
  const below = segments.slice(git + 1);
  // `.git/hooks/**`, and the hooks of a worktree or submodule git directory.
  if (below.includes('hooks')) return true;
  // `.git/config`, and a worktree's or submodule's `config`.
  return below.at(-1) === 'config';
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

function writeTargets(toolArgs: unknown): string[] {
  if (typeof toolArgs === 'string') return patchTargets(toolArgs);
  if (!toolArgs || typeof toolArgs !== 'object') return [];
  const record = toolArgs as Record<string, unknown>;
  // Station's file editor reads with `view`; only its other commands write.
  if (record.command === 'view') return [];
  const targets: string[] = [];
  for (const key of PATH_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) targets.push(value);
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

/** `git config <key> <value>` and its write flags; `--get`/`--list` read. */
function writesGitConfig(words: readonly string[]): boolean {
  for (let index = 0; index < words.length; index += 1) {
    if (path.posix.basename(words[index]!) !== 'git') continue;
    // Skip git's own options (`-C dir`, `-c key=value`, `--git-dir=…`).
    let next = index + 1;
    while (next < words.length && words[next]!.startsWith('-')) {
      if (words[next] === '-C' || words[next] === '-c') next += 1;
      next += 1;
    }
    if (words[next] !== 'config') continue;
    const rest = words.slice(next + 1);
    const reads = rest.some((word) =>
      /^--(get|get-all|get-regexp|get-urlmatch|list|show-origin|show-scope)$|^-l$/.test(
        word,
      ),
    );
    if (!reads) return true;
  }
  return false;
}

export type UntrustedPersistenceVerdict =
  | { kind: 'write'; target: string }
  | { kind: 'shell'; target: string };

/**
 * Whether a tool call reaches a protected location. `toolName` is the name
 * the config-protection stage reads (an MCP tool's own name).
 */
export function untrustedPersistenceTarget(
  toolName: string,
  toolArgs: unknown,
): UntrustedPersistenceVerdict | undefined {
  const name = toolName.toLowerCase();
  if (FILE_WRITE_TOOLS.has(name)) {
    const target = writeTargets(toolArgs).find(isUntrustedPersistencePath);
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
    // `>file` and `--file=path` carry a path after a prefix.
    const candidates = words.flatMap((word) => {
      const equals = word.indexOf('=');
      return equals > 0 ? [word, word.slice(equals + 1)] : [word];
    });
    const target = candidates.find(isUntrustedPersistencePath);
    if (target !== undefined) return { kind: 'shell', target };
    if (writesGitConfig(words)) return { kind: 'shell', target: '.git/config' };
  }
  return undefined;
}
