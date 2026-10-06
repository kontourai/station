import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectDocumentationChanges } from '../documentation-impact.mjs';
import {
  compileDocumentationReviews,
  reviewInputs,
} from './documentation-review.mjs';
import { captureInputs, compileLearningMedia } from './learning-media.mjs';
import { createLearningSourceReader } from './learning-source-reader.mjs';
import { bindingFile } from './review-binding.mjs';
import {
  reviewDecisionChanged,
  touchedReviewInputs,
} from './review-history.mjs';
import {
  isNoteArchiveFile,
  listNoteArchiveFilesAt,
  listReviewLedgerFiles,
  listReviewNoteFilesAt,
  noteArchiveFile,
  parseNoteArchive,
  REVIEW_LEDGER_DIR,
  REVIEW_LEDGER_INDEX,
  readGitObjects,
  readReviewState,
  readReviewStateAt,
} from './review-ledger-store.mjs';

/**
 * One owner decides when a stale recorded review or capture blocks (#2923).
 *
 * Staleness is caught once, at PR time, in the change that caused it:
 * - `scoped` (local runs, pre-push, `ci:fast` and PR events): a stale entry
 *   blocks when this change's own diff against its merge base touches the
 *   entry's document, capture or a recorded source, or edits the entry itself.
 * - `advisory` (merge queue, pushes to main, Nightly and other non-PR
 *   workflow events): stale entries are reported, never failed. The queue
 *   candidate contains other PRs' changes, and every PR already passed the
 *   scoped check on its own head. The Nightly freshness sweep reports the
 *   remaining cross-PR staleness on main in one tracking issue.
 * - `strict`: every stale entry blocks. Used when the change scope cannot be
 *   computed, so a missing base fails closed rather than passing.
 */
export const DOCS_FRESHNESS_MODE_ENV = 'STATION_DOCS_FRESHNESS';
const DOCS_FRESHNESS_BASE_ENV = 'STATION_DOCS_FRESHNESS_BASE';
/** ci:fast's base; the PR check sets it to the pull request's base SHA. */
const CI_FAST_BASE_ENV = 'STATION_CI_FAST_BASE';
const MODES = new Set(['scoped', 'advisory', 'strict']);
/** Every environment variable the mode and scope are derived from. */
export const DOCS_FRESHNESS_ENV_KEYS = Object.freeze([
  DOCS_FRESHNESS_MODE_ENV,
  DOCS_FRESHNESS_BASE_ENV,
  CI_FAST_BASE_ENV,
  'GITHUB_ACTIONS',
  'GITHUB_EVENT_NAME',
]);

/**
 * A copy of `env` without the variables that choose a freshness mode, so a
 * caller (a test fixture, a spawned check) states its mode explicitly instead
 * of inheriting the job's.
 * @param {NodeJS.ProcessEnv} env
 */
export function withoutFreshnessEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => !DOCS_FRESHNESS_ENV_KEYS.includes(key),
    ),
  );
}
const PR_EVENTS = new Set(['pull_request', 'pull_request_target']);
const NOTES_DIR = `${REVIEW_LEDGER_DIR}/notes`;

/**
 * Whether this run judges a pull request. Mode selection has already sent
 * every non-PR GitHub event (merge queue, push, Nightly) to advisory before
 * any scope is computed, so only PR events and ci:fast reach a scope.
 */
export function isPullRequestContext(env) {
  return (
    (env.GITHUB_ACTIONS === 'true' && PR_EVENTS.has(env.GITHUB_EVENT_NAME)) ||
    Boolean(env[CI_FAST_BASE_ENV])
  );
}

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** @param {NodeJS.ProcessEnv} [env] */
export function documentationFreshnessMode(env = process.env) {
  const explicit = env[DOCS_FRESHNESS_MODE_ENV];
  if (explicit !== undefined && explicit !== '') {
    if (!MODES.has(explicit))
      throw new Error(
        `${DOCS_FRESHNESS_MODE_ENV} must be scoped, advisory or strict, not '${String(explicit).slice(0, 32)}'`,
      );
    return { mode: explicit, reason: `${DOCS_FRESHNESS_MODE_ENV}=${explicit}` };
  }
  if (env.GITHUB_ACTIONS === 'true' && !PR_EVENTS.has(env.GITHUB_EVENT_NAME))
    return {
      mode: 'advisory',
      reason: `GitHub ${env.GITHUB_EVENT_NAME || 'unknown'} event: pull requests own freshness, and the Nightly sweep reports what remains`,
    };
  return { mode: 'scoped', reason: 'stale entries this change touches block' };
}

/** JSON with sorted keys, so key order never reads as an edit. */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

const byPath = (entries) =>
  new Map((entries ?? []).map((entry) => [entry.path, entry]));

/**
 * Entries added or edited since the merge base, compared in compiled form so
 * a storage-layout change alone never puts an entry in scope.
 */
function changedEntries(before, current) {
  return new Set(
    [...current]
      .filter(
        ([path, entry]) =>
          !before.has(path) ||
          stableJson(before.get(path)) !== stableJson(entry),
      )
      .map(([path]) => path),
  );
}

/**
 * #2936 D5: a change must not escape re-review by editing a source and
 * deleting its citation. When a record or capture loses a source that this
 * change also modifies, the change must add a review note to that entry
 * (which `docs:review:record --drop-source` does). Removing the whole record
 * while its document remains and a cited source changed is refused outright.
 */
function unreviewedSourceDrops(kind, before, current, changedPaths, exists) {
  const problems = [];
  const inputs = kind === 'review' ? reviewInputs : captureInputs;
  for (const [path, previous] of before) {
    const touched = previous.sources
      .map((source) => source.path)
      .filter((source) => changedPaths.has(bindingFile(source)));
    const now = current.get(path);
    if (!now) {
      if (touched.length && exists(path))
        problems.push({
          kind,
          path,
          inputs: inputs(previous),
          changed: touched,
          rule: 'record-removed',
          problem: `record removed while this change modifies its cited sources: ${touched.join(', ')}; keep the record and review it`,
        });
      continue;
    }
    const dropped = touched.filter(
      (source) => !now.sources.some((entry) => entry.path === source),
    );
    if (!dropped.length) continue;
    const earlier = new Set(previous.notes.map((note) => note.file));
    if (now.notes.some((note) => !earlier.has(note.file))) continue;
    problems.push({
      kind,
      path,
      inputs: inputs(now),
      changed: dropped,
      rule: 'unreviewed-drop',
      problem: `dropped cited sources this change modifies without a review note: ${dropped.join(', ')}; record the review with npm run docs:review:record -- ${path} --note "<what you checked>" --drop-source <path>`,
    });
  }
  return problems;
}

const noteProblem = (path, rule, problem) => ({
  kind: 'note',
  path,
  inputs: [],
  changed: [],
  rule,
  problem,
});

/**
 * Notes are append-only (#3036) and note archives immutable (#3394), judged
 * against the merge base, so a note another PR landed later is never mistaken
 * for this change's deletion. A loose note may leave only into the one archive
 * `docs:review:record -- --advance-baseline` writes, which the merge base fully
 * determines: it is named for the merge base's coverage baseline, the same
 * change moves that baseline (whose new value `baselineAdvanceProblem` judges),
 * and it holds exactly the merge base's loose notes that were already in the
 * tree at that baseline, with their exact merge-base bytes. Any other added
 * archive is refused, so no PR can pre-empt the name the next advance writes.
 * @param {string} root
 * @param {string} mergeBase
 * @param {{ from?: string, to?: string }} baseline the coverage baseline at the
 * merge base (`from`) and in this change (`to`)
 */
export function appendOnlyNoteProblems(root, mergeBase, { from, to }) {
  const problems = [];
  const reader = createLearningSourceReader(root);
  const blobs = (ref, files) =>
    readGitObjects(
      root,
      files.map((file) => `${ref}:${file}`),
    ).map((bytes) => bytes?.toString('utf8'));
  const baseArchives = listNoteArchiveFilesAt(root, mergeBase);
  const [baseBytes, headBytes] = [mergeBase, 'HEAD'].map((ref) =>
    blobs(ref, baseArchives),
  );
  baseArchives.forEach((file, index) => {
    const disk = reader.exists(file)
      ? reader.read(file).toString('utf8')
      : undefined;
    if (headBytes[index] !== baseBytes[index] || disk !== baseBytes[index])
      problems.push(
        noteProblem(
          file,
          'archive-changed',
          `note archive ${file} exists at the merge base but was ${disk === undefined || headBytes[index] === undefined ? 'removed' : 'modified'}; archives are immutable; restore it and add notes with npm run docs:review:record`,
        ),
      );
  });
  const baseNotes = listReviewNoteFilesAt(root, mergeBase);
  const landed = new Set(baseArchives);
  /** Notes moved by an accepted archive. */
  const moved = new Set();
  for (const archive of listReviewLedgerFiles(root).filter(
    (file) => isNoteArchiveFile(file) && !landed.has(file),
  )) {
    const held = parseNoteArchive(
      archive,
      reader.read(archive).toString('utf8'),
    );
    const refuse = (why) =>
      problems.push(
        noteProblem(
          archive,
          'archive-unbacked',
          `note archive ${archive} ${why}; only npm run docs:review:record -- --advance-baseline writes an archive`,
        ),
      );
    const expectedName = /^[0-9a-f]{40}$/.test(String(from))
      ? noteArchiveFile(from)
      : undefined;
    if (archive !== expectedName) {
      refuse(
        expectedName
          ? `is not named for the merge base's coverage baseline (${expectedName})`
          : 'is added, but the merge base has no coverage baseline to archive',
      );
      continue;
    }
    if (!to || to === from) {
      refuse(
        `is added by a change that does not advance coverageBaseline from ${from}`,
      );
      continue;
    }
    const atBaseline = new Set(listReviewNoteFilesAt(root, from));
    const expected = baseNotes.filter((file) => atBaseline.has(file));
    const missing = expected.filter((file) => !held.has(file));
    const extra = [...held.keys()].filter((file) => !expected.includes(file));
    if (missing.length || extra.length) {
      refuse(
        `must hold exactly the ${expected.length} loose note(s) the merge base had at baseline ${from}${
          missing.length ? `; missing ${missing.join(', ')}` : ''
        }${extra.length ? `; not eligible ${extra.join(', ')}` : ''}`,
      );
      continue;
    }
    const files = [...held.keys()];
    const atBase = blobs(mergeBase, files);
    const changed = files.filter(
      (file, index) => atBase[index] !== held.get(file),
    );
    if (changed.length) {
      refuse(
        `does not carry the exact merge-base bytes of ${changed.join(', ')}`,
      );
      continue;
    }
    for (const file of files) moved.add(file);
  }
  const currentNotes = new Set(listReviewNoteFilesAt(root, 'HEAD'));
  for (const file of baseNotes)
    if (
      (!currentNotes.has(file) || !existsSync(join(root, file))) &&
      !moved.has(file)
    )
      problems.push(
        noteProblem(
          file,
          'note-removed',
          `note file ${file} exists at the merge base but is gone; notes are append-only; re-record instead (npm run docs:review:record -- <doc> --note "<what you checked>")`,
        ),
      );
  return problems;
}

/**
 * Resolve the freshness policy for a checkout.
 * @param {{ root?: string, env?: NodeJS.ProcessEnv, ledger?: { records: any[] }, media?: { captures: any[] } }} [input]
 * `ledger` and `media` are the compiled working-tree state from
 * `readReviewState`; they are read when omitted.
 */
export function resolveDocumentationFreshness({
  root = process.cwd(),
  env = process.env,
  ledger,
  media,
} = {}) {
  const { mode, reason } = documentationFreshnessMode(env);
  if (mode !== 'scoped') return { mode, reason };
  if (git(root, ['rev-parse', '--is-shallow-repository']).trim() === 'true')
    return {
      mode: 'advisory',
      reason: 'shallow checkout: report review history, do not judge scope',
    };
  const base =
    env[DOCS_FRESHNESS_BASE_ENV] || env[CI_FAST_BASE_ENV] || 'origin/main';
  if (base.startsWith('-'))
    throw new Error('Documentation freshness base must be a Git ref');
  let selection;
  try {
    selection = collectDocumentationChanges(root, base);
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error)
      .trim()
      .split('\n')[0];
    const strictReason = `cannot compute this change's scope against ${base} (${detail}); every stale entry blocks. Set ${DOCS_FRESHNESS_BASE_ENV} to the change's base.`;
    // Only the version 3 layout has notes to protect.
    const layout = (ledger ?? readReviewState(root, { history: false }).ledger)
      ?.layoutVersion;
    if (layout !== 3)
      return {
        mode: 'strict',
        reason: strictReason,
        appendOnly: 'not-applicable',
      };
    // Strict cannot see a deleted note, so without a merge base the
    // append-only guard is unverified. A PR must not pass on that.
    if (isPullRequestContext(env))
      return {
        mode: 'strict',
        reason: strictReason,
        appendOnly: 'NOT_VERIFIED',
        sourceDrops: [
          {
            kind: 'note',
            path: NOTES_DIR,
            inputs: [],
            changed: [],
            rule: 'append-only-unverified',
            problem: `cannot verify that notes are append-only without a merge base against ${base} (${detail}); fetch the base history or set ${DOCS_FRESHNESS_BASE_ENV}`,
          },
        ],
      };
    return {
      mode: 'strict',
      reason: strictReason,
      appendOnly: 'NOT_VERIFIED',
    };
  }
  const current = ledger
    ? { ledger, media }
    : readReviewState(root, { history: false });
  const previous = readReviewStateAt(root, selection.mergeBase);
  const reader = createLearningSourceReader(root);
  const changedPaths = new Set(selection.paths);
  const entries = {
    review: [byPath(previous.ledger?.records), byPath(current.ledger?.records)],
    capture: [
      byPath(previous.media?.captures),
      byPath(current.media?.captures),
    ],
  };
  const noteCoverage = [];
  const historyEntries = new Set();
  const dirty = new Set(
    git(root, ['diff', '--name-only', '-z', 'HEAD', '--'])
      .split('\0')
      .filter(Boolean),
  );
  const noteIntroductions = new Map();
  const rangeCommits = new Set(
    git(root, ['rev-list', `${selection.mergeBase}..HEAD`])
      .trim()
      .split('\n')
      .filter(Boolean),
  );
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  // One log of the range, not one per note and input: each spawn costs more
  // than the walk on a busy host. Unlike a path-limited log this keeps commits
  // on simplified-away side branches, which only adds candidates to recheck.
  // --no-renames keeps a moved-away input's old path; -z keeps paths unquoted.
  let rangeTouches;
  const commitsTouching = (file) => {
    if (!rangeTouches) {
      rangeTouches = new Map();
      let commit;
      for (const token of git(root, [
        'log',
        '--no-merges',
        '--no-renames',
        '-z',
        '--format=\u0001%H',
        '--name-only',
        `${selection.mergeBase}..HEAD`,
        `^${base}`,
      ]).split('\0')) {
        // -z ends the format with NUL and starts the file list with a newline.
        const line = token.startsWith('\n') ? token.slice(1) : token;
        if (line.startsWith('\u0001')) commit = line.slice(1);
        else if (line && commit) {
          if (!rangeTouches.has(line)) rangeTouches.set(line, []);
          rangeTouches.get(line).push(commit);
        }
      }
    }
    return rangeTouches.get(file) ?? [];
  };
  const commitsAfter = new Map();
  const reachableAfter = (from) => {
    if (!commitsAfter.has(from))
      commitsAfter.set(
        from,
        new Set(
          git(root, ['rev-list', `${from}..HEAD`, `^${base}`])
            .trim()
            .split('\n')
            .filter(Boolean),
        ),
      );
    return commitsAfter.get(from);
  };
  const appendOnlyProblems = [];
  const layoutV3 = current.ledger?.layoutVersion === 3;
  if (layoutV3) {
    const baseState = readReviewStateAt(root, base);
    appendOnlyProblems.push(
      ...appendOnlyNoteProblems(root, selection.mergeBase, {
        from: previous.ledger?.coverageBaseline,
        to: current.ledger?.coverageBaseline,
      }),
    );
    for (const [kind, [before, now]] of Object.entries(entries)) {
      const landed = byPath(
        kind === 'review'
          ? baseState.ledger?.records
          : baseState.media?.captures,
      );
      for (const [path, entry] of now) {
        historyEntries.add(path);
        const old = before.get(path);
        const dependencies = [
          ...new Set([...inputsFor(old), ...inputsFor(entry)]),
        ];
        const touched = touchedReviewInputs(
          root,
          dependencies,
          changedPaths,
          selection.mergeBase,
          'HEAD',
        );
        // Working-tree edits are included even when HEAD still holds the old value.
        if (reviewDecisionChanged(old, entry) && !touched.includes(path))
          touched.push(path);
        for (const input of dependencies)
          if (dirty.has(bindingFile(input)) && !touched.includes(input))
            touched.push(input);
        const earlier = new Set(
          [...(old?.notes ?? []), ...(landed.get(path)?.notes ?? [])].map(
            (note) => note.file,
          ),
        );
        const added = (entry.notes ?? []).filter(
          (note) => !earlier.has(note.file),
        );
        const rewrittenNotes = new Map();
        const uncovered = touched.filter(
          (input) =>
            !added.some((note) => {
              if (
                !note.inputs?.includes(input) ||
                dirty.has(bindingFile(input))
              )
                return false;
              // Do not let an old note approve a later edit on this PR. Excluding
              // the base branch keeps another landed PR from invalidating this note.
              if (!noteIntroductions.has(note.file))
                noteIntroductions.set(
                  note.file,
                  git(root, [
                    'log',
                    '--diff-merges=first-parent',
                    '--no-patch',
                    '--diff-filter=A',
                    '--format=%H',
                    '-1',
                    `${selection.mergeBase}..HEAD`,
                    '--',
                    note.file,
                  ]).trim(),
                );
              const introduced = noteIntroductions.get(note.file);
              const validRevision = introduced
                ? rangeCommits.has(note.revision)
                : note.revision === head;
              if (!introduced && validRevision) return true;
              const after = reachableAfter(introduced || head);
              const later = commitsTouching(bindingFile(input)).filter(
                (commit) => after.has(commit),
              );
              const changedLater = later.some(
                (commit) =>
                  touchedReviewInputs(
                    root,
                    [input],
                    new Set([bindingFile(input)]),
                    `${commit}^`,
                    commit,
                  ).length,
              );
              if (changedLater) return false;
              if (!validRevision) {
                if (!rangeCommits.has(note.revision)) {
                  if (!rewrittenNotes.has(note.file))
                    rewrittenNotes.set(note.file, { note, inputs: new Set() });
                  rewrittenNotes.get(note.file).inputs.add(input);
                }
                return false;
              }
              return true;
            }),
        );
        const rejected = [...rewrittenNotes.values()]
          .filter(({ inputs }) => uncovered.some((input) => inputs.has(input)))
          .map(({ note }) => note);
        if (uncovered.length)
          noteCoverage.push({
            kind,
            path,
            inputs: dependencies,
            changed: uncovered,
            rule: 'stale',
            ...(rejected.length
              ? {
                  problem: `note revision outside this change's range: ${rejected.map((note) => `${note.file} (revision ${note.revision})`).join(', ')}; history was rewritten after recording (or the note came from another history). Re-record with npm run docs:review:record -- ${path} --note "<what you checked>".`,
                }
              : {}),
          });
      }
    }
  }
  return {
    mode,
    reason: `${reason} (base ${base}, merge base ${selection.mergeBase})`,
    base,
    mergeBase: selection.mergeBase,
    changedPaths,
    historyEntries,
    // Judged in checkDocumentationFreshness: the check replays Git history.
    baselineChange:
      previous.ledger?.coverageBaseline !== current.ledger?.coverageBaseline
        ? {
            from: previous.ledger?.coverageBaseline,
            to: current.ledger?.coverageBaseline,
          }
        : undefined,
    changedEntries: {
      review: changedEntries(...entries.review),
      capture: changedEntries(...entries.capture),
    },
    appendOnly: layoutV3 ? 'verified' : 'not-applicable',
    sourceDrops: [
      ...appendOnlyProblems,
      ...noteCoverage,
      ...Object.entries(entries).flatMap(([kind, [before, now]]) =>
        unreviewedSourceDrops(kind, before, now, changedPaths, (path) =>
          reader.exists(path),
        ),
      ),
    ],
  };
}

const inputsFor = (entry) =>
  entry ? [entry.path, ...entry.sources.map((source) => source.path)] : [];

/**
 * The single decision: does this stale entry block under `policy`?
 * @param {{ mode: string, changedPaths?: Set<string>, changedEntries?: Record<string, Set<string>> }} policy
 * @param {{ kind: 'review' | 'capture', path: string, inputs: string[] }} entry
 */
export function freshnessBlocks(policy, { kind, path, inputs }) {
  if (policy.mode === 'strict') return true;
  if (policy.mode === 'advisory') return false;
  if (policy.mode !== 'scoped')
    throw new Error(`Unknown documentation freshness mode: ${policy.mode}`);
  if (policy.historyEntries?.has(path)) return false;
  return (
    Boolean(policy.changedEntries?.[kind]?.has(path)) ||
    policy.changedPaths.has(path) ||
    inputs.some((input) => policy.changedPaths.has(bindingFile(input)))
  );
}

/** Adapts a policy to the `requireFresh` option of the review and media compilers. */
export function freshnessRequirement(policy, kind) {
  return ({ path, inputs }) => freshnessBlocks(policy, { kind, path, inputs });
}

export function formatFreshnessAdvisory(policy, advisories) {
  if (!advisories.length) return '';
  return [
    `Documentation freshness (${policy.mode}): ${advisories.length} stale entries outside this change's scope are advisory; the Nightly freshness sweep tracks them.`,
    ...advisories.map(
      (entry) =>
        `  ${entry.kind} ${entry.path}; changed: ${entry.changed.join(', ')}`,
    ),
  ].join('\n');
}

/**
 * Tracked paths plus a reader that returns the same bytes for every read of a
 * path, so digests and validation see one snapshot.
 * @param {string} root
 */
export function createRepositorySnapshot(root) {
  const reader = createLearningSourceReader(root);
  const tracked = new Set(
    git(root, ['ls-files', '-z']).split('\0').filter(Boolean),
  );
  const captured = new Map();
  const read = async (file) => {
    if (!captured.has(file)) captured.set(file, reader.read(file));
    return captured.get(file);
  };
  return { tracked, read };
}

/**
 * Check every recorded review and capture in a checkout under one policy.
 * Returns the blocking and advisory stale entries; throws only through
 * `assertDocumentationFresh`, so callers can report all of them at once.
 * @param {{ root?: string, env?: NodeJS.ProcessEnv, policy?: ReturnType<typeof resolveDocumentationFreshness> }} [input]
 */
export async function checkDocumentationFreshness({
  root = process.cwd(),
  env = process.env,
  policy,
} = {}) {
  const { tracked, read } = createRepositorySnapshot(root);
  let { ledger, media } = readReviewState(root, { history: false });
  const resolved =
    policy ?? resolveDocumentationFreshness({ root, env, ledger, media });
  if (resolved.mode !== 'scoped') ({ ledger, media } = readReviewState(root));
  if (resolved.mode === 'strict' && ledger.historyUnavailable)
    throw new Error(
      `Strict documentation freshness cannot judge freshness. ${ledger.historyUnavailable}`,
    );
  const documents = new Map();
  for (const file of tracked)
    if (/\.(md|mdx|markdown)$/i.test(file))
      documents.set(
        file,
        createHash('sha256')
          .update(await read(file))
          .digest('hex'),
      );
  // A document or source that is no longer tracked is a stale input, not a
  // malformed ledger: the policy decides, so the queue never fails on a file
  // another PR removed, while a PR's own deletion is in its scope.
  const reviews = await compileDocumentationReviews(
    ledger,
    documents,
    tracked,
    read,
    { reportMissing: true },
  );
  const captures = media
    ? await compileLearningMedia(media, tracked, read, { reportMissing: true })
    : new Map();
  const stale = [
    ...[...reviews.values()]
      .filter((review) => review.changed.length)
      .map((review) => ({
        kind: 'review',
        path: review.path,
        inputs: reviewInputs(review),
        changed: review.changed,
        rule: 'stale',
      })),
    ...[...captures.values()]
      .filter((capture) => capture.changed.length)
      .map((capture) => ({
        kind: 'capture',
        path: capture.path,
        inputs: captureInputs(capture),
        changed: capture.changed,
        rule: 'stale',
      })),
  ];
  const baselineProblem =
    resolved.mode === 'scoped' && resolved.baselineChange
      ? await baselineAdvanceProblem(
          root,
          resolved.baselineChange,
          resolved.mergeBase,
        )
      : undefined;
  const blocking = [
    ...stale.filter((entry) => freshnessBlocks(resolved, entry)),
    ...(resolved.sourceDrops ?? []),
    ...(baselineProblem ? [baselineProblem] : []),
  ];
  return {
    policy: resolved,
    reviews,
    captures,
    blocking,
    historyUnavailable: ledger.historyUnavailable,
    advisory: stale.filter(
      (entry) =>
        !blocking.some(
          (problem) =>
            problem.kind === entry.kind && problem.path === entry.path,
        ),
    ),
  };
}

/**
 * A PR that changes `coverageBaseline` may only move it to a commit reachable
 * from its merge base at which strict freshness passes: the same rule
 * `docs:review:record -- --advance-baseline` enforces, so a hand edit cannot
 * skip an uncovered main commit. Returns a blocking entry, or undefined.
 */
async function baselineAdvanceProblem(root, { from, to }, mergeBase) {
  const fail = (problem) => ({
    kind: 'baseline',
    path: REVIEW_LEDGER_INDEX,
    rule: 'baseline',
    problem: `${problem} Move the baseline only with npm run docs:review:record -- --advance-baseline on a clean checkout of main, then commit the index.`,
  });
  const label = `coverageBaseline ${String(from)} -> ${String(to)}`;
  if (!/^[0-9a-f]{40}$/.test(String(to)))
    return fail(`${label}: not a commit id.`);
  try {
    git(root, ['merge-base', '--is-ancestor', to, mergeBase]);
  } catch {
    return fail(
      `${label}: the new baseline is not reachable from this change's merge base.`,
    );
  }
  const dir = mkdtempSync(join(tmpdir(), 'station-baseline-'));
  try {
    git(root, ['worktree', 'add', '--detach', '--quiet', dir, to]);
    assertDocumentationFresh(
      await checkDocumentationFreshness({
        root: dir,
        env: { STATION_DOCS_FRESHNESS: 'strict' },
      }),
    );
  } catch (error) {
    return fail(
      `${label}: strict freshness does not pass at the new baseline (${String(
        error?.message ?? error,
      )
        .split('\n')
        .slice(0, 4)
        .join('; ')}).`,
    );
  } finally {
    try {
      git(root, ['worktree', 'remove', '--force', dir]);
    } catch {
      rmSync(dir, { recursive: true, force: true });
      try {
        git(root, ['worktree', 'prune']);
      } catch {}
    }
  }
  return undefined;
}

export function assertDocumentationFresh(result) {
  if (!result.blocking.length) return;
  throw new Error(
    [
      `Documentation review needs refresh (${result.policy.mode}: ${result.policy.reason}):`,
      ...result.blocking.map(
        (entry) =>
          `  ${entry.kind} ${entry.path}; ${entry.problem ?? `changed: ${entry.changed.join(', ')}`}`,
      ),
      'Review the changed claims, then record them with npm run docs:review:record -- <path> --note "<what you checked>".',
    ].join('\n'),
  );
}
