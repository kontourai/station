import { QueryClient } from '@tanstack/react-query';
import { describe, expect, test } from 'vitest';
import {
  parseAnswerNarrativeUpdateEvent,
  refreshAnswerNarrativeQueries,
} from '../answer-narrative-events.js';

const scopeA = {
  apiBase: 'http://station-a.test',
  authorityKey: 'owner:a',
  isCurrent: () => true,
};
const scopeB = {
  apiBase: 'http://station-b.test',
  authorityKey: 'owner:b',
  isCurrent: () => true,
};

describe('answer narrative update events', () => {
  test('refreshes only the direct and Task Basis caches in the receiving scope', () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const direct = [
      'answer-basis',
      'session-a',
      'turn-a',
      scopeA.apiBase,
      scopeA.authorityKey,
    ];
    const task = ['task-basis', 'task-a', scopeA.apiBase, scopeA.authorityKey];
    const otherDirect = [
      'answer-basis',
      'session-a',
      'turn-a',
      scopeB.apiBase,
      scopeB.authorityKey,
    ];
    const otherTask = [
      'task-basis',
      'task-a',
      scopeB.apiBase,
      scopeB.authorityKey,
    ];
    client.setQueryData(direct, { state: 'old' });
    client.setQueryData(task, { state: 'old' });
    client.setQueryData(otherDirect, { state: 'other' });
    client.setQueryData(otherTask, { state: 'other' });

    expect(
      refreshAnswerNarrativeQueries(
        client,
        { sessionId: 'session-a', turnId: 'turn-a', revision: 1, active: true },
        scopeA,
      ),
    ).toBe(true);
    expect(client.getQueryData(direct)).toBeNull();
    expect(client.getQueryData(task)).toBeNull();
    expect(client.getQueryData(otherDirect)).toEqual({ state: 'other' });
    expect(client.getQueryData(otherTask)).toEqual({ state: 'other' });
  });

  test('rejects malformed event payloads before touching a cache', () => {
    expect(
      parseAnswerNarrativeUpdateEvent({ sessionId: 'session-a' }),
    ).toBeUndefined();
    expect(
      parseAnswerNarrativeUpdateEvent({
        sessionId: 'session-a',
        turnId: 'turn-a',
        revision: 1,
        active: true,
        extra: true,
      }),
    ).toBeUndefined();
  });
});
