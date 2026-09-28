import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { collectDocumentationChanges } from '../documentation-impact.mjs';
import {
  compileDocumentationReviews,
  reviewInputs,
} from './documentation-review.mjs';
import { captureInputs, compileLearningMedia } from './learning-media.mjs';
import { createLearningSourceReader } from './learning-source-reader.mjs';
import { readReviewState, readReviewStateAt } from './review-ledger-store.mjs';

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
      .filter((source) => changedPaths.has(source));
    const now = current.get(path);
    if (!now) {
      if (touched.length && exists(path))
        problems.push({
          kind,
          path,
          inputs: inputs(previous),
          changed: touched,
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
      problem: `dropped cited sources this change modifies without a review note: ${dropped.join(', ')}; record the review with npm run docs:review:record -- ${path} --note "<what you checked>" --drop-source <path>`,
    });
  }
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
    return {
      mode: 'strict',
      reason: `cannot compute this change's scope against ${base} (${detail}); every stale entry blocks. Set ${DOCS_FRESHNESS_BASE_ENV} to the change's base.`,
    };
  }
  const current = ledger ? { ledger, media } : readReviewState(root);
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
  return {
    mode,
    reason: `${reason} (base ${base}, merge base ${selection.mergeBase})`,
    base,
    mergeBase: selection.mergeBase,
    changedPaths,
    changedEntries: {
      review: changedEntries(...entries.review),
      capture: changedEntries(...entries.capture),
    },
    sourceDrops: Object.entries(entries).flatMap(([kind, [before, now]]) =>
      unreviewedSourceDrops(kind, before, now, changedPaths, (path) =>
        reader.exists(path),
      ),
    ),
  };
}

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
  return (
    Boolean(policy.changedEntries?.[kind]?.has(path)) ||
    policy.changedPaths.has(path) ||
    inputs.some((input) => policy.changedPaths.has(input))
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
  const { ledger, media } = readReviewState(root);
  const resolved =
    policy ?? resolveDocumentationFreshness({ root, env, ledger, media });
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
      })),
    ...[...captures.values()]
      .filter((capture) => capture.changed.length)
      .map((capture) => ({
        kind: 'capture',
        path: capture.path,
        inputs: captureInputs(capture),
        changed: capture.changed,
      })),
  ];
  const blocking = [
    ...stale.filter((entry) => freshnessBlocks(resolved, entry)),
    ...(resolved.sourceDrops ?? []),
  ];
  return {
    policy: resolved,
    reviews,
    captures,
    blocking,
    advisory: stale.filter((entry) => !blocking.includes(entry)),
  };
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
