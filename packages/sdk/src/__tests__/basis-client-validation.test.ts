import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  AnswerBasisRequestError,
  getAnswerBasis,
} from '../client/answer-basis.js';
import {
  getTaskBasis,
  parseStationTaskBasisCollection,
  parseTaskBasisProjection,
  TaskBasisRequestError,
} from '../client/task-basis.js';

afterEach(() => vi.unstubAllGlobals());

const projection = {
  version: 'surface.basis-projection/v1',
  answer: {
    owner: { authority: '@kontourai/thread' },
    state: 'available',
    observedAt: '2026-08-25T00:00:00.000Z',
    value: {
      ref: {
        authority: '@kontourai/thread',
        schemaVersion: '1.2.0',
        kind: 'assistant-message',
        standing: 'observed',
        threadId: 'session-a',
        messageId: 'message-a',
      },
      fact: 'answer-observed',
      observedAt: '2026-08-25T00:00:00.000Z',
    },
  },
  standing: 'execution-only',
  unresolvedReason: null,
  assessment: {
    owner: { authority: '@kontourai/surface' },
    state: 'not-captured',
    observedAt: '2026-08-25T00:00:00.000Z',
  },
  regions: {
    inputs: [],
    execution: [],
    process: [],
    outcomes: [],
    support: [],
    sources: [],
    live: [],
  },
  relationships: [],
  gaps: [],
};

describe('Surface Basis SDK boundary', () => {
  test('uses Surface parser for exact answers', async () => {
    expect(parseTaskBasisProjection(projection)).toEqual(projection);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true, data: projection }), {
            status: 200,
          }),
      ),
    );
    await expect(
      getTaskBasis('http://station.test', 'task-a', {
        answerReferenceId: 'keep-a',
      }),
    ).resolves.toEqual(projection);
  });

  test('parses a bounded Station collection without manufacturing standing', () => {
    const collection = {
      version: 'station.task-basis-collection/v4',
      taskId: 'task-a',
      answers: [{ answerReferenceId: 'reference-a', projection }],
      unassociated: [
        {
          kind: 'task-output',
          taskId: 'task-a',
          outputId: 'out-a',
          kept: true,
        },
      ],
      keptToolResults: [
        {
          referenceId: 'tool-reference-a',
          ref: {
            authority: '@kontourai/thread',
            schemaVersion: '1.2.0',
            kind: 'result',
            threadId: 'session-a',
            resultId: 'result-a',
          },
          kept: true,
          associatedAnswerReferenceIds: [],
        },
      ],
      keptGateEvaluations: [],
      gaps: [],
    };
    expect(parseStationTaskBasisCollection(collection)).toEqual(collection);
    expect(
      parseStationTaskBasisCollection({
        ...collection,
        version: 'station.task-basis-collection/v2',
      }),
    ).toBeNull();
    expect(
      parseStationTaskBasisCollection({
        ...collection,
        standing: 'execution-only',
      }),
    ).toBeNull();
  });

  test('rejects malformed or future Surface input before caching', () => {
    expect(
      parseTaskBasisProjection({ ...projection, version: 'future/v99' }),
    ).toBeNull();
    expect(
      parseTaskBasisProjection({ ...projection, standing: 'policy-met' }),
    ).toBeNull();
  });

  test('is total for hostile collection transport objects', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('hostile ownKeys');
        },
      },
    );
    expect(() => parseStationTaskBasisCollection(hostile)).not.toThrow();
    expect(parseStationTaskBasisCollection(hostile)).toBeNull();
    expect(
      parseStationTaskBasisCollection({
        version: 'station.task-basis-collection/v3',
        taskId: '\udc00',
        answers: [],
        unassociated: [],
        keptToolResults: [],
        gaps: [],
      }),
    ).toBeNull();

    let reads = 0;
    const answer = Object.defineProperties(
      {},
      {
        authority: { enumerable: true, value: '@kontourai/thread' },
        schemaVersion: { enumerable: true, value: '1.2.0' },
        kind: { enumerable: true, value: 'assistant-message' },
        standing: { enumerable: true, value: 'observed' },
        threadId: {
          enumerable: true,
          get: () => {
            reads += 1;
            return 'session-a';
          },
        },
        messageId: { enumerable: true, value: 'message-a' },
      },
    );
    expect(
      parseStationTaskBasisCollection({
        version: 'station.task-basis-collection/v3',
        taskId: 'task-a',
        answers: [],
        unassociated: [
          {
            kind: 'answer-binding',
            binding: {
              version: 'station-answer-binding/v1',
              sessionId: 'session-a',
              turnId: 'turn-a',
              answer,
            },
            kept: true,
          },
        ],
        keptToolResults: [],
        gaps: [],
      }),
    ).toBeNull();
    expect(reads).toBe(0);
  });

  test('normalizes protected Basis network and malformed-response failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('PRIVATE_URL')));
    await expect(
      getTaskBasis('http://station.test', 'task-a'),
    ).rejects.toMatchObject({
      status: 0,
    } satisfies Partial<TaskBasisRequestError>);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('not-json', { status: 200 })),
    );
    await expect(
      getAnswerBasis('http://station.test', 'session-a', 'turn-a'),
    ).rejects.toMatchObject({
      status: 0,
    } satisfies Partial<AnswerBasisRequestError>);
  });
});
