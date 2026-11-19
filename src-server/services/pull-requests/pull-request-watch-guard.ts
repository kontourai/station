/**
 * #5066: what a watched Task's agent may not do, read from the tool call
 * itself before it runs. Merging stays with the person, so the agent never
 * merges and never arms auto-merge; it never rewrites published history with a force-push;
 * and it changes CI configuration only when a person approves.
 *
 * This reads the call, not its effect. A command Station cannot see into (a
 * script file, a variable, an alias, `eval`) is not matched; the refusal is
 * a hard stop for the direct forms an agent writes, not a sandbox.
 */
import type { PullRequestWatchRefusalKind } from '@kontourai/station-contracts/pull-request-watch';

export interface PullRequestWatchMatch {
  kind: PullRequestWatchRefusalKind;
  /** What matched, bounded. */
  detail: string;
}

const DETAIL_CHARS = 200;

/** A tool name without case or separators: `writeFile` = `write_file`. */
const key = (toolName: string) =>
  toolName.toLowerCase().replace(/[^a-z0-9]/g, '');

const SHELL_TOOLS = new Set(
  ['bash', 'shell', 'exec_command', 'execute_command', 'run_shell_command'].map(
    key,
  ),
);

const FILE_WRITE_TOOLS = new Set(
  [
    'write',
    'edit',
    'multiedit',
    'notebookedit',
    'fileEditor',
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
    'move',
    'move_file',
    'rename',
    'rename_file',
    'copy',
    'copy_file',
  ].map(key),
);

const PATH_KEYS = [
  'file_path',
  'path',
  'filePath',
  'filepath',
  'notebook_path',
  'abs_path',
  'destination',
  'to',
  'dest',
  'target',
  'new_path',
  'newPath',
] as const;

/**
 * CI configuration a forge runs: GitHub Actions workflows and actions,
 * GitLab, CircleCI, Azure Pipelines, Buildkite, Bitbucket, Travis, Jenkins.
 */
export function isCiConfigPath(candidate: string): boolean {
  const normalized = candidate.replaceAll('\\', '/').toLowerCase();
  const segments = normalized.split('/').filter((s) => s && s !== '.');
  const name = segments.at(-1) ?? '';
  for (let at = 0; at < segments.length - 1; at += 1) {
    if (
      segments[at] === '.github' &&
      (segments[at + 1] === 'workflows' || segments[at + 1] === 'actions')
    )
      return true;
    if (segments[at] === '.circleci' || segments[at] === '.buildkite')
      return true;
  }
  return (
    name === '.gitlab-ci.yml' ||
    name === '.gitlab-ci.yaml' ||
    name === 'azure-pipelines.yml' ||
    name === 'azure-pipelines.yaml' ||
    name === 'bitbucket-pipelines.yml' ||
    name === '.travis.yml' ||
    name === 'jenkinsfile'
  );
}

/**
 * A command's simple commands, each as its words: quotes removed, split at
 * `;`, `&`, `|`, newlines and parentheses. A redirect target is kept as a
 * word prefixed with `>`.
 */
function shellSegments(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | undefined;
  let redirect = false;
  const flushWord = () => {
    if (started) words.push(redirect ? `>${current}` : current);
    if (started) redirect = false;
    current = '';
    started = false;
  };
  const flushSegment = () => {
    flushWord();
    if (words.length) segments.push(words);
    words = [];
    redirect = false;
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
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (char === '\\' && index + 1 < command.length) {
      const next = command[++index]!;
      if (next !== '\n') {
        current += next;
        started = true;
      }
    } else if (char === '>') {
      flushWord();
      redirect = true;
    } else if (/[;&|\n()`]/.test(char)) flushSegment();
    else if (/\s/.test(char)) flushWord();
    else {
      current += char;
      started = true;
    }
  }
  flushSegment();
  return segments;
}

/** The program a segment runs, past `VAR=value` assignments and wrappers. */
function commandOf(words: readonly string[]): string[] {
  let at = 0;
  while (at < words.length) {
    const word = words[at]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) at += 1;
    else if (['sudo', 'command', 'exec', 'nohup', 'env', 'time'].includes(word))
      at += 1;
    else break;
  }
  const rest = words.slice(at);
  const program = rest[0]?.replaceAll('\\', '/').split('/').at(-1) ?? '';
  return [program.replace(/\.exe$/i, '').toLowerCase(), ...rest.slice(1)];
}

/** Git's global options that take a separate value. */
const GIT_VALUE_OPTIONS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
]);

function gitSubcommand(args: readonly string[]): {
  name: string;
  rest: string[];
} {
  let at = 0;
  while (at < args.length && args[at]!.startsWith('-')) {
    at += GIT_VALUE_OPTIONS.has(args[at]!) ? 2 : 1;
  }
  return { name: args[at] ?? '', rest: args.slice(at + 1) };
}

function isForcePush(rest: readonly string[]): boolean {
  let positional = 0;
  for (const word of rest) {
    if (word === '--') continue;
    if (
      word === '--force' ||
      word.startsWith('--force-with-lease') ||
      word === '--force-if-includes' ||
      word === '--mirror'
    )
      return true;
    // Short flags combine: `-fu`, `-uf`.
    if (/^-[A-Za-z]+$/.test(word) && word.slice(1).includes('f')) return true;
    if (!word.startsWith('-')) {
      positional += 1;
      // A `+` refspec forces that ref.
      if (positional >= 2 && word.startsWith('+')) return true;
    }
  }
  return false;
}

function segmentMatch(
  words: readonly string[],
): PullRequestWatchMatch | undefined {
  const text = words.join(' ');
  const detail = text.slice(0, DETAIL_CHARS);
  // GitHub's GraphQL mutation, however it is reached (`gh api graphql`).
  if (/enablePullRequestAutoMerge|enqueuePullRequest/i.test(text))
    return { kind: 'arm-auto-merge', detail };
  const [program = '', ...args] = commandOf(words);
  if (program === 'gh') {
    const verbs = args.filter((word) => !word.startsWith('-'));
    if (
      verbs[0] === 'pr' &&
      verbs[1] === 'merge' &&
      args.some((word) => word === '--auto' || word.startsWith('--auto='))
    )
      return { kind: 'arm-auto-merge', detail };
    // Merging outright is the person's too.
    if (verbs[0] === 'pr' && verbs[1] === 'merge')
      return { kind: 'merge', detail };
    if (
      verbs[0] === 'api' &&
      args.some((word) => /\/pulls\/\d+\/merge$/.test(word))
    )
      return { kind: 'merge', detail };
  }
  if (program === 'glab') {
    const verbs = args.filter((word) => !word.startsWith('-'));
    if (verbs[0] === 'mr' && verbs[1] === 'merge')
      return {
        kind: args.some(
          (word) =>
            word === '--auto-merge' ||
            word === '--auto-merge=true' ||
            word === '--when-pipeline-succeeds',
        )
          ? 'arm-auto-merge'
          : 'merge',
        detail,
      };
  }
  if (program === 'git') {
    const sub = gitSubcommand(args);
    if (sub.name === 'push' && isForcePush(sub.rest))
      return { kind: 'force-push', detail };
    if (
      ['rm', 'mv', 'checkout', 'restore', 'apply', 'am'].includes(sub.name) &&
      sub.rest.some(isCiConfigPath)
    )
      return { kind: 'ci-config', detail };
  }
  // A write to a CI file: a redirect into it, or a command that changes
  // files given one. Reading one (`cat`, `grep`) is fine.
  if (
    words.some((word) => word.startsWith('>') && isCiConfigPath(word.slice(1)))
  )
    return { kind: 'ci-config', detail };
  if (
    [
      'tee',
      'rm',
      'mv',
      'cp',
      'touch',
      'truncate',
      'install',
      'ln',
      'chmod',
      'dd',
    ].includes(program) &&
    args.some(isCiConfigPath)
  )
    return { kind: 'ci-config', detail };
  if (
    ['sed', 'perl'].includes(program) &&
    args.some((word) => /^-[A-Za-z]*i/.test(word) || word === '--in-place') &&
    args.some(isCiConfigPath)
  )
    return { kind: 'ci-config', detail };
  return undefined;
}

function patchTargets(patch: string): string[] {
  const targets: string[] = [];
  for (const line of patch.split('\n')) {
    const match =
      /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(
        line.trimEnd(),
      ) ?? /^(?:\+\+\+|---) (?:[ab]\/)?(.+)$/.exec(line.trimEnd());
    if (match?.[1] && match[1] !== '/dev/null') targets.push(match[1].trim());
  }
  return targets;
}

function writeTargets(toolArgs: unknown): string[] {
  if (typeof toolArgs === 'string') return patchTargets(toolArgs);
  if (!toolArgs || typeof toolArgs !== 'object') return [];
  const record = toolArgs as Record<string, unknown>;
  if (record.command === 'view') return [];
  const targets: string[] = [];
  for (const name of PATH_KEYS) {
    const value = record[name];
    if (typeof value === 'string' && value) targets.push(value);
  }
  for (const name of ['paths', 'files'] as const) {
    const value = record[name];
    if (Array.isArray(value))
      for (const entry of value)
        if (typeof entry === 'string' && entry) targets.push(entry);
  }
  for (const name of ['patch', 'patchText', 'input'] as const) {
    const value = record[name];
    if (typeof value === 'string') targets.push(...patchTargets(value));
  }
  return targets;
}

/** The shell command a tool call runs, when it is a shell tool. */
function shellText(toolArgs: unknown): string | undefined {
  if (typeof toolArgs === 'string') return toolArgs;
  if (!toolArgs || typeof toolArgs !== 'object') return undefined;
  const command = (toolArgs as Record<string, unknown>).command;
  if (Array.isArray(command))
    return command
      .filter((part): part is string => typeof part === 'string')
      .join(' ');
  return typeof command === 'string' ? command : undefined;
}

/** A simple command that opens a pull request or merge request. */
function segmentOpensPullRequest(words: readonly string[]): boolean {
  const text = words.join(' ');
  // GitHub's GraphQL mutation, however it is reached (`gh api graphql`).
  if (/\bcreatePullRequest\b/.test(text)) return true;
  const [program = '', ...args] = commandOf(words);
  const verbs = args.filter((word) => !word.startsWith('-'));
  if (program === 'gh') {
    if (verbs[0] === 'pr' && verbs[1] === 'create') return true;
    // REST: `gh api repos/o/r/pulls` with fields or an explicit POST.
    if (
      verbs[0] === 'api' &&
      args.some((word) => /(?:^|\/)pulls\/?$/.test(word)) &&
      args.some(
        (word, at) =>
          ['-f', '-F', '--field', '--raw-field', '--input'].includes(word) ||
          /^--(?:raw-)?field=/.test(word) ||
          ((word === '-X' || word === '--method') &&
            args[at + 1]?.toUpperCase() === 'POST') ||
          /^--method=post$/i.test(word),
      )
    )
      return true;
  }
  if (program === 'glab' && verbs[0] === 'mr' && verbs[1] === 'create')
    return true;
  if (program === 'hub' && verbs[0] === 'pull-request') return true;
  if (program === 'git') {
    const sub = gitSubcommand(args);
    // GitLab's push option opens a merge request.
    if (
      sub.name === 'push' &&
      sub.rest.some((word) => /merge_request\.create/.test(word))
    )
      return true;
  }
  return false;
}

/**
 * #5063: whether a tool call opens a pull request (or merge request): a
 * forge CLI or API call in a shell tool, or a forge MCP tool such as
 * GitHub's `create_pull_request`. It reads the call, not its effect, like
 * the watch refusals above.
 */
export function matchPullRequestOpen(
  toolName: string,
  toolArgs: unknown,
): boolean {
  const name = key(toolName);
  if (name.endsWith('createpullrequest') || name.endsWith('createmergerequest'))
    return true;
  if (!SHELL_TOOLS.has(name)) return false;
  const text = shellText(toolArgs);
  return !!text && shellSegments(text).some(segmentOpensPullRequest);
}

/**
 * What a tool call would do that a watched Task's agent may not, or
 * nothing. `toolName` is the operation's own name (an engine built-in, or an
 * MCP tool's original name).
 */
export function matchPullRequestWatchRefusal(
  toolName: string,
  toolArgs: unknown,
): PullRequestWatchMatch | undefined {
  const name = key(toolName);
  if (FILE_WRITE_TOOLS.has(name)) {
    const target = writeTargets(toolArgs).find(isCiConfigPath);
    return target === undefined
      ? undefined
      : { kind: 'ci-config', detail: target.slice(0, DETAIL_CHARS) };
  }
  if (SHELL_TOOLS.has(name)) {
    const text = shellText(toolArgs);
    if (!text) return undefined;
    for (const segment of shellSegments(text)) {
      const match = segmentMatch(segment);
      if (match) return match;
    }
  }
  return undefined;
}
