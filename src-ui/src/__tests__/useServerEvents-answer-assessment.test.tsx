// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import * as React from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const streams = vi.hoisted(
  () =>
    [] as Array<{
      onMessage: (message: { event: string; data: string }) => void;
    }>,
);
const host = vi.hoisted(() => ({
  apiBase: 'http://station.test',
  a1Current: true,
  authority: {
    apiBase: 'http://station.test',
    authorityKey: 'a:1',
    isCurrent: () => host.a1Current,
  } as
    | { apiBase: string; authorityKey: string; isCurrent: () => boolean }
    | undefined,
}));

vi.mock('@kontourai/station-sdk', () => ({
  fetchSSE: vi.fn(
    (
      _url: string,
      options: {
        onMessage: (message: { event: string; data: string }) => void;
      },
    ) => {
      streams.push(options);
      return { close: vi.fn() };
    },
  ),
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: host.apiBase }),
  useHostRequestAuthorityScope: () => host.authority,
}));

import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { answerBasisQueries } from '@kontourai/station-sdk/answer-basis';
import { useServerEvents } from '../hooks/useServerEvents';

function provider(client: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
}

describe('answer owner SSE authority capture', () => {
  beforeEach(() => {
    streams.length = 0;
    host.a1Current = true;
    host.authority = {
      apiBase: host.apiBase,
      authorityKey: 'a:1',
      isCurrent: () => host.a1Current,
    };
  });

  test('delivers valid updates, ignores invalid payloads, and rejects A to B to A late callbacks', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const keyA = answerBasisQueries.answer(
      'session-a',
      'turn-a',
      host.authority,
    ).queryKey;
    client.setQueryData(keyA, { policy: 'old' });
    const hook = renderHook(() => useServerEvents(), {
      wrapper: provider(client),
    });
    const streamA1 = streams[0]!;
    await act(async () => {
      streamA1.onMessage({
        event: SERVER_EVENTS.ANSWER_ASSESSMENT_UPDATED,
        data: JSON.stringify({
          sessionId: 'session-a',
          turnId: 'turn-a',
          revision: 2,
          active: true,
        }),
      });
    });
    expect(client.getQueryData(keyA)).toBeNull();
    client.setQueryData(keyA, { policy: 'narrative-old' });
    await act(async () => {
      streamA1.onMessage({
        event: SERVER_EVENTS.ANSWER_NARRATIVE_UPDATED,
        data: JSON.stringify({
          sessionId: 'session-a',
          turnId: 'turn-a',
          revision: 2,
          active: true,
        }),
      });
    });
    expect(client.getQueryData(keyA)).toBeNull();
    client.setQueryData(keyA, { policy: 'protected' });
    await act(async () => {
      streamA1.onMessage({
        event: SERVER_EVENTS.ANSWER_ASSESSMENT_UPDATED,
        data: JSON.stringify({ sessionId: 'session-a' }),
      });
    });
    expect(client.getQueryData(keyA)).toEqual({ policy: 'protected' });

    host.a1Current = false;
    host.authority = {
      apiBase: host.apiBase,
      authorityKey: 'b:1',
      isCurrent: () => true,
    };
    hook.rerender();
    host.authority = {
      apiBase: host.apiBase,
      authorityKey: 'a:2',
      isCurrent: () => true,
    };
    hook.rerender();
    client.setQueryData(keyA, { policy: 'still-current-a2' });
    await act(async () => {
      streamA1.onMessage({
        event: SERVER_EVENTS.ANSWER_ASSESSMENT_UPDATED,
        data: JSON.stringify({
          sessionId: 'session-a',
          turnId: 'turn-a',
          revision: 3,
          active: false,
        }),
      });
    });
    expect(client.getQueryData(keyA)).toEqual({ policy: 'still-current-a2' });
  });
});
