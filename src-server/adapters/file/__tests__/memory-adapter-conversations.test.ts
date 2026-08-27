import type { Conversation } from '@voltagent/core';
import { describe, expect, test } from 'vitest';
import { applyConversationQueryOptions } from '../memory-adapter-conversations.js';

const conversations: Conversation[] = [
  {
    id: 'b',
    resourceId: 'agent-1',
    userId: 'user-1',
    title: 'Bravo',
    metadata: {},
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-03T00:00:00.000Z',
  },
  {
    id: 'a',
    resourceId: 'agent-2',
    userId: 'user-2',
    title: 'Alpha',
    metadata: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-04T00:00:00.000Z',
  },
];

describe('memory-adapter conversation helpers', () => {
  test('filters by user and resource and sorts by title', () => {
    expect(
      applyConversationQueryOptions(conversations, {
        userId: 'user-1',
        resourceId: 'agent-1',
        orderBy: 'title',
        orderDirection: 'ASC',
      } as any),
    ).toEqual([conversations[0]]);
  });

  test('sorts by updatedAt descending and applies pagination', () => {
    expect(
      applyConversationQueryOptions(conversations, {
        limit: 1,
        offset: 0,
      } as any),
    ).toEqual([conversations[1]]);
  });
});
