import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSON_SCHEMA, load } from 'js-yaml';
import { describe, expect, test } from 'vitest';

/**
 * #2709 re-land: the sharded fast-checks graph evaluated with GitHub's job
 * status semantics, for every event that runs it, over the real ci.yml.
 *
 * #2797 shipped a shard job whose `if` had no status function. GitHub then
 * prefixes `success()`, which is false when ANY ancestor did not succeed --
 * including one that was skipped. `classify` is skipped for every
 * pull_request_target, so on every same-repository pull request the plan
 * ran (it uses `always()`), the shards were skipped, and the required
 * aggregator failed (run 36308041839). Dispatch and merge_group run
 * `classify`, so nothing before merge showed it.
 *
 * This model is deliberately the strict reading observed on that run:
 * - an `if` with no status function (success/always/failure/cancelled) is
 *   evaluated as `success() && (if)`, and a job with no `if` as `success()`;
 * - `success()` is true only when every transitive ancestor succeeded;
 * - `failure()` is true when any transitive ancestor failed;
 * - `cancelled()` is true once the run has been cancelled;
 * - a job whose condition is false is `skipped`, and its outputs are empty.
 *
 * Cancellation is a point in time (review round): jobs that finished before
 * it keep their results; jobs running at it end `cancelled`; jobs not yet
 * started are evaluated with `cancelled()` true, so an `always()` job still
 * runs and one whose condition is now false ends `cancelled` (a reusable
 * workflow call, `uses:`, ends `skipped`, as GitHub reported on run
 * 36301149467). The three cancelled dispatch runs below replay through it.
 */

type Result = 'success' | 'failure' | 'cancelled' | 'skipped';
type Job = {
  name?: string;
  needs?: string | string[];
  if?: string;
  uses?: string;
  strategy?: { matrix?: { shard?: string | number[] } };
  concurrency?: {
    group: string;
    queue?: string;
    'cancel-in-progress': boolean;
  };
};
type Context = {
  event: string;
  action?: string;
  retarget?: boolean;
  repository: string;
  headRepository: string;
};
type State = {
  results: Map<string, Result>;
  outputs: Map<string, Record<string, string>>;
  shards: Map<string, number[]>;
};

const root = resolve(import.meta.dirname, '../..');
const REPOSITORY = 'kontourai/station';

function readJobs(
  text = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8'),
) {
  return (load(text, { schema: JSON_SCHEMA }) as { jobs: Record<string, Job> })
    .jobs;
}

function needsOf(job: Job): string[] {
  if (job.needs === undefined) return [];
  return typeof job.needs === 'string' ? [job.needs] : job.needs;
}

function ancestors(
  jobs: Record<string, Job>,
  id: string,
  seen = new Set<string>(),
) {
  for (const need of needsOf(jobs[id])) {
    if (seen.has(need)) continue;
    seen.add(need);
    ancestors(jobs, need, seen);
  }
  return seen;
}

/** The GitHub expression subset ci.yml's job conditions use. */
function evaluate(
  source: string,
  lookup: (path: string[]) => unknown,
  functions: Record<string, (...arguments_: unknown[]) => unknown>,
): unknown {
  const tokens =
    source.match(
      /\s*(?:'(?:[^']|'')*'|&&|\|\||==|!=|!|\(|\)|\[|\]|\.|[A-Za-z_][A-Za-z0-9_-]*|\S)/g,
    ) ?? [];
  const list = tokens.map((token) => token.trim()).filter(Boolean);
  let position = 0;
  const peek = () => list[position];
  const next = () => list[position++];
  const expect_ = (token: string) => {
    if (next() !== token) throw new Error(`expected ${token} in ${source}`);
  };
  const primary = (): unknown => {
    const token = next();
    if (token === undefined) throw new Error(`unexpected end of ${source}`);
    if (token === '(') {
      const value = or();
      expect_(')');
      return value;
    }
    if (token === '!') return !truthy(primary());
    if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'");
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (/^\d+$/.test(token)) return Number(token);
    if (peek() === '(') {
      next();
      const arguments_: unknown[] = [];
      while (peek() !== ')') {
        arguments_.push(or());
        if (peek() !== ',') break;
        next();
      }
      expect_(')');
      // GitHub function names are case-insensitive.
      const fn = functions[token.toLowerCase()];
      if (!fn) throw new Error(`unmodelled function ${token}() in ${source}`);
      return fn(...arguments_);
    }
    const path = [token];
    while (peek() === '.' || peek() === '[') {
      if (next() === '.') path.push(next());
      else {
        const key = next();
        expect_(']');
        path.push(key.slice(1, -1));
      }
    }
    return lookup(path);
  };
  const comparison = (): unknown => {
    const left = primary();
    if (peek() === '==' || peek() === '!=') {
      const operator = next();
      const right = primary();
      const equal = String(left ?? '') === String(right ?? '');
      return operator === '==' ? equal : !equal;
    }
    return left;
  };
  const and = (): unknown => {
    let value = comparison();
    while (peek() === '&&') {
      next();
      const right = comparison();
      value = truthy(value) ? right : value;
    }
    return value;
  };
  const or = (): unknown => {
    let value = and();
    while (peek() === '||') {
      next();
      const right = and();
      value = truthy(value) ? value : right;
    }
    return value;
  };
  const value = or();
  if (position !== list.length) throw new Error(`unparsed tail in ${source}`);
  return value;
}

function truthy(value: unknown) {
  return (
    value !== false &&
    value !== '' &&
    value !== undefined &&
    value !== null &&
    value !== 0
  );
}

/** Any status function: GitHub prefixes success() only when there is none. */
const STATUS_FUNCTION = /\b(?:success|always|failure|cancelled)\s*\(/i;
/** The ones a skipped ancestor cannot defeat; success() is not among them. */
const SKIP_TOLERANT_STATUS_FUNCTION = /\b(?:always|cancelled|failure)\s*\(/i;

/**
 * Simulates a run: jobs in dependency order, each either skipped by its
 * condition or given the scenario's outcome (default success) and outputs.
 */
function simulate(
  jobs: Record<string, Job>,
  context: Context,
  scenario: {
    outcomes?: Record<string, Result>;
    outputs?: Record<string, Record<string, string>>;
    /** Jobs that finished before the cancel, and those running at it. */
    cancel?: { before: string[]; running: string[] };
    /** A job's outcome derived from the state so far (the aggregator). */
    resolve?: (id: string, state: State) => Result | undefined;
  } = {},
): State {
  const state: State = {
    results: new Map(),
    outputs: new Map(),
    shards: new Map(),
  };
  const pending = new Set(Object.keys(jobs));
  while (pending.size) {
    const ready = [...pending].find((id) =>
      needsOf(jobs[id]).every((need) => state.results.has(need)),
    );
    if (!ready)
      throw new Error('ci.yml job graph has a cycle or a missing need');
    pending.delete(ready);
    const cancelled =
      scenario.cancel !== undefined && !scenario.cancel.before.includes(ready);
    const upstream = [...ancestors(jobs, ready)].map(
      (id) => state.results.get(id) as Result,
    );
    const functions = {
      success: () => upstream.every((result) => result === 'success'),
      always: () => true,
      failure: () => upstream.some((result) => result === 'failure'),
      cancelled: () => cancelled,
    };
    const lookup = (path: string[]) => {
      const [head, ...rest] = path;
      if (head === 'github') {
        const key = rest.join('.');
        if (key === 'event_name') return context.event;
        if (key === 'event.action') return context.action ?? 'synchronize';
        if (key === 'event.changes.base')
          return context.retarget ? { ref: { from: 'release' } } : undefined;
        if (key === 'repository') return context.repository;
        if (key === 'event.pull_request.head.repo.full_name')
          return context.event === 'pull_request_target'
            ? context.headRepository
            : undefined;
        throw new Error(`unmodelled github context ${key}`);
      }
      if (head === 'needs') {
        const [need, field, name] = rest;
        if (!needsOf(jobs[ready]).includes(need))
          throw new Error(`${ready} reads needs.${need} without needing it`);
        if (field === 'result') return state.results.get(need);
        if (field === 'outputs') return state.outputs.get(need)?.[name] ?? '';
      }
      throw new Error(`unmodelled context ${path.join('.')}`);
    };
    const raw = jobs[ready].if;
    const expression =
      raw === undefined
        ? 'success()'
        : String(raw)
            .replace(/^\$\{\{\s*/, '')
            .replace(/\s*\}\}$/, '');
    const guarded = STATUS_FUNCTION.test(expression)
      ? expression
      : `success() && (${expression})`;
    // A job running at the cancel was admitted before it.
    const running = scenario.cancel?.running.includes(ready) ?? false;
    const runs = truthy(
      evaluate(guarded, lookup, {
        ...functions,
        cancelled: () => cancelled && !running,
      }),
    );
    const result: Result = running
      ? runs
        ? 'cancelled'
        : 'skipped'
      : runs
        ? (scenario.resolve?.(ready, state) ??
          scenario.outcomes?.[ready] ??
          'success')
        : cancelled && jobs[ready].uses === undefined
          ? 'cancelled'
          : 'skipped';
    const matrix = jobs[ready].strategy?.matrix?.shard;
    if (runs && matrix !== undefined) {
      const expanded =
        typeof matrix === 'string'
          ? evaluate(
              matrix.replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, ''),
              lookup,
              { fromjson: (value) => JSON.parse(String(value)) },
            )
          : matrix;
      if (!Array.isArray(expanded))
        throw new Error('shard matrix must expand to an array');
      state.shards.set(ready, expanded);
    }
    state.results.set(ready, result);
    state.outputs.set(
      ready,
      result === 'skipped' ? {} : (scenario.outputs?.[ready] ?? {}),
    );
  }
  return state;
}

const sameRepositoryPr: Context = {
  event: 'pull_request_target',
  repository: REPOSITORY,
  headRepository: REPOSITORY,
};
const EVENTS: Array<[string, Context, Record<string, Record<string, string>>]> =
  [
    [
      'pull_request_target (same repository; classify skipped)',
      sameRepositoryPr,
      {},
    ],
    [
      'merge_group',
      { ...sameRepositoryPr, event: 'merge_group' },
      { classify: { heavy: 'false' } },
    ],
    [
      'workflow_dispatch',
      { ...sameRepositoryPr, event: 'workflow_dispatch' },
      { classify: { heavy: 'false' } },
    ],
    [
      'push (heavy)',
      { ...sameRepositoryPr, event: 'push' },
      { classify: { heavy: 'true' } },
    ],
  ];
const PARTS = ['fast-checks-plan', 'fast-checks-shard', 'fast-checks-statics'];

/** The aggregator's base-controlled shell, run against the simulated needs. */
function aggregatorPartResults(jobs: Record<string, Job>, state: State) {
  const step = (
    jobs['fast-checks'] as Job & {
      steps: Array<{ name?: string; run?: string }>;
    }
  ).steps.find(
    (candidate) =>
      candidate.name === 'Require every fast-checks part job to succeed',
  );
  const needs = Object.fromEntries(
    needsOf(jobs['fast-checks']).map((id) => [
      id,
      { result: state.results.get(id), outputs: state.outputs.get(id) },
    ]),
  );
  const result = spawnSync(
    'bash',
    ['--noprofile', '--norc', '-eo', 'pipefail', '-c', String(step?.run)],
    {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', NEEDS: JSON.stringify(needs) },
      timeout: 30_000,
      windowsHide: true,
    },
  );
  return result.status;
}

describe('fast-checks under GitHub job-status semantics (#2709 re-land)', () => {
  const jobs = readJobs();

  test('the model reproduces the #2797 failure on its shard condition', () => {
    // The shipped condition, evaluated by this model: shards skipped on a
    // same-repository pull request although the plan succeeded. If this ever
    // stops failing, the model no longer encodes the trap it guards.
    const shipped = {
      ...jobs,
      'fast-checks-shard': {
        ...jobs['fast-checks-shard'],
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
        if: "${{ needs.fast-checks-plan.outputs.legacy == 'false' }}",
      },
    };
    const state = simulate(shipped, sameRepositoryPr, {
      outputs: { 'fast-checks-plan': { legacy: 'false' } },
    });
    expect(state.results.get('classify')).toBe('skipped');
    expect(state.results.get('fast-checks-plan')).toBe('success');
    expect(state.results.get('fast-checks-shard')).toBe('skipped');
    expect(aggregatorPartResults(shipped, state)).toBe(1);
  });

  test.each(EVENTS)(
    '%s: a planned (legacy=false) run executes the shards and the aggregator passes',
    (_name, context, outputs) => {
      const state = simulate(jobs, context, {
        outputs: { ...outputs, 'fast-checks-plan': { legacy: 'false' } },
      });
      for (const part of PARTS)
        expect(state.results.get(part), part).toBe('success');
      expect(state.results.get('fast-checks')).toBe('success');
      expect(state.shards.get('fast-checks-shard')).toEqual([1, 2, 3, 4]);
      expect(aggregatorPartResults(jobs, state)).toBe(0);
    },
  );

  test('empty selections allocate no shard runner while retaining a required verdict', () => {
    const state = simulate(jobs, sameRepositoryPr, {
      outputs: {
        'fast-checks-plan': {
          legacy: 'false',
          empty: 'true',
          shards: '[1]',
          'shard-count': '1',
        },
      },
    });
    expect(state.results.get('fast-checks-shard')).toBe('skipped');
    expect(state.shards.has('fast-checks-shard')).toBe(false);
    expect(aggregatorPartResults(jobs, state)).toBe(0);
    const failed = simulate(jobs, sameRepositoryPr, {
      outputs: { 'fast-checks-plan': { legacy: 'false', empty: 'true' } },
      outcomes: { 'fast-checks-plan': 'failure' },
    });
    expect(aggregatorPartResults(jobs, failed)).toBe(1);
  });

  test.each([1, 2, 4])(
    'the base verdict accepts %i planned legs on PRs and merge groups',
    (count) => {
      for (const context of [
        sameRepositoryPr,
        { ...sameRepositoryPr, event: 'merge_group' },
      ]) {
        const state = simulate(jobs, context, {
          outputs: {
            'fast-checks-plan': {
              legacy: 'false',
              shards: JSON.stringify(
                Array.from({ length: count }, (_, i) => i + 1),
              ),
              'shard-count': String(count),
            },
          },
        });
        expect(state.shards.get('fast-checks-shard')).toEqual(
          count === 1 ? [1] : count === 2 ? [1, 2] : [1, 2, 3, 4],
        );
        expect(aggregatorPartResults(jobs, state)).toBe(0);
        const skipped = simulate(jobs, context, {
          outputs: { 'fast-checks-plan': { legacy: 'false' } },
          outcomes: { 'fast-checks-shard': 'skipped' },
        });
        expect(aggregatorPartResults(jobs, skipped)).toBe(1);
      }
    },
  );

  test.each(EVENTS)(
    '%s: a failed plan runs no shard and the aggregator still fails',
    (_name, context, outputs) => {
      // The detection step writes legacy=false before planning fails, so a
      // failed plan still carries that output: only its result can stop the
      // shards.
      const state = simulate(jobs, context, {
        outputs: { ...outputs, 'fast-checks-plan': { legacy: 'false' } },
        outcomes: { 'fast-checks-plan': 'failure' },
      });
      expect(state.results.get('fast-checks-shard')).toBe('skipped');
      // The required check still runs (it is not skipped) and fails.
      expect(state.results.get('fast-checks')).not.toBe('skipped');
      expect(aggregatorPartResults(jobs, state)).toBe(1);
    },
  );

  test.each(EVENTS)(
    '%s: a legacy candidate skips the shards and passes on the plan and statics',
    (_name, context, outputs) => {
      const state = simulate(jobs, context, {
        outputs: { ...outputs, 'fast-checks-plan': { legacy: 'true' } },
      });
      expect(state.results.get('fast-checks-shard')).toBe('skipped');
      expect(aggregatorPartResults(jobs, state)).toBe(0);
      const failedLegacy = simulate(jobs, context, {
        outputs: { ...outputs, 'fast-checks-plan': { legacy: 'true' } },
        outcomes: { 'fast-checks-plan': 'failure' },
      });
      expect(aggregatorPartResults(jobs, failedLegacy)).toBe(1);
    },
  );

  test.each(['title', 'body'])(
    'a metadata-only %s edit admits only the independent title check',
    () => {
      const state = simulate(readJobs(), {
        ...sameRepositoryPr,
        action: 'edited',
      });
      expect(
        [...state.results]
          .filter(([, result]) => result !== 'skipped')
          .map(([id]) => id),
      ).toEqual(['pr-title']);
      expect(state.shards.size).toBe(0);
    },
  );

  test('merge queue emits the independent title context without source dependencies', () => {
    const state = simulate(readJobs(), {
      ...sameRepositoryPr,
      event: 'merge_group',
    });
    expect(state.results.get('pr-title')).toBe('success');
    expect(needsOf(readJobs()['pr-title'])).toEqual([]);
  });

  test('base retarget keeps the complete source graph', () => {
    const state = simulate(
      readJobs(),
      { ...sameRepositoryPr, action: 'edited', retarget: true },
      {
        outputs: { 'fast-checks-plan': { legacy: 'false', shards: '[1]' } },
      },
    );
    for (const id of [
      ...PARTS,
      'fast-checks',
      'pr-title',
      'repo-scans',
      'ui-bundle-delta',
    ])
      expect(state.results.get(id), id).toBe('success');
  });

  test('a fork pull request runs fork-smoke and none of the fast-checks graph', () => {
    const state = simulate(jobs, {
      ...sameRepositoryPr,
      headRepository: 'someone/station',
    });
    expect(state.results.get('fork-smoke')).toBe('success');
    for (const id of [...PARTS, 'fast-checks'])
      expect(state.results.get(id), id).toBe('skipped');
  });

  test('a push that is not heavy skips the fast-checks graph', () => {
    const state = simulate(
      jobs,
      { ...sameRepositoryPr, event: 'push' },
      { outputs: { classify: { heavy: 'false' } } },
    );
    for (const id of [...PARTS, 'fast-checks'])
      expect(state.results.get(id), id).toBe('skipped');
  });

  test('dispatch reaches full-regression and its diagnostics through the aggregator', () => {
    const state = simulate(
      jobs,
      { ...sameRepositoryPr, event: 'workflow_dispatch' },
      {
        outputs: {
          classify: { heavy: 'false' },
          'fast-checks-plan': { legacy: 'false' },
        },
      },
    );
    expect(state.results.get('full-regression')).toBe('success');
    expect(state.results.get('manual-completion-diagnostics')).toBe('success');
  });

  // The three cancelled workflow_dispatch runs of #2797, replayed with their
  // real order: which jobs had finished at the cancel, which were running,
  // and each job's recorded conclusion. The aggregator's result is not
  // assumed: it comes from its real bash/jq step over the simulated needs.
  const EARLY = ['classify', 'fork-smoke', 'repo-scans', 'ui-bundle-delta'];
  const REPLAYS: Array<{
    run: string;
    outcomes?: Record<string, Result>;
    cancel: { before: string[]; running: string[] };
    expected: Record<string, Result>;
  }> = [
    {
      run: '36297788589: cancelled after fast-checks succeeded',
      cancel: {
        before: [...EARLY, ...PARTS, 'fast-checks'],
        running: ['full-regression'],
      },
      expected: {
        'fast-checks-plan': 'success',
        'fast-checks-shard': 'success',
        'fast-checks-statics': 'success',
        'fast-checks': 'success',
        'full-regression': 'cancelled',
        'manual-completion-diagnostics': 'cancelled',
      },
    },
    {
      run: '36299640497: a red shard, then cancelled',
      outcomes: { 'fast-checks-shard': 'failure' },
      cancel: {
        before: [...EARLY, ...PARTS, 'fast-checks'],
        running: ['full-regression'],
      },
      expected: {
        'fast-checks-shard': 'failure',
        'fast-checks-statics': 'success',
        'fast-checks': 'failure',
        'full-regression': 'cancelled',
        'manual-completion-diagnostics': 'cancelled',
      },
    },
    {
      run: '36301149467: cancelled mid-shard; the aggregator ran and failed',
      cancel: {
        before: [...EARLY, 'fast-checks-plan'],
        running: ['fast-checks-shard', 'fast-checks-statics'],
      },
      expected: {
        'fast-checks-plan': 'success',
        'fast-checks-shard': 'cancelled',
        'fast-checks-statics': 'cancelled',
        'fast-checks': 'failure',
        'full-regression': 'skipped',
        'manual-completion-diagnostics': 'cancelled',
      },
    },
  ];
  test.each(REPLAYS)(
    'replays dispatch run $run',
    ({ outcomes, cancel, expected }) => {
      const state = simulate(
        jobs,
        { ...sameRepositoryPr, event: 'workflow_dispatch' },
        {
          outcomes,
          cancel,
          outputs: {
            classify: { heavy: 'false' },
            'fast-checks-plan': { legacy: 'false' },
          },
          resolve: (id, current) =>
            id === 'fast-checks'
              ? aggregatorPartResults(jobs, current) === 0
                ? 'success'
                : 'failure'
              : undefined,
        },
      );
      expect(
        Object.fromEntries(
          Object.keys(expected).map((id) => [id, state.results.get(id)]),
        ),
      ).toEqual(expected);
    },
  );

  test('a cancel before the aggregator starts fails the required check closed', () => {
    // The general claim behind the replays: whatever part was cut short, the
    // aggregator still runs (always(), no !cancelled()) and fails.
    for (const running of PARTS) {
      // Parts listed before the cut-short one finished before the cancel.
      const before = [...EARLY, ...PARTS.slice(0, PARTS.indexOf(running))];
      const state = simulate(jobs, sameRepositoryPr, {
        cancel: { before, running: [running] },
        outputs: { 'fast-checks-plan': { legacy: 'false' } },
        resolve: (id, current) =>
          id === 'fast-checks'
            ? aggregatorPartResults(jobs, current) === 0
              ? 'success'
              : 'failure'
            : undefined,
      });
      expect(state.results.get('fast-checks'), running).toBe('failure');
    }
  });

  test('every job that needs another carries a status function, so no skipped ancestor silently skips it', () => {
    // The structural form of the trap, for jobs this file does not simulate
    // by name: a job with `needs` and no status function inherits
    // success() over every ancestor, and `classify` is skipped on every
    // pull_request_target.
    const exposed = Object.entries(jobs)
      .filter(([, job]) => needsOf(job).length > 0)
      .filter(
        ([, job]) => !SKIP_TOLERANT_STATUS_FUNCTION.test(String(job.if ?? '')),
      )
      .map(([id]) => id);
    expect(exposed).toEqual([]);
  });
});

describe('delivery work waits for required PR feedback', () => {
  const jobs = readJobs();
  const outputs = { 'delivery-plan': { install: 'true' } };
  test.each(['success', 'failure', 'cancelled', 'skipped'] as const)(
    'same-repository fast-checks %s controls expensive delivery work',
    (result) => {
      const state = simulate(jobs, sameRepositoryPr, {
        outcomes: { 'fast-checks': result },
        outputs,
      });
      expect(state.results.get('delivery-validation')).toBe(
        result === 'success' ? 'success' : 'skipped',
      );
    },
  );
  test('the live delivery eligibility read waits until every independent nonoptional CI job settles', () => {
    for (const id of ['repo-scans', 'ui-bundle-delta', 'pr-title']) {
      expect(needsOf(jobs['delivery-plan'])).toContain(id);
      expect(ancestors(jobs, 'delivery-plan').has(id)).toBe(true);
    }
    // Scoped skips still reach the eligibility gate; adding dependencies
    // must not inherit success() over the intentionally skipped classifier.
    const state = simulate(
      jobs,
      { ...sameRepositoryPr, headRepository: 'external/fork' },
      { outputs },
    );
    expect(state.results.get('delivery-plan')).toBe('success');
  });
  test('a successful fork smoke still admits affected delivery proof', () => {
    const state = simulate(
      jobs,
      { ...sameRepositoryPr, headRepository: 'external/fork' },
      { outputs },
    );
    expect(state.results.get('fast-checks')).toBe('skipped');
    expect(state.results.get('delivery-validation')).toBe('success');
  });
  test('metadata changes and an empty affected plan allocate no delivery workers', () => {
    expect(
      simulate(
        jobs,
        { ...sameRepositoryPr, action: 'edited' },
        { outputs },
      ).results.get('delivery-validation'),
    ).toBe('skipped');
    expect(
      simulate(jobs, sameRepositoryPr).results.get('delivery-validation'),
    ).toBe('skipped');
  });
  test('failed delivery planning does not become an empty successful result', () => {
    const state = simulate(jobs, sameRepositoryPr, {
      outcomes: { 'delivery-plan': 'failure' },
      outputs,
    });
    expect(state.results.get('delivery-plan')).toBe('failure');
    expect(state.results.get('delivery-validation')).toBe('skipped');
  });
});

describe('repository-wide PR source runner ceilings', () => {
  const jobs = readJobs();
  const sourceGroups = (
    job: Job,
    pr: number,
    shard = 1,
    event = 'pull_request_target',
    sha = 'a'.repeat(40),
  ) => {
    if (!job.concurrency) throw new Error('Missing source concurrency');
    const github = {
      event_name: event,
      ref: `refs/heads/${event}`,
      sha,
      event: {
        pull_request: {
          number: pr,
          head: { sha },
          base: { sha: 'b'.repeat(40) },
        },
      },
    };
    return evaluate(
      job.concurrency.group.slice(3, -2),
      (path) => {
        const context: Record<string, unknown> = { github, matrix: { shard } };
        let value: unknown = context;
        for (const key of path)
          value = (value as Record<string, unknown>)?.[key];
        return value;
      },
      {
        format: (pattern, ...values) =>
          String(pattern).replace(/\{(\d+)\}/g, (_match, index) =>
            String(values[Number(index)] ?? ''),
          ),
        endswith: (value, suffix) =>
          String(value).toLowerCase().endsWith(String(suffix).toLowerCase()),
      },
    );
  };
  test('25 simultaneous PRs expose exactly two statics and two shard slots, with no cancellation or pending replacement', () => {
    const statics = new Set();
    const shards = new Set();
    for (let pr = 3700; pr < 3725; pr++) {
      statics.add(sourceGroups(jobs['fast-checks-statics'], pr));
      for (const shard of [1, 2, 3, 4])
        shards.add(sourceGroups(jobs['fast-checks-shard'], pr, shard));
    }
    expect(statics.size).toBe(2);
    expect(shards.size).toBe(2);
    expect(new Set([...statics, ...shards]).size).toBe(4);
    for (const id of ['fast-checks-statics', 'fast-checks-shard']) {
      expect(jobs[id].concurrency?.queue).toBe('max');
      expect(jobs[id].concurrency?.['cancel-in-progress']).toBe(false);
    }
  });
  test('odd and even one-shard PRs use both slots; four-way plans keep every shard without cancelling siblings', () => {
    expect(sourceGroups(jobs['fast-checks-shard'], 3701)).not.toBe(
      sourceGroups(jobs['fast-checks-shard'], 3702),
    );
    const slots = [1, 2, 3, 4].map((shard) =>
      sourceGroups(jobs['fast-checks-shard'], 3701, shard),
    );
    expect(slots.filter((slot) => slot === slots[0])).toHaveLength(2);
    expect(new Set(slots).size).toBe(2);
    const state = simulate(jobs, sameRepositoryPr, {
      outputs: { 'fast-checks-plan': { legacy: 'false' } },
    });
    expect(state.shards.get('fast-checks-shard')).toEqual([1, 2, 3, 4]);
    expect(state.results.get('fast-checks')).toBe('success');
  });
  test('merge groups and diagnostics never join a PR slot or each other; source identities remain distinct', () => {
    for (const id of ['fast-checks-statics', 'fast-checks-shard']) {
      const prSlots = [
        sourceGroups(jobs[id], 3701),
        sourceGroups(jobs[id], 3702),
      ];
      const queue = sourceGroups(jobs[id], 3701, 1, 'merge_group');
      const dispatch = sourceGroups(jobs[id], 3701, 1, 'workflow_dispatch');
      expect(prSlots).not.toContain(queue);
      expect(prSlots).not.toContain(dispatch);
      expect(queue).not.toBe(dispatch);
      expect(queue).not.toBe(
        sourceGroups(jobs[id], 3701, 1, 'merge_group', 'c'.repeat(40)),
      );
    }
  });
});
