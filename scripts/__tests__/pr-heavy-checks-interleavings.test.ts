import { afterEach, describe, expect, test, vi } from 'vitest';
import { decideHeavyChecks } from '../pr-heavy-checks-decision.mjs';
import {
  CHEAP_ONLY_DESCRIPTION,
  HEAVY_DEFERRED_STEP,
  HEAVY_RAN_STEP,
  reconcileSourceVerification,
} from '../source-verification-policy.mjs';

/**
 * STATION_PR_HEAVY_CHECKS=when-armed, simulated end to end over the real
 * decision and the real source policy against a fake GitHub API. The
 * invariant: a pull request never sits armed on a head whose required
 * `Source verification policy` status is `success` unless a run that ran the
 * heavy checks completed successfully on that exact head. Every other
 * required check is unchanged by the switch, so this status is the one that
 * holds the pull request.
 *
 * Publisher calls are queued per GitHub event and drained in several orders
 * (as delivered, newest first, all at the end) because the publisher waits
 * minutes for a runner and its events are not ordered.
 */

const REPOSITORY = 'kontourai/station';
const BASE = 'b'.repeat(40);
const sha = (character: string) => character.repeat(40);

type Kind = 'heavy' | 'cheap' | 'noop';
type SimRun = {
  id: number;
  head_sha: string;
  event: 'pull_request_target';
  status: 'in_progress' | 'completed';
  conclusion: string | null;
  run_attempt: number;
  run_started_at: string;
  display_title: string;
  workflow_id: 123;
  path: '.github/workflows/ci.yml';
  pull_requests: unknown[];
  kind: Kind;
  outcome: 'success' | 'failure';
};

function world(mode: string | undefined) {
  let clock = 0;
  let nextId = 100;
  const pr = {
    number: 42,
    state: 'open',
    head: {
      sha: sha('1'),
      ref: 'feature',
      repo: { id: 1, full_name: REPOSITORY },
    },
    base: { ref: 'main', sha: BASE, repo: { id: 1, full_name: REPOSITORY } },
    labels: [] as Array<{ name: string }>,
    auto_merge: null as null | Record<string, unknown>,
  };
  const runs: SimRun[] = [];
  const statuses = new Map<string, { state: string; description: string }>();
  const queue: Array<() => Promise<void>> = [];
  const violations: string[] = [];

  const jobsFor = (run: SimRun) => {
    const done = run.status === 'completed';
    const job = (
      name: string,
      conclusion: string | null,
      steps?: unknown[],
    ) => ({
      id:
        run.id * 1000 +
        [...name].reduce((sum, c, i) => sum + c.charCodeAt(0) * (i + 1), 0),
      name,
      status: conclusion === null ? 'in_progress' : 'completed',
      conclusion,
      ...(steps ? { steps } : {}),
    });
    if (run.kind === 'noop')
      return [
        'fast-checks plan',
        'fast-checks statics',
        'fast-checks',
        'Fork pull-request smoke',
      ].map((name) => job(name, 'skipped', []));
    const result = done ? run.outcome : null;
    return [
      // ci.yml: admission runs first in every same-repository source run.
      job('PR source admission', 'success'),
      job('fast-checks plan', done ? 'success' : null),
      job('fast-checks statics', done ? 'success' : null),
      job('Fork pull-request smoke', 'skipped'),
      job(
        'fast-checks',
        result,
        done
          ? [
              {
                name: 'Verify fast-checks shard receipts',
                conclusion: run.kind === 'heavy' ? 'success' : 'skipped',
              },
              {
                name: HEAVY_DEFERRED_STEP,
                conclusion: run.kind === 'cheap' ? 'success' : 'skipped',
              },
              {
                name: HEAVY_RAN_STEP,
                conclusion:
                  run.kind === 'heavy' && run.outcome === 'success'
                    ? 'success'
                    : 'skipped',
              },
            ]
          : [],
      ),
    ];
  };

  const respond = (value: unknown) =>
    new Response(JSON.stringify(value), { status: 200 });
  const fetchStub = async (url: string, options: RequestInit = {}) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(`/repos/${REPOSITORY}/`, '');
    if (options.method === 'POST') {
      const body = JSON.parse(String(options.body));
      statuses.set(path.replace('statuses/', ''), body);
      return respond({});
    }
    if (path === 'actions/workflows/ci.yml')
      return respond({
        id: 123,
        path: '.github/workflows/ci.yml',
        name: 'PR: CI',
      });
    if (parsed.pathname === `/repos/${REPOSITORY}`) return respond({ id: 1 });
    if (path === 'git/ref/heads/main')
      return respond({
        ref: 'refs/heads/main',
        object: { type: 'commit', sha: BASE },
      });
    const pulls = /^commits\/([0-9a-f]{40})\/pulls$/.exec(path);
    if (pulls) return respond([structuredClone(pr)]);
    if (path === 'actions/workflows/123/runs') {
      const selected = runs.filter(
        (run) => run.head_sha === parsed.searchParams.get('head_sha'),
      );
      return respond({ total_count: selected.length, workflow_runs: selected });
    }
    const detail = /^actions\/runs\/(\d+)(?:\/attempts\/\d+)?$/.exec(path);
    if (detail)
      return respond(runs.find((run) => run.id === Number(detail[1])));
    const jobs = /^actions\/runs\/(\d+)\/attempts\/\d+\/jobs$/.exec(path);
    if (jobs) {
      const run = runs.find((entry) => entry.id === Number(jobs[1]));
      const list = run ? jobsFor(run) : [];
      return respond({ total_count: list.length, jobs: list });
    }
    throw new Error(`unexpected route ${path}`);
  };

  /** A queued publisher event, as the workflow_run trigger would run it. */
  const publish = (run: SimRun, action: 'requested' | 'completed') => {
    // source-verification-policy.yml: `PR armed` publishes only completed,
    // and only under when-armed.
    if (
      run.display_title === 'PR armed' &&
      !(action === 'completed' && mode === 'when-armed')
    )
      return;
    queue.push(async () => {
      await reconcileSourceVerification({
        repository: REPOSITORY,
        eventName: 'workflow_run',
        event: { workflow_run: { id: run.id, head_sha: run.head_sha } },
        callerRunId: undefined,
        sourceSha: undefined,
        token: 'fixture',
        apiUrl: 'https://api.example',
      });
    });
  };

  const check = (label: string) => {
    const status = statuses.get(pr.head.sha);
    if (pr.auto_merge && status?.state === 'success') {
      const verified = runs.some(
        (run) =>
          run.head_sha === pr.head.sha &&
          run.kind === 'heavy' &&
          run.status === 'completed' &&
          run.outcome === 'success',
      );
      if (!verified)
        violations.push(
          `${label}: armed head ${pr.head.sha.slice(0, 1)} reads success without a completed heavy run`,
        );
    }
  };

  /** GitHub creates a PR: CI run for an event and decides heavy in it. */
  const event = (action: string, attempt = 1) => {
    const payload = structuredClone(pr);
    const armedRunName =
      action === 'auto_merge_enabled' ? 'PR armed' : 'Source verification';
    // ci.yml: with the switch off, arming skips every job.
    let kind: Kind;
    if (action === 'auto_merge_enabled' && mode !== 'when-armed') kind = 'noop';
    else
      kind = decideHeavyChecks({
        mode,
        eventName: 'pull_request_target',
        action,
        runAttempt: String(attempt),
        pullRequest: payload,
        repository: REPOSITORY,
        live: structuredClone(pr),
        headVerified: statuses.get(pr.head.sha)?.state === 'success',
      }).heavy
        ? 'heavy'
        : 'cheap';
    clock += 1;
    const run: SimRun = {
      id: nextId++,
      head_sha: pr.head.sha,
      event: 'pull_request_target',
      status: kind === 'noop' ? 'completed' : 'in_progress',
      conclusion: kind === 'noop' ? 'skipped' : null,
      run_attempt: 1,
      run_started_at: new Date(Date.UTC(2026, 10, 16, 0, clock)).toISOString(),
      display_title: armedRunName,
      workflow_id: 123,
      path: '.github/workflows/ci.yml',
      pull_requests: [structuredClone(pr)],
      kind,
      outcome: 'success',
    };
    runs.push(run);
    publish(run, 'requested');
    if (kind === 'noop') publish(run, 'completed');
    return run;
  };
  const complete = (
    run: SimRun,
    outcome: 'success' | 'failure' = 'success',
  ) => {
    run.status = 'completed';
    run.outcome = outcome;
    run.conclusion = outcome;
    publish(run, 'completed');
  };
  const push = (character: string) => {
    pr.head.sha = sha(character);
    return event('synchronize');
  };
  const arm = () => {
    pr.auto_merge = { enabled_by: { login: 'author' }, merge_method: 'squash' };
    return event('auto_merge_enabled');
  };
  const disarm = () => {
    pr.auto_merge = null;
  };
  /** Runs queued publisher events; `order` models runner delay. */
  const drain = async (order: 'fifo' | 'lifo') => {
    while (queue.length) {
      const next = order === 'fifo' ? queue.shift() : queue.pop();
      await next?.();
      check(`after a ${order} publish`);
    }
  };
  return {
    pr,
    runs,
    statuses,
    violations,
    event,
    complete,
    push,
    arm,
    disarm,
    drain,
    check,
    fetchStub,
    head: () => statuses.get(pr.head.sha),
  };
}

type World = ReturnType<typeof world>;
type Step = (w: World, runs: Record<string, SimRun>) => void | Promise<void>;

/** Interleavings of question 3. `drain` marks where queued publishers run. */
const SCENARIOS: Array<[string, Array<Step | 'drain'>]> = [
  [
    'arm before any run started',
    [
      (w, r) => {
        r.push = w.event('opened');
        r.armed = w.arm();
      },
      'drain',
      (w, r) => w.complete(r.push),
      'drain',
      (w, r) => w.complete(r.armed),
      'drain',
    ],
  ],
  [
    'arm during the cheap run, armed run finishing first',
    [
      (w, r) => {
        r.push = w.push('2');
      },
      'drain',
      (w, r) => {
        r.armed = w.arm();
        w.complete(r.armed);
      },
      'drain',
      (w, r) => w.complete(r.push),
      'drain',
    ],
  ],
  [
    'arm after the cheap verdict',
    [
      (w, r) => {
        r.push = w.push('2');
        w.complete(r.push);
      },
      'drain',
      (w, r) => {
        r.armed = w.arm();
      },
      'drain',
      (w, r) => w.complete(r.armed),
      'drain',
    ],
  ],
  [
    'push after arming, before the armed run finished',
    [
      (w, r) => {
        r.push = w.push('2');
        w.complete(r.push);
        r.armed = w.arm();
      },
      'drain',
      (w, r) => {
        r.second = w.push('3');
        // The older head's armed run finishes after the new push.
        w.complete(r.armed);
      },
      'drain',
      (w, r) => w.complete(r.second),
      'drain',
    ],
  ],
  [
    'disarm and re-arm after an ejection',
    [
      (w, r) => {
        r.push = w.push('2');
        w.complete(r.push);
        r.armed = w.arm();
        w.complete(r.armed);
      },
      'drain',
      (w, r) => {
        w.disarm();
        r.rearmed = w.arm();
      },
      'drain',
      (w, r) => w.complete(r.rearmed, 'failure'),
      'drain',
    ],
  ],
  [
    'two quick pushes, then arm',
    [
      (w, r) => {
        r.first = w.push('2');
        r.second = w.push('3');
        w.complete(r.second);
      },
      'drain',
      (w, r) => {
        w.complete(r.first);
        r.armed = w.arm();
      },
      'drain',
      (w, r) => w.complete(r.armed),
      'drain',
    ],
  ],
  [
    "a superseded run's late completion after the newer head's verdict",
    [
      (w, r) => {
        r.old = w.push('2');
        w.arm();
        r.oldArmed = w.runs.at(-1) as SimRun;
        r.fresh = w.push('3');
        w.complete(r.fresh);
      },
      'drain',
      (w, r) => {
        w.complete(r.oldArmed);
        w.complete(r.old);
      },
      'drain',
    ],
  ],
];

async function play(
  mode: string | undefined,
  steps: Array<Step | 'drain'>,
  order: 'fifo' | 'lifo' | 'end',
) {
  const w = world(mode);
  vi.stubGlobal('fetch', w.fetchStub);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const runs: Record<string, SimRun> = {};
  for (const step of steps) {
    if (step === 'drain') {
      if (order !== 'end') await w.drain(order);
    } else await step(w, runs);
    w.check('after an event');
  }
  await w.drain('fifo');
  return { w, runs };
}

describe('STATION_PR_HEAVY_CHECKS=when-armed admission interleavings', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test.each(
    SCENARIOS.flatMap(([name, steps]) =>
      (['fifo', 'lifo', 'end'] as const).map(
        (order) => [name, order, steps] as const,
      ),
    ),
  )(
    '%s (publisher order %s): an armed head reads success only after its heavy run',
    async (_name, order, steps) => {
      const { w } = await play('when-armed', steps, order);
      expect(w.violations).toEqual([]);
    },
  );

  test('an unarmed head that passed the cheap checks reads pending, with the instruction', async () => {
    const { w } = await play(
      'when-armed',
      [
        ((world: World, r: Record<string, SimRun>) => {
          r.push = world.push('2');
          world.complete(r.push);
        }) as Step,
      ],
      'fifo',
    );
    expect(w.head()).toEqual({
      context: 'Source verification policy',
      state: 'pending',
      description: CHEAP_ONLY_DESCRIPTION,
    });
    expect(w.runs.map((run) => run.kind)).toEqual(['cheap']);
  });

  test('liveness: arming a cheap-only head ends verified once the armed run passes', async () => {
    const { w } = await play('when-armed', SCENARIOS[2][1], 'fifo');
    expect(w.runs.map((run) => run.kind)).toEqual(['cheap', 'heavy']);
    expect(w.head()?.state).toBe('success');
  });

  test('a re-arm on a verified head spends no heavy run and stays verified, even if its cheap run fails', async () => {
    const { w } = await play('when-armed', SCENARIOS[4][1], 'fifo');
    expect(w.runs.map((run) => run.kind)).toEqual(['cheap', 'heavy', 'cheap']);
    expect(w.head()?.state).toBe('success');
  });

  test('a newer possibly-heavy run holds a verified head pending, and its failure fails it', async () => {
    const { w } = await play(
      'when-armed',
      [
        ((world: World, r: Record<string, SimRun>) => {
          r.push = world.push('2');
          world.complete(r.push);
          r.armed = world.arm();
          world.complete(r.armed);
          // A late heavy run on the same head (a push of the same commit
          // while armed) that fails.
          r.again = world.event('reopened');
        }) as Step,
        'drain',
        ((world: World, r: Record<string, SimRun>) => {
          // A newer run that may be heavy is never assumed to pass.
          expect(world.head()?.state).toBe('pending');
          world.complete(r.again, 'failure');
        }) as Step,
      ],
      'fifo',
    );
    expect(w.runs.map((run) => run.kind)).toEqual(['cheap', 'heavy', 'heavy']);
    expect(w.head()?.state).toBe('failure');
  });

  test('a push to an armed pull request runs heavy on the new head', async () => {
    const { w } = await play('when-armed', SCENARIOS[3][1], 'fifo');
    expect(w.runs.map((run) => [run.head_sha.slice(0, 1), run.kind])).toEqual([
      ['2', 'cheap'],
      ['2', 'heavy'],
      ['3', 'heavy'],
    ]);
    expect(w.head()?.state).toBe('success');
    // The old head's late armed verdict is written to the old head only,
    // which no longer has an owner, so it never reads verified.
    expect(w.statuses.get(sha('2'))?.state).toBe('pending');
  });

  test('switch off: every push run is heavy and arming changes no status', async () => {
    const { w } = await play(undefined, SCENARIOS[2][1], 'end');
    expect(w.runs.map((run) => run.kind)).toEqual(['heavy', 'noop']);
    expect(w.head()?.state).toBe('success');
    expect(w.violations).toEqual([]);
  });

  test('switch off: a no-op arming run newer than a failed run does not hide the failure', async () => {
    const { w } = await play(
      undefined,
      [
        ((world: World, r: Record<string, SimRun>) => {
          r.push = world.push('2');
          world.complete(r.push, 'failure');
          world.arm();
        }) as Step,
      ],
      'fifo',
    );
    expect(w.head()?.state).toBe('failure');
  });
});
