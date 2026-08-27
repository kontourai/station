// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  answerSupportQueries,
  useAnswerSupportBundlesQuery,
  useAnswerSupportCardsQuery,
  useAnswerSupportClaimsQuery,
} from '../answer-support.js';

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://station.test'),
}));

afterEach(() => vi.unstubAllGlobals());

const taskId = 'task-a';
const referenceA = 'reference-a';
const referenceB = 'reference-b';

function seedProtectedScope(client: QueryClient) {
  client.setQueryData(answerSupportQueries.cards(taskId).queryKey, [
    { id: 'card-a' },
  ]);
  for (const referenceId of [referenceA, referenceB]) {
    client.setQueryData(
      answerSupportQueries.bundles(taskId, referenceId).queryKey,
      [{ id: `bundle-${referenceId}` }],
    );
    client.setQueryData(
      answerSupportQueries.claims(taskId, referenceId, 'bundle-a').queryKey,
      [{ id: `claim-${referenceId}` }],
    );
  }
}

describe('answer-support full Task cache revocation', () => {
  it.each([
    ['candidate 404', 404, 'bundles' as const],
    ['candidate 503', 503, 'bundles' as const],
    ['card 404', 404, 'cards' as const],
    ['card 503', 503, 'cards' as const],
  ])(
    'removes all reference A/B protected observers and cache entries after %s',
    async (_label, status, failureSurface) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: false,
            error:
              status === 503
                ? 'Answer support temporarily unavailable'
                : 'Answer support unavailable',
          }),
          { status },
        ),
      );
      vi.stubGlobal('fetch', fetch);
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      seedProtectedScope(client);
      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client }, children);

      const observer = renderHook(
        ({ enabled }: { enabled: boolean }) => ({
          cards: useAnswerSupportCardsQuery(taskId, {
            enabled: failureSurface === 'cards' ? enabled : false,
          }),
          aBundles: useAnswerSupportBundlesQuery(taskId, referenceA, {
            enabled: failureSurface === 'bundles' ? enabled : false,
          }),
          aClaims: useAnswerSupportClaimsQuery(taskId, referenceA, 'bundle-a', {
            enabled: false,
          }),
          bBundles: useAnswerSupportBundlesQuery(taskId, referenceB, {
            enabled: false,
          }),
          bClaims: useAnswerSupportClaimsQuery(taskId, referenceB, 'bundle-a', {
            enabled: false,
          }),
        }),
        { initialProps: { enabled: false }, wrapper },
      );

      await client.invalidateQueries({
        queryKey:
          failureSurface === 'cards'
            ? answerSupportQueries.cards(taskId).queryKey
            : answerSupportQueries.bundles(taskId, referenceA).queryKey,
      });
      observer.rerender({ enabled: true });
      await waitFor(() => expect(fetch).toHaveBeenCalled());
      await waitFor(() => {
        expect(
          client.getQueryData(answerSupportQueries.cards(taskId).queryKey),
        ).toBeUndefined();
        expect(
          client.getQueryData(
            answerSupportQueries.bundles(taskId, referenceA).queryKey,
          ),
        ).toBeUndefined();
        expect(
          client.getQueryData(
            answerSupportQueries.claims(taskId, referenceA, 'bundle-a')
              .queryKey,
          ),
        ).toBeUndefined();
        expect(
          client.getQueryData(
            answerSupportQueries.bundles(taskId, referenceB).queryKey,
          ),
        ).toBeUndefined();
        expect(
          client.getQueryData(
            answerSupportQueries.claims(taskId, referenceB, 'bundle-a')
              .queryKey,
          ),
        ).toBeUndefined();
      });

      for (const query of Object.values(observer.result.current))
        expect(query.data).toBeUndefined();
    },
  );
});
