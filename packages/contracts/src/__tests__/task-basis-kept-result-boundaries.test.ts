import { composeBasisProjection } from '@kontourai/surface/basis';
import { expect, test } from 'vitest';
import {
  parseStationTaskBasisCollection,
  STATION_TASK_BASIS_COLLECTION_VERSION,
} from '../task-basis';
import { MAX_TASK_REFERENCES_PER_TASK } from '../task-graph';

const observedAt = '2026-08-26T00:00:00.000Z';
const resultRef = (resultId = 'result-a', threadId = 'thread-a') => ({
  authority: '@kontourai/thread' as const,
  schemaVersion: '1.2.0' as const,
  kind: 'result' as const,
  threadId,
  resultId,
});
function collection() {
  const answer = {
    authority: '@kontourai/thread',
    schemaVersion: '1.2.0',
    kind: 'assistant-message',
    standing: 'observed',
    threadId: 'thread-a',
    messageId: 'answer-a',
  } as const;
  const projection = composeBasisProjection({
    version: 'surface.basis-projection/v1',
    answer: {
      owner: { authority: '@kontourai/thread' },
      state: 'available',
      observedAt,
      value: { ref: answer, fact: 'answer-observed', observedAt },
    },
    assessment: {
      owner: { authority: '@kontourai/surface' },
      state: 'not-captured',
      observedAt,
    },
    contributions: [
      {
        owner: { authority: '@kontourai/thread' },
        state: 'available',
        observedAt,
        value: [
          {
            ref: resultRef(),
            answer,
            role: 'execution',
            context: {
              kind: 'thread-result',
              name: 'fixture-tool',
              terminalStatus: 'success',
              textParts: 1,
              truncatedParts: 0,
              omittedParts: 0,
            },
          },
        ],
      },
    ],
  });
  return {
    version: STATION_TASK_BASIS_COLLECTION_VERSION,
    taskId: 'task-a',
    answers: [{ answerReferenceId: 'answer-link-a', projection }],
    unassociated: [],
    gaps: [],
    keptToolResults: [
      {
        referenceId: 'result-link-a',
        ref: resultRef(),
        kept: true as const,
        associatedAnswerReferenceIds: ['answer-link-a'],
      },
    ],
    keptGateEvaluations: [],
  };
}

test('preserves exact identity-only curation alongside unchanged Surface execution-only standing', () => {
  const source = collection();
  const parsed = parseStationTaskBasisCollection(source);
  expect(parsed?.keptToolResults).toEqual(source.keptToolResults);
  expect(parsed?.answers[0]?.projection.standing).toBe('execution-only');
  expect(JSON.stringify(parsed?.keptToolResults)).not.toContain('fixture-tool');
});

test.each(['threadId', 'resultId'] as const)(
  'rejects a false association with a different exact %s',
  (field) => {
    const source = collection();
    source.keptToolResults[0]!.ref[field] = 'different-identity';
    expect(parseStationTaskBasisCollection(source)).toBeNull();
  },
);

test('rejects duplicate or absent associated answer identities', () => {
  for (const identities of [
    ['answer-link-a', 'answer-link-a'],
    ['not-an-available-answer'],
  ]) {
    const source = collection();
    source.keptToolResults[0]!.associatedAnswerReferenceIds = identities;
    expect(parseStationTaskBasisCollection(source)).toBeNull();
  }
});

test('unassociated kept refs do not require any available answer and honor the published 100-reference capacity', () => {
  const source = collection();
  source.answers = [];
  source.keptToolResults = Array.from(
    { length: MAX_TASK_REFERENCES_PER_TASK },
    (_, index) => ({
      referenceId: `link-${index}`,
      ref: resultRef(`result-${index}`),
      kept: true,
      associatedAnswerReferenceIds: [],
    }),
  );
  expect(parseStationTaskBasisCollection(source)?.keptToolResults).toHaveLength(
    MAX_TASK_REFERENCES_PER_TASK,
  );
  source.keptToolResults.push({
    referenceId: 'overflow',
    ref: resultRef('overflow'),
    kept: true,
    associatedAnswerReferenceIds: [],
  });
  expect(parseStationTaskBasisCollection(source)).toBeNull();
});

test.each(['referenceId', 'tuple'] as const)(
  'rejects duplicate kept %s without relying on display labels',
  (field) => {
    const source = collection();
    source.keptToolResults.push({
      referenceId: field === 'referenceId' ? 'result-link-a' : 'other-link',
      ref: field === 'tuple' ? resultRef() : resultRef('other-result'),
      kept: true,
      associatedAnswerReferenceIds: [],
    });
    expect(parseStationTaskBasisCollection(source)).toBeNull();
  },
);

test('rejects legacy or missing curation fields instead of silently reporting no kept results', () => {
  const source = collection();
  expect(
    parseStationTaskBasisCollection({
      ...source,
      version: 'station.task-basis-collection/v2',
    }),
  ).toBeNull();
  const { keptToolResults: _omitted, ...missing } = source;
  expect(parseStationTaskBasisCollection(missing)).toBeNull();
  const { keptGateEvaluations: _missingStream, ...missingStream } = source;
  expect(parseStationTaskBasisCollection(missingStream)).toBeNull();
});

test('does not execute nested projection or reference accessors while proving associations', () => {
  const source = collection();
  let reads = 0;
  const unsafe = { ...source.answers[0]!.projection };
  Object.defineProperty(unsafe, 'regions', {
    enumerable: true,
    get: () => {
      reads += 1;
      throw new Error('getter');
    },
  });
  source.answers[0]!.projection = unsafe;
  expect(parseStationTaskBasisCollection(source)).toBeNull();
  expect(reads).toBe(0);
});

test('rejects protected payload additions to the identity-only kept stream', () => {
  const source = collection();
  expect(
    parseStationTaskBasisCollection({
      ...source,
      keptToolResults: [
        {
          ...source.keptToolResults[0],
          result: { text: 'PRIVATE_PAYLOAD_CANARY' },
        },
      ],
    }),
  ).toBeNull();
});
