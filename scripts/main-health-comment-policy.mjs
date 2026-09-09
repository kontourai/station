import { createHash } from 'node:crypto';

/**
 * Deterministic comment policy for `.github/workflows/main-health.yml` (#1811).
 *
 * ## What was wrong
 *
 * The tracker issue is deduped by title — one issue per watched workflow,
 * reopened when it is red again and closed on a real green — but every red run
 * also posted a comment. `Main pipeline red: Backlog disposition policy` (#924)
 * collected 326 comments in nine days, and the scheduled advisory floor now
 * fires four times a day, so a single unattended red adds four comments daily.
 * A tracker nobody can read is a tracker nobody reads.
 *
 * ## The policy
 *
 * A comment is news when the STATE changed, and otherwise a daily heartbeat is
 * enough:
 *
 * 1. **Reopened after green** — the tracker was closed by a green run and this
 *    red reopened it. Always comment; that is the green-to-red transition.
 * 2. **No recorded state** — the tracker predates this policy (or its marker
 *    was edited away). Comment once to establish the marker, then go quiet.
 * 3. **Different failure** — a different job/step failed, or failed with a
 *    different conclusion, than the last comment recorded.
 * 4. **Heartbeat** — same failure, but 24h have passed since the last comment.
 *    Says how many red runs happened in that window.
 * 5. Otherwise **silent**: no new comment. The run is still recorded, by
 *    rewriting the comment that already exists — which updates its visible
 *    run link, head SHA and run count as well as the marker, so a reader
 *    between heartbeats sees current information rather than a day-old link.
 *    Editing a comment sends no notification, which is the whole point.
 *
 * A brand-new tracker is a special case with no marker at all: the run details
 * go in the issue BODY, and the next red posts a near-identical first comment
 * that establishes the marker. That is intentional, not a duplicate.
 *
 * ## Where the state lives
 *
 * In the last comment's own body, as an HTML-comment marker that renders
 * invisibly. That is deliberate: the alternative is a label, a separate state
 * issue, or an artifact, and each of those is a second store that can disagree
 * with the comment stream a reader is looking at. Reading it back costs one
 * paginated `listComments` call and no new permission — `issues: write`
 * already covers reading and editing comments.
 *
 * ## Whose comment may carry state
 *
 * Only a comment authored by a **bot**. A marker is just text, and GitHub's
 * "Quote reply" copies the raw markdown of a quoted comment — HTML comments
 * included — so a maintainer quoting the tracker would otherwise become the
 * state anchor, and every silent red run would rewrite THEIR comment with
 * `issues: write`. Authorship comes from `listComments`' own `user.type`, so
 * this is a derivation from what GitHub reports, not a claim about the text.
 * Quoted lines are stripped before the marker is read, so a bot that ever
 * quotes cannot anchor to someone else's state either.
 *
 * ## What can and cannot go wrong
 *
 * Every parse failure here resolves toward COMMENTING, never toward silence:
 * a missing, malformed, truncated, or non-bot marker yields `null`, which is
 * case 2. Failure identity is compared on a digest of the UNTRUNCATED failure
 * set, so the 20-entry display cap cannot make a changed failure look
 * unchanged. The one residual gap is per-label: two labels identical for their
 * first `MAX_FAILURE_LABEL_LENGTH` characters are indistinguishable, on both
 * sides of the comparison.
 */

/** Marker name; also the grep handle for a human reading raw comment source. */
export const MAIN_HEALTH_STATE_MARKER = 'main-health-state';

/** Longest silence before a heartbeat comment restates that main is still red. */
export const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Bounds on what a run's failure summary may DISPLAY. The comparison never
 * reads these — it reads a digest of the untruncated set — so tightening them
 * changes what a reader sees and nothing about when the tracker speaks.
 */
export const MAX_TRACKED_FAILURES = 20;
export const MAX_FAILURE_LABEL_LENGTH = 200;

/**
 * Conclusions that mean a job or step did not pass. `skipped` and `success`
 * are excluded; `null` (still running) cannot appear on a completed run.
 */
const UNSUCCESSFUL_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'startup_failure',
  'stale',
]);

/**
 * @typedef {object} MainHealthState
 * @property {string} lead First line of the comment carrying this state.
 * @property {string[]} failures Sorted job/step labels, truncated for display.
 * @property {number} failureCount How many there were before truncation.
 * @property {string} digest Digest of the untruncated set; the comparison key.
 * @property {number} redRunsSinceComment Red runs observed since this comment.
 * @property {string} commentedAt ISO timestamp this comment was posted.
 */

/**
 * @typedef {object} MainHealthDecision
 * @property {'create-comment' | 'update-marker'} action
 * @property {string} reason
 * @property {string} body Comment body to create, or rewritten body to store.
 * @property {MainHealthState} state The state that body carries.
 * @property {number | undefined} commentId Comment to edit, for `update-marker`.
 */

/**
 * Collapse a job or step name into a single bounded line that cannot terminate
 * the HTML comment carrying it. `-->` is rewritten rather than dropped so the
 * rewrite stays visible; both the stored and the freshly computed label pass
 * through this same function, so the comparison stays honest either way.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeFailureLabel(value) {
  return (
    String(value ?? '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: a job name is remote data; collapsing control characters is the point.
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/--+>/g, '->')
      .slice(0, MAX_FAILURE_LABEL_LENGTH)
  );
}

/**
 * Sorted and deduped, and deliberately NOT truncated — this is what the digest
 * is taken over.
 *
 * @param {Iterable<unknown> | undefined} failures
 * @returns {string[]}
 */
function normalizeFailures(failures) {
  const labels = new Set();
  for (const failure of failures ?? []) {
    const label = normalizeFailureLabel(failure);
    if (label) labels.add(label);
  }
  return [...labels].sort();
}

/**
 * The comparison key. Taken over the whole normalized set so that a run whose
 * first 20 sorted labels match an earlier run, but whose tail differs, is
 * still recognized as a different failure.
 *
 * @param {string[]} failures normalized, untruncated
 * @returns {string}
 */
export function failureDigest(failures) {
  return createHash('sha256')
    .update(failures.join('\n'), 'utf8')
    .digest('hex')
    .slice(0, 32);
}

/**
 * Describe what failed in a run, from `listJobsForWorkflowRun` output.
 *
 * Step granularity is what makes "a different failure" mean something: the
 * same job failing at a different step is news, and the same job failing at
 * the same step for the ninth time is not. A job reporting no failing step
 * (a startup failure, a cancelled job) still contributes its own name, so the
 * summary is never empty for a run that has an unsuccessful job.
 *
 * @param {{name?: unknown, conclusion?: unknown, steps?: {name?: unknown, conclusion?: unknown}[]}[]} jobs
 * @returns {string[]} normalized and untruncated
 */
export function summarizeRunFailure(jobs = []) {
  const failures = [];
  for (const job of jobs ?? []) {
    if (!UNSUCCESSFUL_CONCLUSIONS.has(String(job?.conclusion))) continue;
    const steps = Array.isArray(job?.steps) ? job.steps : [];
    const failedSteps = steps.filter((step) =>
      UNSUCCESSFUL_CONCLUSIONS.has(String(step?.conclusion)),
    );
    if (failedSteps.length === 0) {
      failures.push(`${job?.name} (${job?.conclusion})`);
      continue;
    }
    for (const step of failedSteps) {
      failures.push(`${job?.name} > ${step?.name} (${step?.conclusion})`);
    }
  }
  return normalizeFailures(failures);
}

const MARKER_PATTERN = new RegExp(
  `<!--\\s*${MAIN_HEALTH_STATE_MARKER}:\\s*(\\{[\\s\\S]*?\\})\\s*-->`,
);

/**
 * @param {MainHealthState} state
 * @returns {string}
 */
export function renderMainHealthState(state) {
  return `<!-- ${MAIN_HEALTH_STATE_MARKER}: ${JSON.stringify(state)} -->`;
}

/**
 * Drop quoted lines, the way `issue-lifecycle-reducer.mjs` does before reading
 * a reply: a marker inside a quote is a copy of someone else's state, not this
 * comment's own.
 *
 * @param {string} body
 * @returns {string}
 */
function unquoted(body) {
  return body
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line))
    .join('\n');
}

/**
 * Read a marker back. Returns `null` — "no state recorded", which comments —
 * for anything it cannot fully validate.
 *
 * @param {unknown} body
 * @returns {MainHealthState | null}
 */
export function parseMainHealthState(body) {
  const match = MARKER_PATTERN.exec(unquoted(String(body ?? '')));
  if (!match) return null;
  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return null;
  const {
    lead,
    failures,
    failureCount,
    digest,
    redRunsSinceComment,
    commentedAt,
  } = parsed;
  if (typeof lead !== 'string' || lead.length === 0) return null;
  if (!Array.isArray(failures)) return null;
  if (!failures.every((failure) => typeof failure === 'string')) return null;
  if (typeof digest !== 'string' || digest.length === 0) return null;
  if (!Number.isInteger(failureCount) || failureCount < failures.length)
    return null;
  if (!Number.isInteger(redRunsSinceComment) || redRunsSinceComment < 0)
    return null;
  if (
    typeof commentedAt !== 'string' ||
    !Number.isFinite(Date.parse(commentedAt))
  )
    return null;
  return {
    lead: normalizeFailureLabel(lead),
    // Re-bounded on the way out: the display list is regenerated into a
    // comment body, and this is the bot's own comment but not beyond editing.
    failures: failures
      .map(normalizeFailureLabel)
      .slice(0, MAX_TRACKED_FAILURES),
    failureCount,
    digest,
    redRunsSinceComment,
    commentedAt,
  };
}

/**
 * The most recent BOT comment carrying a valid marker. Comments arrive oldest
 * first, matching `listComments`' default order.
 *
 * A human comment is never state, however exactly it reproduces the marker —
 * quote-reply copies it verbatim, and the caller edits whatever this returns.
 *
 * The check is `user.type`, not a login: the workflow's identity can
 * legitimately change (a GitHub App or PAT instead of the default token), and
 * a login pin that goes stale would make the tracker forget its state and
 * comment on every run — noisy rather than harmful, but avoidable. `type`
 * separates bots from people, which is the property that matters here.
 *
 * @param {{id?: unknown, body?: unknown, user?: {type?: unknown}}[]} comments
 * @returns {{commentId: number, state: MainHealthState} | null}
 */
export function findLastRecordedState(comments = []) {
  let found = null;
  for (const comment of comments ?? []) {
    if (comment?.user?.type !== 'Bot') continue;
    const state = parseMainHealthState(comment?.body);
    if (!state) continue;
    found = { commentId: Number(comment?.id), state };
  }
  return found;
}

/**
 * The comment body is a pure function of the run being reported and the state
 * it carries, so a silent run can regenerate it in place: same comment, no
 * notification, but the newest run link and an honest count.
 *
 * @param {{workflowName: string, runUrl: string, headSha: string}} run
 * @param {MainHealthState} state
 * @returns {string}
 */
export function renderMainHealthComment(run, state) {
  const sections = [
    state.lead,
    '',
    `Workflow: ${run.workflowName}`,
    `Run: ${run.runUrl}`,
    `Head SHA: ${run.headSha}`,
  ];
  if (state.failures.length > 0) {
    sections.push('', 'Failing:');
    for (const failure of state.failures) sections.push(`- ${failure}`);
    const hidden = state.failureCount - state.failures.length;
    if (hidden > 0) sections.push(`- …and ${hidden} more`);
  }
  if (state.redRunsSinceComment > 0) {
    const runs =
      state.redRunsSinceComment === 1
        ? '1 further red run'
        : `${state.redRunsSinceComment} further red runs`;
    sections.push(
      '',
      `${runs} since this comment, all failing at the same point. The run above is the most recent.`,
    );
  }
  sections.push('', renderMainHealthState(state));
  return sections.join('\n');
}

/**
 * Decide what — if anything — main-health should say about this red run.
 *
 * Pure: it performs no API call and reads no clock of its own, so all four
 * speaking transitions and the silent one are unit-testable without a
 * `workflow_run` event.
 *
 * @param {{
 *   workflowName: string,
 *   runUrl: string,
 *   headSha: string,
 *   failures?: string[],
 *   reopened?: boolean,
 *   comments?: {id?: unknown, body?: unknown, user?: {type?: unknown}}[],
 *   now?: number,
 *   heartbeatIntervalMs?: number,
 * }} input
 * @returns {MainHealthDecision}
 */
export function decideMainHealthComment({
  workflowName,
  runUrl,
  headSha,
  failures = [],
  reopened = false,
  comments = [],
  now = Date.now(),
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
}) {
  const run = { workflowName, runUrl, headSha };
  const current = normalizeFailures(failures);
  const digest = failureDigest(current);
  const recorded = findLastRecordedState(comments);
  const previous = recorded?.state ?? null;
  const commentedAt = new Date(now).toISOString();

  /**
   * @param {string} reason
   * @param {string} lead
   * @returns {MainHealthDecision}
   */
  const comment = (reason, lead) => {
    const state = {
      lead,
      failures: current.slice(0, MAX_TRACKED_FAILURES),
      failureCount: current.length,
      digest,
      redRunsSinceComment: 0,
      commentedAt,
    };
    return {
      action: 'create-comment',
      reason,
      body: renderMainHealthComment(run, state),
      state,
      commentId: undefined,
    };
  };

  if (reopened)
    return comment(
      'reopened-after-green',
      'The workflow failed again on main.',
    );
  if (!previous)
    return comment('no-recorded-state', 'The workflow failed again on main.');
  if (previous.digest !== digest)
    return comment(
      'failure-changed',
      'The workflow failed again on main, at a different point than the last comment recorded.',
    );

  // A red run that posts nothing is still recorded, so the next heartbeat can
  // report the size of the silence rather than only its duration.
  const redRunsSinceComment = previous.redRunsSinceComment + 1;
  const elapsedMs = now - Date.parse(previous.commentedAt);
  const heartbeatDue =
    !Number.isFinite(elapsedMs) ||
    elapsedMs < 0 ||
    elapsedMs >= heartbeatIntervalMs;
  if (heartbeatDue) {
    const runs =
      redRunsSinceComment === 1
        ? '1 red run'
        : `${redRunsSinceComment} red runs`;
    return comment(
      'heartbeat',
      `Still red on main: ${runs} since the last comment, all failing at the same point.`,
    );
  }

  const state = { ...previous, redRunsSinceComment };
  return {
    action: 'update-marker',
    reason: 'unchanged',
    commentId: recorded?.commentId,
    // Regenerated against THIS run, so the visible link and SHA are current.
    body: renderMainHealthComment(run, state),
    state,
  };
}
