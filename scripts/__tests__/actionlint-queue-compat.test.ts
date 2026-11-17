import { load } from 'js-yaml';
import { describe, expect, test } from 'vitest';
import {
  legacyActionlintSources,
  readWorkflowDocuments,
} from '../actionlint-gate.mjs';
import { execFileSyncBounded } from '../lib/bounded-capture.mjs';

const file = '.github/workflows/delivery-validation.yml';
const document = {
  name: 'FIFO compatibility fixture',
  on: { workflow_dispatch: null },
  concurrency: {
    group: 'station-background-compute',
    queue: 'max',
    'cancel-in-progress': false,
  },
  jobs: {
    proof: { 'runs-on': 'ubuntu-22.04', steps: [{ run: 'echo proof' }] },
  },
};

function lint(source: string) {
  return execFileSyncBounded(
    'actionlint',
    ['-shellcheck=', '-pyflakes=', '-stdin-filename', file, '-'],
    {
      input: source,
      encoding: 'utf8',
      windowsHide: true,
    },
  );
}

describe('reviewed GitHub FIFO schema compatibility', () => {
  test('routes PR shards into five shared groups while retaining the three old group identities', () => {
    const ci = readWorkflowDocuments().find(
      (workflow) => workflow.file === '.github/workflows/ci.yml',
    );
    if (!ci) throw new Error('Missing CI');
    const job = (
      ci.document as {
        jobs: Record<
          string,
          {
            concurrency: {
              group: string;
              queue: string;
              'cancel-in-progress': boolean;
            };
          }
        >;
      }
    ).jobs['fast-checks-shard'];
    const expression = job.concurrency.group
      .trim()
      .replace(/^\$\{\{([\s\S]*)\}\}$/, '$1');
    const evaluate = new Function(
      'github',
      'matrix',
      'endsWith',
      'format',
      `return (${expression});`,
    );
    const format = (pattern: string, ...values: unknown[]) =>
      pattern.replace(/\{(\d+)\}/g, (_, index: string) =>
        String(values[Number(index)]),
      );
    const endsWith = (value: unknown, suffix: string) =>
      String(value).endsWith(suffix);
    const groups = new Set<string>();
    for (let number = 10; number < 20; number++) {
      for (let shard = 1; shard <= 4; shard++) {
        const github = {
          event_name: 'pull_request_target',
          event: {
            pull_request: {
              number,
              head: { sha: 'head' },
              base: { sha: 'base' },
            },
          },
          ref: 'ref',
          sha: 'sha',
        };
        const group = evaluate(github, { shard }, endsWith, format) as string;
        // Independent restatement of ci.yml's table, not read from it.
        const slot = ['even', 'odd', 'third', 'fourth', 'fifth'][
          (((number % 10) % 5) + shard - 1) % 5
        ];
        expect(group).toBe(`ci-pr-shards-${slot}`);
        groups.add(group);
      }
    }
    expect(groups).toEqual(
      new Set([
        'ci-pr-shards-odd',
        'ci-pr-shards-even',
        'ci-pr-shards-third',
        'ci-pr-shards-fourth',
        'ci-pr-shards-fifth',
      ]),
    );
    expect(job.concurrency.queue).toBe('max');
    expect(job.concurrency['cancel-in-progress']).toBe(false);
    const github = {
      event_name: 'merge_group',
      event: {
        pull_request: { number: '', head: { sha: '' }, base: { sha: '' } },
      },
      ref: 'candidate',
      sha: 'abc',
    };
    expect(evaluate(github, { shard: 1 }, endsWith, format)).toBe(
      'ci-fast-shard-1-merge_group-candidate-abc-',
    );
    const releaseBot = (login: string, repo: string) => ({
      event_name: 'pull_request_target',
      repository: 'kontourai/station',
      event: {
        pull_request: {
          number: 4097,
          user: { login },
          head: {
            sha: 'head',
            ref: 'changeset-release/main',
            repo: { full_name: repo },
          },
          base: { sha: 'base' },
        },
      },
      ref: 'ref',
      sha: 'sha',
    });
    for (let shard = 1; shard <= 4; shard++) {
      expect(
        evaluate(
          releaseBot('station-automation[bot]', 'kontourai/station'),
          { shard },
          endsWith,
          format,
        ),
      ).toBe('ci-pr-release-bot');
      expect(
        evaluate(
          releaseBot('station-automation[bot]', 'someone/station'),
          { shard },
          endsWith,
          format,
        ),
      ).toMatch(/^ci-pr-shards-(even|odd|third|fourth|fifth)$/);
      expect(
        evaluate(
          releaseBot('octocat', 'kontourai/station'),
          { shard },
          endsWith,
          format,
        ),
      ).toMatch(/^ci-pr-shards-(even|odd|third|fourth|fifth)$/);
    }
  });
  test('removes only the validated new key and preserves the original security document', () => {
    const original = structuredClone(document);
    const [adapted] = legacyActionlintSources([{ file, document: original }]);
    expect(load(adapted.source)).toEqual({
      ...document,
      concurrency: {
        group: 'station-background-compute',
        'cancel-in-progress': false,
      },
    });
    expect(original).toEqual(document);
    expect(lint(adapted.source)).toBe('');
  });
  test.each([
    ['queue value', { queue: 'single' }],
    ['dynamic queue', { queue: `\${{ inputs.queue }}` }],
    ['queue type', { queue: true }],
    ['active cancellation', { 'cancel-in-progress': true }],
    ['string cancellation', { 'cancel-in-progress': 'false' }],
    ['foreign group', { group: 'unreviewed' }],
    ['dynamic group', { group: `\${{ inputs.group }}` }],
    ['unknown concurrency key', { mystery: true }],
  ])('refuses %s instead of suppressing its lint finding', (_name, delta) => {
    expect(() =>
      legacyActionlintSources([
        {
          file,
          document: {
            ...document,
            concurrency: { ...document.concurrency, ...delta },
          },
        },
      ]),
    ).toThrow(/Unreviewed FIFO/);
  });
  test('refuses missing FIFO, unreviewed workflows and job-level queues', () => {
    expect(() =>
      legacyActionlintSources([
        { file, document: { ...document, concurrency: undefined } },
      ]),
    ).toThrow(/Unreviewed FIFO/);
    expect(() =>
      legacyActionlintSources([
        { file: '.github/workflows/other.yml', document },
      ]),
    ).toThrow(/Unreviewed FIFO/);
    expect(() =>
      legacyActionlintSources([
        {
          file,
          document: {
            ...document,
            jobs: {
              proof: {
                ...document.jobs.proof,
                concurrency: document.concurrency,
              },
            },
          },
        },
      ]),
    ).toThrow(/Unreviewed FIFO job/);
  });
  test.each([
    ['unknown job key', { mystery: true }],
    ['wrong runner type', { 'runs-on': true }],
  ])(
    'the real legacy validator still rejects %s after adaptation',
    (_name, delta) => {
      const [adapted] = legacyActionlintSources([
        {
          file,
          document: {
            ...document,
            jobs: { proof: { ...document.jobs.proof, ...delta } },
          },
        },
      ]);
      expect(() => lint(adapted.source)).toThrow();
    },
  );
  test('rejects moving required integration into the optional FIFO', () => {
    const full = readWorkflowDocuments().find(
      (workflow) => workflow.file === '.github/workflows/full-regression.yml',
    );
    if (!full) throw new Error('Missing full qualification workflow');
    const changed = structuredClone(full.document) as {
      concurrency: Record<string, unknown>;
    };
    changed.concurrency.group = 'station-background-compute';
    expect(() =>
      legacyActionlintSources([{ file: full.file, document: changed }]),
    ).toThrow(/Unreviewed FIFO/);
  });
  test.each([
    'per-PR escape',
    'active cancellation',
    'pending replacement',
    'unreviewed job queue',
  ])('refuses a PR source budget mutation: %s', (change) => {
    const ci = readWorkflowDocuments().find(
      (workflow) => workflow.file === '.github/workflows/ci.yml',
    );
    if (!ci) throw new Error('Missing CI');
    const document = structuredClone(ci.document) as {
      jobs: Record<string, { concurrency?: Record<string, unknown> }>;
    };
    const queue = document.jobs['fast-checks-statics'].concurrency;
    if (!queue) throw new Error('Missing statics FIFO');
    if (change === 'per-PR escape')
      queue.group = `ci-pr-statics-\${{ github.event.pull_request.number }}`;
    if (change === 'active cancellation') queue['cancel-in-progress'] = true;
    if (change === 'pending replacement') queue.queue = 'single';
    if (change === 'unreviewed job queue')
      document.jobs['fast-checks-plan'].concurrency = { ...queue };
    expect(() =>
      legacyActionlintSources([{ file: ci.file, document }]),
    ).toThrow(/Unreviewed/);
  });
  test('refuses an unbounded per-PR shard group even when the FIFO flags remain', () => {
    const ci = readWorkflowDocuments().find(
      (workflow) => workflow.file === '.github/workflows/ci.yml',
    );
    if (!ci) throw new Error('Missing CI');
    const document = structuredClone(ci.document) as {
      jobs: Record<string, { concurrency: Record<string, unknown> }>;
    };
    document.jobs['fast-checks-shard'].concurrency.group =
      `ci-pr-shards-\${{ github.event.pull_request.number }}`;
    expect(() =>
      legacyActionlintSources([{ file: ci.file, document }]),
    ).toThrow(/Unreviewed PR source FIFO/);
  });
});
