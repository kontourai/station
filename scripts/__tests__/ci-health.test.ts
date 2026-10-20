import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  buildSnapshot,
  capacityMetrics,
  classifyReentry,
  collectHealth,
  concurrencyTimeline,
  distribution,
  groupRuns,
  LEDGER_LOG_FORMAT,
  ledgerMetrics,
  mergeMetrics,
  parseOptions,
  percentile,
  qualificationMetrics,
  readHistory,
  renderHistory,
  renderSnapshot,
  setupMetrics,
  shardFamily,
  snapshotComment,
  summarizeGroups,
  windowDecision,
} from '../ci-health.mjs';

const makeTempDir = trackTempDirs();

const at = (minutes: number) =>
  new Date(Date.UTC(2026, 9, 1, 0, minutes)).toISOString();
const job = (id = 1, overrides = {}) => ({
  id,
  name: 'test',
  status: 'completed',
  conclusion: 'success',
  created_at: at(0),
  started_at: at(6),
  completed_at: at(16),
  labels: ['ubuntu-latest'],
  runner_id: id + 1,
  runner_name: `runner-${id}`,
  health_run_key: '1:1',
  steps: [],
  ...overrides,
});
const run = (id = 1, overrides = {}) => ({
  id,
  run_attempt: 1,
  name: 'PR: CI',
  event: 'pull_request',
  status: 'completed',
  conclusion: 'success',
  created_at: at(0),
  head_sha: 'abc',
  head_branch: 'feature',
  pull_requests: [{ number: 3102 }],
  ...overrides,
});
const removal = {
  event: 'removed_from_merge_queue',
  created_at: at(10),
  actor: { type: 'Bot', login: 'github-merge-queue[bot]' },
};
const entry = { event: 'added_to_merge_queue', created_at: at(20) };
const merge = { event: 'merged', created_at: at(30) };
const options = { repo: 'kontourai/station', since: at(0), until: at(60) };
const emptyData = () => ({
  runs: [],
  jobs: [],
  timelines: {},
  ledger: ledgerMetrics(''),
  reasons: [],
  capHits: 0,
});

describe('CI health metrics', () => {
  it('uses upper-rank percentiles and null for empty populations', () => {
    expect(percentile([4, 1, 3, 2], 0.5)).toBe(3);
    expect(distribution([10, 0, 5, 20, 30, 40, 50, 60, 70, 80])).toEqual({
      count: 10,
      median: 40,
      p90: 80,
    });
    expect(distribution([])).toEqual({ count: 0, median: null, p90: null });
  });
  it('counts exactly 18 running jobs and idle gaps without double-counting boundaries', () => {
    const jobs = Array.from({ length: 18 }, (_, i) =>
      job(i, { started_at: at(0), completed_at: at(10) }),
    );
    jobs.push(job(20, { started_at: at(20), completed_at: at(30) }));
    expect(concurrencyTimeline(jobs)).toEqual({
      histogramMinutes: { 0: 10, 1: 10, 18: 10 },
      shareAtLeast18: 1 / 3,
    });
    expect(concurrencyTimeline(jobs.slice(0, 17)).shareAtLeast18).toBe(0);
    expect(concurrencyTimeline([]).shareAtLeast18).toBeNull();
  });
  it('measures executed/skipped jobs, runner and wait hours, strict wait thresholds and each OS', () => {
    const metrics = capacityMetrics(
      [
        job(),
        job(2, {
          labels: ['windows-latest'],
          started_at: at(20),
          completed_at: at(30),
        }),
        job(3, {
          labels: ['macos-14'],
          started_at: at(21),
          completed_at: at(31),
        }),
        job(4, { conclusion: 'skipped' }),
        job(5, { conclusion: null, completed_at: null }),
      ],
      at(60),
    );
    expect(metrics.executed).toBe(3);
    expect(metrics.skipped).toBe(1);
    expect(metrics.unfinished).toBe(1);
    expect(metrics.runnerHours).toBe(0.5);
    expect(metrics.waitingHours).toBe(53 / 60);
    expect(metrics.waitOver5Share).toBe(1);
    expect(metrics.waitOver20Share).toBe(1 / 4);
    expect(metrics.platformWaitMinutes).toEqual({
      linux: { count: 2, median: 6, p90: 6 },
      windows: { count: 1, median: 20, p90: 20 },
      macos: { count: 1, median: 21, p90: 21 },
    });
  });
  it('does not mistake GitHub queued placeholder timestamps for runner execution', () => {
    // Retained API shapes: 117287700463 was queued with started_at=created_at;
    // 117276468422 was cancelled before any runner was assigned.
    const snapshot = buildSnapshot(
      {
        ...emptyData(),
        jobs: [
          job(1, {
            status: 'queued',
            conclusion: null,
            started_at: at(0),
            completed_at: null,
            runner_id: null,
            runner_name: null,
          }),
          job(2, {
            conclusion: 'cancelled',
            started_at: at(0),
            completed_at: at(10),
            runner_id: 0,
            runner_name: '',
          }),
          job(3, {
            status: 'in_progress',
            conclusion: null,
            started_at: at(10),
            completed_at: null,
          }),
        ],
      },
      options,
    );
    expect(snapshot.capacity).toMatchObject({
      executed: 0,
      runnerHours: 0,
      waitingHours: 80 / 60,
      unfinishedWaitMinutes: { count: 2, median: 60, p90: 60 },
      concurrency: { histogramMinutes: { 0: 10, 1: 50 } },
    });
    expect(snapshot.incomplete).toBe(true);
  });
  it('clips capacity occupancy to the requested window and separates hosted runners', () => {
    const snapshot = buildSnapshot(
      {
        ...emptyData(),
        jobs: [
          job(1, { started_at: at(0), completed_at: at(80) }),
          job(2, {
            started_at: at(0),
            completed_at: at(80),
            labels: ['self-hosted', 'Linux'],
          }),
          job(3, {
            created_at: at(70),
            started_at: at(70),
            completed_at: at(80),
          }),
        ],
      },
      { ...options, since: at(10), until: at(60) },
    );
    expect(snapshot.capacity.runnerHours).toBe(100 / 60);
    expect(snapshot.capacity.concurrency.histogramMinutes).toEqual({ 2: 50 });
    expect(snapshot.capacity.hostedConcurrency.histogramMinutes).toEqual({
      1: 50,
    });
    expect(snapshot.capacity.selfHostedConcurrency.histogramMinutes).toEqual({
      1: 50,
    });
  });
  it.each(['completed', 'in_progress'])(
    'keeps %s jobs with missing runner attribution unavailable',
    (status) => {
      const snapshot = buildSnapshot(
        {
          ...emptyData(),
          jobs: [
            job(1, {
              status,
              conclusion: status === 'completed' ? 'success' : null,
              completed_at: status === 'completed' ? at(16) : null,
              runner_id: null,
              runner_name: null,
            }),
          ],
        },
        options,
      );
      expect(snapshot.capacity.executed).toBe(0);
      expect(snapshot.capacity.runnerHours).toBe(0);
      expect(snapshot.capacity.platformWaitMinutes.linux.count).toBe(0);
      expect(snapshot.incomplete).toBe(true);
      expect(snapshot.reasons).toContain(
        'window includes 1 jobs with unavailable runner attribution',
      );
    },
  );
  it('groups PR workflows by baseline PR/ten-minute bucket and merge workflows by queue branch', () => {
    const runs = [
      run(),
      run(2, { event: 'pull_request_target', created_at: at(9) }),
      run(3, { created_at: at(10) }),
      run(4, { event: 'merge_group', head_branch: 'queue' }),
      run(5, { event: 'merge_group', head_branch: 'queue' }),
      run(6, { event: 'push' }),
    ];
    expect(
      groupRuns(runs, 'push').map((g: { id: number }[]) => g.map((r) => r.id)),
    ).toEqual([[1, 2], [3]]);
    expect(
      groupRuns(runs, 'merge_group').map((g: { id: number }[]) =>
        g.map((r) => r.id),
      ),
    ).toEqual([[4, 5]]);
    const jobs = Array.from({ length: 5 }, (_, i) => job(i));
    expect(summarizeGroups(groupRuns(runs, 'push'), jobs)).toEqual({
      executedJobs: { count: 1, median: 5, p90: 5 },
      runnerMinutes: { count: 1, median: 50, p90: 50 },
      wallMinutes: { count: 1, median: 16, p90: 16 },
    });
    expect(
      summarizeGroups([[run()]], jobs.slice(0, 4)).executedJobs.count,
    ).toBe(0);
  });
  it('classifies re-entry with a new commit versus an unchanged successful re-entry', () => {
    const committed = {
      event: 'committed',
      sha: 'def',
      author: { date: at(15) },
      committer: { date: at(16) },
    };
    expect(classifyReentry([merge, entry, removal, committed], removal)).toBe(
      'neededNewCommits',
    );
    expect(classifyReentry([removal, entry, merge], removal)).toBe(
      'passedUnchanged',
    );
    expect(
      classifyReentry(
        [removal, entry, { ...removal, created_at: at(25) }, merge],
        removal,
      ),
    ).toBe('unresolvedUnchanged');
    expect(classifyReentry([removal], removal)).toBe('pending');
  });
  it('excludes a removal that is really a merge even when GitHub orders removal first', () => {
    expect(
      classifyReentry([removal, { ...merge, created_at: at(10) }], removal),
    ).toBe('merge');
    const metrics = mergeMetrics(
      [run(1, { event: 'merge_group', conclusion: 'failure' })],
      [],
      { 3102: [removal, { ...merge, created_at: at(10) }] },
      at(0),
      at(60),
    );
    expect(metrics.botRemovals).toBe(0);
  });
  it('counts logical failed groups and regression failures, and bounds removals/outcomes to the window', () => {
    const runs = [
      run(1, {
        event: 'merge_group',
        name: 'Merge-queue regression',
        run_started_at: at(0),
        updated_at: at(32),
        conclusion: 'failure',
        head_branch: 'q1',
      }),
      run(2, { event: 'merge_group', head_branch: 'q1' }),
      run(3, { event: 'merge_group', head_branch: 'q2' }),
    ];
    const metrics = mergeMetrics(
      runs,
      [job(1, { name: 'Merge-queue regression', conclusion: 'failure' })],
      { 3102: [removal, entry, merge, { ...removal, created_at: at(70) }] },
      at(0),
      at(60),
    );
    expect(metrics).toMatchObject({
      groupsBuilt: 2,
      groupsFailed: 1,
      failureRate: 0.5,
      regressionFailedGroups: 1,
      prsWithFailedGroup: 1,
      botRemovals: 1,
      reentries: { passedUnchanged: 1, neededNewCommits: 0 },
      regressionMinutes: { count: 1, median: 32, p90: 32 },
    });
  });
  it('uses force-push and commit event times before re-entry, falling back only when absent', () => {
    for (const event of ['committed', 'head_ref_force_pushed']) {
      const change = { event, created_at: at(15), committer: { date: at(5) } };
      expect(classifyReentry([removal, change, entry, merge], removal)).toBe(
        'neededNewCommits',
      );
      expect(
        classifyReentry(
          [
            removal,
            { ...change, created_at: at(25), committer: { date: at(15) } },
            entry,
            merge,
          ],
          removal,
        ),
      ).toBe('passedUnchanged');
    }
  });
  it('counts only the merge-queue bot login as a bot removal', () => {
    const metrics = mergeMetrics(
      [run(1, { event: 'merge_group', conclusion: 'failure' })],
      [],
      {
        3102: [
          { ...removal, actor: { type: 'Bot', login: 'future-landing[bot]' } },
          entry,
          merge,
        ],
      },
      at(0),
      at(60),
    );
    expect(metrics.botRemovals).toBe(0);
    expect(metrics.reentries.passedUnchanged).toBe(0);
  });
  it('reports unfinished wait so far and concurrency through the window end as incomplete', () => {
    const data = {
      ...emptyData(),
      jobs: [
        job(1, {
          conclusion: null,
          started_at: null,
          completed_at: null,
          status: 'queued',
        }),
        job(2, {
          conclusion: null,
          started_at: at(10),
          completed_at: null,
          status: 'in_progress',
        }),
      ],
    };
    const snapshot = buildSnapshot(data, options);
    expect(snapshot).toMatchObject({
      incomplete: true,
      reasons: ['window includes 2 unfinished jobs'],
    });
    expect(snapshot.capacity).toMatchObject({
      unfinished: 2,
      unfinishedWaitMinutes: { count: 2, median: 60, p90: 60 },
      waitingHours: 70 / 60,
      waitOver5Share: 1,
      waitOver20Share: 0.5,
      concurrency: { histogramMinutes: { 0: 10, 1: 50 } },
    });
    expect(renderSnapshot(snapshot)).toContain('Unfinished wait so far');
  });
  it('floors inverted job intervals without negative concurrency', () => {
    const metrics = concurrencyTimeline(
      [
        job(1, { started_at: at(10), completed_at: at(5) }),
        job(2, { started_at: at(0), completed_at: at(20) }),
      ],
      at(60),
    );
    expect(metrics.histogramMinutes).toEqual({ 1: 20 });
  });
  it('excludes unfinished groups from completed wall-time distributions', () => {
    const data = {
      ...emptyData(),
      runs: [run(1, { event: 'merge_group', conclusion: null })],
      jobs: Array.from({ length: 5 }, (_, i) => job(i)),
    };
    expect(buildSnapshot(data, options).perMergeGroup.wallMinutes.count).toBe(
      0,
    );
    expect(
      summarizeGroups(
        [[run()]],
        [...data.jobs, job(6, { conclusion: null, completed_at: null })],
      ).wallMinutes.count,
    ).toBe(0);
  });
  it('separates cancellation and timeout groups from failure rate and excludes cancelled regression durations', () => {
    const runs = ['success', 'failure', 'cancelled', 'timed_out'].map(
      (conclusion, i) =>
        run(i, {
          event: 'merge_group',
          head_branch: `q${i}`,
          name: 'Merge-queue regression',
          conclusion,
          run_started_at: at(0),
          updated_at: at(i + 1),
        }),
    );
    expect(mergeMetrics(runs, [], {}, at(0), at(60))).toMatchObject({
      groupsFailed: 1,
      failureRate: 0.25,
      groupsCancelled: 1,
      groupsTimedOut: 1,
      regressionMinutes: { count: 3, median: 2, p90: 4 },
    });
  });
  it('attributes integration durations to the current owner per exact merge candidate, retaining every owner attempt', () => {
    const integration = (
      id: number,
      name: string,
      minutes: number,
      overrides = {},
    ) =>
      run(id, {
        name,
        event: 'merge_group',
        head_branch: 'queue',
        run_started_at: at(0),
        updated_at: at(minutes),
        ...overrides,
      });
    const historical = [
      integration(1, 'Merge-queue regression', 2, { head_sha: 'old1' }),
      integration(2, 'Merge integration', 4, { head_sha: 'old2' }),
      integration(3, 'PR: Merge integration', 6, { head_sha: 'old3' }),
      integration(3, 'PR: Merge integration', 8, {
        head_sha: 'old3',
        run_attempt: 2,
      }),
    ];
    const current = [
      integration(4, 'PR: CI', 3, { conclusion: 'failure' }),
      integration(4, 'PR: CI', 9, { run_attempt: 2 }),
    ];
    const ownerJobs = (runs: ReturnType<typeof run>[]) =>
      runs
        .filter((r) => r.name === 'PR: CI')
        .map((r) =>
          job(r.id, {
            name: 'Merge-queue regression',
            health_run_key: `${r.id}:${r.run_attempt}`,
            conclusion: r.conclusion,
            status: r.conclusion == null ? 'in_progress' : 'completed',
            completed_at: r.conclusion == null ? null : at(16),
          }),
        );
    const measure = (runs: ReturnType<typeof run>[]) =>
      mergeMetrics(runs, ownerJobs(runs), {}, at(0), at(60)).regressionMinutes;
    expect(measure(historical)).toEqual({ count: 4, median: 6, p90: 8 });
    expect(measure(current)).toEqual({ count: 2, median: 9, p90: 9 });
    const renamed = current.map((r) => ({
      ...r,
      name: 'Source verification',
      path: '.github/workflows/ci.yml',
    }));
    expect(
      mergeMetrics(renamed, ownerJobs(current), {}, at(0), at(60))
        .regressionMinutes,
    ).toEqual({ count: 2, median: 9, p90: 9 });
    expect(
      mergeMetrics(
        renamed.map((r) => ({ ...r, path: '.github/workflows/unrelated.yml' })),
        ownerJobs(current),
        {},
        at(0),
        at(60),
      ).regressionMinutes.count,
    ).toBe(0);
    const transitional = [
      integration(5, 'PR: Merge integration', 40),
      ...current,
    ];
    expect(measure(transitional)).toEqual({ count: 2, median: 9, p90: 9 });
    expect(measure([...current, ...historical])).toEqual({
      count: 6,
      median: 6,
      p90: 9,
    });
    expect(
      measure([
        integration(6, 'PR: CI', 50, { event: 'workflow_dispatch' }),
        integration(7, 'Diagnostic: Merge integration', 55, {
          event: 'workflow_dispatch',
        }),
        ...historical,
      ]),
    ).toEqual({ count: 4, median: 6, p90: 8 });
    // An old PR: CI run without the integration job must not mask legacy timing.
    expect(
      mergeMetrics(transitional, [], {}, at(0), at(60)).regressionMinutes,
    ).toEqual({
      count: 1,
      median: 40,
      p90: 40,
    });
    // A job from a different attempt cannot establish this attempt's ownership.
    expect(
      mergeMetrics([current[0]], ownerJobs([current[1]]), {}, at(0), at(60))
        .regressionMinutes.count,
    ).toBe(0);
    for (const conclusion of ['cancelled', null]) {
      const runs = [
        integration(8, 'PR: Merge integration', 40),
        integration(9, 'PR: CI', 10, { conclusion }),
      ];
      expect(measure(runs)).toEqual({ count: 0, median: null, p90: null });
      expect(
        mergeMetrics(runs, ownerJobs(runs), {}, at(0), at(60)).groupsCancelled,
      ).toBe(conclusion === 'cancelled' ? 1 : 0);
      expect(
        buildSnapshot({ ...emptyData(), runs, jobs: ownerJobs(runs) }, options)
          .incomplete,
      ).toBe(conclusion == null);
    }
  });
  it('reports qualification recovery and actual agent attempts separately from queue churn', () => {
    const runs = ['failure', 'timed_out', 'success'].map((conclusion, i) =>
      run(i, {
        name: i === 0 ? 'Main qualification' : 'Main: Qualification',
        head_branch: 'main',
        event: 'schedule',
        conclusion,
        created_at: at(i * 10),
        updated_at: at(i * 10 + 5),
      }),
    );
    const jobs = [
      job(1, {
        steps: [
          {
            name: 'Repair collected failures once',
            started_at: at(5),
            conclusion: 'success',
          },
        ],
      }),
      job(2, {
        steps: [
          { name: 'Repair collected failures once', conclusion: 'skipped' },
        ],
      }),
    ];
    expect(qualificationMetrics(runs, jobs)).toEqual({
      runs: 3,
      failedOrIncomplete: 2,
      restoreMinutes: { count: 1, median: 25, p90: 25 },
      unresolvedEpisodeInWindow: false,
      agentInterventions: 1,
    });
    expect(
      qualificationMetrics(runs.slice(0, 2), jobs).unresolvedEpisodeInWindow,
    ).toBe(true);
    expect(
      mergeMetrics(
        [
          run(9, {
            name: 'PR: Merge integration',
            event: 'merge_group',
            conclusion: 'success',
            run_started_at: at(0),
            updated_at: at(2),
          }),
        ],
        [],
        {},
        at(0),
        at(60),
      ).regressionMinutes.count,
    ).toBe(1);
  });
  it('separates setup overhead from named test steps for sampled shard families', () => {
    const jobs = [
      'fast-checks shard 1',
      'Ordinary corpus 2',
      'Process-heavy corpus 1',
    ].map((name, i) =>
      job(i, {
        name,
        steps: [
          {
            name: 'Run focused tests',
            conclusion: 'success',
            started_at: at(8),
            completed_at: at(16),
          },
          {
            name: 'Install test dependencies',
            conclusion: 'success',
            started_at: at(6),
            completed_at: at(8),
          },
        ],
      }),
    );
    expect(shardFamily('other')).toBeNull();
    const metrics = setupMetrics(jobs);
    expect(Object.keys(metrics)).toEqual([
      'fast-checks shard',
      'ordinary corpus',
      'process-heavy corpus',
    ]);
    expect(metrics['ordinary corpus']).toEqual({
      samples: 1,
      setupMinutes: { count: 1, median: 2, p90: 2 },
      testMinutes: { count: 1, median: 8, p90: 8 },
      setupShare: 0.2,
    });
  });
  it('counts only PR merges touching review-ledger files from git log', () => {
    const log =
      '\x1efix: one (#3102)\n\nA\tdocs/learn/review-ledger/a.json\nM\tdocs/learn/review-ledger/b.json\n\x1efix: two (#3103)\n\nA\tdocs/learn/review-ledger/c.json\n\x1eautomation\n\nA\tdocs/learn/review-ledger/d.json\n\x1eother (#3104)\n\nM\tscripts/foo.mjs\n';
    expect(ledgerMetrics(log)).toEqual({
      mergesTouchingLedger: 2,
      medianFiles: 2,
      maxFiles: 2,
    });
    // Compaction merges (#3394), read from a real repository with the exact
    // log format collection uses: the archive and the notes it moved do not
    // count; the index and any note the same merge adds do.
    const root = makeTempDir('station-ci-health-ledger-');
    const run = (...args: string[]) =>
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          '-c',
          'core.hooksPath=/dev/null',
          ...args,
        ],
        { cwd: root, encoding: 'utf8', windowsHide: true },
      );
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    const note = (n: number) =>
      `docs/learn/review-ledger/notes/20261001T000000.000Z-${String(n).padStart(12, '0')}.json`;
    const land = (subject: string) => {
      run('add', '-A');
      run('commit', '-qm', subject);
    };
    run('init', '-q', '-b', 'main');
    write('docs/learn/review-ledger/ledger.json', '1\n');
    for (const n of [1, 2, 3, 4, 5]) write(note(n), `note ${n}\n`);
    land('fix: five reviews (#3401)');
    const advance = (archive: string) => {
      write('docs/learn/review-ledger/ledger.json', `${archive}\n`);
      write(
        `docs/learn/review-ledger/notes/archive/${archive.repeat(40)}.json`,
        '{}\n',
      );
    };
    advance('a');
    for (const n of [1, 2, 3]) rmSync(join(root, note(n)));
    land('docs(docs): advance the baseline (#3402)');
    advance('b');
    for (const n of [4, 5]) rmSync(join(root, note(n)));
    for (const n of [6, 7]) write(note(n), `note ${n}\n`);
    land('feat(docs): advance and review in one squash (#3403)');
    const metricsOf = (commit: string) =>
      ledgerMetrics(run('log', '-1', ...LEDGER_LOG_FORMAT, commit));
    // Ordinary review merge: the index and five added notes.
    expect(metricsOf('HEAD~2').maxFiles).toBe(6);
    // Pure compaction: the index alone.
    expect(metricsOf('HEAD~1').maxFiles).toBe(1);
    // Compaction plus two new notes: the index and the two added notes.
    expect(metricsOf('HEAD').maxFiles).toBe(3);
    expect(ledgerMetrics('')).toEqual({
      mergesTouchingLedger: 0,
      medianFiles: null,
      maxFiles: null,
    });
  });
});

describe('CI health collection bounds and command interface', () => {
  it('detects the 1000 listing cap, splits windows, and rejects an unsplittable cap', async () => {
    expect(windowDecision(999, at(0), at(60))).toEqual({ capped: false });
    const fractionalEnd = new Date(Date.parse(at(0)) + 1001).toISOString();
    expect(windowDecision(1000, at(0), fractionalEnd).windows).toEqual([
      [at(0), new Date(Date.parse(at(0)) + 1000).toISOString()],
      [new Date(Date.parse(at(0)) + 1000).toISOString(), fractionalEnd],
    ]);

    expect(windowDecision(1000, at(0), at(60)).windows).toEqual([
      [at(0), at(30)],
      [at(30), at(60)],
    ]);
    const data = await collectHealth(
      { ...options, until: new Date(Date.parse(at(0)) + 1000).toISOString() },
      async () => ({ total_count: 1000, workflow_runs: [] }),
      async () => '',
    );
    const snapshot = buildSnapshot(data, options);
    expect(snapshot.incomplete).toBe(true);
    expect(snapshot.reasons[0]).toContain('Actions listing cap (1000)');
    expect(snapshot.listingCapHits).toBe(1);
    expect(renderSnapshot(snapshot)).toContain('INCOMPLETE');
  });
  it('deduplicates split boundaries, paginates jobs and collects failed-group timelines', async () => {
    const calls: string[] = [];
    const queueRun = run(1, {
      event: 'merge_group',
      conclusion: 'failure',
      head_branch: `gh-readonly-queue/main/pr-3102-${'a'.repeat(40)}`,
    });
    const data = await collectHealth(
      options,
      async (endpoint: string) => {
        calls.push(endpoint);
        if (endpoint.includes('/actions/runs?')) {
          if (calls.length === 1)
            return { total_count: 1000, workflow_runs: [] };
          return { total_count: 1, workflow_runs: [queueRun] };
        }
        if (endpoint.includes('/jobs'))
          return { total_count: 1, jobs: [job()] };
        if (endpoint.includes('/compare/'))
          return {
            commits: [
              {
                commit: { message: 'fix: batch member (#3103)\nbody (#9999)' },
              },
            ],
          };
        if (endpoint.includes('/timeline')) return [removal, entry, merge];
        throw new Error(`Unexpected REST call ${endpoint}`);
      },
      async (_exe: string, args: string[]) =>
        args[0] === 'remote'
          ? 'git@github.com:kontourai/station.git'
          : args[0] === 'rev-parse'
            ? 'false'
            : '',
    );
    expect(data.reasons).toEqual([]);
    expect(data.capHits).toBe(1);
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0].pull_requests).toEqual([
      { number: 3102 },
      { number: 3103 },
    ]);
    expect(Object.keys(data.timelines)).toEqual(['3102', '3103']);
    expect(calls.filter((p) => p.includes('/jobs'))).toHaveLength(1);
  });
  describe('attributing a pull-request run whose pull_requests list is empty', () => {
    const branch =
      'dependabot/npm_and_yarn/runtime-and-ui-minor-patch-75d864bfe7';
    const head = (label: string, sha = 'f'.repeat(40)) => ({
      label: `kontourai:${label}`,
      ref: label,
      sha,
      repo: { full_name: 'kontourai/station' },
    });
    // Shapes captured from the GitHub REST API: PR 3085 was closed with its
    // head branch deleted, and 3553 is contained by two later stacked PRs.
    const closedPull = {
      number: 3085,
      state: 'closed',
      created_at: '2026-10-01T11:11:45Z',
      closed_at: '2026-10-02T18:12:53Z',
      merged_at: null,
      head: head(branch, '4dad606189e37f6a123c3f0b6509c8886d3ff102'),
    };
    const pullRun = (id: number, sha: string, overrides = {}) => ({
      ...run(id, {
        name: 'Secret Scan',
        event: 'pull_request',
        head_sha: sha,
        head_branch: branch,
        created_at: '2026-10-01T21:40:50Z',
        pull_requests: [],
        head_repository: {
          full_name: 'kontourai/station',
          owner: { login: 'kontourai' },
        },
        ...overrides,
      }),
    });
    async function collect(
      runs: unknown[],
      routes: { sha?: Record<string, unknown[]>; head?: unknown[] },
    ) {
      const calls: string[] = [];
      const data = await collectHealth(
        { ...options, until: '2026-10-04T00:00:00.000Z' },
        async (endpoint: string) => {
          calls.push(endpoint);
          if (endpoint.includes('/actions/runs?'))
            return { total_count: runs.length, workflow_runs: runs };
          if (endpoint.includes('/jobs')) return { total_count: 0, jobs: [] };
          const bySha = endpoint.match(/\/commits\/([^/]+)\/pulls/);
          if (bySha) return routes.sha?.[bySha[1]] ?? [];
          if (endpoint.includes('/pulls?state=all&head='))
            return routes.head ?? [];
          throw new Error(`Unexpected REST call ${endpoint}`);
        },
        async (_exe: string, args: string[]) =>
          args[0] === 'remote'
            ? 'git@github.com:kontourai/station.git'
            : args[0] === 'rev-parse'
              ? 'false'
              : '',
      );
      return { data, calls };
    }

    it('resolves an unreachable head, and the head a force-push replaced, from the branch and PR lifetime', async () => {
      const current = pullRun(1, '4dad606189e37f6a123c3f0b6509c8886d3ff102');
      const replaced = pullRun(2, '10d49bea031f8a2489951d039b3c9f3f070076bf', {
        created_at: '2026-10-01T21:40:48Z',
      });
      const { data, calls } = await collect([current, replaced], {
        head: [closedPull],
      });
      expect(data.reasons).toEqual([]);
      expect(data.runs.map((r: any) => r.pull_requests)).toEqual([
        [{ number: 3085 }],
        [{ number: 3085 }],
      ]);
      // One branch lookup serves both heads.
      expect(calls.filter((c) => c.includes('/pulls?state=all&head='))).toEqual(
        [
          `repos/kontourai/station/pulls?state=all&head=${encodeURIComponent(`kontourai:${branch}`)}&per_page=100&page=1`,
        ],
      );
    });
    it('credits only the PR whose head is the branch, not stacked PRs that contain the commit', async () => {
      const sha = '51bc37b501b4b89417de61230c976aa8de4a8fd0';
      const pairing = 'feature/32af3a2a-pairing-permissions';
      const { data } = await collect(
        [
          pullRun(1, sha, {
            head_branch: pairing,
            created_at: '2026-10-02T12:00:00Z',
          }),
        ],
        {
          sha: {
            [sha]: [
              {
                number: 3553,
                state: 'closed',
                created_at: '2026-10-01T00:00:00Z',
                closed_at: '2026-10-03T00:00:00Z',
                head: head(pairing),
              },
              {
                number: 3584,
                state: 'open',
                created_at: '2026-10-01T00:00:00Z',
                closed_at: null,
                head: head('feat/station-groups-3557'),
              },
              {
                number: 3585,
                state: 'open',
                created_at: '2026-10-01T00:00:00Z',
                closed_at: null,
                head: head('feat/personal-tokens-3557'),
              },
            ],
          },
        },
      );
      expect(data.reasons).toEqual([]);
      expect(data.runs[0].pull_requests).toEqual([{ number: 3553 }]);
    });
    it('reports the residual run when no PR had the branch before the run', async () => {
      const beforeAnyPull = pullRun(7, 'a'.repeat(40), {
        created_at: '2026-10-01T11:00:00Z',
      });
      const { data } = await collect([beforeAnyPull], { head: [closedPull] });
      expect(data.runs[0].pull_requests).toEqual([]);
      expect(data.reasons).toEqual([
        `Cannot resolve PR push: run 7 (${'a'.repeat(12)} on kontourai/station:${branch}): no pull request lists this commit or had this head branch before the run`,
      ]);
      expect(buildSnapshot(data, options).incomplete).toBe(true);
    });
    it('credits a run created seconds after its PR closed (real #3085 timestamps)', async () => {
      // CI run 37045922691 was created 3s after #3085 closed at 18:12:53Z.
      const late = pullRun(9, '4dad606189e37f6a123c3f0b6509c8886d3ff102', {
        name: 'CI',
        event: 'pull_request_target',
        created_at: '2026-10-02T18:12:56Z',
      });
      const viaBranch = await collect([late], { head: [closedPull] });
      expect(viaBranch.data.reasons).toEqual([]);
      expect(viaBranch.data.runs[0].pull_requests).toEqual([{ number: 3085 }]);
      const viaSha = await collect([late], {
        sha: { '4dad606189e37f6a123c3f0b6509c8886d3ff102': [closedPull] },
      });
      expect(viaSha.data.runs[0].pull_requests).toEqual([{ number: 3085 }]);
    });
    it('credits only the PR that owned the run when a branch name was reused', async () => {
      const sha = 'c'.repeat(40);
      const older = {
        ...closedPull,
        number: 100,
        created_at: '2026-09-01T00:00:00Z',
        closed_at: '2026-09-02T00:00:00Z',
        head: head(branch, sha),
      };
      const newer = {
        ...closedPull,
        number: 200,
        created_at: '2026-10-01T11:11:45Z',
        closed_at: null,
        state: 'open',
        head: head(branch, sha),
      };
      const { data } = await collect([pullRun(10, sha)], {
        sha: { [sha]: [older, newer] },
      });
      expect(data.runs[0].pull_requests).toEqual([{ number: 200 }]);
    });
    it('credits the latest-created PR when every candidate closed before the run', async () => {
      const sha = 'd'.repeat(40);
      const first = {
        ...closedPull,
        number: 300,
        created_at: '2026-09-01T00:00:00Z',
        closed_at: '2026-09-02T00:00:00Z',
        head: head(branch, sha),
      };
      const second = {
        ...first,
        number: 301,
        created_at: '2026-09-03T00:00:00Z',
        closed_at: '2026-10-01T21:40:00Z',
      };
      // The run lands after both closed; listed oldest first so a "first
      // candidate" pick would credit the wrong PR.
      const { data } = await collect([pullRun(11, sha)], {
        sha: { [sha]: [first, second] },
      });
      expect(data.runs[0].pull_requests).toEqual([{ number: 301 }]);
    });
    it('does not guess when the head repository is gone', async () => {
      const orphan = pullRun(8, 'b'.repeat(40), { head_repository: null });
      const { data, calls } = await collect([orphan], { head: [closedPull] });
      expect(data.reasons).toHaveLength(1);
      expect(calls.some((c) => c.includes('/pulls?state=all'))).toBe(false);
    });
  });
  it('marks rate limits and exhausted job pagination incomplete rather than complete zeroes', async () => {
    const rateLimited = await collectHealth(options, async () => {
      throw new Error('API rate limit exceeded (HTTP 403)');
    });
    expect(buildSnapshot(rateLimited, options)).toMatchObject({
      incomplete: true,
      reasons: ['API rate limit exceeded (HTTP 403)'],
    });
    const data = await collectHealth(options, async (endpoint: string) =>
      endpoint.includes('/actions/runs?')
        ? { total_count: 1, workflow_runs: [run()] }
        : { jobs: Array.from({ length: 100 }, (_, i) => job(i)) },
    );
    expect(data.reasons[0]).toContain('Pagination cap');
  });
  it.each([
    'git@github.com:otherkontourai/station.git',
    'https://github.com/otherkontourai/station',
    'https://github.com/x/kontourai/station.git',
  ])('rejects an origin with a suffix-only repo match: %s', async (origin) => {
    const data = await collectHealth(
      options,
      async () => ({ total_count: 0, workflow_runs: [] }),
      async () => origin,
    );
    expect(data.reasons).toEqual([
      'origin does not match --repo=kontourai/station; local ledger unavailable',
    ]);
  });
  it('validates time windows and explicit recording/history destinations', () => {
    expect(
      parseOptions(['--hours=6', '--json'], new Date(at(360))),
    ).toMatchObject({
      since: at(0),
      until: at(360),
      json: true,
      record: false,
    });
    expect(
      parseOptions([
        '--record',
        '--issue=3101',
        `--since=${at(0)}`,
        `--until=${at(60)}`,
      ]),
    ).toMatchObject({ record: true, issue: '3101' });
    for (const args of [
      ['--record'],
      ['--history'],
      ['--hours=0'],
      ['--since=bad'],
      [`--since=${at(0)}`, '--hours=1'],
      ['--repo=../x'],
      ['--issue=0'],
      ['--record', '--history', '--issue=3101'],
    ])
      expect(() => parseOptions(args)).toThrow();
  });
  it('refuses --record without --issue in the real CLI before collecting or posting', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/ci-health.mjs', '--record'],
      { windowsHide: true, encoding: 'utf8', timeout: 10_000 },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '--record and --history require --issue=<n>',
    );
    expect(result.stdout).toBe('');
  });
  it('renders hosted occupancy separately and never substitutes legacy total occupancy', () => {
    const snapshot = buildSnapshot(emptyData(), options);
    snapshot.capacity.concurrency.shareAtLeast18 = 1;
    snapshot.capacity.hostedConcurrency.shareAtLeast18 = 0.25;
    expect(renderSnapshot(snapshot)).toContain(
      '| Time with >=18 hosted jobs running | 25% |',
    );
    expect(renderHistory([snapshot])).toContain('| 25% |');
    const { hostedConcurrency: _hosted, ...legacyCapacity } = snapshot.capacity;
    const legacy = { ...snapshot, capacity: legacyCapacity };
    expect(renderSnapshot(legacy)).toContain(
      '| Time with >=18 hosted jobs running | unavailable (legacy snapshot) |',
    );
    expect(renderHistory([legacy])).toContain(
      '| unavailable (legacy snapshot) |',
    );
  });
  it('round-trips snapshot comments and prints key rates in chronological history', () => {
    const snapshot = buildSnapshot(emptyData(), options);
    const later = { ...snapshot, until: at(120) };
    expect(renderSnapshot(snapshot)).toContain('Jobs executed / skipped');
    const history = readHistory([
      { body: snapshotComment(later) },
      { body: 'unrelated ```json\n{}\n```' },
      { body: 'CI health bad\n```json\ninvalid\n```' },
      { body: snapshotComment(snapshot).replaceAll('\n', '\r\n') },
    ]);
    expect(history).toEqual([snapshot, later]);
    expect(renderHistory(history)).toContain(
      '| Window end | Hours | Failed groups |',
    );
    expect(renderHistory(history).indexOf(at(60))).toBeLessThan(
      renderHistory(history).indexOf(at(120)),
    );
  });
});
