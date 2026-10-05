import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  buildSnapshot,
  capacityMetrics,
  classifyReentry,
  collectHealth,
  concurrencyTimeline,
  distribution,
  groupRuns,
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
  health_run_key: '1:1',
  steps: [],
  ...overrides,
});
const run = (id = 1, overrides = {}) => ({
  id,
  run_attempt: 1,
  name: 'CI',
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
  it('reports qualification recovery and actual agent attempts separately from queue churn', () => {
    const runs = ['failure', 'timed_out', 'success'].map((conclusion, i) =>
      run(i, {
        name: 'Main qualification',
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
            name: 'Merge integration',
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
      '\x1efix: one (#3102)\n\ndocs/learn/review-ledger/a.json\ndocs/learn/review-ledger/b.json\n\x1efix: two (#3103)\ndocs/learn/review-ledger/c.json\n\x1eautomation\ndocs/learn/review-ledger/d.json\n\x1eother (#3104)\nscripts/foo.mjs\n';
    expect(ledgerMetrics(log)).toEqual({
      mergesTouchingLedger: 2,
      medianFiles: 2,
      maxFiles: 2,
    });
    // A compaction merge (#3394): the index, one archive and the loose notes it
    // moved count as the index alone, not as a 1,000-file ledger merge.
    const moved = Array.from(
      { length: 1000 },
      (_, n) =>
        `docs/learn/review-ledger/notes/20261001T000000.000Z-${String(n).padStart(12, '0')}.json`,
    );
    const compaction = `\x1edocs(docs): advance baseline (#3400)\ndocs/learn/review-ledger/ledger.json\ndocs/learn/review-ledger/notes/archive/${'a'.repeat(40)}.json\n${moved.join('\n')}\n`;
    expect(ledgerMetrics(compaction)).toEqual({
      mergesTouchingLedger: 1,
      medianFiles: 1,
      maxFiles: 1,
    });
    // An ordinary review merge still counts its notes.
    expect(
      ledgerMetrics(
        `\x1efix: review (#3401)\n${moved.slice(0, 3).join('\n')}\n`,
      ).maxFiles,
    ).toBe(3);
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
