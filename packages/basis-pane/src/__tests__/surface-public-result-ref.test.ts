import { composeBasisProjection } from '@kontourai/surface/basis';
import { buildBasisPanelViewModel } from '@kontourai/surface/basis/view';
import { expect, test } from 'vitest';

test('the published Surface view preserves exact result identity without upgrading standing', () => {
  const observedAt = '2026-08-26T00:00:00.000Z';
  const answer = {
    authority: '@kontourai/thread',
    schemaVersion: '1.2.0',
    kind: 'assistant-message',
    standing: 'observed',
    threadId: 'fixture-thread',
    messageId: 'fixture-answer',
  } as const;
  const ref = {
    authority: '@kontourai/thread',
    schemaVersion: '1.2.0',
    kind: 'result',
    threadId: 'fixture-thread',
    resultId: 'fixture-terminal-event',
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
            ref,
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
  const model = buildBasisPanelViewModel(projection);
  expect(projection.standing).toBe('execution-only');
  expect(
    model.contextGroups.find((group) => group.id === 'execution')?.items[0]
      ?.ref,
  ).toEqual(ref);
});
