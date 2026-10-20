import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * #3800: the `.codex` directories a session not started as `host` would load
 * that the repository does not account for.
 *
 * Station's permission profile denies `.codex` under the workspace roots,
 * but not under `/tmp` and `TMPDIR` (Codex refuses glob rules there), and
 * moving an ANCESTOR of a denied path is not a write to it. So an agent can
 * build `/tmp/x/pkg/.codex/config.toml` and move `pkg` into its workspace; a
 * later session started in `pkg` loads it and runs its `mcp_servers` command
 * outside the sandbox at `thread/start` (EXECUTED, codex-cli 0.162.1).
 * Nothing in the sandbox can see that coming, so the start checks what is on
 * disk before Codex is spawned.
 *
 * Every directory from the outermost Git work tree containing the cwd (or
 * the cwd alone when there is none) down to the cwd is checked, the lexical
 * path and the resolved one both: a superset of the layers Codex reads. A
 * `.codex` there is accepted only when it is a real directory whose every
 * file is a blob of that outermost repository's `HEAD` with the same bytes
 * (so a `.codex` committed only in a nested repository or submodule, whose
 * files the outer `HEAD` does not hold, is not). That is the repository's own configuration,
 * with the trust its root `.codex` already has. Anything else (untracked,
 * modified, ignored, a symlink, inside a nested or planted repository, or a
 * project with no repository at all) is reported, including an untracked
 * `.codex` at the repository root: Station cannot tell an operator's local
 * file from one an agent placed there.
 *
 * The outermost repository is the anchor because a planted one is
 * necessarily nested inside the workspace. Below it, a linked worktree the
 * outermost repository registered is judged against its own `HEAD`.
 *
 * Known limits:
 * - A workspace that is not in a Git repository at all has no anchor: an
 *   agent that plants a whole committed repository there is not told apart
 *   from a real one.
 * - A project inside another repository (a home-directory dotfiles
 *   repository, say) is judged against that outer one, so its own committed
 *   `.codex` is refused. Bounding the walk needs the Project root, which the
 *   start input does not carry.
 * - A `.codex` committed in `HEAD` but absent on disk is accepted once it
 *   appears with the same bytes, by any route. A session that can write
 *   objects and move a branch (Claude's Seatbelt git grants) could commit
 *   one and then stage the matching bytes through temp.
 *
 * The user's own `~/.codex` (and `CODEX_HOME`) is user configuration, not a
 * project layer, and is skipped.
 *
 * Git is asked only for `ls-tree` and `hash-object --no-filters` in the
 * outermost repository: neither runs hooks, filters or fsmonitor.
 */
export function findUnaccountedCodexConfig(
  cwd: string,
  options: { codexHome?: string; gitTimeoutMs?: number } = {},
): string | undefined {
  const skipped = new Set(
    [join(homedir(), '.codex'), options.codexHome]
      .filter((path): path is string => Boolean(path))
      .map((path) => resolve(path)),
  );
  const lexical = resolve(cwd);
  const paths = [lexical];
  try {
    const real = realpathSync(lexical);
    if (real !== lexical) paths.push(real);
  } catch {
    // A missing cwd fails the start on its own.
  }
  for (const path of paths) {
    const found = findOnPath(path, skipped, options.gitTimeoutMs);
    if (found) return found;
  }
  return undefined;
}

const MAX_CONFIG_FILES = 256;

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function ancestors(path: string): string[] {
  const chain = [path];
  for (let dir = dirname(path); dir !== chain.at(-1); dir = dirname(dir))
    chain.push(dir);
  return chain;
}

function findOnPath(
  cwd: string,
  skipped: ReadonlySet<string>,
  gitTimeoutMs: number | undefined,
): string | undefined {
  const chain = ancestors(cwd);
  let outer: string | undefined;
  for (const dir of chain) if (exists(join(dir, '.git'))) outer = dir;
  const walk = outer
    ? chain.slice(0, chain.indexOf(outer) + 1).reverse()
    : [cwd];
  // The work tree whose `HEAD` a `.codex` is judged against: the outermost,
  // or below it a linked worktree that repository itself registered.
  let trusted = outer;
  for (const dir of walk) {
    if (
      trusted &&
      dir !== trusted &&
      registeredWorktreeOf(trusted, dir, gitTimeoutMs)
    )
      trusted = dir;
    const config = join(dir, '.codex');
    if (skipped.has(config) || !exists(config)) continue;
    if (!trusted || !matchesHead(trusted, config, gitTimeoutMs)) return config;
  }
  return undefined;
}

/**
 * Whether `dir` is a linked worktree that `repository` registered: its
 * `.git` is a gitfile naming `<common dir>/worktrees/<name>`, whose own
 * `gitdir` points back at `dir/.git`. An agent cannot write the common dir,
 * so a repository it staged elsewhere and moved in (its own `.git`
 * directory, or a gitfile borrowing another worktree's entry) is not one.
 */
function registeredWorktreeOf(
  repository: string,
  dir: string,
  gitTimeoutMs: number | undefined,
): boolean {
  try {
    const gitfile = join(dir, '.git');
    if (!lstatSync(gitfile).isFile()) return false;
    const match = /^gitdir: (.+)$/m.exec(readFileSync(gitfile, 'utf8'));
    if (!match) return false;
    const entry = realpathSync(resolve(dir, match[1]!.trim()));
    const common = realpathSync(
      git(
        repository,
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        gitTimeoutMs,
      ).trim(),
    );
    if (dirname(entry) !== join(common, 'worktrees')) return false;
    const back = readFileSync(join(entry, 'gitdir'), 'utf8').trim();
    return realpathSync(resolve(entry, back)) === realpathSync(gitfile);
  } catch {
    return false;
  }
}

/** Every file under `config` is a regular file whose bytes are its `HEAD` blob. */
function matchesHead(
  repository: string,
  config: string,
  gitTimeoutMs: number | undefined,
): boolean {
  const files: string[] = [];
  const pending = [config];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    const stat = lstatSync(dir);
    if (!stat.isDirectory()) return false;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
      else return false;
      if (files.length > MAX_CONFIG_FILES) return false;
    }
  }
  const prefix = relative(repository, config).split(sep).join('/');
  let tree: string;
  try {
    tree = git(
      repository,
      ['ls-tree', '-r', '-z', '--full-tree', 'HEAD', '--', prefix],
      gitTimeoutMs,
    );
  } catch {
    return false;
  }
  const blobs = new Map<string, string>();
  for (const line of tree.split('\0')) {
    const match = /^(100644|100755) blob ([0-9a-f]+)\t(.+)$/.exec(line);
    if (match) blobs.set(match[3]!, match[2]!);
  }
  if (blobs.size === 0) return false;
  if (files.length === 0) return true;
  let hashes: string;
  try {
    hashes = git(
      repository,
      ['hash-object', '--no-filters', ...files],
      gitTimeoutMs,
    );
  } catch {
    return false;
  }
  const actual = hashes.trim().split('\n');
  return files.every((file, index) => {
    const path = relative(repository, file).split(sep).join('/');
    return blobs.get(path) === actual[index];
  });
}

function git(cwd: string, args: string[], timeoutMs = 10_000): string {
  return execFileSync(
    'git',
    ['--literal-pathspecs', '-c', 'core.fsmonitor=false', ...args],
    {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      // A `GIT_DIR` or `GIT_WORK_TREE` inherited from the server would
      // point the check at another repository.
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !key.startsWith('GIT_'),
          ),
        ),
        GIT_TERMINAL_PROMPT: '0',
      },
    },
  );
}
