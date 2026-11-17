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
 *    different conclusion, than the last comment recorded, and the last
 *    comment is at least a day old. A change sooner than that rewrites the
 *    existing comment and its marker instead: a flaky secondary job flipping
 *    the failure set would otherwise comment on every run.
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
 * Remote text (job and step names, annotation lines) as a literal block: a
 * fenced block renders no headings, links, mentions or emphasis, and a run of
 * three or more backticks inside it is rewritten so it cannot close the
 * fence early.
 *
 * @param {string[]} lines
 * @returns {string[]}
 */
function fenced(lines) {
  return [
    '```text',
    ...lines.map((line) => String(line).replace(/`{3,}/g, "'''")),
    '```',
  ];
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
  // Job and step names are remote text inside an HTML comment. Escaping
  // every <, > and - as a JSON unicode escape means no stored string can
  // spell -->, --!> or any other comment terminator; JSON.parse restores it.
  const payload = JSON.stringify(state).replace(
    /[<>-]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return `<!-- ${MAIN_HEALTH_STATE_MARKER}: ${payload} -->`;
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
 * The check is `user.type`, not a login, so swapping the default token for a
 * GitHub App does not strand the state: an installation token's comments are
 * still `type: "Bot"`, where a login pin would go stale and make the tracker
 * forget its state and comment on every run. That is only true for tokens
 * GitHub attributes to a bot. A PAT is attributed to the human account that
 * issued it, `type: "User"`, so running this workflow under a PAT would put
 * the tracker's own comments outside the trust boundary and it would comment
 * on every red run — noisy, never silent, but worth knowing before changing
 * the token.
 *
 * `type === 'Bot'` also trusts EVERY bot, not just this workflow's own: any
 * installed App whose comment reproduced the marker unquoted could become the
 * anchor. The residual is small rather than closed — quote stripping removes
 * the copy-by-quote path, and this is the only workflow in the repository that
 * comments on issues at all — so it takes a third-party App echoing issue text
 * verbatim. Naming the boundary here beats letting the next reader assume it
 * is tighter than it is.
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
 * The trade: regenerating REPLACES the whole body, so anything a human
 * appended by editing the bot's comment is discarded on the next silent run.
 * (Editing does not change `comment.user`, so the comment stays the anchor.)
 * An earlier draft patched only the marker and preserved surrounding text, at
 * the cost of leaving the visible run link up to 24h stale. Reply on the issue
 * rather than editing this comment; GitHub's edit history keeps the original
 * either way.
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
    const hidden = state.failureCount - state.failures.length;
    sections.push(
      '',
      'Failing:',
      ...fenced([
        ...state.failures.map((failure) => `- ${failure}`),
        ...(hidden > 0 ? [`- …and ${hidden} more`] : []),
      ]),
    );
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
      // Normalized on the way in as well as out (`parseMainHealthState`), so
      // the round trip is symmetric by construction and not by the leads
      // happening to be normalization-stable literals.
      lead: normalizeFailureLabel(lead),
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
  // A red run that posts nothing is still recorded, so the next heartbeat can
  // report the size of the silence rather than only its duration.
  const redRunsSinceComment = previous.redRunsSinceComment + 1;
  const elapsedMs = now - Date.parse(previous.commentedAt);
  const heartbeatDue =
    !Number.isFinite(elapsedMs) ||
    elapsedMs < 0 ||
    elapsedMs >= heartbeatIntervalMs;
  if (previous.digest !== digest) {
    // A changed failure set speaks at most once a day: a flaky secondary job
    // flipping the set (Fresh-home: 15 of 23 replayed comments) is still
    // recorded at once, in the issue body and in this comment's marker.
    if (heartbeatDue)
      return comment(
        'failure-changed',
        'The workflow failed again on main, at a different point than the last comment recorded.',
      );
    const state = {
      ...previous,
      failures: current.slice(0, MAX_TRACKED_FAILURES),
      failureCount: current.length,
      digest,
      redRunsSinceComment,
    };
    return {
      action: 'update-marker',
      reason: 'failure-changed-within-a-day',
      commentId: recorded?.commentId,
      body: renderMainHealthComment(run, state),
      state,
    };
  }
  if (heartbeatDue) {
    const runs =
      redRunsSinceComment === 1
        ? '1 red run'
        : `${redRunsSinceComment} red runs`;
    return comment(
      'heartbeat',
      `Still red on main: ${runs} since the last comment; the newest failing set is below.`,
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

/**
 * Damping, chosen by replaying 2026-10-17..11-16 for every watched scheduled
 * workflow: a tracker closes only on a green with no red run of the same
 * workflow on main in the preceding day, and a red within a day of a close
 * reopens it without an announcement. Opening is never damped. Against
 * closing on any green this cut replayed comments from 199 to 129; Main:
 * Qualification health went from 34 opens and 66 comments to 8 and 20.
 */
export const CLOSE_HOLD_MS = 24 * 60 * 60 * 1000;

/** Run conclusions that count as a red for the hold. */
const RED_RUN_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'startup_failure',
]);

/**
 * @param {{id: number, updated_at?: string, created_at: string}} run the green being considered
 * @param {{id: number, conclusion?: string | null, updated_at?: string, created_at: string}[]} runs recent completed runs of the workflow on main
 * @param {number} [holdMs]
 */
export function greenHasHeld(run, runs = [], holdMs = CLOSE_HOLD_MS) {
  // The event payload carries the run's times; a payload without them is
  // judged at the moment of the check.
  const stamped = Date.parse(run?.updated_at ?? run?.created_at);
  const at = Number.isFinite(stamped) ? stamped : Date.now();
  return !(runs ?? []).some((other) => {
    if (
      other?.id === run.id ||
      !RED_RUN_CONCLUSIONS.has(String(other?.conclusion))
    )
      return false;
    const redAt = Date.parse(other.updated_at ?? other.created_at);
    return Number.isFinite(redAt) && redAt <= at && at - redAt < holdMs;
  });
}

/**
 * Whether a closed tracker was closed within the damping window, so a red
 * now continues the same episode.
 *
 * @param {{state?: string, closed_at?: string | null}} issue
 * @param {number} now
 */
export function closedRecently(issue, now, holdMs = CLOSE_HOLD_MS) {
  const closedAt = Date.parse(issue?.closed_at ?? '');
  return (
    issue?.state === 'closed' &&
    Number.isFinite(closedAt) &&
    now - closedAt < holdMs
  );
}

/** Every tracker's title: the dedupe key, one issue per watched workflow. */
export function trackerTitle(workflowName) {
  return `Main pipeline red: ${workflowName}`;
}

/** Labels every tracker carries, whether or not `ci:red` exists yet. */
export const MAIN_HEALTH_BASE_LABELS = Object.freeze(['bug', 'P1']);

/**
 * The filter the owner and, later, agent intake read: every issue it marks is
 * one watched workflow that is red on main, opened and closed by
 * `main-health.yml` alone. The owner creates it; until then trackers are
 * opened unlabelled rather than not at all.
 */
export const MAIN_HEALTH_LABEL = 'ci:red';

/**
 * The labels a tracker can carry right now. `ci:red` only once it exists:
 * adding a missing label would create it with an arbitrary colour, which the
 * label-manifest check then reports as drift. A label API failure never
 * stops a tracker: it is opened with the base labels and `note` says why,
 * for the tracker body.
 *
 * @param {any} github Octokit
 * @param {{owner: string, repo: string}} repo
 * @param {{info: (line: string) => void, warning?: (line: string) => void}} core
 * @returns {Promise<{labels: string[], note: string | null}>}
 */
export async function trackerLabels(github, repo, core) {
  try {
    await github.rest.issues.getLabel({ ...repo, name: MAIN_HEALTH_LABEL });
    return {
      labels: [...MAIN_HEALTH_BASE_LABELS, MAIN_HEALTH_LABEL],
      note: null,
    };
  } catch (error) {
    if (error?.status === 404) {
      core.info(
        `main-health: label ${MAIN_HEALTH_LABEL} does not exist yet; trackers stay unlabelled with it until the owner creates it.`,
      );
      return { labels: [...MAIN_HEALTH_BASE_LABELS], note: null };
    }
    const message = error instanceof Error ? error.message : String(error);
    core.warning?.(
      `main-health: could not read label ${MAIN_HEALTH_LABEL}: ${message}`,
    );
    return {
      labels: [...MAIN_HEALTH_BASE_LABELS],
      note: `Label ${MAIN_HEALTH_LABEL} could not be checked, so this tracker may be missing it; the Main: Health run log has the error.`,
    };
  }
}

/** The account `GITHUB_TOKEN` writes as: every tracker is opened by it. */
export const TRACKER_CREATOR = 'github-actions[bot]';

/**
 * Every existing tracker, from one consistent listing of the issues the
 * workflow bot opened (22 in this repository on 2026-11-16, all states),
 * rather than a scan of every issue (~50 pages) or a search, which is
 * eventually consistent and can miss a tracker created seconds earlier.
 * Creation is serialised per workflow by the reporter's concurrency group,
 * so a second red run reads the first run's tracker here.
 *
 * Only exact titles match: a tracker a person renamed, or one whose workflow
 * was renamed, is no longer found; the next red opens a fresh tracker and the
 * old one stays as it is.
 *
 * @param {any} github Octokit
 * @param {{owner: string, repo: string}} repo
 * @returns {Promise<{number: number, title: string, state: string, body?: string | null}[]>}
 */
export async function listTrackers(github, repo) {
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    ...repo,
    creator: TRACKER_CREATOR,
    state: 'all',
    per_page: 100,
  });
  return issues.filter(
    (issue) =>
      !issue?.pull_request &&
      String(issue?.title ?? '').startsWith(trackerTitle('')),
  );
}

/** Marks a tracker body written by Main: Health. */
export const TRACKER_MARKER = '<!-- main-health-tracker -->';

/**
 * Whether an issue body is one Main: Health wrote for this workflow: the
 * tracker marker, the overdue marker, or the line every tracker body has
 * carried since before the markers (`Workflow: <name>`). Creator and title
 * alone are not enough: a person can rename any bot-opened issue.
 *
 * @param {unknown} body
 * @param {string} workflowName
 */
export function isTrackerBody(body, workflowName) {
  const text = String(body ?? '');
  return (
    text.includes(TRACKER_MARKER) ||
    text.startsWith('<!-- main-health-overdue -->') ||
    text.split(/\r?\n/).includes(`Workflow: ${workflowName}`)
  );
}

/**
 * The trackers one title may reuse: Main: Health's own, never one closed as
 * a duplicate. One closed as "not planned" is reused: closing a tracker does
 * not stop a workflow being watched (remove it from the watch list for that),
 * so its next red reopens it.
 *
 * @param {{number: number, title: string, state: string, state_reason?: string | null, body?: string | null}[]} trackers
 * @param {string} title
 */
function candidates(trackers, title) {
  const workflowName = title.slice(trackerTitle('').length);
  return trackers.filter(
    (issue) =>
      issue.title === title &&
      issue.state_reason !== 'duplicate' &&
      isTrackerBody(issue.body, workflowName),
  );
}

/**
 * The tracker for one title: the oldest open one, otherwise the newest
 * closed one.
 *
 * @param {{number: number, title: string, state: string, state_reason?: string | null, body?: string | null}[]} trackers
 * @param {string} title
 */
export function pickTracker(trackers, title) {
  const matches = candidates(trackers, title);
  const open = matches
    .filter((issue) => issue.state === 'open')
    .sort((a, b) => a.number - b.number);
  if (open.length) return open[0];
  return [...matches].sort((a, b) => b.number - a.number)[0] ?? null;
}

/**
 * Converge on one tracker per title: when several are open (#3403 and #4037
 * both track Main: Container smoke), keep the oldest and close each other
 * with a comment pointing to it. A closed duplicate is never picked again,
 * so this speaks once per duplicate.
 *
 * @param {any} github Octokit
 * @param {{owner: string, repo: string}} repo
 * @param {{number: number, title: string, state: string}[]} trackers
 * @param {string} title
 */
export async function consolidateTracker(github, repo, trackers, title) {
  const kept = pickTracker(trackers, title);
  if (!kept || kept.state !== 'open') return kept;
  for (const duplicate of candidates(trackers, title)) {
    if (duplicate.state !== 'open' || duplicate.number === kept.number)
      continue;
    await github.rest.issues.createComment({
      ...repo,
      issue_number: duplicate.number,
      body: `Duplicate of #${kept.number}: Main: Health keeps one tracker per workflow and reports there.`,
    });
    await github.rest.issues.update({
      ...repo,
      issue_number: duplicate.number,
      state: 'closed',
      state_reason: 'duplicate',
    });
    duplicate.state = 'closed';
    duplicate.state_reason = 'duplicate';
  }
  return kept;
}

/** Unsuccessful jobs whose annotations are read, so one red run costs a bounded number of calls. */
export const MAX_ANNOTATED_JOBS = 5;

/** Bounds on the failing lines quoted into a tracker body. */
export const MAX_FAILING_LINES = 15;
export const MAX_FAILING_LINE_LENGTH = 300;

/**
 * The jobs whose annotations are worth reading: anything that did not pass,
 * in the order GitHub listed them, bounded.
 *
 * @param {{id?: unknown, conclusion?: unknown}[]} jobs
 */
export function unsuccessfulJobs(jobs = []) {
  return (jobs ?? [])
    .filter(
      (job) =>
        UNSUCCESSFUL_CONCLUSIONS.has(String(job?.conclusion)) &&
        Number.isSafeInteger(job?.id),
    )
    .slice(0, MAX_ANNOTATED_JOBS);
}

/**
 * Who cancelled a run, from its jobs' check-run annotations. GitHub records
 * the cause only there; the run and job objects say `cancelled` either way.
 * Every pattern below is a verbatim annotation from a real run (fixtures in
 * scheduled-failure-reporting.test.ts carry the run ids).
 *
 * - `person`: "The run was canceled by @login." Writes nothing: someone chose it.
 * - `superseded`: "Canceling since a higher priority waiting request for
 *   <group> exists". Writes nothing: the newer run carries the verdict.
 * - `infrastructure`: GitHub gave up on the job ("not acquired by Runner",
 *   "lost communication with the server"). Reported.
 * - `unknown`: anything else, including a cancel with no annotation at all
 *   (an API cancel by automation leaves none). Reported too, saying the cause
 *   was not recognised: a failure must do something, and only a positively
 *   identified choice by a person or a newer run is allowed to stay silent.
 *
 * A person's cancel wins over everything else in the same run: cancelling a
 * run that was stuck waiting for a runner is still a person's decision.
 *
 * @param {{message?: unknown}[]} annotations
 * @returns {'person' | 'superseded' | 'infrastructure' | 'unknown'}
 */
export function classifyCancellation(annotations = []) {
  const messages = (annotations ?? []).map((annotation) =>
    String(annotation?.message ?? ''),
  );
  if (messages.some((message) => /^The run was canceled by @/.test(message)))
    return 'person';
  if (
    messages.some((message) =>
      /^Canceling since a higher priority waiting request for .+ exists/.test(
        message,
      ),
    )
  )
    return 'superseded';
  if (
    messages.some((message) =>
      /not acquired by Runner of type|lost communication with the server/.test(
        message,
      ),
    )
  )
    return 'infrastructure';
  return 'unknown';
}

/**
 * A cancelled run with no jobs was replaced while still pending: a newer run
 * of the same workflow on the same ref took its place in a workflow-level
 * concurrency group, which records no annotation (Main: Qualification health
 * run 43099494704, replaced 7 s later by 43099513706). Without a newer run
 * the cancel stays unrecognised and is reported.
 *
 * @param {{id: number, head_branch?: string, created_at: string}} run
 * @param {{id: number, head_branch?: string, created_at: string}[]} runs the workflow's runs on that branch
 */
export function supersededByNewerRun(run, runs = []) {
  const created = Date.parse(run?.created_at);
  if (!Number.isFinite(created)) return false;
  return (runs ?? []).some(
    (other) =>
      other?.id !== run.id &&
      other?.head_branch === run.head_branch &&
      Date.parse(other?.created_at) > created,
  );
}

/** Cancel causes that write nothing. */
export const SILENT_CANCEL_CAUSES = Object.freeze(['person', 'superseded']);

/**
 * Normalize one annotation line for a fenced block: no control characters,
 * bounded length. `fenced` rewrites backtick runs for every fenced line.
 *
 * @param {unknown} value
 */
function quotedLine(value) {
  return (
    String(value ?? '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: annotation text is remote data.
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ')
      .trimEnd()
      .slice(0, MAX_FAILING_LINE_LENGTH)
  );
}

/**
 * The first failing lines of a run: its failure-level annotations (the
 * `##[error]` lines a reader sees in the log), prefixed with their job.
 *
 * @param {{message?: unknown, annotation_level?: unknown, job?: unknown}[]} annotations
 * @returns {string[]}
 */
export function failingLines(annotations = []) {
  const lines = [];
  for (const annotation of annotations ?? []) {
    if (annotation?.annotation_level !== 'failure') continue;
    for (const line of String(annotation?.message ?? '').split(/\r?\n/)) {
      if (!line.trim()) continue;
      lines.push(quotedLine(`${annotation?.job ?? 'job'}: ${line}`));
      if (lines.length >= MAX_FAILING_LINES) return lines;
    }
  }
  return lines;
}

/**
 * The tracker body: everything a person or an agent needs to start on the
 * red without opening the Actions tab. Rewritten for every reported run, so it
 * always describes the newest one.
 *
 * @param {{
 *   workflowName: string,
 *   runUrl: string,
 *   headSha: string,
 *   event?: string,
 *   conclusion?: string,
 *   failures?: string[],
 *   lines?: string[],
 *   detailsError?: string | null,
 *   notes?: string[],
 *   cancelCause?: string | null,
 * }} input
 */
export function renderTrackerBody({
  workflowName,
  runUrl,
  headSha,
  event,
  conclusion,
  failures = [],
  lines = [],
  detailsError = null,
  notes = [],
  cancelCause = null,
}) {
  const lead =
    conclusion !== 'cancelled'
      ? 'A watched workflow failed on main.'
      : cancelCause === 'infrastructure'
        ? 'A watched workflow never completed on main: GitHub cancelled it (no runner took the job, or the runner was lost).'
        : 'A watched workflow was cancelled on main and the cause was not recognised: not a person, not a newer run in its concurrency group, not a lost runner. Check who or what cancelled it.';
  const shown = normalizeFailures(failures);
  const sections = [
    TRACKER_MARKER,
    lead,
    '',
    `Workflow: ${workflowName}`,
    `Run: ${runUrl}`,
    `Head SHA: ${headSha}`,
    `Trigger: ${event || 'unknown'}`,
    `Conclusion: ${conclusion || 'unknown'}`,
  ];
  if (shown.length > 0) {
    sections.push(
      '',
      'Failing:',
      ...fenced([
        ...shown
          .slice(0, MAX_TRACKED_FAILURES)
          .map((failure) => `- ${failure}`),
        ...(shown.length > MAX_TRACKED_FAILURES
          ? [`- …and ${shown.length - MAX_TRACKED_FAILURES} more`]
          : []),
      ]),
    );
  }
  if (lines.length > 0) {
    sections.push('', 'First failing lines:', ...fenced(lines));
  }
  if (detailsError) {
    sections.push(
      '',
      'Run details unavailable (open the run above):',
      ...fenced([quotedLine(detailsError)]),
    );
  }
  if (notes.length > 0) sections.push('', ...notes);
  sections.push(
    '',
    'This issue is updated in place while the workflow stays red and closed by the next fully green run.',
  );
  return sections.join('\n');
}
