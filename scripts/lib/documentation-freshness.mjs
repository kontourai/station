import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { collectDocumentationChanges } from '../documentation-impact.mjs';
import {
  compileDocumentationReviews,
  reviewInputs,
} from './documentation-review.mjs';
import {
  captureInputs,
  compileLearningMedia,
  LEARNING_MEDIA_MANIFEST,
} from './learning-media.mjs';
import { createLearningSourceReader } from './learning-source-reader.mjs';

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
export const REVIEW_LEDGER = 'docs/learn/review-ledger.json';
const MODES = new Set(['scoped', 'advisory', 'strict']);
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

/** Entry paths added or edited since `mergeBase` in a `{ [key]: [{ path }] }` manifest. */
function changedEntries(root, mergeBase, file, key, current) {
  let previous = [];
  try {
    previous = JSON.parse(git(root, ['show', `${mergeBase}:${file}`]))[key];
  } catch (error) {
    // A manifest absent at the base makes every current entry new.
    const stderr = String(error?.stderr ?? '');
    if (!/does not exist|exists on disk, but not in/.test(stderr)) throw error;
  }
  const before = new Map(
    (Array.isArray(previous) ? previous : []).map((entry) => [
      entry?.path,
      JSON.stringify(entry),
    ]),
  );
  return new Set(
    (current ?? [])
      .filter((entry) => before.get(entry?.path) !== JSON.stringify(entry))
      .map((entry) => entry?.path),
  );
}

/**
 * Resolve the freshness policy for a checkout.
 * @param {{ root?: string, env?: NodeJS.ProcessEnv, ledger?: { records?: { path: string }[] }, media?: { captures?: { path: string }[] } }} [input]
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
  const reader = createLearningSourceReader(root);
  const read = (file) => JSON.parse(reader.read(file).toString('utf8'));
  const currentLedger = ledger ?? read(REVIEW_LEDGER);
  const currentMedia =
    media ??
    (reader.exists(LEARNING_MEDIA_MANIFEST)
      ? read(LEARNING_MEDIA_MANIFEST)
      : { captures: [] });
  return {
    mode,
    reason: `${reason} (base ${base}, merge base ${selection.mergeBase})`,
    base,
    mergeBase: selection.mergeBase,
    changedPaths: new Set(selection.paths),
    changedEntries: {
      review: changedEntries(
        root,
        selection.mergeBase,
        REVIEW_LEDGER,
        'records',
        currentLedger.records,
      ),
      capture: changedEntries(
        root,
        selection.mergeBase,
        LEARNING_MEDIA_MANIFEST,
        'captures',
        currentMedia.captures,
      ),
    },
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
  const ledger = JSON.parse((await read(REVIEW_LEDGER)).toString('utf8'));
  const media = tracked.has(LEARNING_MEDIA_MANIFEST)
    ? JSON.parse((await read(LEARNING_MEDIA_MANIFEST)).toString('utf8'))
    : undefined;
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
  const reviews = await compileDocumentationReviews(
    ledger,
    documents,
    tracked,
    read,
  );
  const captures = media
    ? await compileLearningMedia(media, tracked, read)
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
  const blocking = stale.filter((entry) => freshnessBlocks(resolved, entry));
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
          `  ${entry.kind} ${entry.path}; changed: ${entry.changed.join(', ')}`,
      ),
      'Review the changed claims, then record them with npm run docs:review:record -- <path> --note "<what you checked>".',
    ].join('\n'),
  );
}
