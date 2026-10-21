import { CONVERSATION_HANDOFF_RESET_FIELDS } from '@kontourai/station-contracts/orchestration';
import { describe, expect, test, vi } from 'vitest';
import {
  ConversationHandoffConflictError,
  createConversationContextSeedPin,
  createConversationHandoffModule,
  readConversationContextSeedPin,
} from '../conversation-handoff-module.js';

const handoff = {
  conversationId: 'conversation-a',
  predecessorSessionId: 'session-a',
  sessionId: 'session-b',
  idempotencyKey: 'request-1',
  targetAgentId: 'codex',
  targetEnvironmentId: 'environment-a',
  targetConnectionId: 'codex',
  targetModelId: 'gpt-5',
  messageDigest: 'message-a',
  createdAt: '2026-08-24T12:00:00.000Z',
};

describe('ConversationHandoffModule', () => {
  test.each(['omission', 'cutoff'] as const)(
    'rejects changed %s facts under an old context seal',
    (changed) => {
      const seed = createConversationContextSeedPin({
        text: 'Only the newest source message fits.',
        sourceCutoffs: [
          { sessionId: 'source', afterSequence: 0, throughSequence: 7 },
        ],
        omission: {
          totalMessages: 2,
          includedMessages: 1,
          omittedMessages: 1,
          newestShortened: false,
          nonTextMessages: 0,
        },
      });
      if (changed === 'omission') {
        seed.omission.totalMessages = 1;
        seed.omission.omittedMessages = 0;
      } else {
        seed.sourceCutoffs[0]!.throughSequence = 8;
      }
      expect(() =>
        readConversationContextSeedPin(JSON.stringify(seed)),
      ).toThrow('The pinned conversation context is invalid.');
    },
  );

  test.each([
    'private-transcript-sentinel{',
    JSON.stringify({ text: 'private-transcript-sentinel' }),
    JSON.stringify({
      text: 'private-transcript-sentinel',
      seedDigest: 'a'.repeat(64),
      sourceCutoffs: [],
      omission: {
        totalMessages: 0,
        includedMessages: 0,
        omittedMessages: 0,
        newestShortened: false,
        nonTextMessages: 0,
      },
    }),
  ])(
    'rejects corrupt stored context with a content-free diagnostic (%#)',
    (json) => {
      expect(() => readConversationContextSeedPin(json)).toThrow(
        'The pinned conversation context is invalid.',
      );
    },
  );

  test('returns an immutable marker with exact carry/reset disclosure', () => {
    const observe = vi.fn();
    const module = createConversationHandoffModule({
      persistence: {
        reserve: (input) => ({ marker: input, outcome: 'created' as const }),
        findBySession: () => undefined,
        findByPredecessor: () => undefined,
        findByKey: () => undefined,
        listByConversation: () => [handoff],
      },
      observe,
    });

    const result = module.reserve(handoff);

    expect(result).toMatchObject({
      outcome: 'created',
      carried: [
        'authorizedTranscript',
        'ownerTenantWorkspace',
        'targetAgentModel',
      ],
      reset: CONVERSATION_HANDOFF_RESET_FIELDS,
    });
    expect(result.reset).toContain('taskWorkflowReferences');
    expect(() => {
      (result.marker as { targetAgentId: string }).targetAgentId = 'claude';
    }).toThrow();
    expect(observe).toHaveBeenCalledWith('created');
    expect(module.markersForConversation('conversation-a')).toEqual([handoff]);
  });

  test('fails closed for a changed idempotency target while telemetry remains observational', () => {
    const observe = vi.fn(() => {
      throw new Error('telemetry unavailable');
    });
    const module = createConversationHandoffModule({
      persistence: {
        reserve: () => {
          throw new ConversationHandoffConflictError(
            'idempotency_target_mismatch',
          );
        },
        findBySession: () => undefined,
        findByPredecessor: () => undefined,
        findByKey: () => undefined,
        listByConversation: () => [],
      },
      observe,
    });

    expect(() => module.reserve(handoff)).toThrow(
      'idempotency key already names a different target',
    );
    expect(observe).toHaveBeenCalledWith('conflict');
  });
});
