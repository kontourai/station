// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { answerBasisQueries, useAnswerBasisQuery } from '../answer-basis.js';

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://station.test'),
}));

afterEach(() => vi.unstubAllGlobals());

describe('answer Basis protected cache', () => {
  test.each([404, 503])(
    'tombstones and withholds a revoked %i answer without resetting to pending',
    async (status) => {
      const sessionId = 'session-a';
      const turnId = 'turn-a';
      const queryKey = answerBasisQueries.answer(sessionId, turnId).queryKey;
      vi.stubGlobal(
        'fetch',
        vi
          .fn<typeof fetch>()
          .mockImplementation(
            async () =>
              new Response(JSON.stringify({ success: false }), { status }),
          ),
      );
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      client.setQueryData(queryKey, { prior: 'protected answer' });
      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client }, children);
      const observer = renderHook(
        () => useAnswerBasisQuery(sessionId, turnId),
        { wrapper },
      );
      await waitFor(() => {
        expect(observer.result.current.data).toBeUndefined();
        expect(client.getQueryData(queryKey)).toBeNull();
        expect(observer.result.current.isFetching).toBe(false);
      });
    },
  );
});
