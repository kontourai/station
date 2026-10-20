import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * #3800: the `.codex` directories a session not started as `host` would load
 * that came from somewhere other than the repository's upstream.
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
 * file is a regular file whose bytes are the blob at the same path in one
 * remote-tracking ref (`refs/remotes/*`) of that outermost repository:
 * content that came from upstream. Local commits confer nothing: a confined
 * Claude session holds Seatbelt grants for its objects and its branch ref,
 * so it can commit a `.codex` and stage the matching bytes (EXECUTED in
 * review). Neither engine can write `refs/remotes` or `packed-refs`: Codex
 * keeps `.git` read-only and Seatbelt denies both. The objects the refs name
 * are writable, so every commit and tree on the path is re-hashed and must
 * match its id: a forged loose object is refused.
 *
 * Anything else is reported: uncommitted, local-only, changed, a symlink or
 * other non-file inside, a `.codex` known only to a nested or planted
 * repository, a repository with no remote-tracking refs or with the reftable
 * backend, or no repository at all. Below the outermost repository, a
 * linked worktree it registered is judged with its own path (it shares the
 * same refs); a repository moved in from elsewhere is not one.
 *
 * Known limits, both needing the Project root, which the start input does
 * not carry: a project inside another repository (a home-directory dotfiles
 * repository, say) is judged against that outer one, so its own upstream
 * `.codex` is refused; and in a workspace outside any repository, an agent
 * can build a whole repository (remote-tracking refs included) in temp and
 * move it in, which is then the outermost one. Content an agent manages to push
 * upstream, and that the operator then fetches, is trusted like any other
 * upstream content.
 *
 * The user's own `~/.codex` (and `CODEX_HOME`) is user configuration, not a
 * project layer, and is skipped. Git is asked only for plumbing that runs no
 * hooks, filters or fsmonitor, with replace objects off.
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
  // The work tree a `.codex` path is judged from: the outermost, or below it
  // a linked worktree that repository itself registered.
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
    if (!trusted || !matchesUpstream(trusted, config, gitTimeoutMs))
      return config;
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

/** The regular files under `config`, or `undefined` if it holds anything else. */
function configFiles(config: string): string[] | undefined {
  const files: string[] = [];
  const pending = [config];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    if (!lstatSync(dir).isDirectory()) return undefined;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
      else return undefined;
      if (files.length > MAX_CONFIG_FILES) return undefined;
    }
  }
  return files;
}

/** Most remote-tracking refs read; a repository with more is judged on these. */
const MAX_REMOTE_REFS = 4096;

/**
 * Every file under `config` is the blob at its path in one remote-tracking
 * ref, reached through commits and trees whose bytes hash to their ids.
 */
function matchesUpstream(
  workTree: string,
  config: string,
  gitTimeoutMs: number | undefined,
): boolean {
  const files = configFiles(config);
  if (!files) return false;
  try {
    const common = realpathSync(
      git(
        workTree,
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        gitTimeoutMs,
      ).trim(),
    );
    if (exists(join(common, 'reftable'))) return false;
    const format = git(
      workTree,
      ['rev-parse', '--show-object-format'],
      gitTimeoutMs,
    ).trim();
    if (format !== 'sha1' && format !== 'sha256') return false;
    const refs = [
      ...new Set(
        git(
          workTree,
          ['for-each-ref', '--format=%(objectname)', 'refs/remotes'],
          gitTimeoutMs,
        )
          .split('\n')
          .filter(Boolean),
      ),
    ].slice(0, MAX_REMOTE_REFS);
    if (refs.length === 0) return false;
    const read = verifiedReader(workTree, format, gitTimeoutMs);
    // Descend every ref to the `.codex` tree, one batch per level.
    const components = relative(workTree, config).split(sep);
    let trees = read(refs)
      .map((commit) =>
        commit?.type === 'commit' ? commitTree(commit) : undefined,
      )
      .filter((id): id is string => Boolean(id));
    for (const name of components) {
      trees = read([...new Set(trees)])
        .map((tree) =>
          tree?.type === 'tree'
            ? treeEntries(tree, format).get(name)
            : undefined,
        )
        .filter((entry): entry is TreeEntry => entry?.mode === '40000')
        .map((entry) => entry.id);
      if (trees.length === 0) return false;
    }
    if (files.length === 0) return true;
    const hashes = git(
      workTree,
      ['hash-object', '--no-filters', ...files],
      gitTimeoutMs,
    )
      .trim()
      .split('\n');
    const wanted = files.map((file, index) => ({
      path: relative(config, file).split(sep),
      id: hashes[index],
    }));
    return [...new Set(trees)].some((tree) =>
      wanted.every(({ path, id }) => blobAt(read, format, tree, path) === id),
    );
  } catch {
    return false;
  }
}

interface GitObject {
  type: string;
  content: Buffer;
}
interface TreeEntry {
  mode: string;
  id: string;
}

/**
 * Reads objects with `cat-file --batch` and keeps only those whose bytes
 * hash to the id asked for: the object store is writable to a confined
 * engine, so a stored object is not believed on its name alone.
 */
function verifiedReader(
  workTree: string,
  format: 'sha1' | 'sha256',
  gitTimeoutMs: number | undefined,
): (ids: string[]) => (GitObject | undefined)[] {
  return (ids) => {
    if (ids.length === 0) return [];
    const output = execFileSync(
      'git',
      ['--no-replace-objects', 'cat-file', '--batch'],
      {
        cwd: workTree,
        input: `${ids.join('\n')}\n`,
        timeout: gitTimeoutMs ?? 10_000,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'ignore'],
        env: gitEnv(),
      },
    );
    const objects: (GitObject | undefined)[] = [];
    let offset = 0;
    for (const id of ids) {
      const end = output.indexOf(0x0a, offset);
      if (end < 0)
        return [...objects, ...ids.slice(objects.length).map(() => undefined)];
      const header = output.subarray(offset, end).toString('utf8').split(' ');
      offset = end + 1;
      if (header.length !== 3 || header[0] !== id) {
        objects.push(undefined);
        continue;
      }
      const [, type, sizeText] = header as [string, string, string];
      const size = Number(sizeText);
      const content = output.subarray(offset, offset + size);
      offset += size + 1;
      const digest = createHash(format === 'sha256' ? 'sha256' : 'sha1')
        .update(`${type} ${size}\0`)
        .update(content)
        .digest('hex');
      objects.push(digest === id ? { type, content } : undefined);
    }
    return objects;
  };
}

function commitTree(commit: GitObject): string | undefined {
  return /^tree ([0-9a-f]+)\n/.exec(commit.content.toString('utf8'))?.[1];
}

function treeEntries(
  tree: GitObject,
  format: 'sha1' | 'sha256',
): Map<string, TreeEntry> {
  const width = format === 'sha256' ? 32 : 20;
  const entries = new Map<string, TreeEntry>();
  let offset = 0;
  while (offset < tree.content.length) {
    const space = tree.content.indexOf(0x20, offset);
    const nul = tree.content.indexOf(0, space);
    if (space < 0 || nul < 0) break;
    const mode = tree.content.subarray(offset, space).toString('utf8');
    const name = tree.content.subarray(space + 1, nul).toString('utf8');
    const id = tree.content.subarray(nul + 1, nul + 1 + width).toString('hex');
    entries.set(name, { mode, id });
    offset = nul + 1 + width;
  }
  return entries;
}

/** The regular-file blob id at `path` under `tree`, verified at every level. */
function blobAt(
  read: (ids: string[]) => (GitObject | undefined)[],
  format: 'sha1' | 'sha256',
  tree: string,
  path: string[],
): string | undefined {
  let current = tree;
  for (const [index, name] of path.entries()) {
    const [object] = read([current]);
    if (object?.type !== 'tree') return undefined;
    const entry = treeEntries(object, format).get(name);
    if (!entry) return undefined;
    if (index === path.length - 1)
      return entry.mode === '100644' || entry.mode === '100755'
        ? entry.id
        : undefined;
    if (entry.mode !== '40000') return undefined;
    current = entry.id;
  }
  return undefined;
}

function gitEnv(): NodeJS.ProcessEnv {
  // A `GIT_DIR` or `GIT_WORK_TREE` inherited from the server would point the
  // check at another repository.
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
    ),
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
  };
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
      env: gitEnv(),
    },
  );
}
