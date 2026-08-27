import { describe, expect, test } from 'vitest';
import {
  createStationAnswerBinding,
  isStationBasisId,
  parseStationAnswerBinding,
  parseStationTaskBasisCollection,
} from '../task-basis.js';

describe('Station Basis host parsers', () => {
  test('accepts bounded well-formed unicode ids without normalizing them', () => {
    const binding = createStationAnswerBinding({
      sessionId: '会話',
      turnId: 'turn-🧪',
      messageId: 'message-🧪',
    });
    expect(parseStationAnswerBinding(binding)).toEqual(binding);
    expect(
      parseStationTaskBasisCollection({
        version: 'station.task-basis-collection/v4',
        taskId: 'task-🧪',
        answers: [],
        unassociated: [{ kind: 'answer-binding', binding, kept: true }],
        keptToolResults: [],
        keptGateEvaluations: [],
        gaps: [{ state: 'restricted' }],
      }),
    ).toMatchObject({ taskId: 'task-🧪' });
  });

  test('is total for getters, proxies, malformed shapes, and oversize ids', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('do not inspect me');
        },
      },
    );
    expect(() => parseStationAnswerBinding(hostile)).not.toThrow();
    expect(parseStationAnswerBinding(hostile)).toBeNull();
    expect(() => parseStationTaskBasisCollection(hostile)).not.toThrow();
    expect(parseStationTaskBasisCollection(hostile)).toBeNull();
    expect(
      parseStationAnswerBinding({
        version: 'station-answer-binding/v1',
        sessionId: '🧪'.repeat(300),
        turnId: 'turn',
        answer: {},
      }),
    ).toBeNull();
    expect(
      parseStationTaskBasisCollection({
        version: 'station.task-basis-collection/v4',
        taskId: 'task',
        answers: [],
        unassociated: [],
        keptToolResults: [],
        keptGateEvaluations: [],
        gaps: [{ state: 'restricted', leaked: 'nope' }],
      }),
    ).toBeNull();
  });

  test('never executes accessors and rejects lone surrogates at every scalar boundary', () => {
    let reads = 0;
    const accessor = Object.defineProperties(
      {},
      {
        sessionId: {
          enumerable: true,
          get: () => {
            reads += 1;
            return 'session';
          },
        },
        turnId: {
          enumerable: true,
          get: () => {
            reads += 1;
            return 'turn';
          },
        },
        messageId: {
          enumerable: true,
          get: () => {
            reads += 1;
            return 'message';
          },
        },
      },
    );
    expect(() => createStationAnswerBinding(accessor as never)).toThrow();
    expect(reads).toBe(0);
    expect(isStationBasisId('\ud800')).toBe(false);
    expect(isStationBasisId('\udc00')).toBe(false);
    expect(() =>
      createStationAnswerBinding({
        sessionId: '\ud800',
        turnId: 'turn',
        messageId: 'message',
      }),
    ).toThrow();
    expect(
      parseStationAnswerBinding({
        version: 'station-answer-binding/v1',
        sessionId: '\udc00',
        turnId: 'turn',
        answer: {},
      }),
    ).toBeNull();
    expect(
      parseStationTaskBasisCollection({
        version: 'station.task-basis-collection/v3',
        taskId: '\ud800',
        answers: [],
        unassociated: [],
        keptToolResults: [],
        gaps: [],
      }),
    ).toBeNull();

    const binding = createStationAnswerBinding({
      sessionId: 'session',
      turnId: 'turn',
      messageId: 'message',
    });
    const nestedAnswer = Object.defineProperties(
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
            return 'session';
          },
        },
        messageId: { enumerable: true, value: 'message' },
      },
    );
    const nestedAccessorBinding = { ...binding, answer: nestedAnswer };
    expect(parseStationAnswerBinding(nestedAccessorBinding)).toBeNull();
    expect(
      parseStationTaskBasisCollection({
        version: 'station.task-basis-collection/v3',
        taskId: 'task',
        answers: [],
        unassociated: [
          {
            kind: 'answer-binding',
            binding: nestedAccessorBinding,
            kept: true,
          },
        ],
        keptToolResults: [],
        gaps: [],
      }),
    ).toBeNull();
    expect(reads).toBe(0);
  });

  test('rejects oversize before UTF-8 encoding and keeps proxy traps total', () => {
    const oversized = 'x'.repeat(1_025);
    expect(isStationBasisId(oversized)).toBe(false);
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('descriptor trap');
        },
        ownKeys() {
          throw new Error('own keys trap');
        },
      },
    );
    expect(() => parseStationAnswerBinding(hostile)).not.toThrow();
    expect(() => parseStationTaskBasisCollection(hostile)).not.toThrow();
  });
});
