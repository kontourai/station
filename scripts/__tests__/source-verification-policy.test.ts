import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { JSON_SCHEMA, load } from 'js-yaml';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  FAST_CHECKS_PROVISIONAL_STEP,
  reconcileSourceVerification,
} from '../source-verification-policy.mjs';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const advanced = 'c'.repeat(40);
const owner = {
  number: 42,
  state: 'open',
  base: { ref: 'main', sha: base, repo: { id: 1 } },
  head: { sha: head, ref: 'feature', repo: { id: 1 } },
};
const run = {
  id: 10,
  workflow_id: 123,
  path: '.github/workflows/ci.yml',
  head_sha: head,
  event: 'pull_request_target',
  status: 'completed',
  conclusion: 'success',
  run_attempt: 1,
  run_started_at: '2026-10-16T12:00:00Z',
  pull_requests: [owner],
};
const jobs = [
  'fast-checks plan',
  'fast-checks statics',
  'Fast checks execution',
  'Fork pull-request smoke',
].map((name, id) => ({
  id,
  name,
  status: 'completed',
  conclusion: name.startsWith('Fork') ? 'skipped' : 'success',
}));
// Observed run 38949134941: title bootstrap failed; all thirteen source jobs skipped.
const legacyMetadataJobs = [
  'PR title',
  'diff',
  'Exact full-diff classification',
  `fast-checks shard \${{ matrix.shard }}`,
  'UI entry bundle delta (report only)',
  'Repository source scans',
  'fast-checks plan',
  'fast-checks statics',
  'merge-integration-full-regression',
  "github.event_name == 'pull_request_target' && github.event.action == 'edited' && !github.event.changes.base && 'fast-checks (metadata only)' || 'fast-checks'",
  'Merge-queue regression',
  'full-regression',
  'manual-completion-diagnostics',
  'Fork pull-request smoke',
].map((name, id) => ({
  id: 117135772985 + id,
  name,
  status: 'completed',
  conclusion: id === 0 ? 'failure' : 'skipped',
}));

type Job = Omit<(typeof jobs)[number], 'conclusion'> & {
  conclusion: string | null;
};
type Run = Omit<typeof run, 'conclusion'> & {
  conclusion: string | null;
  head_branch?: string;
  name?: string;
  display_title?: string;
  referenced_workflows?: Array<{ path: string; sha: string; ref: string }>;
};

function fixture() {
  const state = {
    owners: structuredClone([owner]),
    runs: structuredClone([run]) as Run[],
    jobs: new Map<number, Job[]>([[10, structuredClone(jobs)]]),
    posts: [] as Array<{ state: string }>,
    comparison: { status: 'ahead', merge_base_commit: { sha: base } },
    error: '',
    truncate: false,
    reads: 0,
    move: false,
    metadataWorkflow: readFileSync(
      new URL('../../.github/workflows/ci.yml', import.meta.url),
      'utf8',
    ),
  };
  const execute = async (eventName = 'workflow_dispatch', dryRun = false) => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const handle = async (url: string, options: RequestInit) => {
      const parsed = new URL(url);
      const path = parsed.pathname.replace('/repos/kontourai/station/', '');
      const json = (value: unknown) =>
        new Response(JSON.stringify(value), { status: 200 });
      if (options.method === 'POST') {
        state.posts.push(JSON.parse(String(options.body)));
        return json({});
      }
      if (state.error && path.includes(state.error))
        return new Response('', { status: 503 });
      if (path === 'actions/workflows/ci.yml')
        return json({
          id: 123,
          path: '.github/workflows/ci.yml',
          name: 'PR: CI',
        });
      if (parsed.pathname === '/repos/kontourai/station')
        return json({ id: 1 });
      if (path === `commits/${head}/pulls`) {
        state.reads += 1;
        if (state.move && state.reads === 2) state.owners[0].head.ref = 'moved';
        return json(state.owners);
      }
      if (path === 'actions/workflows/123/runs')
        return json({
          total_count: state.runs.length + (state.truncate ? 1 : 0),
          workflow_runs: state.runs,
        });
      if (path === 'contents/.github/workflows/ci.yml') {
        expect(parsed.searchParams.get('ref')).toBe(base);
        return json({
          path: '.github/workflows/ci.yml',
          encoding: 'base64',
          content: Buffer.from(state.metadataWorkflow).toString('base64'),
        });
      }
      if (path.startsWith('compare/')) return json(state.comparison);
      const detail = /^actions\/runs\/(\d+)$/.exec(path);
      if (detail)
        return json(state.runs.find((entry) => entry.id === Number(detail[1])));
      const attemptRoute = /^actions\/runs\/(\d+)\/attempts\/(\d+)$/.exec(path);
      if (attemptRoute)
        return json(
          state.runs.find((entry) => entry.id === Number(attemptRoute[1])),
        );
      const jobRoute = /^actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/.exec(
        path,
      );
      if (jobRoute) {
        const selected = state.jobs.get(Number(jobRoute[1])) ?? [];
        return json({ total_count: selected.length, jobs: selected });
      }
      throw new Error(`Unexpected API route ${url}`);
    };
    const server = createServer(async (req, res) => {
      try {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const response = await handle(`http://127.0.0.1${req.url}`, {
          method: req.method,
          ...(raw ? { body: raw } : {}),
        });
        res.writeHead(response.status, { 'content-type': 'application/json' });
        res.end(await response.text());
      } catch (error) {
        res.writeHead(500);
        res.end(String(error));
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing fixture address');
      return await reconcileSourceVerification({
        repository: 'kontourai/station',
        sourceSha: head,
        callerRunId: 10,
        dryRun,
        eventName,
        event: { workflow_run: { id: 10, head_sha: head } },
        token: 'fixture',
        apiUrl: `http://127.0.0.1:${address.port}`,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  };
  const newer = (conclusion: string) => {
    state.runs.unshift({
      ...structuredClone(run),
      id: 11,
      run_started_at: '2026-10-16T12:01:00Z',
    });
    state.jobs.set(
      11,
      conclusion === 'skipped'
        ? legacyMetadataJobs.map((job) => ({
            ...job,
            conclusion: job.name === 'PR title' ? 'success' : 'skipped',
          }))
        : jobs.map((job) => ({ ...job, conclusion })),
    );
  };
  return { state, execute, newer };
}

describe('source verification reconciler API boundary', () => {
  afterEach(() => vi.restoreAllMocks());
  test('publishes exact source success, ignoring a later completed metadata suite with literal skipped name', async () => {
    const { state, execute, newer } = fixture();
    newer('skipped');
    state.jobs.get(11)?.push({
      id: 12,
      name: "github.event.action == 'edited' && 'metadata' || 'fast-checks'",
      status: 'completed',
      conclusion: 'skipped',
    });
    expect((await execute()).state).toBe('success');
    expect(state.posts).toMatchObject([
      { context: 'Source verification policy', state: 'success' },
    ]);
  });
  // #1706: a green over a plan that deferred ci-fast must not read as a
  // full run's green on the required status.
  test.each([
    {
      conclusion: 'success',
      description:
        'All exact-owner source proofs succeeded (provisional: ci-fast/test-full deferred to full qualification)',
    },
    {
      conclusion: 'skipped',
      description: 'All exact-owner source proofs succeeded',
    },
  ])(
    'a provisional marker step that finished $conclusion publishes "$description"',
    async ({ conclusion, description }) => {
      const { state, execute } = fixture();
      const aggregate = state.jobs
        .get(10)
        ?.find((job) => job.name === 'Fast checks execution');
      if (!aggregate) throw new Error('Expected the aggregate job.');
      Object.assign(aggregate, {
        steps: [
          { name: 'Verify fast-checks shard receipts', conclusion: 'success' },
          { name: FAST_CHECKS_PROVISIONAL_STEP, conclusion },
        ],
      });
      expect(await execute()).toEqual({ state: 'success', description });
      expect(state.posts).toEqual([
        {
          context: 'Source verification policy',
          state: 'success',
          description,
        },
      ]);
    },
  );
  test.each(['failure', 'cancelled', 'timed_out', 'unknown'])(
    'newer source %s prevents older success reuse',
    async (conclusion) => {
      const { execute, newer } = fixture();
      newer(conclusion);
      expect((await execute()).state).toBe(
        conclusion === 'unknown' ? 'pending' : 'failure',
      );
    },
  );
  test('missing jobs and in-progress metadata classification remain pending', async () => {
    const { state, execute, newer } = fixture();
    newer('skipped');
    state.runs[0].status = 'in_progress';
    expect((await execute()).state).toBe('pending');
    state.runs[0].status = 'completed';
    state.jobs.set(11, []);
    expect((await execute()).state).toBe('pending');
  });
  test('legacy genuine aggregate name remains accepted but duplicate producers refuse success', async () => {
    const { state, execute } = fixture();
    state.jobs.get(10)![2].name = 'fast-checks';
    expect((await execute()).state).toBe('success');
    state.jobs.get(10)!.push({ ...jobs[2], id: 99 });
    await expect(execute()).rejects.toThrow('Ambiguous');
    expect(state.posts.at(-1)?.state).toBe('pending');
  });
  test('main advancement retains valid source proof while divergence refuses it', async () => {
    const { state, execute } = fixture();
    state.owners[0].base.sha = advanced;
    expect((await execute()).state).toBe('success');
    state.comparison.status = 'diverged';
    expect((await execute()).state).toBe('pending');
  });
  test('all open main PR owners of a shared head require their own bound proof', async () => {
    const { state, execute } = fixture();
    state.owners.push({ ...structuredClone(owner), number: 43 });
    expect((await execute()).state).toBe('pending');
  });
  test('fork smoke proves only a fork owner, never a failed same-repository source lane', async () => {
    const { state, execute } = fixture();
    state.owners[0].head.repo.id = 2;
    state.runs[0].pull_requests[0].head.repo.id = 2;
    state.jobs.set(
      10,
      jobs.map((job) => ({
        ...job,
        conclusion: job.name.startsWith('Fork') ? 'success' : 'skipped',
      })),
    );
    expect((await execute()).state).toBe('success');
    state.owners[0].head.repo.id = 1;
    state.runs[0].pull_requests[0].head.repo.id = 1;
    expect((await execute()).state).toBe('pending');
  });
  test.each(['head', 'base', 'repo', 'event', 'path'])(
    'rejects source identity mismatch: %s',
    async (kind) => {
      const { state, execute } = fixture();
      if (kind === 'head') state.runs[0].head_sha = 'd'.repeat(40);
      if (kind === 'base') state.runs[0].pull_requests[0].base.ref = 'other';
      if (kind === 'repo') state.runs[0].pull_requests[0].head.repo.id = 2;
      if (kind === 'event') state.runs[0].event = 'push';
      if (kind === 'path') state.runs[0].path = '.github/workflows/other.yml';
      expect((await execute()).state).toBe('pending');
    },
  );
  test('rereads ownership before publishing and refuses a moved owner', async () => {
    const { state, execute } = fixture();
    state.move = true;
    expect((await execute()).state).toBe('pending');
  });
  test.each(['api', 'pagination'])(
    'unavailable %s evidence invalidates old success with pending',
    async (kind) => {
      const { state, execute } = fixture();
      if (kind === 'api') state.error = 'attempts';
      else state.truncate = true;
      await expect(execute()).rejects.toThrow();
      expect(state.posts.at(-1)?.state).toBe('pending');
    },
  );
  test('workflow lifecycle reconciles a later source completion after an earlier pending event', async () => {
    const { state, execute } = fixture();
    state.jobs.get(10)![2].status = 'in_progress';
    expect((await execute('workflow_run')).state).toBe('pending');
    state.jobs.get(10)![2].status = 'completed';
    expect((await execute('workflow_run')).state).toBe('success');
  });
  test('only an exact main queue synthetic head can use merge-group source proof', async () => {
    const { state, execute } = fixture();
    state.owners = [];
    state.runs[0].event = 'merge_group';
    state.runs[0].head_branch = 'gh-readonly-queue/main/pr-42-example';
    expect((await execute()).state).toBe('success');
    state.runs[0].head_branch = 'feature';
    expect((await execute()).state).toBe('pending');
  });
  test('source completion caller publishes before unrelated optional workflow jobs finish', async () => {
    const { state, execute } = fixture();
    state.runs[0].status = 'in_progress';
    expect((await execute('pull_request_target')).state).toBe('success');
  });
  test('a new attempt with unmaterialized source jobs cannot borrow prior-attempt success', async () => {
    const { state, execute } = fixture();
    state.runs[0].run_attempt = 2;
    state.jobs.set(10, []);
    expect((await execute('workflow_run')).state).toBe('pending');
  });
  test.each(['in_progress', 'failure'])(
    'old run ID with later rerun %s dominates a newer successful run ID',
    async (condition) => {
      const { state, execute, newer } = fixture();
      newer('success');
      const old = state.runs.find((entry) => entry.id === 10)!;
      old.run_attempt = 2;
      old.run_started_at = '2026-10-16T12:02:00Z';
      if (condition === 'in_progress')
        state.jobs.get(10)![2].status = 'in_progress';
      else state.jobs.get(10)![2].conclusion = 'failure';
      expect((await execute()).state).toBe(
        condition === 'in_progress' ? 'pending' : 'failure',
      );
    },
  );
  test('operator dry run reports evidence and would-publish state without any status writes, including error fallback', async () => {
    const { state, execute } = fixture();
    expect((await execute('workflow_dispatch', true)).state).toBe('success');
    expect(state.posts).toEqual([]);
    state.error = 'attempts';
    await expect(execute('workflow_dispatch', true)).rejects.toThrow();
    expect(state.posts).toEqual([]);
  });
  test('completed metadata recovery repairs pending from a source caller racing unmaterialized metadata jobs', async () => {
    const { state, execute, newer } = fixture();
    newer('skipped');
    state.runs[0].status = 'in_progress';
    state.jobs.set(11, []);
    expect((await execute('pull_request_target')).state).toBe('pending');
    state.runs[0].status = 'completed';
    state.jobs.set(
      11,
      legacyMetadataJobs.map((job) => ({
        ...job,
        conclusion: job.name === 'PR title' ? 'success' : 'skipped',
      })),
    );
    expect((await execute('workflow_run')).state).toBe('success');
  });
  test.each(['cancelled', 'failure'])(
    'cancelled or failed source with skipped producers cannot reuse older green: %s',
    async (conclusion) => {
      const { state, execute, newer } = fixture();
      newer('skipped');
      state.runs[0].conclusion = conclusion;
      state.jobs.get(11)![2].conclusion = conclusion;
      expect((await execute()).state).toBe('failure');
      state.jobs.set(
        11,
        state.jobs
          .get(11)!
          .filter((job) => job.name !== 'Fast checks execution'),
      );
      expect((await execute()).state).toBe('failure');
    },
  );
  test('observed failed legacy title-only metadata does not supersede genuine source success', async () => {
    const { state, execute, newer } = fixture();
    newer('skipped');
    state.runs[0].conclusion = 'failure';
    state.jobs.set(11, structuredClone(legacyMetadataJobs));
    expect((await execute()).state).toBe('success');
  });
  test.each([
    'aggregate failure',
    'aggregate cancelled',
    'aggregate missing',
    'run cancelled',
    'extra failed job',
    'unknown skipped name',
    'duplicate skipped name',
  ])(
    'legacy metadata does not fall through to old green with %s',
    async (change) => {
      const { state, execute, newer } = fixture();
      newer('skipped');
      state.runs[0].conclusion = 'failure';
      const observed = structuredClone(legacyMetadataJobs);
      const aggregate = observed[9];
      if (change === 'aggregate failure') aggregate.conclusion = 'failure';
      if (change === 'aggregate cancelled') aggregate.conclusion = 'cancelled';
      if (change === 'aggregate missing') observed.splice(9, 1);
      if (change === 'run cancelled') state.runs[0].conclusion = 'cancelled';
      if (change === 'extra failed job')
        observed.push({
          id: 900,
          name: 'source build',
          status: 'completed',
          conclusion: 'failure',
        });
      if (change === 'unknown skipped name')
        aggregate.name = 'arbitrary expression';
      if (change === 'duplicate skipped name')
        observed.push({ ...observed[1], id: 901 });
      state.jobs.set(11, observed);
      expect((await execute()).state).not.toBe('success');
    },
  );
  test.each(['pending', 'success'])(
    'observed3974 cancelled metadata between newer metadata and genuine %s source does not mask source',
    async (sourceState) => {
      const { state, execute } = fixture();
      const source = {
        ...structuredClone(run),
        id: 39477519649,
        name: 'Source verification',
        display_title: 'Source verification',
        run_started_at: '2026-10-20T18:45:23Z',
        status: sourceState === 'pending' ? 'pending' : 'completed',
        conclusion: sourceState === 'pending' ? null : 'success',
      };
      const metadata = (id: number, time: string, conclusion: string): Run => ({
        ...structuredClone(run),
        id,
        name: 'PR metadata',
        display_title: 'PR metadata',
        run_started_at: time,
        conclusion,
        referenced_workflows: [
          {
            path: `kontourai/station/.github/workflows/source-verification-policy.yml@${base}`,
            sha: base,
            ref: 'refs/heads/main',
          },
        ],
      });
      state.runs = [
        metadata(39478123910, '2026-10-20T18:49:36Z', 'success'),
        metadata(39477635301, '2026-10-20T18:46:11Z', 'cancelled'),
        source,
      ];
      state.jobs.set(
        source.id,
        jobs.map((job) => ({
          ...job,
          status:
            sourceState === 'pending' &&
            ['fast-checks statics', 'Fast checks execution'].includes(job.name)
              ? 'pending'
              : 'completed',
          conclusion:
            sourceState === 'pending' &&
            ['fast-checks statics', 'Fast checks execution'].includes(job.name)
              ? null
              : job.conclusion,
        })),
      );
      for (const item of state.runs.slice(0, 2))
        state.jobs.set(
          item.id,
          legacyMetadataJobs.map((job, index) => ({
            ...job,
            name: index === 0 ? 'PR title status publisher' : job.name,
            conclusion: index === 0 ? item.conclusion : 'skipped',
          })),
        );
      expect((await execute()).state).toBe(sourceState);
    },
  );

  test.each([
    'missing labels',
    'source label',
    'missing reference',
    'wrong reference sha',
    'untrusted ref',
    'source run-name policy',
    'source producer executed',
    'source producer cancelled',
    'title success',
    'title failure',
    'duplicate reference',
  ])(
    'cancelled metadata-like rows remain failure without trusted distinction: %s',
    async (change) => {
      const { state, execute, newer } = fixture();
      newer('skipped');
      const item = state.runs[0];
      item.status = 'completed';
      item.conclusion = 'cancelled';
      item.name = 'PR metadata';
      item.display_title = 'PR metadata';
      item.referenced_workflows = [
        {
          path: `kontourai/station/.github/workflows/source-verification-policy.yml@${base}`,
          sha: base,
          ref: 'refs/heads/main',
        },
      ];
      state.jobs.set(
        item.id,
        legacyMetadataJobs.map((job, index) => ({
          ...job,
          name: index === 0 ? 'PR title status publisher' : job.name,
          conclusion: index === 0 ? 'cancelled' : 'skipped',
        })),
      );
      if (change === 'missing labels') {
        delete item.name;
        delete item.display_title;
      }
      if (change === 'source label') item.display_title = 'Source verification';
      if (change === 'missing reference') item.referenced_workflows = [];
      if (change === 'wrong reference sha')
        item.referenced_workflows[0].sha = advanced;
      if (change === 'untrusted ref')
        item.referenced_workflows[0].ref = 'refs/heads/feature';
      if (change === 'source run-name policy')
        state.metadataWorkflow =
          'name: "PR: CI"\nrun-name: ${{ github.event.pull_request.title }}\n';
      if (change === 'title success' || change === 'title failure')
        state.jobs.get(item.id)![0].conclusion =
          change === 'title success' ? 'success' : 'failure';
      if (change === 'duplicate reference')
        item.referenced_workflows.push({ ...item.referenced_workflows[0] });
      if (change === 'source producer executed')
        state.jobs
          .get(item.id)!
          .find((job) => job.name === 'fast-checks plan')!.conclusion =
          'success';
      if (change === 'source producer cancelled')
        state.jobs
          .get(item.id)!
          .find((job) => job.name === 'fast-checks plan')!.conclusion =
          'cancelled';
      expect((await execute()).state).toBe('failure');
    },
  );

  test('binds metadata to its actual referenced workflow after GitHub advances the reported PR base', async () => {
    const { state, execute, newer } = fixture();
    newer('skipped');
    state.owners[0].base.sha = advanced;
    state.runs[0].pull_requests[0].base.sha = advanced;
    const item = state.runs[0];
    item.conclusion = 'cancelled';
    item.name = 'PR metadata';
    item.display_title = 'PR metadata';
    item.referenced_workflows = [
      {
        path: `kontourai/station/.github/workflows/source-verification-policy.yml@${base}`,
        sha: base,
        ref: 'refs/heads/main',
      },
    ];
    state.jobs.get(item.id)![0].conclusion = 'cancelled';
    expect((await execute()).state).toBe('success');
    state.comparison.status = 'diverged';
    expect((await execute()).state).toBe('failure');
  });

  test('unavailable immutable metadata policy cannot reuse older green', async () => {
    const { state, execute, newer } = fixture();
    newer('skipped');
    const item = state.runs[0];
    item.conclusion = 'cancelled';
    item.name = 'PR metadata';
    item.display_title = 'PR metadata';
    item.referenced_workflows = [
      {
        path: `kontourai/station/.github/workflows/source-verification-policy.yml@${base}`,
        sha: base,
        ref: 'refs/heads/main',
      },
    ];
    state.error = 'contents/';
    await expect(execute()).rejects.toThrow('503');
    expect(state.posts.at(-1)?.state).toBe('pending');
  });

  test('completed source producers retain their proof when only the parent tail was cancelled', async () => {
    const { state, execute } = fixture();
    state.runs[0].conclusion = 'cancelled';
    expect((await execute()).state).toBe('success');
  });

  test('publisher workflow checks out only trusted policy with narrowly isolated write authority', () => {
    const workflow = load(
      readFileSync(
        new URL(
          '../../.github/workflows/source-verification-policy.yml',
          import.meta.url,
        ),
        'utf8',
      ),
      { schema: JSON_SCHEMA },
    ) as {
      on: Record<string, unknown>;
      permissions: unknown;
      concurrency: unknown;
      jobs: Record<
        string,
        {
          steps: Array<{
            uses?: string;
            run?: string;
            with?: Record<string, unknown>;
          }>;
        }
      >;
    };
    expect(workflow.permissions).toEqual({
      contents: 'read',
      actions: 'read',
      statuses: 'write',
    });
    expect(workflow.on.workflow_run).toEqual({
      workflows: ['PR: CI'],
      types: ['requested', 'in_progress', 'completed'],
    });
    const steps = workflow.jobs.reconcile.steps;
    expect(steps.filter((step) => step.run).map((step) => step.run)).toEqual([
      'node scripts/source-verification-policy.mjs',
    ]);
    expect(steps[0].with).toEqual({
      ref: `\${{ github.event_name == 'merge_group' && github.event.merge_group.base_sha || github.workflow_sha }}`,
      'persist-credentials': false,
    });
    expect(steps.some((step) => step.uses?.includes('artifact'))).toBe(false);
  });
});
