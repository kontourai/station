#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { invokedDirectly } from './lib/module-entry.mjs';
import {
  captureOwnedProcessOutput,
  executeOwnedCommand,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from './lib/owned-process.mjs';

const minute = 60_000;
const time = (value) => Date.parse(value);
const ratio = (n, d) => (d ? n / d : null);
const executed = (job) =>
  job.conclusion != null &&
  job.conclusion !== 'skipped' &&
  job.started_at &&
  job.completed_at;
const duration = (job) =>
  Math.max(0, time(job.completed_at) - time(job.started_at)) / minute;
const wait = (job) =>
  Math.max(0, time(job.started_at) - time(job.created_at)) / minute;
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
export function concurrencyTimeline(jobs, until) {
  const events = jobs
    .flatMap((job) => {
      if (job.conclusion == null) {
        const end = time(until);
        if (job.started_at) {
          const start = Math.min(time(job.started_at), end);
          return [
            [start, 1],
            [end, -1],
          ];
        }
        // Queued jobs consume no runner slots, but their wait remains observable.
        return [
          [Math.min(time(job.created_at), end), 0],
          [end, 0],
        ];
      }
      if (!executed(job)) return [];
      const start = time(job.started_at);
      return [
        [start, 1],
        [Math.max(start, time(job.completed_at)), -1],
      ];
    })
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
  const regression = runs.filter(
    (r) =>
      r.event === 'merge_group' &&
      [
        'Merge-queue regression',
        'Merge integration',
        'PR: Merge integration',
      ].includes(r.name) &&
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
export function capacityMetrics(jobs, until) {
  const ran = jobs.filter(executed);
  const unfinished = jobs.filter((j) => j.conclusion == null);
  const waiting = [...ran, ...unfinished];
  const waitSoFar = (j) =>
    Math.max(
      0,
      Math.min(time(j.started_at ?? until), time(until)) - time(j.created_at),
    ) / minute;
  const jobWait = (j) => (j.conclusion == null ? waitSoFar(j) : wait(j));
  const waits = waiting.map(jobWait);
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
    unfinishedWaitMinutes: distribution(unfinished.map(waitSoFar)),
    runnerHours: ran.reduce((sum, j) => sum + duration(j), 0) / 60,
    waitingHours: waits.reduce((a, b) => a + b, 0) / 60,
    concurrency: concurrencyTimeline(jobs, until),
    waitOver5Share: ratio(waits.filter((w) => w > 5).length, waiting.length),
    waitOver20Share: ratio(waits.filter((w) => w > 20).length, waiting.length),
    platformWaitMinutes: Object.fromEntries(
      ['linux', 'windows', 'macos'].map((os) => [
        os,
        distribution(waiting.filter((j) => platform(j) === os).map(jobWait)),
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
export function ledgerMetrics(log) {
  const counts = log
    .split('\x1e')
    .filter(Boolean)
    .flatMap((entry) => {
      const [header, ...files] = entry.trim().split('\n');
      if (!/\(#\d+\)/.test(header)) return [];
      const count = files.filter((f) =>
        f.startsWith('docs/learn/review-ledger/'),
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
    const pushPRs = new Map();
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
    for (const run of runs.filter(
      (r) =>
        ['pull_request', 'pull_request_target'].includes(r.event) &&
        !r.pull_requests.length,
    )) {
      if (!pushPRs.has(run.head_sha))
        pushPRs.set(
          run.head_sha,
          await pages(request, `repos/${repo}/commits/${run.head_sha}/pulls`),
        );
      run.pull_requests = pushPRs
        .get(run.head_sha)
        .map((p) => ({ number: p.number }));
      if (!run.pull_requests.length)
        reasons.push(`Cannot resolve PR push: run ${run.id}`);
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
      '--format=%x1e%s',
      '--name-only',
    ]);
    ledger = ledgerMetrics(log);
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
        ['schedule', 'workflow_dispatch'].includes(run.event),
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
  const capacity = capacityMetrics(data.jobs, options.until);
  const reasons = [...data.reasons];
  if (capacity.unfinished)
    reasons.push(`window includes ${capacity.unfinished} unfinished jobs`);
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
    ['Time with >=18 jobs running', percent(c.concurrency.shareAtLeast18)],
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
  ];
  return `${s.repo}: ${s.since} .. ${s.until}\n${s.incomplete ? `INCOMPLETE: ${s.reasons.join('; ')}` : 'Complete REST collection'}; listing cap hits: ${s.listingCapHits}\n\n| Measure | Value |\n| --- | --- |\n${rows.map(([label, value]) => `| ${label} | ${String(value).replaceAll('|', '\\|')} |`).join('\n')}`;
}
export function snapshotComment(snapshot) {
  return `CI health ${snapshot.since} .. ${snapshot.until}: ${snapshot.mergeQueue.groupsFailed}/${snapshot.mergeQueue.groupsBuilt} groups failed (${percent(snapshot.mergeQueue.failureRate)}); incomplete=${snapshot.incomplete}.\n\n\`\`\`json\n${JSON.stringify(snapshot, null, 2)}\n\`\`\``;
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
  return `| Window end | Hours | Failed groups | >=18 running | Wait >5 min | Wait >20 min | New commits / unchanged | Incomplete |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n${snapshots.map((s) => `| ${s.until} | ${number((time(s.until) - time(s.since)) / (60 * minute))} | ${percent(s.mergeQueue.failureRate)} | ${percent(s.capacity.concurrency.shareAtLeast18)} | ${percent(s.capacity.waitOver5Share)} | ${percent(s.capacity.waitOver20Share)} | ${s.mergeQueue.reentries.neededNewCommits} / ${s.mergeQueue.reentries.passedUnchanged} | ${s.incomplete} |`).join('\n')}`;
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
  const snapshot = buildSnapshot(await collectHealth(options), options);
  if (options.record)
    await api(`repos/${options.repo}/issues/${options.issue}/comments`, [
      '--method',
      'POST',
      '-f',
      `body=${snapshotComment(snapshot)}`,
    ]);
  console.log(
    options.json ? JSON.stringify(snapshot) : renderSnapshot(snapshot),
  );
  if (snapshot.incomplete) process.exitCode = 1;
}
if (invokedDirectly(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
