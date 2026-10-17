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
  test('the manual admission-only probe joins the same FIFO without candidate execution or write authority', () => {
    const probe = readWorkflowDocuments().find(
      (workflow) =>
        workflow.file === '.github/workflows/hosted-capacity-probe.yml',
    );
    if (!probe) throw new Error('Missing admission-only probe');
    const original = structuredClone(probe.document) as {
      on: Record<string, unknown>;
      permissions: Record<string, string>;
      jobs: Record<
        string,
        {
          'timeout-minutes': number;
          steps: Array<{ run?: string; uses?: string }>;
        }
      >;
      concurrency: Record<string, unknown>;
    };
    expect(original.on).toEqual({ workflow_dispatch: null });
    expect(original.permissions).toEqual({});
    expect(Object.keys(original.jobs)).toEqual(['admission-only']);
    const job = original.jobs['admission-only'];
    expect(job['timeout-minutes']).toBe(2);
    expect(job.steps).toHaveLength(1);
    expect(job.steps[0].uses).toBeUndefined();
    expect(job.steps[0].run).toContain('"kind": "ADMISSION_ONLY"');
    expect(job.steps[0].run).toContain('time.sleep(10)');
    expect(job.steps[0].run).not.toMatch(
      /checkout|secrets|install|qualification/,
    );
    const [adapted] = legacyActionlintSources([
      { file: probe.file, document: original },
    ]);
    expect(lint(adapted.source)).toBe('');
    original.concurrency.queue = true;
    expect(() =>
      legacyActionlintSources([{ file: probe.file, document: original }]),
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
});
