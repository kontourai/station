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
 * 5. Otherwise **silent**: no comment. The run is still counted, by rewriting
 *    the marker inside the comment that already exists.
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
 * Every parse failure here resolves toward COMMENTING, never toward silence:
 * a missing, malformed, or truncated marker yields `null`, which is case 2. A
 * bug in this file can make the tracker noisy again — the behaviour it
 * replaced — but cannot make a red main silent.
 */

/** Marker name; also the grep handle for a human reading raw comment source. */
export const MAIN_HEALTH_STATE_MARKER = 'main-health-state';

/** Longest silence before a heartbeat comment restates that main is still red. */
export const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Bounds on what a run's failure summary may carry into an issue comment. */
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
 * @property {string[]} failures Sorted job/step labels that failed.
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
 * @param {Iterable<unknown> | undefined} failures
 * @returns {string[]} sorted, deduped, bounded labels
 */
function normalizeFailures(failures) {
  const labels = new Set();
  for (const failure of failures ?? []) {
    const label = normalizeFailureLabel(failure);
    if (label) labels.add(label);
  }
  return [...labels].sort().slice(0, MAX_TRACKED_FAILURES);
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
 * @returns {string[]}
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
 * Read a marker back. Returns `null` — "no state recorded", which comments —
 * for anything it cannot fully validate.
 *
 * @param {unknown} body
 * @returns {MainHealthState | null}
 */
export function parseMainHealthState(body) {
  const match = MARKER_PATTERN.exec(String(body ?? ''));
  if (!match) return null;
  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return null;
  const { failures, redRunsSinceComment, commentedAt } = parsed;
  if (!Array.isArray(failures)) return null;
  if (!failures.every((failure) => typeof failure === 'string')) return null;
  if (
    typeof redRunsSinceComment !== 'number' ||
    !Number.isInteger(redRunsSinceComment) ||
    redRunsSinceComment < 0
  )
    return null;
  if (
    typeof commentedAt !== 'string' ||
    !Number.isFinite(Date.parse(commentedAt))
  )
    return null;
  return {
    failures: normalizeFailures(failures),
    redRunsSinceComment,
    commentedAt,
  };
}

/**
 * The most recent comment carrying a valid marker. Comments arrive oldest
 * first, matching `listComments`' default order.
 *
 * @param {{id?: unknown, body?: unknown}[]} comments
 * @returns {{commentId: number, body: string, state: MainHealthState} | null}
 */
export function findLastRecordedState(comments = []) {
  let found = null;
  for (const comment of comments ?? []) {
    const state = parseMainHealthState(comment?.body);
    if (!state) continue;
    found = {
      commentId: Number(comment?.id),
      body: String(comment?.body ?? ''),
      state,
    };
  }
  return found;
}

/**
 * Replace the marker in `body`, or append one when the body carries none.
 *
 * @param {string} body
 * @param {MainHealthState} state
 * @returns {string}
 */
export function applyMainHealthState(body, state) {
  const marker = renderMainHealthState(state);
  const source = String(body ?? '');
  if (MARKER_PATTERN.test(source))
    return source.replace(MARKER_PATTERN, marker);
  return `${source.replace(/\s+$/, '')}\n\n${marker}`;
}

/**
 * @param {{workflowName: string, runUrl: string, headSha: string}} run
 * @returns {string}
 */
function renderRunDetails({ workflowName, runUrl, headSha }) {
  return [
    `Workflow: ${workflowName}`,
    `Run: ${runUrl}`,
    `Head SHA: ${headSha}`,
  ].join('\n');
}

/**
 * @param {{lead: string, run: {workflowName: string, runUrl: string, headSha: string}, failures: string[], state: MainHealthState}} input
 * @returns {string}
 */
function renderComment({ lead, run, failures, state }) {
  const sections = [lead, '', renderRunDetails(run)];
  if (failures.length > 0) {
    sections.push('', 'Failing:', ...failures.map((failure) => `- ${failure}`));
  }
  sections.push('', renderMainHealthState(state));
  return sections.join('\n');
}

/**
 * @param {string[]} left
 * @param {string[]} right
 * @returns {boolean}
 */
function sameFailures(left, right) {
  return (
    left.length === right.length && left.every((item, i) => item === right[i])
  );
}

/**
 * Decide what — if anything — main-health should say about this red run.
 *
 * Pure: it performs no API call and reads no clock of its own, so all four
 * transitions are unit-testable without a `workflow_run` event.
 *
 * @param {{
 *   workflowName: string,
 *   runUrl: string,
 *   headSha: string,
 *   failures?: string[],
 *   reopened?: boolean,
 *   comments?: {id?: unknown, body?: unknown}[],
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
  const recorded = findLastRecordedState(comments);
  const previous = recorded?.state ?? null;
  const commentedAt = new Date(now).toISOString();

  /**
   * @param {string} reason
   * @param {string} lead
   * @returns {MainHealthDecision}
   */
  const comment = (reason, lead) => {
    const state = { failures: current, redRunsSinceComment: 0, commentedAt };
    return {
      action: 'create-comment',
      reason,
      body: renderComment({ lead, run, failures: current, state }),
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
  if (!sameFailures(previous.failures, current))
    return comment(
      'failure-changed',
      'The workflow failed again on main, at a different point than the last comment recorded.',
    );

  // A red run that says nothing is still counted, so the next heartbeat can
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

  const state = {
    failures: previous.failures,
    redRunsSinceComment,
    commentedAt: previous.commentedAt,
  };
  return {
    action: 'update-marker',
    reason: 'unchanged',
    commentId: recorded?.commentId,
    body: applyMainHealthState(recorded?.body ?? '', state),
    state,
  };
}
