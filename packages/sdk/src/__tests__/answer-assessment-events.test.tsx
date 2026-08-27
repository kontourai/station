// @vitest-environment jsdom

import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import * as React from 'react';
import { describe, expect, test } from 'vitest';
import {
  parseAnswerAssessmentUpdateEvent,
  refreshAnswerAssessmentQueries,
} from '../answer-assessment-events';
import { answerBasisQueries } from '../answer-basis';

const scopeA = { apiBase: 'http://station-a.test', authorityKey: 'a:1' };
const scopeB = { apiBase: 'http://station-b.test', authorityKey: 'b:1' };
const update = {
  sessionId: 'session-a',
  turnId: 'turn-a',
  revision: 2,
  active: true,
};

function wrapper(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
}

describe('assessment update cache notification', () => {
  test('accepts only the closed update payload', () => {
    expect(parseAnswerAssessmentUpdateEvent(update)).toEqual(update);
    expect(
      parseAnswerAssessmentUpdateEvent({ ...update, extra: true }),
    ).toBeUndefined();
    expect(
      parseAnswerAssessmentUpdateEvent({ ...update, revision: -1 }),
    ).toBeUndefined();
    expect(
      parseAnswerAssessmentUpdateEvent({ sessionId: 'session-a' }),
    ).toBeUndefined();
  });

  test('withholds an active observer during a deferred refetch and never touches co-resident authority', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const keyA = answerBasisQueries.answer(
      'session-a',
      'turn-a',
      scopeA,
    ).queryKey;
    const keyB = answerBasisQueries.answer(
      'session-a',
      'turn-a',
      scopeB,
    ).queryKey;
    let calls = 0;
    const observer = renderHook(
      () =>
        useQuery({
          queryKey: keyA,
          queryFn: ({ signal }) => {
            calls += 1;
            if (calls === 1) return Promise.resolve({ policy: 'old' });
            return new Promise((resolve) => {
              signal.addEventListener('abort', () =>
                resolve({ policy: 'old-late' }),
              );
            });
          },
          staleTime: Infinity,
        }),
      { wrapper: wrapper(client) },
    );
    await waitFor(() =>
      expect(observer.result.current.data).toEqual({ policy: 'old' }),
    );
    client.setQueryData(keyB, { policy: 'other-authority' });
    await act(async () => {
      void observer.result.current.refetch();
      await Promise.resolve();
    });
    await act(async () => {
      expect(refreshAnswerAssessmentQueries(client, update, scopeA)).toBe(true);
    });
    expect(client.getQueryData(keyA)).toBeNull();
    await waitFor(() => expect(observer.result.current.data).toBeNull());
    expect(client.getQueryData(keyB)).toEqual({ policy: 'other-authority' });
    client.removeQueries({ queryKey: keyA, exact: true });
    expect(client.getQueryData(keyA)).toBeUndefined();
  });
});
