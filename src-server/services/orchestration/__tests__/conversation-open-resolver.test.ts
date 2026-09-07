import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { ConversationListItem } from '@kontourai/station-contracts/orchestration';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { describe, expect, it, vi } from 'vitest';
import { createConversationOpenResolver } from '../conversation-open-resolver.js';

const authority = sessionReadAuthorityFromRequest(
  'human:local:operator',
  undefined,
  undefined,
  {
    localHomePossession: true,
  },
);
const conversation: ConversationListItem = {
  id: 'released-conversation',
  source: 'runtime',
  agentSlug: agentId('codex'),
  title: 'Cool conversation',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:01:00.000Z',
  messageCount: 2,
  mutable: false,
  answerability: { answerable: true },
};

describe('ConversationOpenResolver', () => {
  it('returns one resolved state from the current lineage child and its transcript', async () => {
    const resolver = createConversationOpenResolver({
      currentSessionId: () => 'released-conversation:session:child',
      readCurrent: vi.fn().mockResolvedValue({
        sessionId: 'released-conversation:session:child',
        messages: [{ id: 'one', role: 'user', parts: [] }],
        answerability: { answerable: true },
        canContinue: true,
      }),
    });

    await expect(
      resolver.resolve({ conversation, authority }),
    ).resolves.toMatchObject({
      status: 'resolved',
      currentSessionId: 'released-conversation:session:child',
      transcript: { available: true, owner: 'runtime' },
      canContinue: true,
    });
  });

  it('does not invent a writable session when the lineage current child is absent', async () => {
    const resolver = createConversationOpenResolver({
      currentSessionId: () => 'released-conversation:session:missing',
      readCurrent: vi.fn().mockResolvedValue(null),
    });

    await expect(
      resolver.resolve({ conversation, authority }),
    ).resolves.toEqual({
      status: 'missing-session',
      conversation,
      transcript: { available: false, owner: 'runtime' },
      canContinue: false,
      answerability: { answerable: true },
      recoveryActions: ['retry', 'start-new'],
    });
  });

  it('keeps durable read failure explicit rather than falling back to inventory', async () => {
    const resolver = createConversationOpenResolver({
      currentSessionId: () => 'released-conversation:session:child',
      readCurrent: vi.fn().mockRejectedValue(new Error('sqlite unavailable')),
    });

    await expect(
      resolver.resolve({ conversation, authority }),
    ).resolves.toMatchObject({
      status: 'unavailable',
      canContinue: false,
      recoveryActions: ['retry', 'start-new'],
    });
  });
});

it('refuses mixed execution metadata when lineage changes during the authorized read', async () => {
  let current = 'old-child';
  const resolver = createConversationOpenResolver({
    currentSessionId: () => current,
    readCurrent: async () => {
      current = 'new-child';
      return {
        sessionId: 'new-child',
        messages: [],
        answerability: { answerable: true },
        canContinue: true,
        execution: {
          sessionId: 'new-child',
          agentId: conversation.agentSlug,
          provider: 'claude',
        },
      };
    },
  });
  await expect(
    resolver.resolve({
      conversation,
      authority,
      expectedSessionId: 'old-child',
    }),
  ).resolves.toMatchObject({ status: 'unavailable', canContinue: false });
});

it('returns exact observed execution separately from inventory decorations', async () => {
  const execution = {
    sessionId: 'current-child',
    agentId: conversation.agentSlug,
    provider: 'claude',
    engineConnectionId: 'actual-connection',
    model: 'reported-model',
    acceptedModel: 'accepted-model',
  };
  const resolver = createConversationOpenResolver({
    currentSessionId: () => 'current-child',
    readCurrent: async () => ({
      sessionId: 'current-child',
      execution,
      messages: [],
      answerability: { answerable: true },
      canContinue: true,
    }),
  });
  await expect(
    resolver.resolve({ conversation, authority }),
  ).resolves.toMatchObject({ status: 'resolved', execution });
});
