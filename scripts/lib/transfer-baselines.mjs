import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { basename, sep } from 'node:path';
import { sanitizedGitEnvironment } from './git-environment.mjs';

/**
 * Transfer-gate baselines: naming, reuse, and reclamation (#2355).
 *
 * `--prepare-baseline` creates one detached sibling worktree per `main` tip.
 * Main moves many times a day and nothing removed the old ones, so they
 * accumulated without bound (35 on the reference Mac). This module owns the
 * one question both reuse and pruning ask: which registered worktrees are
 * baselines this gate created, and which of those are safe to remove?
 *
 * Every removal requires ALL of: a registered worktree of this repository,
 * a detached HEAD, the gate's own canonical directory name, not locked, a
 * HEAD outside the keep set, and no live process observed using it. A tree
 * that fails any one of those is left alone and never reported as pruned.
 */

/**
 * The one place a baseline's directory name is spelled.
 *
 * `scripts/worktree-hygiene.mjs` also has to recognise these to report them,
 * and a prefix restated in two files is the drift this repository has been
 * bitten by before. A reader of the inventory cannot otherwise tell a
 * regenerable baseline from a bisect or a review pin: both are detached HEADs.
 */
export const TRANSFER_BASELINE_PREFIX = '4294-transfer-baseline-';

/** Set to `0`/`false`/`off`/`no` to keep stale baselines (opt-out). */
export const TRANSFER_BASELINE_PRUNE_ENV = 'STATION_TRANSFER_BASELINE_PRUNE';

/**
 * The base SHA a path names, or null when the path is not a baseline.
 *
 * Deliberately derives nothing from the filesystem: this answers "what does
 * this NAME claim", so a caller can compare that claim against the worktree's
 * actual HEAD rather than trusting the directory name.
 */
export function transferBaselineShaFromPath(path) {
  const name = basename(String(path).replace(/[/]+$/, ''));
  if (!name.startsWith(TRANSFER_BASELINE_PREFIX)) return null;
  const sha = name.slice(TRANSFER_BASELINE_PREFIX.length);
  return /^[0-9a-f]{12}$/.test(sha) ? sha : null;
}

function transferBaselinePruneEnabled(env = process.env) {
  const raw = String(env[TRANSFER_BASELINE_PRUNE_ENV] ?? '')
    .trim()
    .toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

/**
 * `git worktree list --porcelain -z`. Kept local rather than imported from
 * `worktree-hygiene.mjs` because that module imports the gate, which imports
 * this one; this parser also needs the `detached`/`locked` attributes.
 */
function parseWorktreePorcelain(porcelain) {
  const entries = [];
  for (const line of porcelain.split(porcelain.includes('\0') ? '\0' : '\n')) {
    const space = line.indexOf(' ');
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? '' : line.slice(space + 1);
    if (key === 'worktree')
      entries.push({ path: value, head: null, branch: null });
    const current = entries.at(-1);
    if (!current || key === 'worktree') continue;
    if (key === 'HEAD') current.head = value.trim();
    else if (key === 'branch') current.branch = value;
    // `detached`, `locked [reason]`, `prunable [reason]`: presence is the fact.
    else if (['detached', 'locked', 'prunable'].includes(key))
      current[key] = true;
  }
  return entries.map((entry, index) => ({
    detached: false,
    locked: false,
    prunable: false,
    ...entry,
    isPrimary: index === 0,
  }));
}

function gitSync(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: sanitizedGitEnvironment(process.env),
    windowsHide: true,
  });
}

export function listRegisteredWorktrees(repoRoot, git = gitSync) {
  return parseWorktreePorcelain(
    git(repoRoot, ['worktree', 'list', '--porcelain', '-z']),
  );
}

function realOrSelf(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * A registered worktree this gate created: canonical name, detached, not the
 * primary checkout, not locked, and a HEAD that still agrees with the SHA its
 * name claims. The name alone is only a claim: a baseline someone re-pointed
 * for other work is no longer the regenerable tree the gate made.
 */
function isOwnedTransferBaseline(worktree) {
  const claimed = transferBaselineShaFromPath(worktree.path);
  return (
    claimed !== null &&
    !worktree.isPrimary &&
    worktree.detached === true &&
    !worktree.branch &&
    !worktree.locked &&
    typeof worktree.head === 'string' &&
    worktree.head.startsWith(claimed)
  );
}

/**
 * The first owned baseline already at exactly `baseSha` whose dependencies
 * verify, or null. `verify(path)` throws (or returns false) to reject.
 */
export function findReusableBaseline({ worktrees, baseSha, verify, log }) {
  for (const worktree of worktrees) {
    if (!isOwnedTransferBaseline(worktree)) continue;
    if (worktree.head !== baseSha || !existsSync(worktree.path)) continue;
    try {
      if (verify(worktree.path) === false) continue;
    } catch (error) {
      log?.(
        `Not reusing ${worktree.path}: ${error instanceof Error ? error.message : error}`,
      );
      continue;
    }
    return worktree.path;
  }
  return null;
}

/** Owned baselines whose HEAD is outside `keepShas`, excluding given paths. */
function selectStaleBaselines({ worktrees, keepShas, excludePaths = [] }) {
  const keep = new Set(keepShas.filter(Boolean));
  const excluded = new Set(excludePaths.map(realOrSelf));
  return worktrees.filter(
    (worktree) =>
      isOwnedTransferBaseline(worktree) &&
      worktree.head !== null &&
      !keep.has(worktree.head) &&
      !excluded.has(realOrSelf(worktree.path)),
  );
}

function within(path, root) {
  return (
    path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
  );
}

/**
 * Process cwds on this host, or null when they cannot be read. Linux reads
 * `/proc/<pid>/cwd`; macOS and other POSIX hosts ask `lsof -d cwd`, which
 * lists only each process's cwd and so avoids `lsof +D`'s full tree walk.
 */
function readProcessCwds({ platform = process.platform } = {}) {
  return platform === 'linux' && existsSync('/proc')
    ? readProcCwds()
    : readLsofCwds();
}

function readProcCwds() {
  const cwds = [];
  for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    try {
      cwds.push({ pid: Number(pid), path: readlinkSync(`/proc/${pid}/cwd`) });
    } catch {
      // Another user's process or one that just exited: not observable.
    }
  }
  return cwds;
}

function readLsofCwds() {
  const result = spawnSync('lsof', ['-n', '-P', '-d', 'cwd', '-F', 'pn'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  // lsof exits 1 when some processes are unreadable but still prints the
  // rest; only a missing binary or empty output makes the answer unknown.
  if (result.error || !result.stdout) return null;
  const cwds = [];
  let pid = null;
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== null)
      cwds.push({ pid, path: line.slice(1) });
  }
  return cwds;
}

/** Full command lines of live processes, or null when unreadable. */
function readProcessCommands() {
  const result = spawnSync('ps', ['-A', '-ww', '-o', 'pid=,command='], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || !result.stdout) return null;
  return result.stdout
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), command: match[2] }));
}

/**
 * Which of `paths` a live process is using, as a Map path → reason, or null
 * when the host cannot answer (the caller must then remove nothing).
 *
 * "Using" means a process cwd inside the tree, or a command line naming it.
 * The second matters because the capture child runs with the CANDIDATE as
 * its cwd and receives the baseline as an argument.
 */
export function findPathsInUse(
  paths,
  {
    cwds = readProcessCwds(),
    commands = readProcessCommands(),
    selfPid = process.pid,
  } = {},
) {
  if (cwds === null || commands === null) return null;
  const inUse = new Map();
  for (const path of paths) {
    const forms = [...new Set([path, realOrSelf(path)])];
    const cwd = cwds.find(
      (entry) =>
        entry.pid !== selfPid &&
        forms.some((form) => within(realOrSelf(entry.path), form)),
    );
    if (cwd) {
      inUse.set(path, `process ${cwd.pid} has its cwd inside`);
      continue;
    }
    const command = commands.find(
      (entry) =>
        entry.pid !== selfPid &&
        forms.some((form) => entry.command.includes(form)),
    );
    if (command) inUse.set(path, `process ${command.pid} names it`);
  }
  return inUse;
}

/**
 * Some installs leave read-only directories, which make both `rm -rf` and
 * `git worktree remove` fail with a bare "Directory not empty". Only
 * DIRECTORIES are touched: pnpm hard-links files from its shared store, so a
 * file chmod would change the mode of every other checkout's copy too.
 */
function makeDirectoriesWritable(path) {
  return spawnSync(
    'find',
    [
      path,
      '-type',
      'd',
      '!',
      '-perm',
      '-u+w',
      '-exec',
      'chmod',
      'u+rwx',
      '{}',
      '+',
    ],
    { stdio: 'ignore', windowsHide: true },
  );
}

/** @typedef {(repoRoot: string, path: string) => { status: number | null, stderr?: string }} GitRemove */

/** @type {GitRemove} */
function gitWorktreeRemove(repoRoot, path) {
  return spawnSync(
    'git',
    ['-C', repoRoot, 'worktree', 'remove', '--force', path],
    {
      encoding: 'utf8',
      env: sanitizedGitEnvironment(process.env),
      windowsHide: true,
    },
  );
}

/**
 * `git worktree remove` can unregister a tree and then fail on its last
 * `rmdir` when something writes into it mid-removal (macOS Finder recreating
 * `.DS_Store` was observed live), leaving an orphan directory git no longer
 * knows. The path was already proven an owned, stale, unused baseline, so
 * finish the job once git has let go of it; while git still lists it, report
 * the failure instead.
 */
/**
 * @param {string} repoRoot
 * @param {string} path
 * @param {GitRemove} [runGitRemove]
 */
function removeWorktree(repoRoot, path, runGitRemove = gitWorktreeRemove) {
  makeDirectoriesWritable(path);
  const result = runGitRemove(repoRoot, path);
  if (result.status === 0) return;
  const stillRegistered = listRegisteredWorktrees(repoRoot).some(
    (entry) => realOrSelf(entry.path) === realOrSelf(path),
  );
  if (stillRegistered || !existsSync(path))
    throw new Error((result.stderr || `git exited ${result.status}`).trim());
  makeDirectoriesWritable(path);
  rmSync(path, { recursive: true, force: true, maxRetries: 3 });
}

/**
 * Remove owned baselines that are stale and unused. Returns what happened so
 * a caller can report it; never throws for a single tree it could not remove,
 * because a failed cleanup must not fail the baseline the caller just made.
 */
export function pruneStaleTransferBaselines({
  repoRoot,
  keepShas,
  excludePaths = [],
  env = process.env,
  platform = process.platform,
  log = (line) => console.log(line),
  listWorktrees = () => listRegisteredWorktrees(repoRoot),
  pathsInUse = findPathsInUse,
  runGitRemove = /** @type {GitRemove} */ (gitWorktreeRemove),
  remove = (path) => removeWorktree(repoRoot, path, runGitRemove),
  prune = () => gitSync(repoRoot, ['worktree', 'prune']),
}) {
  /** @type {{ pruned: string[], kept: { path: string, reason: string }[], failed: { path: string, error: string }[], skipped: string | null }} */
  const outcome = { pruned: [], kept: [], failed: [], skipped: null };
  if (!transferBaselinePruneEnabled(env)) {
    outcome.skipped = `${TRANSFER_BASELINE_PRUNE_ENV} disables pruning`;
    return outcome;
  }
  if (platform === 'win32') {
    // No cheap, reliable in-use probe here, so do not guess.
    outcome.skipped = 'in-use check unavailable on Windows';
    log(
      'Skipped pruning stale transfer baselines: in-use check unavailable on Windows.',
    );
    return outcome;
  }
  const stale = selectStaleBaselines({
    worktrees: listWorktrees(),
    keepShas,
    excludePaths,
  });
  if (stale.length === 0) return outcome;
  const inUse = pathsInUse(stale.map((worktree) => worktree.path));
  if (inUse === null) {
    outcome.skipped = 'could not read live process state';
    log(
      'Skipped pruning stale transfer baselines: could not read live process state.',
    );
    return outcome;
  }
  for (const worktree of stale) {
    const reason = inUse.get(worktree.path);
    if (reason) {
      outcome.kept.push({ path: worktree.path, reason });
      log(`Kept stale transfer baseline in use (${reason}): ${worktree.path}`);
      continue;
    }
    try {
      remove(worktree.path);
      outcome.pruned.push(worktree.path);
      log(`Pruned stale transfer baseline: ${worktree.path}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome.failed.push({ path: worktree.path, error: message });
      log(`Could not prune transfer baseline ${worktree.path}: ${message}`);
    }
  }
  if (outcome.pruned.length > 0) {
    try {
      prune();
    } catch {
      // Metadata of a removed tree is already gone; prune is housekeeping.
    }
  }
  return outcome;
}
