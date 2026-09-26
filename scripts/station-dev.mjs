#!/usr/bin/env node

// station-dev-shim-marker: v1
//
// This marker line is load-bearing: `scripts/install-station-dev.mjs` reads
// it back from an existing installed file to decide whether it is safe to
// overwrite (a prior install of this shim) or must refuse (some unrelated
// file already occupies the destination). Do not remove or reword it.

/**
 * station-dev — a cwd-resolving, global dev shim for the Station CLI
 * (station#4536).
 *
 * Why this exists instead of `npm link`: a machine-global symlink into one
 * checkout makes `station` silently run whatever branch that tree happens to
 * be on, with no staleness gate in front of a git-ignored `dist/` — on a
 * many-worktree host with concurrent sessions flipping the "current" branch,
 * that is the truthful-looking-wrong-binary failure class. `station-dev`
 * instead resolves its target FROM WHERE YOU STAND, every invocation: it
 * walks up from the current working directory to the enclosing Station
 * checkout and runs THAT tree's own build, so two worktrees on the same
 * machine each get their own correct answer with one shim installed once.
 *
 * Deliberately self-contained: Node builtins only, no import from this repo's
 * `scripts/lib/`. It is copied (not symlinked) onto a global `PATH` by
 * `scripts/install-station-dev.mjs` and must keep working from outside any
 * checkout, tolerant of whatever system Node happens to be resolving it —
 * all it does from there is resolve a target checkout and Node 24, then
 * delegate.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The root workspace package name every Station checkout's package.json carries. */
const CHECKOUT_MARKER_NAME = '@kontourai/station-core';
const CLI_DIST_RELATIVE = ['packages', 'cli', 'dist', 'station.mjs'];
const CLI_SRC_RELATIVE = ['packages', 'cli', 'src'];

/**
 * Whether `dir` is the root of a Station checkout: the marker package name
 * AND a `packages/cli` directory both present. Either alone is not enough —
 * a plugin repo that merely depends on `@kontourai/station-core` in its own
 * lockfile has no `packages/cli` of its own to build or run.
 */
export function isStationCheckoutRoot(dir) {
  const manifestPath = join(dir, 'package.json');
  if (!existsSync(manifestPath)) return false;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return false;
  }
  if (!manifest || manifest.name !== CHECKOUT_MARKER_NAME) return false;
  return existsSync(join(dir, 'packages', 'cli'));
}

/**
 * Walks up from `startDir` to the filesystem root looking for a Station
 * checkout. Returns the checkout root, or `null` if none is found before the
 * filesystem root (parent === dir).
 */
export function findCheckoutRoot(startDir) {
  let dir = resolve(startDir);
  for (;;) {
    if (isStationCheckoutRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Newest mtime (ms) of any regular file under `dir`, recursively.
 * Returns `-Infinity` when `dir` does not exist or contains no file.
 */
function newestMtimeUnder(dir) {
  let newest = -Infinity;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const mtime = statSync(full).mtimeMs;
        if (mtime > newest) newest = mtime;
      } catch {
        // Unreadable file: ignore rather than fail the whole scan.
      }
    }
  }
  return newest;
}

/**
 * `'fresh' | 'stale' | 'missing'` for `<root>/packages/cli/dist/station.mjs`
 * relative to `<root>/packages/cli/src`.
 *
 * This is an APPROXIMATE mtime comparison, not the canonical freshness
 * check. The canonical one is `scripts/check-dist-freshness.mjs` (content
 * digests over the package's own tsconfig `exclude`, covering every
 * workspace package this repo builds) — deliberately not imported here to
 * keep this shim standalone. A false "fresh" from a clock skew or a touched
 * file with unchanged content is a known, accepted gap of this approximation;
 * `npm run build:cli` is always a safe remedy regardless.
 */
export function distFreshnessVerdict(root) {
  const distFile = join(root, ...CLI_DIST_RELATIVE);
  if (!existsSync(distFile)) return 'missing';
  let distMtime;
  try {
    distMtime = statSync(distFile).mtimeMs;
  } catch {
    return 'missing';
  }
  const srcDir = join(root, ...CLI_SRC_RELATIVE);
  const newestSrc = newestMtimeUnder(srcDir);
  if (newestSrc === -Infinity) return 'fresh'; // no source file found to compare against
  return newestSrc > distMtime ? 'stale' : 'fresh';
}

/**
 * Reads the branch name (or short SHA when detached) for the checkout at
 * `root`, handling both an ordinary `.git` directory and a linked worktree's
 * `.git` FILE (`gitdir: <path>`, which may be relative to the file's own
 * directory). Returns `null` when nothing readable is found — callers must
 * degrade to printing just the root, never throw.
 */
export function readGitRef(root) {
  const gitPath = join(root, '.git');
  let stat;
  try {
    stat = lstatSync(gitPath);
  } catch {
    return null;
  }
  let gitDir;
  if (stat.isDirectory()) {
    gitDir = gitPath;
  } else if (stat.isFile()) {
    let content;
    try {
      content = readFileSync(gitPath, 'utf8').trim();
    } catch {
      return null;
    }
    const match = /^gitdir:\s*(.+)$/.exec(content);
    if (!match) return null;
    gitDir = resolve(dirname(gitPath), match[1]);
  } else {
    return null;
  }
  try {
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    const branchMatch = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (branchMatch) return branchMatch[1];
    if (/^[0-9a-f]{7,40}$/i.test(head)) return head.slice(0, 12);
    return head.length > 0 ? head : null;
  } catch {
    return null;
  }
}

/** `station-dev: <root> @ <ref>`, degrading to just the root when no ref is readable. */
export function identificationLine(root) {
  const ref = readGitRef(root);
  return ref ? `station-dev: ${root} @ ${ref}` : `station-dev: ${root}`;
}

/**
 * Deliberately narrower than `child_process.spawnSync`'s real type: this is
 * the whole shape `resolveNodeExecutable` and `run` read off a result, so a
 * test can inject a minimal stub instead of a full `SpawnSyncReturns`.
 * @typedef {(command: string, args?: string[], options?: object) => {status?: number | null, stdout?: string, error?: Error}} SpawnLike
 */

/**
 * Node 24 executable to delegate to: `mise where node@24`'s bin directory
 * when `mise` is on PATH and reports one, else the Node currently running
 * this shim. Mirrors the PATH-prefix pattern used elsewhere in this repo's
 * tooling, without requiring mise to be installed.
 * @param {{spawn?: SpawnLike}} [options]
 */
export function resolveNodeExecutable({ spawn = spawnSync } = {}) {
  let result;
  try {
    result = spawn('mise', ['where', 'node@24'], {
      encoding: 'utf8',
      windowsHide: true,
    });
  } catch {
    return process.execPath;
  }
  if (result.error || result.status !== 0) return process.execPath;
  const miseDir = (result.stdout ?? '').trim();
  if (!miseDir) return process.execPath;
  const candidate = join(miseDir, 'bin', 'node');
  return existsSync(candidate) ? candidate : process.execPath;
}

const NO_CHECKOUT_MESSAGE = [
  'station-dev: no Station checkout found above the current directory.',
  'Run this from inside a Station checkout, or use the published CLI instead:',
  '  npx @kontourai/station-cli@<channel> ...   (channel: nightly or latest)',
  '  npm install -g @kontourai/station-cli@<channel>',
].join('\n');

/**
 * Resolves the target checkout and dist freshness, prints the
 * self-identification line, and delegates to that checkout's built CLI —
 * propagating the child's exit code exactly. stdout is left untouched by
 * this shim (every message it prints itself goes to stderr) so a JSON
 * pipeline consuming the delegated CLI's stdout is never polluted.
 *
 * Returns the process exit code that should be used; never throws.
 * @param {string[]} argv
 * @param {{cwd?: string, stdio?: string, spawn?: SpawnLike}} [options]
 */
export function run(
  argv,
  { cwd = process.cwd(), stdio = 'inherit', spawn = spawnSync } = {},
) {
  const root = findCheckoutRoot(cwd);
  if (!root) {
    process.stderr.write(`${NO_CHECKOUT_MESSAGE}\n`);
    return 1;
  }

  const freshness = distFreshnessVerdict(root);
  if (freshness !== 'fresh') {
    process.stderr.write(
      `station-dev: ${join(root, ...CLI_DIST_RELATIVE)} is ${freshness === 'missing' ? 'MISSING' : 'STALE'}.\n` +
        'Fix: npm run build:cli\n',
    );
    return 1;
  }

  process.stderr.write(`${identificationLine(root)}\n`);

  const node = resolveNodeExecutable({ spawn });
  const distFile = join(root, ...CLI_DIST_RELATIVE);
  const result = spawn(node, [distFile, ...argv], { stdio, windowsHide: true });
  if (result.error) {
    process.stderr.write(
      `station-dev: failed to launch ${distFile}: ${result.error.message}\n`,
    );
    return 1;
  }
  return typeof result.status === 'number' ? result.status : 1;
}

/**
 * Is this module the process entry point? Realpath-resolves both sides (see
 * `scripts/lib/module-entry.mjs`'s `invokedDirectly`, not imported here to
 * keep this file self-contained) rather than the weaker
 * `import.meta.url === file://\${process.argv[1]}` form, which breaks on a
 * symlinked invocation path or a space in it.
 */
function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exitCode = run(process.argv.slice(2));
}
