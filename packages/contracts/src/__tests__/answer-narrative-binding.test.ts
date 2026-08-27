import { describe, expect, test } from 'vitest';
import {
  parseStationAnswerNarrativePublishInput,
  parseStationAnswerNarrativeRemoveInput,
  STATION_FLOW_AGENTS_PROJECT_NARRATIVE_OWNER,
} from '../answer-narrative-binding.js';
import { createStationAnswerBinding } from '../task-basis.js';

const expectedAnswer = createStationAnswerBinding({
  sessionId: 'session-a',
  turnId: 'turn-a',
  messageId: 'message-a',
});
const input = {
  expectedAnswer,
  publicationId: 'publish-a',
  expectedRevision: 0,
  ownerId: STATION_FLOW_AGENTS_PROJECT_NARRATIVE_OWNER,
  narrativeRef: {
    schemaVersion: 'grounded-narrative-ref/v1',
    narrativeId: 'narrative-a',
    envelopeSha256: 'a'.repeat(64),
  },
};

describe('Station answer narrative binding contract', () => {
  test('accepts only the closed public path-free producer wire', () => {
    expect(parseStationAnswerNarrativePublishInput(input)).toEqual(input);
    expect(
      parseStationAnswerNarrativePublishInput({ ...input, path: '/tmp/no' }),
    ).toBeNull();
    expect(
      parseStationAnswerNarrativePublishInput({
        ...input,
        narrativeRef: {
          ...input.narrativeRef,
          schemaVersion: 'grounded-narrative-ref/v2',
        },
      }),
    ).toBeNull();
    expect(
      parseStationAnswerNarrativePublishInput({
        ...input,
        publicationId: '\u0000',
      }),
    ).toBeNull();
  });

  test('does not evaluate accessors and only accepts a non-negative CAS revision', () => {
    const hostile = Object.create(null, {
      expectedAnswer: { enumerable: true, value: expectedAnswer },
      publicationId: {
        enumerable: true,
        get: () => {
          throw new Error('getter');
        },
      },
      expectedRevision: { enumerable: true, value: 0 },
      ownerId: {
        enumerable: true,
        value: STATION_FLOW_AGENTS_PROJECT_NARRATIVE_OWNER,
      },
      narrativeRef: { enumerable: true, value: input.narrativeRef },
    });
    expect(parseStationAnswerNarrativePublishInput(hostile)).toBeNull();
    expect(
      parseStationAnswerNarrativeRemoveInput({ expectedRevision: 0 }),
    ).toEqual({ expectedRevision: 0 });
    expect(
      parseStationAnswerNarrativeRemoveInput({ expectedRevision: -1 }),
    ).toBeNull();
  });
});
