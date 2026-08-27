#!/usr/bin/env node

/**
 * station#3205: an inventory of registered worktrees. It reads; it never
 * writes.
 *
 * Why this exists. A checkout carrying ~140 registered worktrees, 18 of them
 * NESTED inside the primary checkout, advertised itself to an editor as
 * nineteen repositories. The editor tracked each one and ran a concurrent
 * `git status --untracked-files=all` per repository; 373 simultaneous `git`
 * processes took the host to load average 110. A single such status costs
 * ~128ms here, so the cost was never one slow command — it was the
 * multiplier. The load, in turn, is indistinguishable from the conditions
 * under which this repository's load-dependent test failures (#1045, #3162,
 * #3188) are triaged, which is the real damage: an unmeasured background load
 * source that no `pgrep vitest` reveals.
 *
 * ## Why this reports and does not remove
 *
 * Earlier revisions removed the worktrees they classified. Two independent
 * reviews examined that path and every HIGH finding, across both rounds, was
 * inside it or inside the safety claims that justified it — including one
 * introduced by the fix written to close the round before. Removing an outer
 * worktree deleted a NESTED worktree's untracked files that this tool's own
 * report had just called keep-worthy; the advertised safe preview ran
 * `git worktree prune`; `--remove=false` turned removal on.
 *
 * `git worktree remove` already exists, and git already refuses to remove a
 * worktree that "contains modified or untracked files". Every route around
 * that refusal is what the reviews kept finding. So the split is now:
 *
 *   - this tool derives and prints the inventory
 *   - a human reads it and runs `git worktree remove <path>` themselves
 *   - GIT'S OWN REFUSAL is the protection, because it runs against the tree
 *     as it exists at the instant of removal rather than against facts
 *     collected minutes earlier by a sweep
 *
 * Automating the inventory is worth real time. Automating the judgement has
 * now twice proven subtle in ways its own tests could not see.
 *
 * ## What "finished" means in the report
 *
 * A worktree is reported as FINISHED only when every one of these holds:
 *
 *   - it is not the primary (main) checkout, and not the current one
 *   - it has a branch (a detached HEAD may be a bisect or a review pin)
 *   - the branch has zero commits the comparison ref lacks
 *   - it has no modified/staged tracked files
 *   - it has no untracked (non-ignored) files — the one category of state
 *     that exists in exactly one place on earth, since `git worktree remove`
 *     never deletes a branch and committed work therefore always survives
 *   - nothing under it, at any depth, was modified within the freshness window
 *
 * Every one of those facts is DERIVED, and every derivation that fails is a
 * named reason to keep. There is no fact in the report that nothing computed.
 * FINISHED is a description of a lane, not an instruction: the reader still
 * decides, and git still gets the last word.
 *
 * ## Time of check, time of use
 *
 * Collecting facts for ~150 worktrees takes tens of seconds, and the
 * registered count moved 143 → 148 during one review from sibling activity
 * alone. A report is therefore a snapshot with a short shelf life — which is
 * survivable precisely because nothing acts on it automatically.
 */

import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const HYGIENE_POLICY = Object.freeze({
  /**
   * A worktree touched inside this window is treated as live regardless of
   * its git state — a sibling session may be mid-edit between commits.
   */
  freshnessWindowHours: 6,
  /** The ref a branch is compared against. */
  comparisonRef: 'origin/main',
  /**
   * How many worktrees are inspected at once. Serial inspection of 148
   * worktrees measured 61s, and this tool is recommended *while diagnosing a
   * git-process storm* — a triage tool must not be a meaningful share of the
   * phenomenon it measures. Bounded, because unbounded is how the storm in
   * #3205 happened in the first place. `mapWithConcurrency` is tested for the
   * peak it actually reaches, so the bound is a derived property rather than
   * a claim about the code.
   */
  concurrency: 8,
});

/** Thrown for a usage error; `main` turns it into exit code 2. */
export class UsageError extends Error {}

export const USAGE = `Usage: node scripts/worktree-hygiene.mjs [options]

Reports which registered worktrees are finished and which are nested inside
another worktree. It only reads: it runs no command that changes a repository.
Close a lane yourself with \`git worktree remove <path>\`, which performs git's
own check and refuses when the tree has modified or untracked files.

Options:
  --base <ref>       Comparison ref (default: ${HYGIENE_POLICY.comparisonRef}).
                     A branch is finished only when this ref already contains
                     every one of its commits.
  --repo <path>      Repository to inspect (default: this script's own
                     checkout, NOT the current directory — so running it from
                     an unrelated repository cannot report on that repository
                     as if it were this one).
  --json             Emit the whole report as one JSON document.
  --verbose          Also list kept worktrees and why they were kept.
  --concurrency <n>  Worktrees inspected at once (default: ${HYGIENE_POLICY.concurrency}).
  --help             Show this help.

Exit codes: 0 success, 2 usage error.`;

// ── pure decision layer ────────────────────────────────

/**
 * Describe one worktree from already-collected facts.
 *
 * Pure on purpose: every reason a worktree is KEPT is a string a human can
 * read, and the description can be tested without a git repository. The caller
 * owns all I/O.
 *
 * A `null` count means the fact could not be derived. That is always a reason
 * to keep — an undecidable worktree is not one a reader should close on this
 * report's say-so, and saying so in the report is the point.
 *
 * @param {{
 *   path: string,
 *   branch: string | null,
 *   isPrimary: boolean,
 *   isCurrent: boolean,
 *   commitsNotInBase: number | null,
 *   baseError: string | null,
 *   modifiedTrackedFiles: number | null,
 *   untrackedFiles: number | null,
 *   statusError: string | null,
 *   touchedWithinWindow: boolean,
 *   freshnessError: string | null,
 * }} worktree
 */
export function classifyWorktree(worktree) {
  const keepReasons = [];

  if (worktree.isPrimary) keepReasons.push('primary checkout');
  if (worktree.isCurrent) keepReasons.push('current worktree');
  if (!worktree.branch) keepReasons.push('detached HEAD');

  if (worktree.branch) {
    // ONE derivation, not two. `merge-base --is-ancestor B ref` is true iff
    // `rev-list --count ref..B` is 0 — checked across 120 real branches here,
    // 120 agreed and 0 disagreed. Reporting them as independent guards was a
    // label nothing computed; the count is the derivation, and "merged" is
    // just the name for the count being zero.
    if (worktree.commitsNotInBase === null) {
      keepReasons.push(
        `cannot compare against the base: ${worktree.baseError ?? 'unknown error'}`,
      );
    } else if (worktree.commitsNotInBase > 0) {
      keepReasons.push(
        `${worktree.commitsNotInBase} commit(s) not in the base`,
      );
    }
  }

  if (worktree.statusError) {
    keepReasons.push(`working tree unreadable: ${worktree.statusError}`);
  } else {
    if ((worktree.modifiedTrackedFiles ?? 0) > 0) {
      keepReasons.push(
        `${worktree.modifiedTrackedFiles} modified tracked file(s)`,
      );
    }
    // The only genuinely unrecoverable category, and the reason the report
    // says so out loud: `git worktree remove` never deletes a branch, so
    // committed work always survives, and an untracked file is what does not.
    // Ignored paths (node_modules, dist, scratch config) are absent from `??`
    // entries by definition, so this does not fire on regenerable build
    // output — which is also why a FINISHED lane can still hold state the
    // reader cares about, and why they, not this tool, decide.
    if ((worktree.untrackedFiles ?? 0) > 0) {
      keepReasons.push(
        `${worktree.untrackedFiles} untracked file(s) — not committed anywhere`,
      );
    }
  }

  if (worktree.freshnessError) {
    keepReasons.push(`freshness undecidable: ${worktree.freshnessError}`);
  } else if (worktree.touchedWithinWindow) {
    keepReasons.push('modified recently — a session may be live');
  }

  return {
    path: worktree.path,
    branch: worktree.branch,
    // Named for what it describes, not for an action. The tool cannot remove
    // anything, so calling a lane `removable` would be a label asserting a
    // capability nothing here has.
    finished: keepReasons.length === 0,
    keepReasons,
    untrackedFiles: worktree.untrackedFiles,
    modifiedTrackedFiles: worktree.modifiedTrackedFiles,
    commitsNotInBase: worktree.commitsNotInBase,
  };
}

/**
 * Directories whose nesting is owned by a tool, not by our convention. The
 * Claude Code harness creates a worktree per background agent under
 * `.claude/worktrees/` (already in `.gitignore` for the same reason). Those
 * are nested by design and nobody working in this repo can place them
 * elsewhere, so reporting them as a problem would be telling agents to fix
 * something they do not own — which is how a check teaches people to ignore
 * it. They are still counted, separately, because they are real multiplier.
 */
const HARNESS_MANAGED_SEGMENTS = Object.freeze(['/.claude/worktrees/']);

export function isHarnessManaged(path) {
  return HARNESS_MANAGED_SEGMENTS.some((segment) => path.includes(segment));
}

/**
 * True when a worktree lives INSIDE another one. Nested worktrees are what
 * makes a checkout advertise itself as many repositories to any tool that
 * walks the directory tree; they are reported separately from removability
 * because a nested worktree can be perfectly live.
 *
 * `insideOf` names the IMMEDIATE container (the longest containing path), not
 * the outermost one: told that `a/b/c` is inside `a`, the reader still has to
 * work out which directory to move it out of.
 *
 * `harnessManaged` entries are nesting we do not control (see above); only
 * the rest are actionable by the sibling-directory convention.
 */
export function findNestedWorktrees(paths) {
  // Walking each path's own ancestry, rather than scanning the sorted list
  // for a prefix, is what makes this correct AND cheap. Lexicographic order
  // does not keep a container adjacent to what it contains: `station`,
  // `station-worktrees/lane`, `station/.claude/...` sort in that order
  // because `-` < `/`, so a sorted single pass reads the 27 worktrees nested
  // under this checkout as zero. (It did, live, before this was rewritten.)
  const registered = new Set(paths);
  const nested = [];
  for (const candidate of [...paths].sort()) {
    let parent = dirname(candidate);
    let previous = candidate;
    while (parent !== previous) {
      if (registered.has(parent)) {
        nested.push({
          path: candidate,
          insideOf: parent,
          harnessManaged: isHarnessManaged(candidate),
        });
        break;
      }
      previous = parent;
      parent = dirname(parent);
    }
  }
  return nested;
}

export function summarize(classifications, nested) {
  return {
    total: classifications.length,
    finished: classifications.filter((entry) => entry.finished).length,
    nested: nested.length,
    /** The subset the sibling-directory convention can actually move. */
    nestedActionable: nested.filter((entry) => !entry.harnessManaged).length,
  };
}

/**
 * `git worktree list --porcelain -z`: NUL-terminated attribute lines, one
 * extra NUL between records. `-z` rather than the newline form because a path
 * containing a newline is otherwise indistinguishable from a new attribute.
 */
export function parseWorktreeList(porcelain) {
  const entries = [];
  let current = null;
  for (const line of porcelain.split(porcelain.includes('\0') ? '\0' : '\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: line.slice('worktree '.length), branch: null };
    } else if (line.startsWith('branch refs/heads/')) {
      if (current) current.branch = line.slice('branch refs/heads/'.length);
    }
  }
  if (current) entries.push(current);
  return entries.map((entry, index) => ({ ...entry, isPrimary: index === 0 }));
}

/**
 * Count entries in `status --porcelain=v1 --no-renames -z` output. `-z` makes
 * every record NUL-terminated, so a path containing a newline counts once
 * rather than twice; `--no-renames` means no record ever carries a second
 * path.
 */
export function countStatusEntries(statusOutput) {
  let modifiedTrackedFiles = 0;
  let untrackedFiles = 0;
  const records = statusOutput
    .split('\0')
    .filter((record) => record.length > 0);
  for (const record of records) {
    if (record.startsWith('??')) untrackedFiles += 1;
    else modifiedTrackedFiles += 1;
  }
  return { modifiedTrackedFiles, untrackedFiles };
}

/**
 * Is `worktreePath` the worktree the process is running in?
 *
 * Strict equality against `process.cwd()` was the original check, and it
 * failed from any subdirectory: git then removed the worktree out from under
 * the running process. Unlike the primary checkout, which git hard-refuses, a
 * linked worktree has no backstop of its own. Containment, on resolved paths,
 * is the fact being asserted — `/w/lane-10` must not match `/w/lane-1`, hence
 * the separator.
 */
export function isCurrentWorktree(worktreePath, currentPath) {
  if (!worktreePath || !currentPath) return false;
  return (
    currentPath === worktreePath || currentPath.startsWith(worktreePath + sep)
  );
}

/** Resolve symlinks so `/tmp/...` and `/private/tmp/...` compare equal. */
export function realPathOrSelf(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// ── git I/O ────────────────────────────────────────────

/**
 * Every command this tool can execute goes through here, and there are five,
 * all read-only: `git rev-parse --verify`, `git worktree list`,
 * `git rev-list --count`, `git status --porcelain`, and `find`. `execFile`,
 * never a shell, so a branch name or path is an argv element rather than
 * something a shell parses.
 */
async function run(command, args, options = {}) {
  return execFileAsync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    ...options,
  });
}

/**
 * `--no-optional-locks` because a plain `git status` WRITES the index (proven
 * by inode watch), and this tool touches ~148 sibling worktrees: without it,
 * the sweep takes `index.lock` in every live lane and can collide with a
 * session's own `git add`. It is the same flag the editor in #3205 was
 * already using.
 */
function gitArgs(repoRoot, args) {
  return ['--no-optional-locks', '-C', repoRoot, ...args];
}

/**
 * `find` cannot answer the freshness question on Windows: `-newermt` does not
 * exist there. The original code let that fall into a catch that reported
 * "assume live" for every worktree, which is safe but is also a permanent
 * silent no-op. It is now named as an undecidable fact.
 */
export const FRESHNESS_UNSUPPORTED_PLATFORM =
  'find -newermt is unavailable on this platform (win32)';

/**
 * Build directories, as ROOT-ANCHORED patterns relative to a worktree root.
 *
 * These are `-path` patterns, not `-name` globs, and the difference is the
 * whole point (MED-2). `-name 'dist*'` is a BASENAME glob matched at every
 * depth, so it pruned any path whose basename merely starts with `dist` —
 * live examples in this repo: `packages/contracts/src/distribution.ts`,
 * `packages/cli/src/distribution.ts`,
 * `src-server/services/plugins/distribution-profile-service.ts`,
 * `docs/guides/distribution-profiles.md`. Editing one of those was invisible
 * to the freshness walk. Worse, `find` evaluates the START path too, so a
 * worktree directory named `dist-something` was pruned at its own root and
 * the entire lane read as cold.
 *
 * Anchoring at the root is what makes the pattern mean "the build output",
 * which is the only thing it was ever supposed to mean. The names come from
 * this repo's own `.gitignore` (`dist/`, `dist-ui*`, `dist-server*`,
 * `dist-pages/`, `dist-desktop*`).
 *
 * `node_modules` and `.git` stay basename globs deliberately: both nest at
 * arbitrary depth (23 `node_modules` trees live under this checkout alone),
 * and neither name is ever a tracked file.
 */
export const BUILD_OUTPUT_PRUNE_PATTERNS = Object.freeze(['dist', 'dist-*']);

/**
 * `find` arguments for "was anything under here touched inside the window".
 *
 * Three corrections from review:
 *  - no `-maxdepth`. 3762 of this repo's 4884 tracked paths are at depth ≥ 4,
 *    so a depth-3 walk could not see `src-ui/src/components/X.tsx` at all,
 *    and a lane edited ten seconds earlier read as finished.
 *  - `-prune` rather than `-not -path`: the old filter still DESCENDED into
 *    `node_modules` and only discarded the results afterwards. Pruning is why
 *    dropping `-maxdepth` made this cheaper rather than more expensive
 *    (measured on one station worktree: 518ms before, 109ms after on a cold
 *    tree, 6ms when a recent file is found early).
 *  - build output is pruned by ROOT-ANCHORED PATH, not by basename glob (see
 *    `BUILD_OUTPUT_PRUNE_PATTERNS`).
 *
 * No `-type f`: a linked worktree's index lives under the PRIMARY checkout,
 * so committing inside a worktree touches nothing under its own path, and
 * directory mtimes are part of the little evidence there is.
 */
export function freshnessFindArgs(worktreePath, windowHours) {
  // `find` composes child paths from the start argument verbatim, so a
  // trailing separator would put a doubled `//` between the root and every
  // `-path` pattern and match nothing.
  const root = worktreePath.replace(/[/\\]+$/, '') || worktreePath;
  const prune = ['-name', 'node_modules', '-o', '-name', '.git'];
  for (const pattern of BUILD_OUTPUT_PRUNE_PATTERNS) {
    prune.push('-o', '-path', `${root}/${pattern}`);
  }
  return [
    root,
    '(',
    ...prune,
    ')',
    '-prune',
    '-o',
    '-newermt',
    `-${windowHours} hours`,
    '-print',
    '-quit',
  ];
}

function errorText(error) {
  const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
  return (stderr || error?.message || String(error))
    .split('\n')[0]
    .slice(0, 200);
}

/**
 * Collect every fact `classifyWorktree` needs for one worktree.
 *
 * EVERY catch here fails CLOSED, toward keeping the worktree: a fact this
 * function could not derive is reported as underivable, never as a benign
 * zero. The eight fault injections that motivated this (all of which the
 * original test suite passed) each turned one of these into a fail-open.
 */
export async function collectWorktreeFacts(entry, context) {
  const {
    repoRoot,
    comparisonRef,
    windowHours = HYGIENE_POLICY.freshnessWindowHours,
    currentPath,
    platform = process.platform,
  } = context;

  const isPrimary = entry.isPrimary === true;
  const isCurrent = isCurrentWorktree(realPathOrSelf(entry.path), currentPath);

  let commitsNotInBase = null;
  let baseError = null;
  if (entry.branch) {
    try {
      const { stdout } = await run(
        'git',
        gitArgs(repoRoot, [
          'rev-list',
          '--count',
          `${comparisonRef}..refs/heads/${entry.branch}`,
        ]),
      );
      const parsed = Number.parseInt(stdout.trim(), 10);
      if (Number.isNaN(parsed)) {
        baseError = `unparseable rev-list output ${JSON.stringify(stdout.trim())}`;
      } else {
        commitsNotInBase = parsed;
      }
    } catch (error) {
      baseError = errorText(error);
    }
  }

  let modifiedTrackedFiles = null;
  let untrackedFiles = null;
  let statusError = null;
  try {
    const { stdout } = await run(
      'git',
      gitArgs(entry.path, [
        'status',
        '--porcelain=v1',
        // `normal` collapses an untracked DIRECTORY into a single `?? dir/`
        // record, which under-reports the count the report prints as a
        // reason to keep.
        '--untracked-files=all',
        '--no-renames',
        '-z',
      ]),
    );
    ({ modifiedTrackedFiles, untrackedFiles } = countStatusEntries(stdout));
  } catch (error) {
    statusError = errorText(error);
  }

  let touchedWithinWindow = false;
  let freshnessError = null;
  if (platform === 'win32') {
    freshnessError = FRESHNESS_UNSUPPORTED_PLATFORM;
  } else {
    try {
      const { stdout } = await run(
        'find',
        freshnessFindArgs(entry.path, windowHours),
      );
      touchedWithinWindow = stdout.trim().length > 0;
    } catch (error) {
      freshnessError = errorText(error);
    }
  }

  return {
    path: entry.path,
    branch: entry.branch,
    isPrimary,
    isCurrent,
    commitsNotInBase,
    baseError,
    modifiedTrackedFiles,
    untrackedFiles,
    statusError,
    touchedWithinWindow,
    freshnessError,
  };
}

/** Run `worker` over `items` with at most `limit` in flight. */
export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, () =>
    (async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    })(),
  );
  await Promise.all(runners);
  return results;
}

// ── CLI ────────────────────────────────────────────────

/**
 * Options are parsed strictly. The original accepted `--base X` only, so the
 * ordinary GNU `--base=X` silently degraded to `origin/main` — and the
 * dangerous direction is real: an operator who passes a NARROWER base and
 * silently gets the broader one sees strictly more worktrees as finished.
 * Unknown flags and missing values now exit 2 rather than being ignored.
 */
export function parseArgs(argv) {
  const options = {
    json: false,
    verbose: false,
    help: false,
    comparisonRef: HYGIENE_POLICY.comparisonRef,
    repo: null,
    concurrency: HYGIENE_POLICY.concurrency,
  };

  const takeValue = (flag, inlineValue, index) => {
    const value = inlineValue ?? argv[index + 1];
    if (value === undefined) throw new UsageError(`${flag} requires a value`);
    if (inlineValue === undefined && value.startsWith('-')) {
      throw new UsageError(
        `${flag} requires a value, got the flag ${JSON.stringify(value)}`,
      );
    }
    if (value === '')
      throw new UsageError(`${flag} requires a non-empty value`);
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const equals = arg.indexOf('=');
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);

    switch (flag) {
      case '--json':
        options.json = true;
        break;
      case '--verbose':
        options.verbose = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--base':
        options.comparisonRef = takeValue(flag, inline, index);
        if (inline === undefined) index += 1;
        break;
      case '--repo':
        options.repo = takeValue(flag, inline, index);
        if (inline === undefined) index += 1;
        break;
      case '--concurrency': {
        const raw = takeValue(flag, inline, index);
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new UsageError(
            `--concurrency requires a positive integer, got ${JSON.stringify(raw)}`,
          );
        }
        options.concurrency = parsed;
        if (inline === undefined) index += 1;
        break;
      }
      default:
        throw new UsageError(`unrecognized argument ${JSON.stringify(arg)}`);
    }
  }

  return options;
}

/**
 * The repository this tool inspects defaults to ITS OWN checkout, not
 * `process.cwd()`. Anchoring to the cwd meant that running the script from
 * another repository reported on THAT repository, and running it outside any
 * repository died with a raw stack trace.
 */
export function defaultRepoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function renderReport(payload, options, log) {
  const { summary, classifications, nested } = payload;
  log(
    `${summary.total} worktrees; ${summary.finished} finished; ` +
      `${summary.nested} nested (${summary.nestedActionable} movable, ` +
      `${summary.nested - summary.nestedActionable} harness-managed).`,
  );
  for (const entry of classifications) {
    if (entry.finished) {
      // No `[untracked=N]`: a FINISHED line can only ever carry
      // `untracked=0`, since a non-zero count is what makes it not finished.
      // A field that cannot vary reads as a quantity somebody checked.
      log(`  FINISHED   ${entry.branch ?? '(detached)'}  ${entry.path}`);
    } else if (options.verbose) {
      log(
        `  KEPT       ${entry.branch ?? '(detached)'}  ${entry.path}\n` +
          `             ${entry.keepReasons.join('; ')}`,
      );
    }
  }
  for (const entry of nested) {
    if (entry.harnessManaged) continue;
    log(`  NESTED     ${entry.path}\n             inside ${entry.insideOf}`);
  }
  if (summary.nestedActionable > 0) {
    log(
      '\nNested worktrees make one checkout look like many repositories to any\n' +
        'tool that walks the tree (station#3205). Prefer a sibling directory.\n' +
        'Harness-managed worktrees are excluded above: they are nested by\n' +
        'design and this convention cannot move them.',
    );
  }
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const log = io.log ?? console.log;
  const errorLog = io.errorLog ?? console.error;

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    errorLog(`worktree-hygiene: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    log(USAGE);
    return 0;
  }

  const repoRoot = realPathOrSelf(resolve(options.repo ?? defaultRepoRoot()));
  if (!existsSync(join(repoRoot, '.git'))) {
    errorLog(
      `worktree-hygiene: ${repoRoot} is not a git checkout (pass --repo <path>).`,
    );
    return 2;
  }

  try {
    await run(
      'git',
      gitArgs(repoRoot, [
        'rev-parse',
        '--verify',
        '--quiet',
        `${options.comparisonRef}^{commit}`,
      ]),
    );
  } catch {
    errorLog(
      `worktree-hygiene: comparison ref ${JSON.stringify(options.comparisonRef)} does not resolve in ${repoRoot}.`,
    );
    return 2;
  }

  const context = {
    repoRoot,
    comparisonRef: options.comparisonRef,
    windowHours: HYGIENE_POLICY.freshnessWindowHours,
    currentPath: realPathOrSelf(process.cwd()),
  };

  const { stdout: listOutput } = await run(
    'git',
    gitArgs(repoRoot, ['worktree', 'list', '--porcelain', '-z']),
  );
  const entries = parseWorktreeList(listOutput);
  const facts = await mapWithConcurrency(
    entries,
    options.concurrency,
    (entry) => collectWorktreeFacts(entry, context),
  );
  const classifications = facts.map((fact) => classifyWorktree(fact));
  const nested = findNestedWorktrees(entries.map((entry) => entry.path));
  const summary = summarize(classifications, nested);
  const payload = { summary, classifications, nested };

  if (process.platform === 'win32') {
    errorLog(
      `worktree-hygiene: ${FRESHNESS_UNSUPPORTED_PLATFORM}; every worktree is kept as undecidable.`,
    );
  }

  if (options.json) {
    log(JSON.stringify(payload, null, 2));
    return 0;
  }

  renderReport(payload, options, log);
  if (summary.finished > 0) {
    log(
      '\nNothing above has been changed — this tool only reads. Close a lane\n' +
        'yourself:\n' +
        '\n' +
        '  git worktree remove <path>\n' +
        '\n' +
        'git runs its own check there and refuses when the tree has modified\n' +
        'or untracked files. That refusal, not this report, is the protection:\n' +
        'it sees the tree as it is at that instant, while these facts were\n' +
        'collected while sibling sessions kept writing. The branch survives a\n' +
        'removal either way.',
    );
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`worktree-hygiene: ${error?.stack ?? error}`);
      process.exitCode = 1;
    },
  );
}
