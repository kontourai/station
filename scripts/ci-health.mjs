#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { invokedDirectly } from './lib/module-entry.mjs';
import {
  captureOwnedProcessOutput,
  executeOwnedCommand,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from './lib/owned-process.mjs';
import {
  isNoteArchiveFile,
  REVIEW_LEDGER_DIR,
  REVIEW_NOTES_DIR,
} from './lib/review-ledger-paths.mjs';

const minute = 60_000;
const time = (value) => Date.parse(value);
const ratio = (n, d) => (d ? n / d : null);
const assignedRunner = (job) =>
  Number.isSafeInteger(job.runner_id) && job.runner_id > 0;
const startedOnRunner = (job) =>
  job.status !== 'queued' && assignedRunner(job) && job.started_at;
const executed = (job) =>
  startedOnRunner(job) &&
  job.conclusion != null &&
  job.conclusion !== 'skipped' &&
  job.completed_at;
const duration = (job) =>
  Math.max(0, time(job.completed_at) - time(job.started_at)) / minute;
const failed = (run) => run.conclusion === 'failure';

// Upper-rank quantiles match the capacity baseline, including even-sized medians.
export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
    : null;
}
export function distribution(values) {
  return {
    count: values.length,
    median: percentile(values, 0.5),
    p90: percentile(values, 0.9),
  };
}
function intervalMinutes(start, end, since, until) {
  return (
    Math.max(
      0,
      Math.min(time(end), until ? time(until) : Infinity) -
        Math.max(time(start), since ? time(since) : -Infinity),
    ) / minute
  );
}

export function concurrencyTimeline(jobs, until, since) {
  const events = jobs
    .flatMap((job) => {
      if (job.conclusion === 'skipped') return [];
      const end = job.completed_at ?? until;
      if (!end) return [];
      const start = Math.max(
        time(startedOnRunner(job) ? job.started_at : job.created_at),
        since ? time(since) : -Infinity,
      );
      const stop = Math.min(time(end), until ? time(until) : Infinity);
      if (!Number.isFinite(start) || !Number.isFinite(stop) || stop <= start)
        return [];
      // Queued API records can have placeholder started_at timestamps.
      // Only assigned runners establish execution, never the timestamp alone.
      const occupied = startedOnRunner(job) ? 1 : 0;
      return [
        [start, occupied],
        [stop, -occupied],
      ];
    })
    .concat(
      since && until
        ? [
            [time(since), 0],
            [time(until), 0],
          ]
        : [],
    )
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const histogram = {};
  let current = 0;
  let previous = events[0]?.[0];
  for (const [at, delta] of events) {
    if (at > previous)
      histogram[current] = (histogram[current] ?? 0) + (at - previous) / minute;
    current += delta;
    previous = at;
  }
  const total = Object.values(histogram).reduce((a, b) => a + b, 0);
  return {
    histogramMinutes: histogram,
    shareAtLeast18: ratio(
      Object.entries(histogram)
        .filter(([n]) => Number(n) >= 18)
        .reduce((sum, [, mins]) => sum + mins, 0),
      total,
    ),
  };
}
export function groupRuns(runs, kind) {
  const groups = new Map();
  for (const run of runs) {
    let keys = [];
    if (kind === 'merge_group' && run.event === kind) keys = [run.head_branch];
    if (
      kind === 'push' &&
      ['pull_request', 'pull_request_target'].includes(run.event)
    ) {
      keys = run.pull_requests.map(
        (pr) => `${pr.number}:${run.created_at.slice(0, 15)}`,
      );
    }
    for (const key of keys) groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  return [...groups.values()];
}
export function summarizeGroups(groups, jobs) {
  const samples = groups
    .map((runs) => {
      const ids = new Set(runs.map((r) => `${r.id}:${r.run_attempt ?? 1}`));
      const groupJobs = jobs.filter((j) => ids.has(j.health_run_key));
      if (
        runs.some((r) => r.conclusion == null) ||
        groupJobs.some((j) => j.conclusion == null)
      )
        return null;
      const selected = jobs.filter(
        (j) => ids.has(j.health_run_key) && executed(j),
      );
      if (selected.length < 5) return null;
      return {
        jobs: selected.length,
        runnerMinutes: selected.reduce((sum, j) => sum + duration(j), 0),
        wallMinutes:
          (Math.max(...selected.map((j) => time(j.completed_at))) -
            Math.min(...selected.map((j) => time(j.created_at)))) /
          minute,
      };
    })
    .filter(Boolean);
  return {
    executedJobs: distribution(samples.map((s) => s.jobs)),
    runnerMinutes: distribution(samples.map((s) => s.runnerMinutes)),
    wallMinutes: distribution(samples.map((s) => s.wallMinutes)),
  };
}
const eventTime = (e) =>
  time(e.created_at ?? e.committer?.date ?? e.author?.date);
export function classifyReentry(timeline, removal) {
  if (
    timeline.some(
      (e) =>
        e.event === 'merged' &&
        Math.abs(eventTime(e) - eventTime(removal)) <= minute,
    )
  )
    return 'merge';
  const after = timeline
    .filter((e) => eventTime(e) >= eventTime(removal))
    .sort((a, b) => eventTime(a) - eventTime(b));
  const nextEntry = after.find(
    (e) =>
      e.event === 'added_to_merge_queue' && eventTime(e) > eventTime(removal),
  );
  const merge = after.find((e) => e.event === 'merged');
  // GitHub emits a queue removal on successful merge, too.
  if (merge && nextEntry && eventTime(merge) <= eventTime(nextEntry))
    return 'merge';
  if (!nextEntry) return 'pending';
  const changed = after.some(
    (e) =>
      ['committed', 'head_ref_force_pushed'].includes(e.event) &&
      eventTime(e) > eventTime(removal) &&
      eventTime(e) <= eventTime(nextEntry),
  );
  if (changed) return 'neededNewCommits';
  const nextRemoval = after.find(
    (e) =>
      e.event === 'removed_from_merge_queue' &&
      eventTime(e) > eventTime(nextEntry),
  );
  if (
    merge &&
    (!nextRemoval || eventTime(merge) <= eventTime(nextRemoval) + minute)
  )
    return 'passedUnchanged';
  return 'unresolvedUnchanged';
}
export function mergeMetrics(runs, jobs, timelines, since, until) {
  const groups = groupRuns(runs, 'merge_group');
  const failures = groups.filter((group) => group.some(failed));
  const prs = new Set(
    failures.flatMap((group) =>
      group.flatMap((r) => r.pull_requests.map((p) => p.number)),
    ),
  );
  const reentries = {
    neededNewCommits: 0,
    passedUnchanged: 0,
    pending: 0,
    unresolvedUnchanged: 0,
  };
  let botRemovals = 0;
  for (const pr of prs) {
    const timeline = timelines[pr] ?? [];
    for (const event of timeline) {
      if (
        event.event !== 'removed_from_merge_queue' ||
        event.actor?.login !== 'github-merge-queue[bot]' ||
        eventTime(event) < time(since) ||
        eventTime(event) >= time(until)
      )
        continue;
      const classification = classifyReentry(
        timeline.filter((e) => eventTime(e) < time(until)),
        event,
      );
      if (classification === 'merge') continue;
      botRemovals++;
      reentries[classification]++;
    }
  }
  const candidateKey = (run) => `${run.head_branch}:${run.head_sha}`;
  const isCiWorkflow = (run) =>
    run.path === '.github/workflows/ci.yml' ||
    (run.path == null && run.name === 'PR: CI');
  const ownsIntegration = (run) =>
    isCiWorkflow(run) &&
    jobs.some(
      (job) =>
        job.name === 'Merge-queue regression' &&
        job.health_run_key === `${run.id}:${run.run_attempt ?? 1}`,
    );
  // PR: CI predates integration ownership; the attempt-bound aggregate job
  // distinguishes it. Select before filtering cancelled/unfinished evidence.
  const currentOwners = new Set(
    runs
      .filter((r) => r.event === 'merge_group' && ownsIntegration(r))
      .map(candidateKey),
  );
  const regression = runs.filter(
    (r) =>
      r.event === 'merge_group' &&
      (isCiWorkflow(r) ||
        [
          'Merge-queue regression',
          'Merge integration',
          'PR: Merge integration',
        ].includes(r.name)) &&
      (isCiWorkflow(r)
        ? ownsIntegration(r)
        : !currentOwners.has(candidateKey(r))) &&
      r.conclusion != null &&
      r.conclusion !== 'cancelled' &&
      r.run_started_at &&
      r.updated_at,
  );
  return {
    groupsBuilt: groups.length,
    groupsFailed: failures.length,
    groupsCancelled: groups.filter((g) =>
      g.some((r) => r.conclusion === 'cancelled'),
    ).length,
    groupsTimedOut: groups.filter((g) =>
      g.some((r) => r.conclusion === 'timed_out'),
    ).length,
    failureRate: ratio(failures.length, groups.length),
    regressionFailedGroups: failures.filter((g) =>
      jobs.some(
        (j) =>
          j.name === 'Merge-queue regression' &&
          failed(j) &&
          g.some((r) => j.health_run_key === `${r.id}:${r.run_attempt ?? 1}`),
      ),
    ).length,
    prsWithFailedGroup: prs.size,
    botRemovals,
    reentries,
    regressionMinutes: distribution(
      regression.map(
        (r) =>
          Math.max(0, time(r.updated_at) - time(r.run_started_at)) / minute,
      ),
    ),
  };
}
export function capacityMetrics(jobs, until, since) {
  jobs = jobs.filter(
    (job) =>
      (!until || time(job.created_at) < time(until)) &&
      (!since || !job.completed_at || time(job.completed_at) > time(since)),
  );
  const ran = jobs.filter(executed);
  const unfinished = jobs.filter((j) => j.conclusion == null);
  const unassignedCancelled = jobs.filter(
    (job) => job.conclusion === 'cancelled' && !assignedRunner(job),
  );
  const unattributed = jobs.filter(
    (job) =>
      !assignedRunner(job) &&
      job.status !== 'queued' &&
      job.conclusion !== 'skipped' &&
      job.conclusion !== 'cancelled',
  );
  const knownUnfinished = unfinished.filter(
    (job) => job.status === 'queued' || startedOnRunner(job),
  );
  const waiting = [...ran, ...knownUnfinished, ...unassignedCancelled];
  const waitEnd = (job) =>
    startedOnRunner(job) ? job.started_at : (job.completed_at ?? until);
  const waitSoFar = (job) =>
    intervalMinutes(job.created_at, waitEnd(job), undefined, until);
  const waits = waiting.map(waitSoFar);
  const platform = (j) =>
    /macos/i.test(j.labels.join(' '))
      ? 'macos'
      : /windows/i.test(j.labels.join(' '))
        ? 'windows'
        : 'linux';
  return {
    executed: ran.length,
    skipped: jobs.filter((j) => j.conclusion === 'skipped').length,
    unfinished: unfinished.length,
    unattributed: unattributed.length,
    unfinishedWaitMinutes: distribution(knownUnfinished.map(waitSoFar)),
    runnerHours:
      ran.reduce(
        (sum, j) =>
          sum + intervalMinutes(j.started_at, j.completed_at, since, until),
        0,
      ) / 60,
    waitingHours:
      waiting.reduce(
        (sum, j) =>
          sum + intervalMinutes(j.created_at, waitEnd(j), since, until),
        0,
      ) / 60,
    concurrency: concurrencyTimeline(jobs, until, since),
    hostedConcurrency: concurrencyTimeline(
      jobs.filter((j) => !j.labels.includes('self-hosted')),
      until,
      since,
    ),
    selfHostedConcurrency: concurrencyTimeline(
      jobs.filter((j) => j.labels.includes('self-hosted')),
      until,
      since,
    ),
    waitOver5Share: ratio(waits.filter((w) => w > 5).length, waiting.length),
    waitOver20Share: ratio(waits.filter((w) => w > 20).length, waiting.length),
    platformWaitMinutes: Object.fromEntries(
      ['linux', 'windows', 'macos'].map((os) => [
        os,
        distribution(waiting.filter((j) => platform(j) === os).map(waitSoFar)),
      ]),
    ),
  };
}
export function shardFamily(name) {
  return (
    name
      .match(/fast-checks shard|Ordinary corpus|Process-heavy corpus/i)?.[0]
      .toLowerCase() ?? null
  );
}
export function setupMetrics(jobs) {
  const families = new Map();
  for (const job of jobs.filter(executed)) {
    const family = shardFamily(job.name);
    if (!family || !job.steps?.length) continue;
    const steps = job.steps.filter(
      (s) => s.started_at && s.completed_at && s.conclusion !== 'skipped',
    );
    const testMinutes = steps
      .filter(
        (s) =>
          /test|corpus|regression|focused|ci:fast|shard/i.test(s.name) &&
          !/install|setup|set up|plan|resolve|prepare|download|upload/i.test(
            s.name,
          ),
      )
      .reduce((sum, s) => sum + duration(s), 0);
    const setupMinutes = Math.max(0, duration(job) - testMinutes);
    families.set(family, [
      ...(families.get(family) ?? []),
      { setupMinutes, testMinutes },
    ]);
  }
  return Object.fromEntries(
    [...families].map(([name, samples]) => {
      const setup = samples.reduce((sum, s) => sum + s.setupMinutes, 0);
      const tests = samples.reduce((sum, s) => sum + s.testMinutes, 0);
      return [
        name,
        {
          samples: samples.length,
          setupMinutes: distribution(samples.map((s) => s.setupMinutes)),
          testMinutes: distribution(samples.map((s) => s.testMinutes)),
          setupShare: ratio(setup, setup + tests),
        },
      ];
    }),
  );
}
// Shard and matrix legs differ only in counters, which become `N`:
// "X of Y" ranges ("1-2 of 8", "ordinary-1-of-8") and numbers that stand alone
// after a space, "(", "," or "/" ("shard 3", "test (1, 4)", "1/4"). A number
// joined to a word by a hyphen ("macos-14", "windows-2022", "ubuntu-22"),
// inside a token ("linux-x64", "22.04") or leading the name as a stage
// ordinal ("1 · Source gate") names a platform or step and is kept.
export function laneJobName(name) {
  return String(name ?? '')
    .replace(
      /(?<![A-Za-z0-9_.])\d+(-\d+)?([- ])of\2\d+(?![A-Za-z0-9_.])/g,
      (_, range, sep) => `N${range ? '-N' : ''}${sep}of${sep}N`,
    )
    .replace(/(?<=[\s(,/])\d+(?=$|[\s),/])/g, 'N');
}
const runKey = (run) => `${run.id}:${run.run_attempt ?? 1}`;
const workflowFile = (run) =>
  run?.path?.replace(/^\.github\/workflows\//, '').replace(/@.*$/, '') ??
  run?.name ??
  'unknown';
const pullRequestEvent = (event) =>
  ['pull_request', 'pull_request_target'].includes(event);
const jobFailed = (job) => ['failure', 'timed_out'].includes(job.conclusion);
const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
const roundDistribution = (d) => ({
  count: d.count,
  median: round2(d.median),
  p90: round2(d.p90),
});
/** Lane rows kept in a snapshot; the rest fold into one `other` row. */
export const LANE_ROW_LIMIT = 25;
export const EVENT_CLASSES = [
  'pull_request',
  'merge_group',
  'push',
  'schedule',
  'workflow_run',
  'other',
];
const eventClass = (event) =>
  pullRequestEvent(event)
    ? 'pull_request'
    : EVENT_CLASSES.includes(event)
      ? event
      : 'other';
// Same job population and clipping as capacityMetrics, so lane runner-minutes
// sum to its runner-hours.
function windowJobs(jobs, until, since) {
  return jobs.filter(
    (job) =>
      (!until || time(job.created_at) < time(until)) &&
      (!since || !job.completed_at || time(job.completed_at) > time(since)),
  );
}
export function laneMetrics(runs, jobs, until, since, limit = LANE_ROW_LIMIT) {
  const runsByKey = new Map(runs.map((run) => [runKey(run), run]));
  const lanes = new Map();
  const byEvent = Object.fromEntries(EVENT_CLASSES.map((e) => [e, 0]));
  let total = 0;
  let cancelled = 0;
  for (const job of windowJobs(jobs, until, since)) {
    const run = runsByKey.get(job.health_run_key);
    const workflow = workflowFile(run);
    const name = laneJobName(job.name);
    const event = run?.event ?? 'unknown';
    const key = JSON.stringify([workflow, name, event]);
    const lane = lanes.get(key) ?? {
      workflow,
      job: name,
      event,
      executed: 0,
      runnerMinutes: 0,
      jobMinutes: [],
      waitMinutes: [],
      failures: 0,
      cancelledRunMinutes: 0,
      unfinished: 0,
      unattributed: 0,
    };
    lanes.set(key, lane);
    // The capacity definitions of unfinished and unattributed jobs; either
    // already makes the snapshot incomplete, and the row says so.
    if (job.conclusion == null) lane.unfinished++;
    else if (
      !assignedRunner(job) &&
      job.status !== 'queued' &&
      job.conclusion !== 'skipped' &&
      job.conclusion !== 'cancelled'
    )
      lane.unattributed++;
    if (!executed(job)) continue;
    const minutes = intervalMinutes(
      job.started_at,
      job.completed_at,
      since,
      until,
    );
    lane.executed++;
    lane.runnerMinutes += minutes;
    lane.jobMinutes.push(duration(job));
    lane.waitMinutes.push(
      intervalMinutes(job.created_at, job.started_at, undefined, until),
    );
    if (jobFailed(job)) lane.failures++;
    if (run?.conclusion === 'cancelled') {
      lane.cancelledRunMinutes += minutes;
      cancelled += minutes;
    }
    byEvent[eventClass(event)] += minutes;
    total += minutes;
  }
  const rows = [...lanes.values()]
    .filter((lane) => lane.executed || lane.unfinished || lane.unattributed)
    .sort(
      (a, b) =>
        b.runnerMinutes - a.runnerMinutes ||
        a.workflow.localeCompare(b.workflow) ||
        a.job.localeCompare(b.job) ||
        a.event.localeCompare(b.event),
    );
  const shareOf = (n) =>
    total ? Math.round((n / total) * 10_000) / 10_000 : null;
  const row = (lane) => ({
    workflow: lane.workflow,
    job: lane.job,
    event: lane.event,
    executed: lane.executed,
    runnerMinutes: round2(lane.runnerMinutes),
    share: shareOf(lane.runnerMinutes),
    jobMinutes: roundDistribution(distribution(lane.jobMinutes)),
    waitMinutes: roundDistribution(distribution(lane.waitMinutes)),
    failures: lane.failures,
    cancelledRunMinutes: round2(lane.cancelledRunMinutes),
    incomplete: lane.unfinished + lane.unattributed > 0,
    unfinished: lane.unfinished,
    unattributed: lane.unattributed,
  });
  const rest = rows.slice(limit);
  const sum = (field) => rest.reduce((n, lane) => n + lane[field], 0);
  return {
    totalRunnerMinutes: round2(total),
    cancelledRunMinutes: round2(cancelled),
    cancelledRunShare: ratio(cancelled, total),
    runnerHoursByEvent: Object.fromEntries(
      EVENT_CLASSES.map((e) => [e, round2(byEvent[e] / 60)]),
    ),
    rows: rows.slice(0, limit).map(row),
    other: rest.length
      ? {
          lanes: rest.length,
          executed: sum('executed'),
          runnerMinutes: round2(sum('runnerMinutes')),
          share: shareOf(sum('runnerMinutes')),
          failures: sum('failures'),
          cancelledRunMinutes: round2(sum('cancelledRunMinutes')),
          incomplete: rest.some((l) => l.unfinished + l.unattributed > 0),
          unfinished: sum('unfinished'),
          unattributed: sum('unattributed'),
        }
      : null,
  };
}
// PR-event workflows whose triggers are not source events (`opened`,
// `synchronize`): landing automation reacts to labels and dequeues, and
// supersession to closes. Their jobs verify nothing about the head, so a
// "failure" there is not a catch. A test pins this list against the checked-in
// trigger types; the script itself runs without a YAML parser.
export const NON_VERIFYING_PR_WORKFLOWS = [
  'landing-automation.yml',
  'pr-ci-supersession.yml',
];
const ciReference = (run) =>
  run.path === '.github/workflows/ci.yml' ||
  (run.path == null && run.name === 'PR: CI');
/**
 * PR-level unique catch: per lane, head SHAs where the lane failed while the
 * `ci.yml` source verdict passed on the same SHA. Any passing attempt on a SHA
 * supersedes failed attempts on that SHA, on both sides.
 */
export function uniqueCatchMetrics(runs, jobs, limit = LANE_ROW_LIMIT) {
  const pullRuns = runs.filter((run) => pullRequestEvent(run.event));
  const verdict = (map, key, outcome) => {
    if (!outcome) return;
    if (map.get(key) !== 'success') map.set(key, outcome);
  };
  const ci = new Map();
  for (const run of pullRuns) {
    // `edited` metadata runs share the head SHA but verify nothing.
    if (!ciReference(run) || run.display_title === 'PR metadata') continue;
    verdict(
      ci,
      run.head_sha,
      run.conclusion === 'success'
        ? 'success'
        : ['failure', 'timed_out'].includes(run.conclusion)
          ? 'failure'
          : null,
    );
  }
  const runsByKey = new Map(pullRuns.map((run) => [runKey(run), run]));
  const attempts = new Map();
  for (const job of jobs) {
    const run = runsByKey.get(job.health_run_key);
    if (
      !run ||
      ciReference(run) ||
      NON_VERIFYING_PR_WORKFLOWS.includes(workflowFile(run))
    )
      continue;
    const lane = JSON.stringify([workflowFile(run), laneJobName(job.name)]);
    const key = `${lane}\n${job.health_run_key}`;
    const attempt = attempts.get(key) ?? {
      lane,
      sha: run.head_sha,
      outcomes: [],
    };
    attempts.set(key, attempt);
    attempt.outcomes.push(job.conclusion);
  }
  const lanes = new Map();
  for (const { lane, sha, outcomes } of attempts.values()) {
    const shas = lanes.get(lane) ?? new Map();
    lanes.set(lane, shas);
    // One failed shard fails the lane's attempt; it passes only when every
    // leg concluded and at least one ran successfully.
    verdict(
      shas,
      sha,
      outcomes.some((c) => ['failure', 'timed_out'].includes(c))
        ? 'failure'
        : outcomes.every((c) =>
              ['success', 'skipped', 'neutral'].includes(c),
            ) && outcomes.includes('success')
          ? 'success'
          : null,
    );
  }
  const rows = [...lanes]
    .map(([lane, shas]) => {
      const [workflow, job] = JSON.parse(lane);
      const failedShas = [...shas].filter(([, v]) => v === 'failure');
      return {
        workflow,
        job,
        shas: shas.size,
        failedShas: failedShas.length,
        failedWhileCiPassed: failedShas.filter(
          ([sha]) => ci.get(sha) === 'success',
        ).length,
      };
    })
    .filter((row) => row.shas)
    .sort(
      (a, b) =>
        b.failedWhileCiPassed - a.failedWhileCiPassed ||
        b.failedShas - a.failedShas ||
        b.shas - a.shas ||
        a.workflow.localeCompare(b.workflow) ||
        a.job.localeCompare(b.job),
    );
  return {
    note: 'Counts real defects and flakes together: an upper bound on value, not a defect count.',
    reference: 'ci.yml',
    referenceShas: ci.size,
    referencePassedShas: [...ci.values()].filter((v) => v === 'success').length,
    rows: rows.slice(0, limit),
    omittedLanes: Math.max(0, rows.length - limit),
  };
}
// A merge-queue squash commit carries the time its group was built, which can
// precede the push to main by hours, so commit dates cannot place a landing in
// the window. GitHub's `merged_at` can; one search lists every PR it places in
// the window. Search ranges are inclusive, so the half-open window is applied
// to the returned timestamps.
const searchTime = (value) =>
  new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
export async function mergedPullRequests(request, repo, since, until) {
  const endpoint = `search/issues?q=${encodeURIComponent(`repo:${repo} is:pr is:merged merged:${searchTime(since)}..${searchTime(until)}`)}`;
  const items = [];
  for (let page = 1; ; page++) {
    const data = await request(`${endpoint}&per_page=100&page=${page}`);
    if (!Number.isInteger(data.total_count) || !Array.isArray(data.items))
      throw new Error('Invalid merged pull request search response');
    if (data.incomplete_results)
      throw new Error('Merged pull request search returned incomplete results');
    if (data.total_count > 1000)
      throw new Error(
        `Merged pull request search cap (1000) at ${since}..${until}`,
      );
    items.push(...data.items);
    if (data.items.length < 100 || items.length >= data.total_count) break;
  }
  return [
    ...new Set(
      items
        .filter((item) => {
          const at = time(item.pull_request?.merged_at);
          if (!Number.isFinite(at))
            throw new Error(
              `Merged pull request search item #${item.number} has no merged_at`,
            );
          return at >= time(since) && at < time(until);
        })
        .map((item) => item.number),
    ),
  ].sort((a, b) => a - b);
}
export function costPerLanding(lanes, runnerHours, landings) {
  const count = landings?.length ?? null;
  return {
    landings: count,
    landingSource: 'PRs whose merged_at is in the window',
    runnerHours: round2(runnerHours),
    runnerHoursPerLanding: count ? round2(runnerHours / count) : null,
    runnerHoursByEvent: lanes.runnerHoursByEvent,
  };
}
export function landingLatency(landings, timelines) {
  if (landings == null)
    return {
      merged: null,
      measured: 0,
      notQueuedAtMerge: 0,
      missingMergeEvent: 0,
      multipleEntries: 0,
      lastEntryToMergeMinutes: distribution([]),
      firstEntryToMergeMinutes: distribution([]),
    };
  const last = [];
  const first = [];
  let notQueuedAtMerge = 0;
  let missingMergeEvent = 0;
  let multipleEntries = 0;
  for (const pr of new Set(landings)) {
    const timeline = timelines[pr] ?? [];
    const merged = timeline
      .filter((e) => e.event === 'merged')
      .map(eventTime)
      .sort((a, b) => a - b)[0];
    if (merged == null || !Number.isFinite(merged)) {
      missingMergeEvent++;
      continue;
    }
    const entries = timeline
      .filter(
        (e) => e.event === 'added_to_merge_queue' && eventTime(e) <= merged,
      )
      .map(eventTime)
      .sort((a, b) => a - b);
    // GitHub logs a queue removal with every queue merge, a second before or
    // at the same second (PRs 4879, 4876). Any other removal after the last
    // entry means the PR left the queue and was merged some other way.
    const removals = timeline
      .filter((e) => e.event === 'removed_from_merge_queue')
      .map(eventTime);
    if (
      !entries.length ||
      removals.some((at) => at > entries.at(-1) && at < merged - minute)
    ) {
      notQueuedAtMerge++;
      continue;
    }
    if (entries.length > 1) multipleEntries++;
    first.push((merged - entries[0]) / minute);
    last.push((merged - entries.at(-1)) / minute);
  }
  return {
    merged: new Set(landings).size,
    measured: last.length,
    notQueuedAtMerge,
    missingMergeEvent,
    multipleEntries,
    lastEntryToMergeMinutes: roundDistribution(distribution(last)),
    firstEntryToMergeMinutes: roundDistribution(distribution(first)),
  };
}
/** The `git log` output format `ledgerMetrics` parses. */
export const LEDGER_LOG_FORMAT = [
  '--format=%x1e%s',
  '--name-status',
  '--no-renames',
];
export function ledgerMetrics(log) {
  const counts = log
    .split('\x1e')
    .filter(Boolean)
    .flatMap((entry) => {
      const [header, ...lines] = entry.trim().split('\n');
      if (!/\(#\d+\)/.test(header)) return [];
      // `--name-status --no-renames` lines: "<status>\t<path>".
      const changes = lines.filter(Boolean).map((line) => {
        const [status, path] = line.split('\t');
        return { status, path };
      });
      // A baseline advance that compacts notes (#3394) adds one archive and
      // deletes the loose notes it moved: that measures compaction, not review.
      // Notes are otherwise append-only, so a deleted note is always one moved;
      // notes the same merge adds still count.
      const count = changes.filter(
        ({ status, path }) =>
          path?.startsWith(`${REVIEW_LEDGER_DIR}/`) &&
          !isNoteArchiveFile(path) &&
          !(status === 'D' && path.startsWith(REVIEW_NOTES_DIR)),
      ).length;
      return count ? [count] : [];
    });
  return {
    mergesTouchingLedger: counts.length,
    medianFiles: percentile(counts, 0.5),
    maxFiles: counts.length ? Math.max(...counts) : null,
  };
}
export function windowDecision(total, since, until) {
  if (total < 1000) return { capped: false };
  const start = time(since);
  const end = time(until);
  if (end - start <= 1000)
    return {
      capped: true,
      reason: `Actions listing cap (1000) at ${since}..${until}`,
    };
  const pivot = Math.max(
    Math.floor((start + end) / 2000) * 1000,
    Math.floor(start / 1000) * 1000 + 1000,
  );
  if (pivot >= end)
    return {
      capped: true,
      reason: `Actions listing cap (1000) at ${since}..${until}`,
    };
  const middle = new Date(pivot).toISOString();
  return {
    capped: true,
    windows: [
      [since, middle],
      [middle, until],
    ],
  };
}

async function command(executable, args) {
  const execution = executeOwnedCommand(executable, args, spawn, executable, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const capture = captureOwnedProcessOutput(execution, {
    maxBytes: 32 * 1024 * 1024,
  });
  let timer;
  try {
    const result = await Promise.race([
      execution.completion,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${executable} timed out`)),
          60_000,
        );
      }),
    ]);
    const output = capture.finish();
    if (
      result.status !== 0 ||
      result.error ||
      output.truncated ||
      output.invalidUtf8
    )
      throw new Error(
        `${executable}: ${output.stderr.text || result.error?.message || `exit ${result.status}; truncated=${output.truncated}`}`,
      );
    return output.stdout.text;
  } finally {
    clearTimeout(timer);
    await terminateSuiteExecution(execution, {
      processLabel: executable,
      terminationGraceMs: 1000,
      terminationForceMs: 1000,
      waitForSuiteSettlement,
    });
  }
}
const api = async (endpoint, extra = []) =>
  JSON.parse(await command('gh', ['api', endpoint, ...extra]));
async function pages(request, endpoint, field, limit = 100) {
  const items = [];
  for (let page = 1; page <= limit; page++) {
    const data = await request(
      `${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
    );
    const list = field ? data[field] : data;
    if (!Array.isArray(list))
      throw new Error(`Invalid REST list at ${endpoint}`);
    items.push(...list);
    if (list.length < 100) return items;
  }
  throw new Error(`Pagination cap at ${endpoint} (${limit} pages)`);
}
// Actions leaves `pull_requests` empty for forks and for runs whose head moved
// before the run was listed, so a push is attributed through the head instead.
// `commits/{sha}/pulls` lists every PR that merely CONTAINS the commit (a
// stacked PR included) and returns nothing for a commit that is no longer
// reachable from any branch (a closed PR whose branch was deleted, or a head
// replaced by a force-push). The head ref and the PR lifetime resolve both.
function headLabel(run) {
  const owner = run.head_repository?.owner?.login;
  return owner && run.head_branch ? `${owner}:${run.head_branch}` : null;
}
function headsRun(pull, run) {
  const label = headLabel(run);
  return label
    ? pull.head?.label === label
    : pull.head?.ref === run.head_branch;
}
// A pull-request-family run exists only because of an event on a PR that was
// already open, but events such as `edited` or `labeled` can land seconds after
// the PR closed. Among PRs created before the run, those whose lifetime contains
// it own it; with none, the latest-created one does.
function owningPulls(pulls, run) {
  const at = time(run.created_at);
  const before = pulls.filter((p) => time(p.created_at) <= at);
  const live = before.filter(
    (p) => p.closed_at == null || at <= time(p.closed_at),
  );
  if (live.length || !before.length) return live;
  return [
    before.reduce((a, b) => (time(b.created_at) > time(a.created_at) ? b : a)),
  ];
}
export async function resolvePushPRs(run, repo, request, caches) {
  const { shaPulls, branchPulls } = caches;
  if (!shaPulls.has(run.head_sha))
    shaPulls.set(
      run.head_sha,
      await pages(request, `repos/${repo}/commits/${run.head_sha}/pulls`),
    );
  const direct = owningPulls(
    shaPulls.get(run.head_sha).filter((p) => headsRun(p, run)),
    run,
  );
  if (direct.length) return direct;
  const owner = run.head_repository?.owner?.login;
  if (!owner || !run.head_branch) return [];
  const label = headLabel(run);
  if (!branchPulls.has(label))
    branchPulls.set(
      label,
      await pages(
        request,
        `repos/${repo}/pulls?state=all&head=${encodeURIComponent(label)}`,
      ),
    );
  return owningPulls(
    branchPulls.get(label).filter((p) => headsRun(p, run)),
    run,
  );
}
export async function collectHealth(
  options,
  request = api,
  runCommand = command,
) {
  const { repo, since, until } = options;
  const reasons = [];
  let capHits = 0;
  const runs = [];
  const jobs = [];
  const timelines = {};
  let ledger = null;
  let landings = null;
  try {
    const collectWindow = async (start, end) => {
      const endpoint = `repos/${repo}/actions/runs?created=${encodeURIComponent(`${start}..${end}`)}`;
      const first = await request(`${endpoint}&per_page=100&page=1`);
      if (
        !Number.isInteger(first.total_count) ||
        !Array.isArray(first.workflow_runs)
      )
        throw new Error('Invalid Actions runs response');
      const decision = windowDecision(first.total_count, start, end);
      if (decision.capped) {
        capHits++;
        if (!decision.windows) {
          reasons.push(decision.reason);
          return;
        }
        for (const [a, b] of decision.windows) await collectWindow(a, b);
        return;
      }
      const listed = [...first.workflow_runs];
      for (let page = 2; listed.length < first.total_count; page++) {
        if (page > 10) {
          reasons.push(`Actions pagination cap at ${start}..${end}`);
          break;
        }
        const data = await request(`${endpoint}&per_page=100&page=${page}`);
        if (!data.workflow_runs.length) {
          reasons.push(
            `Actions listing changed during pagination at ${start}..${end}`,
          );
          break;
        }
        listed.push(...data.workflow_runs);
      }
      runs.push(
        ...listed.filter(
          (r) =>
            time(r.created_at) >= time(since) &&
            time(r.created_at) < time(until),
        ),
      );
    };
    await collectWindow(since, until);
    const unique = [...new Map(runs.map((r) => [r.id, r])).values()];
    runs.length = 0;
    const collectRun = async (run) => {
      const collectedRuns = [];
      const collectedJobs = [];
      for (let attempt = 1; attempt <= (run.run_attempt ?? 1); attempt++) {
        const detail =
          attempt === (run.run_attempt ?? 1)
            ? run
            : await request(
                `repos/${repo}/actions/runs/${run.id}/attempts/${attempt}`,
              );
        const attemptJobs = await pages(
          request,
          `repos/${repo}/actions/runs/${run.id}/attempts/${attempt}/jobs`,
          'jobs',
        );
        const key = `${run.id}:${attempt}`;
        // The API returns steps with jobs; retain at most 20 per family.
        for (const job of attemptJobs)
          collectedJobs.push({ ...job, health_run_key: key });
        collectedRuns.push({
          ...detail,
          run_attempt: attempt,
          pull_requests: [...(detail.pull_requests ?? [])],
        });
      }
      return { runs: collectedRuns, jobs: collectedJobs };
    };
    // Four requests at a time bound API pressure; fold results in listing order.
    for (let offset = 0; offset < unique.length; offset += 4) {
      const batch = await Promise.allSettled(
        unique.slice(offset, offset + 4).map(collectRun),
      );
      for (const result of batch)
        if (result.status === 'fulfilled') {
          runs.push(...result.value.runs);
          jobs.push(...result.value.jobs);
        }
      const rejected = batch.find((result) => result.status === 'rejected');
      if (rejected) throw rejected.reason;
    }
    const shaPulls = new Map();
    const branchPulls = new Map();
    for (const run of runs.filter(
      (r) =>
        ['pull_request', 'pull_request_target'].includes(r.event) &&
        !r.pull_requests.length,
    )) {
      const resolved = await resolvePushPRs(run, repo, request, {
        shaPulls,
        branchPulls,
      });
      run.pull_requests = resolved.map((p) => ({ number: p.number }));
      if (!run.pull_requests.length)
        reasons.push(
          `Cannot resolve PR push: run ${run.id} (${run.head_sha?.slice(0, 12)} on ${run.head_repository?.full_name ?? 'unknown repository'}:${run.head_branch}): no pull request lists this commit or had this head branch before the run`,
        );
    }
    for (const group of groupRuns(runs, 'merge_group')) {
      const run = group[0];
      const base = run.head_branch.match(/-([a-f0-9]{40})$/)?.[1];
      const numbers = new Set(
        group.flatMap((r) => r.pull_requests.map((p) => p.number)),
      );
      const leader = run.head_branch.match(/\/pr-(\d+)-/);
      if (leader) numbers.add(Number(leader[1]));
      if (base) {
        const commits = await pages(
          request,
          `repos/${repo}/compare/${base}...${run.head_sha}`,
          'commits',
        );
        for (const commit of commits) {
          const pr = commit.commit.message.split('\n')[0].match(/\(#(\d+)\)$/);
          if (pr) numbers.add(Number(pr[1]));
        }
      } else
        reasons.push(`Cannot resolve merge-group base: ${run.head_branch}`);
      for (const r of group)
        r.pull_requests = [...numbers].map((number) => ({ number }));
    }
    const failedPRs = new Set(
      groupRuns(runs, 'merge_group')
        .filter((g) => g.some(failed))
        .flatMap((g) => g.flatMap((r) => r.pull_requests.map((p) => p.number))),
    );
    for (const pr of failedPRs)
      timelines[pr] = await pages(
        request,
        `repos/${repo}/issues/${pr}/timeline`,
      );
    const remote = (
      await runCommand('git', ['remote', 'get-url', 'origin'])
    ).trim();
    const originRepo = remote.match(
      /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?\/?$/,
    )?.[1];
    if (originRepo !== repo)
      throw new Error(
        `origin does not match --repo=${repo}; local ledger unavailable`,
      );
    const shallow = (
      await runCommand('git', ['rev-parse', '--is-shallow-repository'])
    ).trim();
    if (shallow === 'true')
      throw new Error('Shallow origin/main history; ledger unavailable');
    const log = await runCommand('git', [
      'log',
      'origin/main',
      '--first-parent',
      `--since=${since}`,
      `--until=${until}`,
      ...LEDGER_LOG_FORMAT,
    ]);
    ledger = ledgerMetrics(log);
    // Landing latency needs each landed PR's timeline: one search plus one
    // paginated request per landing not already fetched for a failed group.
    const landed = await mergedPullRequests(request, repo, since, until);
    for (const pr of landed)
      timelines[pr] ??= await pages(
        request,
        `repos/${repo}/issues/${pr}/timeline`,
      );
    landings = landed;
  } catch (error) {
    reasons.push(error.message);
  }
  const samples = new Map();
  for (const job of jobs) {
    const family = shardFamily(job.name);
    const count = samples.get(family) ?? 0;
    if (!family || count >= 20) delete job.steps;
    else if (executed(job)) samples.set(family, count + 1);
  }
  return {
    runs,
    jobs,
    timelines,
    ledger,
    landings,
    reasons,
    capHits,
    collectedAt: new Date().toISOString(),
  };
}
export function qualificationMetrics(runs, jobs) {
  const qualified = runs
    .filter(
      (run) =>
        ['Main qualification', 'Main: Qualification'].includes(run.name) &&
        run.head_branch === 'main' &&
        ['push', 'schedule', 'workflow_dispatch'].includes(run.event),
    )
    .sort((a, b) => time(a.created_at) - time(b.created_at));
  const restored = [];
  let firstFailure = null;
  for (const run of qualified) {
    if (['failure', 'timed_out', 'cancelled'].includes(run.conclusion)) {
      firstFailure ??= time(run.created_at);
    } else if (run.conclusion === 'success' && firstFailure !== null) {
      restored.push(Math.max(0, time(run.updated_at) - firstFailure) / minute);
      firstFailure = null;
    }
  }
  return {
    runs: qualified.length,
    failedOrIncomplete: qualified.filter((run) => run.conclusion !== 'success')
      .length,
    restoreMinutes: distribution(restored),
    unresolvedEpisodeInWindow: firstFailure !== null,
    agentInterventions: jobs.filter((job) =>
      (job.steps ?? []).some(
        (step) =>
          step.name === 'Repair collected failures once' &&
          step.started_at &&
          step.conclusion !== 'skipped',
      ),
    ).length,
  };
}
export function buildSnapshot(data, options) {
  const capacity = capacityMetrics(data.jobs, options.until, options.since);
  const lanes = laneMetrics(data.runs, data.jobs, options.until, options.since);
  const reasons = [...data.reasons];
  if (capacity.unattributed)
    reasons.push(
      `window includes ${capacity.unattributed} jobs with unavailable runner attribution`,
    );
  if (capacity.unfinished)
    reasons.push(`window includes ${capacity.unfinished} unfinished jobs`);
  const latency = landingLatency(data.landings ?? null, data.timelines ?? {});
  if (latency.missingMergeEvent)
    reasons.push(
      `window includes ${latency.missingMergeEvent} merged PRs without a timeline merge event`,
    );
  return {
    schema: 'station-ci-health/v1',
    repo: options.repo,
    since: options.since,
    until: options.until,
    collectedAt: data.collectedAt ?? options.until,
    incomplete: reasons.length > 0,
    reasons,
    listingCapHits: data.capHits,
    mergeQueue: mergeMetrics(
      data.runs,
      data.jobs,
      data.timelines,
      options.since,
      options.until,
    ),
    capacity,
    qualification: qualificationMetrics(data.runs, data.jobs),
    perPRPush: summarizeGroups(groupRuns(data.runs, 'push'), data.jobs),
    perMergeGroup: summarizeGroups(
      groupRuns(data.runs, 'merge_group'),
      data.jobs,
    ),
    setupVsTest: setupMetrics(data.jobs),
    reviewLedger: data.ledger,
    lanes,
    uniqueCatch: uniqueCatchMetrics(data.runs, data.jobs),
    costPerLanding: costPerLanding(
      lanes,
      capacity.runnerHours,
      data.landings ?? null,
    ),
    landingLatency: latency,
  };
}
export function parseOptions(args, now = new Date()) {
  const options = {
    repo: 'kontourai/station',
    until: now.toISOString(),
    json: false,
    record: false,
    history: false,
  };
  let hours = 24;
  let since;
  for (const arg of args) {
    if (['--json', '--record', '--history'].includes(arg))
      options[arg.slice(2)] = true;
    else {
      const match = arg.match(/^--(since|until|hours|repo|issue)=(.+)$/);
      if (!match) throw new Error(`Unknown option: ${arg}`);
      const [, key, value] = match;
      if (key === 'since') since = value;
      else if (key === 'hours') hours = Number(value);
      else options[key] = value;
    }
  }
  if ((options.record || options.history) && !options.issue)
    throw new Error('--record and --history require --issue=<n>');
  if (options.record && options.history)
    throw new Error('--record and --history are mutually exclusive');
  if (since && args.some((a) => a.startsWith('--hours=')))
    throw new Error('Choose --since or --hours');
  if (!/^[a-zA-Z0-9][\w.-]*\/[a-zA-Z0-9][\w.-]*$/.test(options.repo))
    throw new Error('Invalid --repo');
  if (options.issue && !/^[1-9]\d*$/.test(options.issue))
    throw new Error('Invalid --issue');
  if (!Number.isFinite(hours) || hours <= 0)
    throw new Error('--hours must be positive');
  options.since =
    since ?? new Date(time(options.until) - hours * 60 * minute).toISOString();
  if (
    !Number.isFinite(time(options.since)) ||
    !Number.isFinite(time(options.until)) ||
    time(options.since) >= time(options.until)
  )
    throw new Error('Invalid time window');
  options.since = new Date(options.since).toISOString();
  options.until = new Date(options.until).toISOString();
  return options;
}
const number = (n) => (n == null ? 'n/a' : Number(n.toFixed(2)));
const percent = (n) => (n == null ? 'n/a' : `${number(n * 100)}%`);
const stats = (d) => `${number(d.median)} / ${number(d.p90)} (n=${d.count})`;
export function renderSnapshot(s) {
  const m = s.mergeQueue;
  const c = s.capacity;
  const rows = [
    ['Merge groups built', m.groupsBuilt],
    ...(s.qualification
      ? [
          [
            'Qualification runs / failed or incomplete',
            `${s.qualification.runs} / ${s.qualification.failedOrIncomplete}`,
          ],
          [
            'Qualification restore minutes median / p90',
            stats(s.qualification.restoreMinutes),
          ],
          ['Repair agent interventions', s.qualification.agentInterventions],
        ]
      : []),
    ['Groups failed / rate', `${m.groupsFailed} / ${percent(m.failureRate)}`],
    [
      'Groups cancelled / timed out',
      `${m.groupsCancelled} / ${m.groupsTimedOut}`,
    ],
    ['Failed groups with integration-gate failure', m.regressionFailedGroups],
    [
      'PRs with failed group / bot removals',
      `${m.prsWithFailedGroup} / ${m.botRemovals}`,
    ],
    [
      'Re-entry: new commits / passed unchanged',
      `${m.reentries.neededNewCommits} / ${m.reentries.passedUnchanged}`,
    ],
    [
      'Re-entry: pending / unresolved unchanged',
      `${m.reentries.pending} / ${m.reentries.unresolvedUnchanged}`,
    ],
    ['Merge integration minutes median / p90', stats(m.regressionMinutes)],
    [
      'Jobs executed / skipped / unfinished',
      `${c.executed} / ${c.skipped} / ${c.unfinished}`,
    ],
    [
      'Runner-hours / waiting hours',
      `${number(c.runnerHours)} / ${number(c.waitingHours)}`,
    ],
    [
      'Unfinished wait so far minutes median / p90',
      stats(c.unfinishedWaitMinutes),
    ],
    [
      'Time with >=18 hosted jobs running',
      c.hostedConcurrency
        ? percent(c.hostedConcurrency.shareAtLeast18)
        : 'unavailable (legacy snapshot)',
    ],
    [
      'Jobs waiting >5 / >20 minutes',
      `${percent(c.waitOver5Share)} / ${percent(c.waitOver20Share)}`,
    ],
    ...Object.entries(c.platformWaitMinutes).map(([os, d]) => [
      `${os} wait minutes median / p90`,
      stats(d),
    ]),
    ...[
      ['PR push', s.perPRPush],
      ['Merge group', s.perMergeGroup],
    ].flatMap(([label, group]) =>
      Object.entries(group).map(([metric, d]) => [
        `${label} ${metric} median / p90`,
        stats(d),
      ]),
    ),
    ...Object.entries(s.setupVsTest).map(([family, d]) => [
      `${family}: setup / test median minutes; setup share`,
      `${number(d.setupMinutes.median)} / ${number(d.testMinutes.median)}; ${percent(d.setupShare)} (n=${d.samples})`,
    ]),
    [
      'Ledger-touching PR merges / median / max files',
      s.reviewLedger
        ? `${s.reviewLedger.mergesTouchingLedger} / ${number(s.reviewLedger.medianFiles)} / ${number(s.reviewLedger.maxFiles)}`
        : 'unavailable',
    ],
    ...(s.costPerLanding
      ? [
          [
            'Landed PRs / runner-hours per landing',
            `${number(s.costPerLanding.landings)} / ${number(s.costPerLanding.runnerHoursPerLanding)}`,
          ],
          [
            'Runner-hours by event',
            Object.entries(s.costPerLanding.runnerHoursByEvent)
              .map(([event, hours]) => `${event} ${number(hours)}`)
              .join(', '),
          ],
          [
            'Runner-minutes in cancelled runs / share',
            `${number(s.lanes.cancelledRunMinutes)} / ${percent(s.lanes.cancelledRunShare)}`,
          ],
          [
            'Last queue entry to merge minutes median / p90',
            stats(s.landingLatency.lastEntryToMergeMinutes),
          ],
          [
            'First queue entry to merge minutes median / p90',
            stats(s.landingLatency.firstEntryToMergeMinutes),
          ],
          [
            'Merged PRs: with re-entry / not queued at merge / no merge event',
            `${s.landingLatency.multipleEntries} / ${s.landingLatency.notQueuedAtMerge} / ${s.landingLatency.missingMergeEvent}`,
          ],
        ]
      : []),
  ];
  const table = (header, body) =>
    `| ${header.join(' | ')} |\n| ${header.map(() => '---').join(' | ')} |\n${body.map((cells) => `| ${cells.map((v) => String(v).replaceAll('|', '\\|')).join(' | ')} |`).join('\n')}`;
  const laneTable = s.lanes
    ? `\n\nRunner-minutes by lane (top ${s.lanes.rows.length}${s.lanes.other ? ` of ${s.lanes.rows.length + s.lanes.other.lanes}` : ''})\n\n${table(
        [
          'Workflow',
          'Job',
          'Event',
          'Jobs',
          'Runner-min',
          'Share',
          'Job min median / p90',
          'Wait min median / p90',
          'Failures',
          'Cancelled-run min',
        ],
        [
          ...s.lanes.rows.map((r) => [
            r.workflow,
            r.job,
            r.event,
            r.executed,
            number(r.runnerMinutes),
            percent(r.share),
            `${number(r.jobMinutes.median)} / ${number(r.jobMinutes.p90)}`,
            `${number(r.waitMinutes.median)} / ${number(r.waitMinutes.p90)}`,
            r.failures,
            `${number(r.cancelledRunMinutes)}${r.incomplete ? ' (incomplete)' : ''}`,
          ]),
          ...(s.lanes.other
            ? [
                [
                  `other (${s.lanes.other.lanes} lanes)`,
                  '',
                  '',
                  s.lanes.other.executed,
                  number(s.lanes.other.runnerMinutes),
                  percent(s.lanes.other.share),
                  '',
                  '',
                  s.lanes.other.failures,
                  `${number(s.lanes.other.cancelledRunMinutes)}${s.lanes.other.incomplete ? ' (incomplete)' : ''}`,
                ],
              ]
            : []),
        ],
      )}`
    : '';
  const catchTable = s.uniqueCatch
    ? `\n\nPR-level unique catch against ${s.uniqueCatch.reference} (${s.uniqueCatch.referencePassedShas}/${s.uniqueCatch.referenceShas} head SHAs passed). ${s.uniqueCatch.note}${s.uniqueCatch.omittedLanes ? ` ${s.uniqueCatch.omittedLanes} lanes omitted.` : ''}\n\n${table(
        [
          'Workflow',
          'Job',
          'Head SHAs',
          'Failed SHAs',
          'Failed while CI passed',
        ],
        s.uniqueCatch.rows.map((r) => [
          r.workflow,
          r.job,
          r.shas,
          r.failedShas,
          r.failedWhileCiPassed,
        ]),
      )}`
    : '';
  return `${s.repo}: ${s.since} .. ${s.until}\n${s.incomplete ? `INCOMPLETE: ${s.reasons.join('; ')}` : 'Complete REST collection'}; listing cap hits: ${s.listingCapHits}\n\n${table(['Measure', 'Value'], rows)}${laneTable}${catchTable}`;
}
/** GitHub refuses issue comment bodies longer than this many characters. */
export const COMMENT_LIMIT = 65_536;
export function snapshotComment(snapshot) {
  const body = (json) =>
    `CI health ${snapshot.since} .. ${snapshot.until}: ${snapshot.mergeQueue.groupsFailed}/${snapshot.mergeQueue.groupsBuilt} groups failed (${percent(snapshot.mergeQueue.failureRate)}); incomplete=${snapshot.incomplete}.\n\n\`\`\`json\n${json}\n\`\`\``;
  // Lane rows are capped; unindented JSON is the fallback for an unusually
  // long window so recording keeps working. History parses either form.
  const pretty = body(JSON.stringify(snapshot, null, 2));
  if (pretty.length <= COMMENT_LIMIT) return pretty;
  const compact = body(JSON.stringify(snapshot));
  if (compact.length <= COMMENT_LIMIT) return compact;
  throw new Error(
    `CI health comment is ${compact.length} characters; GitHub accepts ${COMMENT_LIMIT}`,
  );
}
export function readHistory(comments) {
  return comments
    .flatMap((comment) => {
      if (!comment.body?.startsWith('CI health ')) return [];
      const block = comment.body.match(/^```json\r?\n([\s\S]*?)\r?\n```/m);
      if (!block) return [];
      try {
        const value = JSON.parse(block[1]);
        return value.schema === 'station-ci-health/v1' &&
          value.mergeQueue &&
          value.capacity
          ? [value]
          : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => time(a.until) - time(b.until));
}
export function renderHistory(snapshots) {
  // Snapshots recorded before the lane ledger lack these fields.
  const legacy = 'n/a (legacy snapshot)';
  return `| Window end | Hours | Failed groups | >=18 hosted running | Wait >5 min | Wait >20 min | New commits / unchanged | Runner-h per landing | Last entry to merge min median / p90 | Cancelled-run share | Incomplete |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n${snapshots.map((s) => `| ${s.until} | ${number((time(s.until) - time(s.since)) / (60 * minute))} | ${percent(s.mergeQueue.failureRate)} | ${s.capacity.hostedConcurrency ? percent(s.capacity.hostedConcurrency.shareAtLeast18) : 'unavailable (legacy snapshot)'} | ${percent(s.capacity.waitOver5Share)} | ${percent(s.capacity.waitOver20Share)} | ${s.mergeQueue.reentries.neededNewCommits} / ${s.mergeQueue.reentries.passedUnchanged} | ${s.costPerLanding ? number(s.costPerLanding.runnerHoursPerLanding) : legacy} | ${s.landingLatency ? `${number(s.landingLatency.lastEntryToMergeMinutes.median)} / ${number(s.landingLatency.lastEntryToMergeMinutes.p90)}` : legacy} | ${s.lanes ? percent(s.lanes.cancelledRunShare) : legacy} | ${s.incomplete} |`).join('\n')}`;
}
async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.history) {
    try {
      const history = readHistory(
        await pages(
          api,
          `repos/${options.repo}/issues/${options.issue}/comments`,
        ),
      );
      console.log(
        options.json
          ? JSON.stringify({ snapshots: history, incomplete: false })
          : renderHistory(history),
      );
    } catch (error) {
      console.log(
        options.json
          ? JSON.stringify({
              snapshots: [],
              incomplete: true,
              reasons: [error.message],
            })
          : `INCOMPLETE history: ${error.message}`,
      );
      process.exitCode = 1;
    }
    return;
  }
  process.exitCode = await reportSnapshot(options);
}
/**
 * Collect, print, then record. The snapshot is printed before recording so a
 * refused or failed comment still leaves the measurement in the output the
 * workflow retains; either failure exits nonzero.
 * @param {any} options
 * @param {{
 *   collect?: (options: any) => Promise<any>,
 *   post?: (body: string) => Promise<unknown>,
 *   print?: (text: string) => void,
 *   warn?: (text: string) => void,
 * }} [deps]
 */
export async function reportSnapshot(
  options,
  {
    collect = (o) => collectHealth(o),
    post = (body) =>
      api(`repos/${options.repo}/issues/${options.issue}/comments`, [
        '--method',
        'POST',
        '-f',
        `body=${body}`,
      ]),
    print = console.log,
    warn = console.error,
  } = {},
) {
  const snapshot = buildSnapshot(await collect(options), options);
  print(options.json ? JSON.stringify(snapshot) : renderSnapshot(snapshot));
  let failed = snapshot.incomplete;
  if (options.record)
    try {
      await post(snapshotComment(snapshot));
    } catch (error) {
      warn(`Recording failed: ${error.message}`);
      failed = true;
    }
  return failed ? 1 : 0;
}
if (invokedDirectly(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
