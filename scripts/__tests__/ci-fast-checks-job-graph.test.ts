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
 * - `cancelled()` is true only when the run was cancelled;
 * - a job whose condition is false is `skipped`, and its outputs are empty.
 */

type Result = 'success' | 'failure' | 'cancelled' | 'skipped';
type Job = { needs?: string | string[]; if?: string };
type Context = {
  event: string;
  repository: string;
  headRepository: string;
  cancelled: boolean;
};
type State = {
  results: Map<string, Result>;
  outputs: Map<string, Record<string, string>>;
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
  functions: Record<string, () => boolean>,
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
    if (peek() === '(') {
      next();
      expect_(')');
      const fn = functions[token];
      if (!fn) throw new Error(`unmodelled function ${token}() in ${source}`);
      return fn();
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

const STATUS_FUNCTION = /\b(?:success|always|failure|cancelled)\s*\(/;

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
  } = {},
): State {
  const state: State = { results: new Map(), outputs: new Map() };
  const pending = new Set(Object.keys(jobs));
  while (pending.size) {
    const ready = [...pending].find((id) =>
      needsOf(jobs[id]).every((need) => state.results.has(need)),
    );
    if (!ready)
      throw new Error('ci.yml job graph has a cycle or a missing need');
    pending.delete(ready);
    const upstream = [...ancestors(jobs, ready)].map(
      (id) => state.results.get(id) as Result,
    );
    const functions = {
      success: () => upstream.every((result) => result === 'success'),
      always: () => true,
      failure: () => upstream.some((result) => result === 'failure'),
      cancelled: () => context.cancelled,
    };
    const lookup = (path: string[]) => {
      const [head, ...rest] = path;
      if (head === 'github') {
        const key = rest.join('.');
        if (key === 'event_name') return context.event;
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
    const runs = truthy(evaluate(guarded, lookup, functions));
    const result: Result = runs
      ? (scenario.outcomes?.[ready] ?? 'success')
      : 'skipped';
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
  cancelled: false,
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
      expect(aggregatorPartResults(jobs, state)).toBe(0);
    },
  );

  test.each(EVENTS)(
    '%s: a failed plan runs no shard and the aggregator still fails',
    (_name, context, outputs) => {
      const state = simulate(jobs, context, {
        outputs,
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

  test('every job that needs another carries a status function, so no skipped ancestor silently skips it', () => {
    // The structural form of the trap, for jobs this file does not simulate
    // by name: a job with `needs` and no status function inherits
    // success() over every ancestor, and `classify` is skipped on every
    // pull_request_target.
    const exposed = Object.entries(jobs)
      .filter(([, job]) => needsOf(job).length > 0)
      .filter(([, job]) => !STATUS_FUNCTION.test(String(job.if ?? '')))
      .map(([id]) => id);
    expect(exposed).toEqual([]);
  });
});
