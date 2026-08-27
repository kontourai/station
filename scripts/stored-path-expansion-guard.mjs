#!/usr/bin/env node
/**
 * Stored paths are kept tilde-literal on purpose — `~/.station/projects/
 * <slug>/project.json` holds `~/dev/x` verbatim — so every consumer owes a
 * `resolve(expandTilde(...))` before touching the filesystem with it.
 *
 * That rule was documented in SIX separate comments and enforced by nothing,
 * and eight consumers violated it (station#3155). The failures were mostly
 * silent: file previews read "unreadable", Flow-Agents steering was never
 * injected, a knowledge namespace wrote into a literal `~` directory inside
 * Station's install root, and multi-turn chat was refused outright.
 *
 * This is a ratchet, not a proof. It cannot know whether a given read is
 * followed by an expansion, so it counts UNGUARDED reads — a field read whose
 * enclosing statement does not also mention expandTilde — and holds that
 * count at or below a checked-in baseline. New violations fail here, in the
 * file that owns them, instead of surfacing as an unrelated symptom three
 * files away.
 *
 * station#3246 triaged all 48 baselined rows and gave the baseline shape a
 * memory: `scripts/stored-path-expansion-baseline.json`'s `unguardedReads` is
 * now an array of `{ entry, category, reason }`, not bare strings.
 * `category` is 1 (never reaches the filesystem — an existence check, a
 * display string, a cache key, ...), 2 (reaches the filesystem or path
 * resolution but IS expanded — just not in the same statement, so this
 * heuristic misses it: elsewhere in the same function, in a callee, or
 * upstream at the call site), or 3 (a real unexpanded read — station#3246
 * fixed every one found; none should remain). `reason` names WHERE the
 * expansion happens for category 2, or why expansion is unnecessary/wrong
 * for category 1 (a few rows are deliberately never expanded — e.g. a raw
 * byte-equality corroboration check, or a value that names a directory on a
 * REMOTE machine, where local expansion would resolve against the wrong
 * host's home directory). A category-1/2 row is not a license to stop
 * reading; it is a recorded judgement call, and `--update` refuses to add a
 * new one without a human supplying both fields first (see below).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const BASELINE = join(root, 'scripts', 'stored-path-expansion-baseline.json');

/**
 * Fields whose stored value can carry a leading `~`.
 *
 * `worktreeBaseDir` was added after station#3246's triage: it is a free-text
 * policy field on `WorktreeIsolationPolicy` that reaches `resolve()` in
 * worktree-provisioning-service.ts, and the guard could not see it because the
 * list only covered the two fields the original incident touched. Nothing sets
 * it today, so nothing was broken — but a guard whose vocabulary stops at the
 * fields that already caused an incident only ever catches the incident that
 * already happened.
 */
const TILDE_FIELDS = ['workingDirectory', 'storageDir', 'worktreeBaseDir'];

async function listSourceFiles() {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  // TRACKED **and** untracked-but-not-ignored. `git ls-files` alone omits a
  // brand-new file, which is exactly the case the guard exists for: a new
  // consumer reading a stored path is invisible until it is committed, and by
  // then the gate that would have caught it has already passed. Found by
  // probing the guard with a new file and watching it report clean.
  const { stdout } = await run(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      // Root-level files need their own pattern: `src-server/**/*.ts` misses
      // src-server/*.ts, and `packages/**/src/**/*.ts` misses
      // packages/<pkg>/src/*.ts — 161 files between them (review L2).
      'src-server/*.ts',
      'src-server/**/*.ts',
      'packages/*/src/*.ts',
      'packages/**/src/**/*.ts',
    ],
    { cwd: root, maxBuffer: 32 * 1024 * 1024 },
  );
  return stdout.split('\n').filter((f) => f && !f.includes('__tests__'));
}

export function unguardedReads(source) {
  const hits = [];
  const lines = source.split('\n');
  lines.forEach((line, index) => {
    if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) {
      return;
    }
    for (const field of TILDE_FIELDS) {
      // Three spellings, not one: `.field`, `['field']`, and a destructured
      // `{ field }`. The first version caught only the first, so
      // `const { workingDirectory } = getProject(slug)` was silent.
      const reads =
        line.includes(`.${field}`) ||
        line.includes(`['${field}']`) ||
        line.includes(`["${field}"]`) ||
        new RegExp(`\\{[^}]*\\b${field}\\b[^}]*\\}\\s*=`).test(line);
      if (!reads) continue;
      // A read is guarded when the expansion appears in the same statement.
      // Statements wrap, so look at a small window rather than one line — but
      // strip comments from that window first. Otherwise `// no expandTilde
      // needed here` silences the guard permanently and reads to a reviewer
      // as a justification (station#3155 review).
      const window = lines
        .slice(Math.max(0, index - 2), index + 3)
        .map((entry) => entry.replace(/\/\/.*$/, ''))
        .join('\n');
      if (window.includes('expandTilde')) continue;
      hits.push({ line: index + 1, field, text: line.trim() });
    }
  });
  return hits;
}

/**
 * The category vocabulary, and why 4 exists separately from 1:
 *
 *   1  never reaches the filesystem — an existence check, a cache key, a
 *      query parameter, display text. A tilde is inert here.
 *   2  reaches the filesystem or path resolution and IS expanded, just not
 *      in the statement the detector can see (a few lines down, in a callee,
 *      or upstream at the value's construction site). The reason must cite
 *      where.
 *   4  DELIBERATELY raw, and expanding it would be a regression. These are
 *      not harmless and they are not oversights: two compare a stored path
 *      against a normalized one by raw byte equality to decide a
 *      security-relevant corroboration label (`directory-corroborated` vs
 *      `unverified-cross-machine`, packages/contracts/src/orchestration.ts:147-160),
 *      one computes the pre-#3155 path on purpose to find orphaned content,
 *      and one names a directory on a REMOTE host where the local home is
 *      the wrong answer.
 *
 * Category 4 was carved out of 1 after review (station#3246): filed as
 * "never reaches the filesystem", they read as harmless, and a future
 * contributor sweeping category 1 for consistency — "these are all just
 * existence checks, expand them and shrink the baseline" — would get no
 * signal from the machine-readable field that these four must not be
 * touched. The whole load was being carried by prose.
 *
 * There is deliberately no persistable category 3. A category-3 finding is
 * an unexpanded read: a bug to fix, never a row to keep.
 *
 * station#3246: each baseline row now carries a CATEGORY and REASON a human
 * wrote down after reading the surrounding code — not just the matching
 * string. `--update` cannot invent that judgement, so it may only ever
 * (a) drop rows that no longer appear (fixed) and (b) keep the recorded
 * category/reason for rows that still appear, byte-identically keyed on
 * `entry` exactly as before. It refuses anything it has not seen before —
 * a whole new FILE (the original station#3155 guard), or — closing a real
 * gap the flat string-array baseline had — a new STATEMENT inside an
 * already-known file, which previously slipped through unnoticed because
 * only file novelty was checked. `seeding` is true for `--seed` (or an
 * empty previous baseline): the one time an unexplained row is expected,
 * because there is nothing to compare against yet.
 *
 * Pure by design (no fs/process access) so it can be unit-tested directly —
 * see `scripts/__tests__/stored-path-expansion-guard.test.ts`.
 */
export function computeUpdatedBaseline({ found, previousEntries, seeding }) {
  // A QUEUE per key, not a Map of one row per key. Five statements appear
  // twice in this baseline (the same text at two sites in one file), and a
  // Map keeps only the last — so carrying forward by lookup handed BOTH
  // occurrences the same row and silently rewrote five reasons to describe
  // the wrong call site on the next `--update`. The reasons still read as
  // authoritative afterwards, which is the failure that matters: the row for
  // `pinSshDispatchWorkspace` came back saying "same pattern as line 1025"
  // while being line 1025. Shifting off a queue keeps the Nth occurrence's
  // own recorded judgement with the Nth occurrence (review of station#3246).
  const remainingByEntry = new Map();
  for (const row of previousEntries) {
    const queue = remainingByEntry.get(row.entry);
    if (queue) queue.push(row);
    else remainingByEntry.set(row.entry, [row]);
  }
  const take = (entry) => remainingByEntry.get(entry)?.shift();

  if (!seeding) {
    // Count occurrences, so a SECOND copy of an already-baselined statement
    // is unexplained rather than absorbed (see compareToBaseline's note).
    const available = new Map(
      [...remainingByEntry].map(([entry, rows]) => [entry, rows.length]),
    );
    const unexplained = [];
    for (const entry of found) {
      const left = available.get(entry) ?? 0;
      if (left === 0) unexplained.push(entry);
      else available.set(entry, left - 1);
    }
    if (unexplained.length > 0) return { ok: false, unexplained };
  }

  const unguardedReads = found.map(
    (entry) =>
      take(entry) ?? {
        entry,
        category: 0,
        reason: 'UNREVIEWED — seeded by --seed, needs a human triage pass.',
      },
  );
  return { ok: true, unguardedReads };
}

/**
 * The categories a PERSISTED row may carry. `3` ("a real unexpanded read")
 * is deliberately absent: a category-3 finding is a bug to fix, never a row
 * to keep, and `0` is the placeholder `--seed` stamps on something no human
 * has read yet.
 *
 * This exists because the gate used to ignore both fields entirely. It
 * compared `row.entry` and nothing else, so a `--seed` run could convert a
 * genuine new violation into an official-looking row reading "UNREVIEWED"
 * and every later run would pass — a laundering path through the flag the
 * `--update` refusal message points people at. A category and a reason that
 * nothing validates are a memo field, not a memory (review of station#3246).
 */
export const PERSISTABLE_CATEGORIES = Object.freeze([1, 2, 4]);

/** Rows whose recorded judgement is missing, placeholder, or out of vocabulary. */
export function unreviewedRows(baselineRows) {
  return baselineRows.filter(
    (row) =>
      !PERSISTABLE_CATEGORIES.includes(row.category) ||
      typeof row.reason !== 'string' ||
      row.reason.trim() === '',
  );
}

/**
 * The steady-state (non-`--update`) comparison: what got added (fails the
 * gate) and what got removed (fixed, lowers the baseline on the next
 * `--update`). Pure — see the test file referenced above.
 */
export function compareToBaseline({ found, baselineRows }) {
  const allowed = new Set(baselineRows.map((row) => row.entry));
  const added = found.filter((entry) => !allowed.has(entry));
  const removed = baselineRows.filter((row) => !found.includes(row.entry));
  // The gate reads the recorded judgement, not just the key. Without this a
  // `category: 0` placeholder row passes forever and the baseline's whole
  // value -- that every remaining entry was READ by someone -- is a claim
  // nothing computes.
  return { added, removed, unreviewed: unreviewedRows(baselineRows) };
}
/**
 * The CLI, behind a main-module guard. It used to run at import time, which
 * meant importing this file to unit-test its pure functions EXECUTED the gate
 * over the whole repository — and on a tree with a genuine new unguarded read
 * the module called `process.exit(1)` during import, so the test file died
 * with "Tests no tests" instead of reporting anything. The unit tests were
 * silently coupled to the repo's live state, and a real violation would have
 * surfaced as an unloadable test file rather than a failing gate.
 *
 * Found by fault injection: collapsing the detector's line window made the
 * gate fail, which killed the test run before a single test executed, which
 * read as "the mutation was not caught" (station#3246 review round).
 */
async function main() {
  const files = await listSourceFiles();
  const found = [];
  for (const file of files) {
    const source = readFileSync(join(root, file), 'utf8');
    for (const hit of unguardedReads(source)) {
      // Keyed on the STATEMENT, not the line number. Line keys meant that
      // adding one import shifted six entries and reported them as new
      // violations — and the prescribed remedy (--update) regenerates the whole
      // baseline, silently absorbing any genuinely new read in the same commit.
      // The ratchet defeating itself along its own happy path.
      found.push(`${file} :: ${hit.field} :: ${hit.text}`);
    }
  }
  found.sort();

  const updating =
    process.argv.includes('--update') || process.argv.includes('--seed');
  if (updating) {
    const previousEntries = JSON.parse(
      readFileSync(BASELINE, 'utf8'),
    ).unguardedReads;
    // `--seed` is for establishing the baseline itself (first run, or a change
    // to the key/shape format). It is deliberately a DIFFERENT flag from
    // `--update`, because the refusal inside computeUpdatedBaseline is the
    // only thing stopping `--update` — the documented recovery from a cosmetic
    // line shift — from absorbing a real new violation in the same commit.
    const seeding =
      process.argv.includes('--seed') || previousEntries.length === 0;
    const result = computeUpdatedBaseline({ found, previousEntries, seeding });
    if (!result.ok) {
      console.error(
        'FAIL: --update refuses to add an unexplained entry to the baseline.\n' +
          'These reads have no recorded category/reason:\n',
      );
      for (const entry of result.unexplained) console.error(`  + ${entry}`);
      console.error(
        '\nExpand the read, or — if it is genuinely safe — add it to\n' +
          'scripts/stored-path-expansion-baseline.json by hand with a category\n' +
          '(1 = never reaches the filesystem, 2 = reaches it already expanded\n' +
          'elsewhere, 3 = a real bug — fix it instead) and a one-line reason,\n' +
          'then re-run --update to pick up any OTHER, already-explained changes.',
      );
      process.exit(1);
    }
    writeFileSync(
      BASELINE,
      `${JSON.stringify({ unguardedReads: result.unguardedReads }, null, 2)}\n`,
    );
    console.log(
      `OK: baseline written with ${result.unguardedReads.length} unguarded read(s)`,
    );
    process.exit(0);
  }

  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
  const { added, removed, unreviewed } = compareToBaseline({
    found,
    baselineRows: baseline.unguardedReads,
  });

  if (unreviewed.length > 0) {
    console.error(
      'FAIL: the baseline holds rows nobody has triaged.\n' +
        'Every row must carry a category (1, 2 or 4) and a reason a human wrote\n' +
        'after reading the surrounding code. A placeholder row passes the gate\n' +
        'forever and makes the baseline look reviewed when it is not.\n',
    );
    for (const row of unreviewed)
      console.error(`  ? [category ${row.category ?? 'missing'}] ${row.entry}`);
    console.error(
      '\nRead each one and record why it is safe, or fix the read. `--seed`\n' +
        'stamps `category: 0` deliberately so this gate catches it.',
    );
    process.exit(1);
  }

  if (added.length > 0) {
    console.error(
      'FAIL: a stored path is read without resolve(expandTilde(...)).\n' +
        'These fields hold `~/...` verbatim; using one raw silently reads or\n' +
        'writes the wrong directory. See station#3155.\n',
    );
    for (const entry of added) console.error(`  + ${entry}`);
    console.error(
      '\nExpand at the read, or — if the value is genuinely remote or already\n' +
        'expanded upstream — say so in a comment and run:\n' +
        '  node scripts/stored-path-expansion-guard.mjs --update',
    );
    process.exit(1);
  }

  console.log(
    `OK: ${found.length} known unguarded read(s), 0 new` +
      (removed.length > 0
        ? `; ${removed.length} fixed — re-run with --update to lower the baseline`
        : ''),
  );
}

if (
  process.argv[1] &&
  join(
    fileURLToPath(new URL('.', import.meta.url)),
    'stored-path-expansion-guard.mjs',
  ) === process.argv[1]
) {
  await main();
}
