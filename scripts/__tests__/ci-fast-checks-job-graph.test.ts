import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { JSON_SCHEMA, load } from 'js-yaml';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { spawnSyncBounded } from '../lib/bounded-capture.mjs';

/**
 * #2709 re-land: the sharded fast-checks graph evaluated with GitHub's job
 * status semantics, for every event that runs it, over the real ci.yml.
 *
 * #2797 shipped a shard job whose `if` had no status function. GitHub then
 * prefixes `success()`, which is false when ANY ancestor did not succeed --
 * including one that was skipped. `classify` is skipped for every
 * pull_request_target, so on every same-repository pull request the plan
 * ran (it uses `always()`), the shards were skipped, and the required
 * aggregator failed (run 36308041839). Dispatch ran `classify` (merge
 * groups did too until it was skipped there), so nothing before merge
 * showed it.
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
    // classify is skipped on merge groups: no classifier output is supplied.
    [
      'merge_group (classify skipped)',
      { ...sameRepositoryPr, event: 'merge_group' },
      {},
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

  // Merge groups no longer wait on the classifier's runner hop: classify is
  // skipped there, and every part, the aggregator and the queue's required
  // jobs still run from their merge_group clauses alone.
  test('a merge group skips classify and still runs and aggregates every part', () => {
    const state = simulate(
      jobs,
      { ...sameRepositoryPr, event: 'merge_group' },
      {
        outputs: {
          'fast-checks-plan': { legacy: 'false', 'integration-ready': 'true' },
        },
        resolve: (id, current) =>
          id === 'fast-checks'
            ? aggregatorPartResults(jobs, current) === 0
              ? 'success'
              : 'failure'
            : undefined,
      },
    );
    expect(state.results.get('classify')).toBe('skipped');
    for (const id of [
      'actionlint-artifact',
      ...PARTS,
      'fast-checks',
      'diff',
      'merge-queue-regression',
      'source-policy',
      'pr-title',
    ])
      expect(state.results.get(id), id).toBe('success');
    expect(state.shards.get('fast-checks-shard')).toEqual([1, 2, 3, 4]);
    for (const id of ['full-regression', 'manual-completion-diagnostics'])
      expect(state.results.get(id), id).toBe('skipped');
  });

  test('pushes and dispatches still run classify', () => {
    for (const event of ['push', 'workflow_dispatch'])
      expect(
        simulate(jobs, { ...sameRepositoryPr, event }).results.get('classify'),
        event,
      ).toBe('success');
  });

  test('a deferred conflict spends no plan, shard or statics runner and fails the aggregator', () => {
    const state = simulate(jobs, sameRepositoryPr, {
      outcomes: { 'pr-admission': 'failure' },
      outputs: { 'pr-admission': { admitted: 'false' } },
    });
    expect(state.results.get('pr-admission')).toBe('failure');
    for (const part of PARTS)
      expect(state.results.get(part), part).toBe('skipped');
    expect(aggregatorPartResults(jobs, state)).toBe(1);
  });

  test.each(['failure', 'cancelled'] as const)(
    'an admission job that %s without deciding never blocks the candidate',
    (outcome) => {
      const state = simulate(jobs, sameRepositoryPr, {
        outcomes: { 'pr-admission': outcome },
        outputs: { 'fast-checks-plan': { legacy: 'false' } },
      });
      for (const part of PARTS)
        expect(state.results.get(part), part).toBe('success');
      expect(aggregatorPartResults(jobs, state)).toBe(0);
    },
  );

  test.each([
    ['merge_group', { ...sameRepositoryPr, event: 'merge_group' }],
    ['workflow_dispatch', { ...sameRepositoryPr, event: 'workflow_dispatch' }],
  ])('%s never evaluates conflict admission', (_name, context) => {
    const state = simulate(jobs, context, {
      outputs: {
        ...(context.event === 'merge_group'
          ? {}
          : { classify: { heavy: 'false' } }),
        'fast-checks-plan': { legacy: 'false' },
      },
    });
    expect(state.results.get('pr-admission')).toBe('skipped');
    expect(state.results.get('fast-checks-plan')).toBe('success');
  });

  test('a fork candidate and a metadata-only edit skip conflict admission', () => {
    for (const context of [
      { ...sameRepositoryPr, headRepository: 'someone/fork' },
      { ...sameRepositoryPr, action: 'edited' },
    ])
      expect(
        simulate(jobs, context).results.get('pr-admission'),
        JSON.stringify(context),
      ).toBe('skipped');
  });

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

  // The required `Source verification policy` status for a queue head is
  // published from inside the merge-group run once fast-checks settles,
  // instead of only by the post-run workflow_run reconcile, which waited for
  // a runner after the whole run (up to 8.4 minutes on the last context).
  test.each(['success', 'failure', 'cancelled'] as const)(
    'a merge group publishes its source status in-run after a fast-checks %s, on the queue head',
    (outcome) => {
      const state = simulate(
        jobs,
        { ...sameRepositoryPr, event: 'merge_group' },
        {
          outcomes: { 'fast-checks': outcome },
          outputs: { 'fast-checks-plan': { legacy: 'false' } },
        },
      );
      expect(state.results.get('fast-checks')).toBe(outcome);
      expect(state.results.get('source-policy')).toBe('success');
      const call = jobs['source-policy'] as Job & {
        with?: Record<string, string>;
      };
      expect(call.uses).toBe(
        './.github/workflows/source-verification-policy.yml',
      );
      const queueHead = 'd'.repeat(40);
      const github: Record<string, unknown> = {
        sha: queueHead,
        event: {
          merge_group: { head_sha: queueHead, base_sha: 'e'.repeat(40) },
        },
      };
      expect(
        evaluate(
          String(call.with?.source_sha)
            .replace(/^\$\{\{\s*/, '')
            .replace(/\s*\}\}$/, ''),
          ([head, ...rest]) => {
            if (head !== 'github') throw new Error(`unmodelled ${head}`);
            let value: unknown = github;
            for (const key of rest)
              value = (value as Record<string, unknown>)?.[key];
            return value;
          },
          {},
        ),
      ).toBe(queueHead);
    },
  );

  test('a cancelled merge-group run spends no publisher runner, while a cancelled PR run still publishes', () => {
    const cancel = {
      before: ['classify', 'pr-admission', 'actionlint-artifact', ...PARTS],
      running: ['fast-checks'],
    };
    const queue = simulate(
      jobs,
      { ...sameRepositoryPr, event: 'merge_group' },
      { cancel, outputs: { 'fast-checks-plan': { legacy: 'false' } } },
    );
    expect(queue.results.get('fast-checks')).toBe('cancelled');
    expect(queue.results.get('source-policy')).toBe('skipped');
    const pr = simulate(jobs, sameRepositoryPr, {
      cancel,
      outputs: { 'fast-checks-plan': { legacy: 'false' } },
    });
    expect(pr.results.get('source-policy')).toBe('success');
  });

  test('pushes and dispatches still publish no source status', () => {
    for (const event of ['push', 'workflow_dispatch'])
      expect(
        simulate(
          jobs,
          { ...sameRepositoryPr, event },
          { outputs: { classify: { heavy: 'true' } } },
        ).results.get('source-policy'),
        event,
      ).toBe('skipped');
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
  // The actionlint artifact (#4748) finishes before any part that consumes it
  // (shards, statics, fork-smoke). The plan does not need it, so the plan and
  // the producer may run in parallel.
  const EARLY = [
    'classify',
    'actionlint-artifact',
    'fork-smoke',
    'repo-scans',
    'ui-bundle-delta',
  ];
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

  describe('the pinned actionlint artifact handoff (#4748)', () => {
    const PRODUCER = 'actionlint-artifact';
    const ran = (state: State, id: string) =>
      !['skipped', 'cancelled'].includes(state.results.get(id) as Result);

    test.each(EVENTS)(
      '%s: the producer runs before the consumers that need it',
      (_name, context, outputs) => {
        const state = simulate(jobs, context, {
          outputs: {
            ...outputs,
            'fast-checks-plan': { legacy: 'false' },
            [PRODUCER]: { 'artifact-id': '4748' },
          },
        });
        expect(state.results.get(PRODUCER)).toBe('success');
        for (const id of ['fast-checks-shard', 'fast-checks-statics'])
          expect(state.results.get(id), id).toBe('success');
        expect(state.results.get('fork-smoke')).toBe('skipped');
        expect(aggregatorPartResults(jobs, state)).toBe(0);
      },
    );

    test.each(
      EVENTS.flatMap(([name, context, outputs]) =>
        (['failure', 'cancelled', 'skipped'] as const).map(
          (outcome) => [name, outcome, context, outputs] as const,
        ),
      ),
    )(
      '%s: a producer that ends %s admits no consumer and the aggregator fails',
      (_name, outcome, context, outputs) => {
        const state = simulate(jobs, context, {
          outputs: { ...outputs, 'fast-checks-plan': { legacy: 'false' } },
          outcomes: { [PRODUCER]: outcome },
        });
        expect(state.results.get(PRODUCER)).toBe(outcome);
        // The plan does not depend on the producer, so it still succeeds;
        // only the consumers are held back, and no consumer fetches the
        // archive itself.
        expect(state.results.get('fast-checks-plan')).toBe('success');
        for (const id of ['fast-checks-shard', 'fast-checks-statics'])
          expect(state.results.get(id), id).toBe('skipped');
        expect(state.results.get('fast-checks')).not.toBe('skipped');
        expect(aggregatorPartResults(jobs, state)).toBe(1);
      },
    );

    test('a fork pull request runs fork-smoke only after the producer, and a failed producer skips it', () => {
      const fork = { ...sameRepositoryPr, headRepository: 'someone/station' };
      const ok = simulate(jobs, fork);
      expect(ok.results.get(PRODUCER)).toBe('success');
      expect(ok.results.get('fork-smoke')).toBe('success');
      for (const outcome of ['failure', 'cancelled', 'skipped'] as const) {
        const state = simulate(jobs, fork, {
          outcomes: { [PRODUCER]: outcome },
        });
        expect(state.results.get('fork-smoke'), outcome).toBe('skipped');
      }
    });

    test.each([
      ['a same-repository pull request', sameRepositoryPr, {}, true],
      [
        'a fork pull request',
        { ...sameRepositoryPr, headRepository: 'someone/station' },
        {},
        true,
      ],
      [
        'a base retarget edit',
        { ...sameRepositoryPr, action: 'edited', retarget: true },
        {},
        true,
      ],
      [
        'a metadata-only edit',
        { ...sameRepositoryPr, action: 'edited' },
        {},
        false,
      ],
      [
        'a metadata-only edit of a fork pull request',
        {
          ...sameRepositoryPr,
          action: 'edited',
          headRepository: 'someone/station',
        },
        {},
        false,
      ],
      [
        'a merge group',
        { ...sameRepositoryPr, event: 'merge_group' },
        {},
        true,
      ],
      [
        'a manual dispatch',
        { ...sameRepositoryPr, event: 'workflow_dispatch' },
        { classify: { heavy: 'false' } },
        true,
      ],
      [
        'a heavy push',
        { ...sameRepositoryPr, event: 'push' },
        { classify: { heavy: 'true' } },
        true,
      ],
      [
        'a light push',
        { ...sameRepositoryPr, event: 'push' },
        { classify: { heavy: 'false' } },
        false,
      ],
    ] as Array<
      [string, Context, Record<string, Record<string, string>>, boolean]
    >)(
      'the producer runs exactly when a consumer can run: %s',
      (_name, context, outputs, expected) => {
        const state = simulate(jobs, context, {
          outputs: { ...outputs, 'fast-checks-plan': { legacy: 'false' } },
        });
        expect(ran(state, PRODUCER)).toBe(expected);
        expect(
          ran(state, 'fast-checks-statics') || ran(state, 'fork-smoke'),
        ).toBe(expected);
      },
    );

    test('a deferred merge conflict spends no producer runner either', () => {
      const state = simulate(jobs, sameRepositoryPr, {
        outcomes: { 'pr-admission': 'failure' },
        outputs: { 'pr-admission': { admitted: 'false' } },
      });
      expect(state.results.get(PRODUCER)).toBe('skipped');
    });

    test('every consumer depends on the producer and downloads only the id it outputs', () => {
      type Step = { uses?: string; with?: Record<string, unknown> };
      const parsed = (
        load(readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8'), {
          schema: JSON_SCHEMA,
        }) as { jobs: Record<string, Job & { steps: Step[] }> }
      ).jobs;
      expect(
        (parsed[PRODUCER] as unknown as { outputs: Record<string, string> })
          .outputs,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
      ).toEqual({ 'artifact-id': '${{ steps.artifact.outputs.artifact-id }}' });
      for (const id of [
        'fast-checks-shard',
        'fast-checks-statics',
        'fork-smoke',
      ]) {
        expect(needsOf(parsed[id]), id).toContain(PRODUCER);
        const downloads = parsed[id].steps.filter(
          (step) =>
            step.uses?.startsWith('actions/download-artifact@') &&
            step.with?.['artifact-ids'] !== undefined,
        );
        expect(downloads, id).toHaveLength(1);
        expect(downloads[0].with?.['artifact-ids']).toBe(
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
          '${{ needs.actionlint-artifact.outputs.artifact-id }}',
        );
      }
    });
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
  // #4365 added a third shared shard slot for odd shards of PRs ending 0-2.
  test('25 simultaneous PRs expose exactly two statics and three shard slots, with no cancellation or pending replacement', () => {
    const statics = new Set();
    const shards = new Set();
    for (let pr = 3700; pr < 3725; pr++) {
      statics.add(sourceGroups(jobs['fast-checks-statics'], pr));
      for (const shard of [1, 2, 3, 4])
        shards.add(sourceGroups(jobs['fast-checks-shard'], pr, shard));
    }
    expect(statics.size).toBe(2);
    expect(shards).toEqual(
      new Set(['ci-pr-shards-odd', 'ci-pr-shards-even', 'ci-pr-shards-third']),
    );
    expect(new Set([...statics, ...shards]).size).toBe(5);
    for (const id of ['fast-checks-statics', 'fast-checks-shard']) {
      expect(jobs[id].concurrency?.queue).toBe('max');
      expect(jobs[id].concurrency?.['cancel-in-progress']).toBe(false);
    }
  });
  test('odd and even one-shard PRs use both slots; four-way plans keep every shard without cancelling siblings', () => {
    // PRs ending 0-2 send shard 1 to the third slot; 3703/3704 keep odd/even.
    expect(sourceGroups(jobs['fast-checks-shard'], 3703)).not.toBe(
      sourceGroups(jobs['fast-checks-shard'], 3704),
    );
    expect(sourceGroups(jobs['fast-checks-shard'], 3701)).toBe(
      'ci-pr-shards-third',
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

/**
 * #4748: the actionlint handoff's shell, taken verbatim from ci.yml and run in
 * real GNU bash against real GNU sha256sum and tar. Only the network and the
 * clock are controlled: `curl` and `sleep` are stand-ins that record their
 * calls and serve a fixture archive (or fail with curl's exit 22, a missing
 * file, a flipped byte). `tar` is a recording wrapper around the host tar, so
 * "the digest is verified BEFORE tar runs" is observed, not inferred.
 */
describe('the pinned actionlint provisioning text, executed (#4748)', () => {
  type RunStep = {
    name?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, string>;
  };
  const workflowJobs = readJobs() as unknown as Record<
    string,
    Job & { steps: RunStep[] }
  >;
  const stepOf = (jobId: string, name: string) => {
    const step = workflowJobs[jobId].steps.find(
      (candidate) => candidate.name === name,
    );
    if (typeof step?.run !== 'string' && step?.with === undefined)
      throw new Error(`Expected the ${jobId} "${name}" step.`);
    return step as RunStep;
  };
  const provisioning = (jobId: string, name: string) => {
    const step = stepOf(jobId, name);
    if (typeof step.run !== 'string' || !step.env)
      throw new Error(`Expected a ${jobId} "${name}" run step with env.`);
    return { run: step.run, env: step.env };
  };
  const PRODUCER = 'actionlint-artifact';
  const PRODUCER_STEP = 'Download and verify pinned actionlint';
  const INSTALL_STEP = 'Install pinned actionlint';
  const CONSUMERS = ['fast-checks-shard', 'fast-checks-statics', 'fork-smoke'];
  const ARCHIVE = 'actionlint_1.7.12_linux_amd64.tar.gz';
  const makeTempDir = trackTempDirs();

  type Outcome = { status: number; stdout: string; stderr: string };
  /**
   * A fixture child counts only when it ran to a numeric exit: a spawn error
   * (ENOENT, a timeout, an output overflow), a signal, a missing status or a
   * shell "command not found" would otherwise read as a nonzero "denial" for a
   * negative control that never reached the behavior it names.
   */
  function settle(label: string, result: SpawnSyncReturns<string>): Outcome {
    if (result.error)
      throw new Error(
        `${label}: spawn infrastructure error ${result.error.name}: ${result.error.message}`,
      );
    if (result.signal !== null)
      throw new Error(`${label}: ended by signal ${result.signal}`);
    if (typeof result.status !== 'number')
      throw new Error(`${label}: no numeric exit status`);
    if (/command not found/.test(result.stderr))
      throw new Error(`${label}: a command was missing: ${result.stderr}`);
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  const bounded = (
    label: string,
    command: string,
    args: string[],
    options: { env?: Record<string, string> } = {},
  ) =>
    settle(
      label,
      spawnSyncBounded(command, args, {
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true,
        ...options,
      }) as SpawnSyncReturns<string>,
    );

  function sandbox() {
    const root = makeTempDir('actionlint-handoff-');
    const bin = join(root, 'bin');
    const temp = join(root, 'runner-temp');
    mkdirSync(bin);
    mkdirSync(temp);
    const githubPath = join(root, 'github-path');
    writeFileSync(githubPath, '');
    const located = bounded('locate tar', 'bash', ['-c', 'command -v tar']);
    const realTar = located.stdout.trim();
    if (located.status !== 0 || !realTar)
      throw new Error('A host tar is required for these fixtures.');
    const tool = (name: string, body: string) =>
      writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`, {
        mode: 0o755,
      });
    tool(
      'curl',
      [
        'printf "%s\\n" "$*" >> "$FAKE_CURL_LOG"',
        'echo call >> "$FAKE_CURL_COUNT"',
        'calls="$(wc -l < "$FAKE_CURL_COUNT" | tr -d " ")"',
        "out=''",
        'while [ "$#" -gt 0 ]; do case "$1" in --output) out="$2"; shift ;; esac; shift; done',
        'case "$FAKE_CURL_MODE" in',
        '  ok) cp "$FAKE_ARCHIVE" "$out" ;;',
        '  fail22) echo "curl: (22) The requested URL returned error: 504" >&2; exit 22 ;;',
        '  flaky) if [ "$calls" -le 2 ]; then echo "curl: (22) The requested URL returned error: 504" >&2; exit 22; fi; cp "$FAKE_ARCHIVE" "$out" ;;',
        '  nofile) ;;',
        '  *) echo "unknown fake curl mode" >&2; exit 99 ;;',
        'esac',
      ].join('\n'),
    );
    tool('sleep', 'echo "$*" >> "$FAKE_SLEEP_LOG"');
    tool('tar', 'echo "$*" >> "$FAKE_TAR_LOG"\nexec "$REAL_TAR" "$@"');
    const run = (
      script: string,
      env: Record<string, string>,
      extra: Record<string, string> = {},
    ) =>
      bounded(
        'workflow script',
        'bash',
        ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script],
        {
          env: {
            PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
            RUNNER_TEMP: temp,
            GITHUB_PATH: githubPath,
            GITHUB_OUTPUT: join(root, 'github-output'),
            FAKE_CURL_LOG: join(root, 'curl.log'),
            FAKE_CURL_COUNT: join(root, 'curl.count'),
            FAKE_SLEEP_LOG: join(root, 'sleep.log'),
            FAKE_TAR_LOG: join(root, 'tar.log'),
            REAL_TAR: realTar,
            ...env,
            ...extra,
          },
        },
      );
    const lines = (name: string) =>
      existsSync(join(root, name))
        ? readFileSync(join(root, name), 'utf8').split('\n').filter(Boolean)
        : [];
    return { root, temp, githubPath, run, lines };
  }

  function fixtureArchive(box: ReturnType<typeof sandbox>) {
    const src = join(box.root, 'src');
    const good = join(box.root, 'fixture');
    const flipped = join(box.root, 'fixture-flipped');
    for (const dir of [src, good, flipped]) mkdirSync(dir);
    writeFileSync(
      join(src, 'actionlint'),
      '#!/bin/sh\necho fixture actionlint\n',
      { mode: 0o755 },
    );
    const made = bounded('fixture tar', 'tar', [
      '-czf',
      join(good, ARCHIVE),
      '-C',
      src,
      'actionlint',
    ]);
    if (made.status !== 0)
      throw new Error(`fixture tar failed: ${made.stderr}`);
    const bytes = readFileSync(join(good, ARCHIVE));
    const corrupted = Buffer.from(bytes);
    corrupted[Math.floor(corrupted.length / 2)] ^= 1;
    writeFileSync(join(flipped, ARCHIVE), corrupted);
    return {
      archive: join(good, ARCHIVE),
      flipped: join(flipped, ARCHIVE),
      sha: createHash('sha256').update(bytes).digest('hex'),
    };
  }

  test('the fixtures run on GNU sha256sum and GNU tar, so a host without them fails here instead of passing vacuously', () => {
    for (const [tool, banner] of [
      ['sha256sum', /GNU coreutils/],
      ['tar', /GNU tar/],
    ] as const) {
      const result = bounded(`${tool} --version`, tool, ['--version']);
      expect(result.status, tool).toBe(0);
      expect(`${result.stdout}${result.stderr}`, tool).toMatch(banner);
    }
  });

  describe('the producer download step', () => {
    const producer = provisioning(PRODUCER, PRODUCER_STEP);

    test('the uploaded path is the file the step verified', () => {
      expect(
        stepOf(PRODUCER, 'Upload verified actionlint archive').with,
      ).toMatchObject({
        path: `\${{ runner.temp }}/actionlint-download/${ARCHIVE}`,
        overwrite: false,
        'if-no-files-found': 'error',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
        name: 'pinned-actionlint-${{ github.run_id }}-${{ github.run_attempt }}',
      });
      expect(producer.env.ACTIONLINT_ARCHIVE).toBe(ARCHIVE);
    });

    test('downloads once, verifies the digest and leaves exactly the verified archive', () => {
      const box = sandbox();
      const fixture = fixtureArchive(box);
      const result = box.run(
        producer.run,
        { ...producer.env, ACTIONLINT_SHA256: fixture.sha },
        { FAKE_CURL_MODE: 'ok', FAKE_ARCHIVE: fixture.archive },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(
        readFileSync(join(box.temp, 'actionlint-download', ARCHIVE)),
      ).toEqual(readFileSync(fixture.archive));
      const [call] = box.lines('curl.log');
      expect(box.lines('curl.count')).toHaveLength(1);
      expect(call).toContain('--fail');
      expect(call).toContain('--max-time 60');
      expect(call).toContain(producer.env.ACTIONLINT_URL);
      expect(box.lines('sleep.log')).toEqual([]);
    });

    test('retries after curl exit 22 and succeeds on the third attempt', () => {
      const box = sandbox();
      const fixture = fixtureArchive(box);
      const result = box.run(
        producer.run,
        { ...producer.env, ACTIONLINT_SHA256: fixture.sha },
        { FAKE_CURL_MODE: 'flaky', FAKE_ARCHIVE: fixture.archive },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(box.lines('curl.count')).toHaveLength(3);
      expect(box.lines('sleep.log')).toEqual(['10', '15']);
    });

    test('gives up after exactly four attempts when curl keeps returning 22', () => {
      const box = sandbox();
      const fixture = fixtureArchive(box);
      const result = box.run(
        producer.run,
        { ...producer.env, ACTIONLINT_SHA256: fixture.sha },
        { FAKE_CURL_MODE: 'fail22', FAKE_ARCHIVE: fixture.archive },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('failed after 4 attempts');
      expect(box.lines('curl.count')).toHaveLength(4);
      expect(box.lines('sleep.log')).toEqual(['10', '15', '20']);
      expect(existsSync(join(box.temp, 'actionlint-download', ARCHIVE))).toBe(
        false,
      );
    });

    test.each([
      [
        'the production digest rejects an archive that is not the release',
        'ok',
        'good',
        undefined,
      ],
      ['a flipped byte in the served archive', 'ok', 'flipped', 'fixture-sha'],
      [
        'a download that reports success but writes nothing',
        'nofile',
        'good',
        'fixture-sha',
      ],
    ] as const)('rejects %s', (_name, mode, which, digest) => {
      const box = sandbox();
      const fixture = fixtureArchive(box);
      const result = box.run(
        producer.run,
        {
          ...producer.env,
          ...(digest === 'fixture-sha'
            ? { ACTIONLINT_SHA256: fixture.sha }
            : {}),
        },
        {
          FAKE_CURL_MODE: mode,
          FAKE_ARCHIVE: which === 'good' ? fixture.archive : fixture.flipped,
        },
      );
      expect(result.status).toBe(1);
      expect(box.lines('curl.count')).toHaveLength(1);
    });

    test('refuses a download directory that already exists and never calls curl', () => {
      const box = sandbox();
      const fixture = fixtureArchive(box);
      mkdirSync(join(box.temp, 'actionlint-download'));
      const result = box.run(
        producer.run,
        { ...producer.env, ACTIONLINT_SHA256: fixture.sha },
        { FAKE_CURL_MODE: 'ok', FAKE_ARCHIVE: fixture.archive },
      );
      expect(result.status).toBe(1);
      expect(box.lines('curl.count')).toEqual([]);
    });
  });

  describe('the producer artifact id validation step', () => {
    const VALIDATION_STEP = 'Validate uploaded artifact id';
    const validation = stepOf(PRODUCER, VALIDATION_STEP);
    const script = String(validation.run);
    const outputFile = (box: ReturnType<typeof sandbox>) =>
      join(box.root, 'github-output');
    const written = (box: ReturnType<typeof sandbox>) =>
      existsSync(outputFile(box)) ? readFileSync(outputFile(box), 'utf8') : '';

    test('is the only step that writes the job output, from the upload id', () => {
      const steps = workflowJobs[PRODUCER].steps as Array<
        RunStep & { id?: string }
      >;
      expect(
        steps.filter((step) => String(step.run).includes('GITHUB_OUTPUT')),
      ).toEqual([validation]);
      expect(validation.env).toEqual({
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
        UPLOADED_ARTIFACT_ID: '${{ steps.upload.outputs.artifact-id }}',
      });
      // The validation step follows the upload that produces the id.
      expect(steps.findIndex((step) => step.id === 'artifact')).toBeGreaterThan(
        steps.findIndex((step) => step.id === 'upload'),
      );
    });

    test.each(['1', '4748', '123456789012', '9007199254740993'])(
      'passes the positive integer %s through unchanged and writes nothing else',
      (id) => {
        const box = sandbox();
        const result = box.run(script, { UPLOADED_ARTIFACT_ID: id });
        expect(result.status, result.stderr).toBe(0);
        expect(written(box)).toBe(`artifact-id=${id}\n`);
      },
    );

    test.each([
      ['empty', ''],
      ['zero', '0'],
      ['a leading zero', '007'],
      ['negative', '-5'],
      ['a decimal', '1.5'],
      ['letters', '12ab'],
      ['a space', '12 34'],
      ['surrounding whitespace', ' 12 '],
      ['a newline-injected second output', '12\nartifact-id=99'],
      ['an environment-file injection', '12\nGITHUB_ENV=x'],
    ])('rejects %s and exposes no output', (_name, id) => {
      const box = sandbox();
      const result = box.run(script, { UPLOADED_ARTIFACT_ID: id });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('not a positive integer');
      expect(written(box)).toBe('');
    });

    test('control: without the validation an empty id would be exposed as a successful output', () => {
      // The harness reads the same output file; an unvalidated writer leaves a
      // present-but-empty id, the shape that makes the download action fetch
      // every artifact of the run.
      const unvalidated =
        'echo "artifact-id=$UPLOADED_ARTIFACT_ID" >> "$GITHUB_OUTPUT"';
      const box = sandbox();
      const result = box.run(unvalidated, { UPLOADED_ARTIFACT_ID: '' });
      expect(result.status).toBe(0);
      expect(written(box)).toBe('artifact-id=\n');
    });
  });

  test('all three consumers install with the same shell and the same pinned inputs', () => {
    const [first, ...rest] = CONSUMERS.map((id) =>
      provisioning(id, INSTALL_STEP),
    );
    expect(first.run).toContain('sha256sum --check --status');
    for (const other of rest) expect(other).toEqual(first);
    expect(first.env.ACTIONLINT_ARCHIVE).toBe(ARCHIVE);
    expect(first.env.ACTIONLINT_SHA256).toBe(
      provisioning(PRODUCER, PRODUCER_STEP).env.ACTIONLINT_SHA256,
    );
  });

  describe.each(CONSUMERS)('%s install step', (jobId) => {
    const install = provisioning(jobId, INSTALL_STEP);
    const place = (box: ReturnType<typeof sandbox>, source: string) => {
      const directory = join(box.temp, 'actionlint-artifact');
      mkdirSync(directory);
      copyFileSync(source, join(directory, ARCHIVE));
      return directory;
    };
    const untouched = (box: ReturnType<typeof sandbox>) => {
      expect(box.lines('tar.log')).toEqual([]);
      expect(readFileSync(box.githubPath, 'utf8')).toBe('');
    };

    test('extracts the verified archive and puts only that directory on PATH', () => {
      const box = sandbox();
      const fixture = fixtureArchive(box);
      place(box, fixture.archive);
      const result = box.run(install.run, {
        ...install.env,
        ACTIONLINT_SHA256: fixture.sha,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(box.temp, 'actionlint', 'actionlint'))).toBe(true);
      expect(readFileSync(box.githubPath, 'utf8')).toBe(
        `${join(box.temp, 'actionlint')}\n`,
      );
      expect(box.lines('tar.log')).toHaveLength(1);
      expect(box.lines('tar.log')[0]).toContain('-xzf');
      // The controlled curl wrapper is on this PATH, and the install never
      // calls it: it extracts only what the download step already provided.
      expect(box.lines('curl.count')).toEqual([]);
    });

    test.each([
      ['a flipped byte', 'flipped', 'fixture-sha'],
      ['an archive that is not the pinned release', 'good', 'production-sha'],
    ] as const)('rejects %s before tar runs', (_name, which, digest) => {
      const box = sandbox();
      const fixture = fixtureArchive(box);
      place(box, which === 'good' ? fixture.archive : fixture.flipped);
      const result = box.run(install.run, {
        ...install.env,
        ...(digest === 'fixture-sha' ? { ACTIONLINT_SHA256: fixture.sha } : {}),
      });
      expect(result.status).toBe(1);
      untouched(box);
      expect(existsSync(join(box.temp, 'actionlint'))).toBe(false);
    });

    test('rejects a missing archive before tar runs', () => {
      const box = sandbox();
      const result = box.run(install.run, install.env);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('missing from the downloaded artifact');
      untouched(box);
    });

    test('rejects an archive that is a symbolic link before tar runs', () => {
      const box = sandbox();
      const fixture = fixtureArchive(box);
      const directory = join(box.temp, 'actionlint-artifact');
      mkdirSync(directory);
      symlinkSync(fixture.archive, join(directory, ARCHIVE));
      const result = box.run(install.run, {
        ...install.env,
        ACTIONLINT_SHA256: fixture.sha,
      });
      expect(result.status).toBe(1);
      untouched(box);
    });

    test('control: the harness sees tar run when the verification is moved after it', () => {
      // Without this, "tar never ran" above could hold for a harness that
      // cannot observe tar at all. The same flipped archive, with the digest
      // check moved behind the extraction, must show tar having run.
      const verify =
        'echo "$ACTIONLINT_SHA256  $archive" | sha256sum --check --status\n';
      const tail = 'echo "$RUNNER_TEMP/actionlint" >> "$GITHUB_PATH"';
      const unsafe = install.run
        .replace(verify, '')
        .replace(tail, `${verify}${tail}`);
      expect(install.run).toContain(verify);
      expect(unsafe).not.toBe(install.run);
      const box = sandbox();
      const fixture = fixtureArchive(box);
      place(box, fixture.flipped);
      const result = box.run(unsafe, {
        ...install.env,
        ACTIONLINT_SHA256: fixture.sha,
      });
      // GNU tar's own refusal of the corrupted gzip (exit 2), or 1 from the
      // digest check that now runs after it: either way tar was observed.
      expect([1, 2]).toContain(result.status);
      expect(box.lines('tar.log')).toHaveLength(1);
    });

    test('refuses an extraction directory that already exists', () => {
      const box = sandbox();
      const fixture = fixtureArchive(box);
      place(box, fixture.archive);
      mkdirSync(join(box.temp, 'actionlint'));
      const result = box.run(install.run, {
        ...install.env,
        ACTIONLINT_SHA256: fixture.sha,
      });
      expect(result.status).toBe(1);
      untouched(box);
    });
  });
});
