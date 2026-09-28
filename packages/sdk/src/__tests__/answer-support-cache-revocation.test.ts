// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  answerSupportQueries,
  useAnswerSupportBundlesQuery,
  useAnswerSupportCardsQuery,
  useAnswerSupportClaimsQuery,
  useCreateAnswerSupportMutation,
  useRemoveAnswerSupportMutation,
  useReplaceAnswerSupportMutation,
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
    ['claim 404', 404, 'claims' as const],
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
            enabled: failureSurface === 'claims' ? enabled : false,
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
            : failureSurface === 'claims'
              ? answerSupportQueries.claims(taskId, referenceA, 'bundle-a')
                  .queryKey
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

function protectedKeys() {
  return [
    answerSupportQueries.cards(taskId).queryKey,
    ...[referenceA, referenceB].flatMap((referenceId) => [
      answerSupportQueries.bundles(taskId, referenceId).queryKey,
      answerSupportQueries.claims(taskId, referenceId, 'bundle-a').queryKey,
    ]),
  ];
}

const mutations = [
  [
    'attach',
    () => {
      const mutation = useCreateAnswerSupportMutation();
      return () =>
        mutation.mutateAsync({
          taskId,
          referenceId: referenceA,
          bundleId: 'bundle-a',
          claimId: 'claim-a',
        });
    },
  ],
  [
    'replace',
    () => {
      const mutation = useReplaceAnswerSupportMutation();
      return () =>
        mutation.mutateAsync({
          taskId,
          referenceId: referenceA,
          bundleId: 'bundle-a',
          claimId: 'claim-a',
          expectedRevision: 1,
        });
    },
  ],
  [
    'remove',
    () => {
      const mutation = useRemoveAnswerSupportMutation();
      return () =>
        mutation.mutateAsync({
          taskId,
          referenceId: referenceA,
          expectedRevision: 1,
        });
    },
  ],
] as const;

async function runMutation(
  useMutate: () => () => Promise<unknown>,
  response: Response,
): Promise<QueryClient> {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof globalThis.fetch>().mockResolvedValue(response),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  seedProtectedScope(client);
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
  const { result } = renderHook(() => useMutate(), { wrapper });
  await act(async () => {
    await result.current().catch(() => undefined);
  });
  return client;
}

function failure(status: number, error: string): Response {
  return new Response(JSON.stringify({ success: false, error }), { status });
}

describe('answer-support mutation cache effects', () => {
  it.each(mutations)(
    'removes every protected Task entry when %s loses answer authority',
    async (_label, useMutate) => {
      const client = await runMutation(
        useMutate,
        failure(503, 'Answer support temporarily unavailable'),
      );
      for (const key of protectedKeys())
        expect(client.getQueryState(key)).toBeUndefined();
    },
  );

  it.each(mutations)(
    'keeps and invalidates every Task selector after a %s compare-and-swap conflict',
    async (_label, useMutate) => {
      const client = await runMutation(
        useMutate,
        failure(409, 'Answer support conflicts'),
      );
      for (const key of protectedKeys())
        expect(client.getQueryState(key)).toMatchObject({
          isInvalidated: true,
        });
      expect(
        client.getQueryData(answerSupportQueries.cards(taskId).queryKey),
      ).toEqual([{ id: 'card-a' }]);
    },
  );

  it('invalidates cards and Task-wide selections after attach', async () => {
    const client = await runMutation(
      mutations[0][1],
      new Response(
        JSON.stringify({ success: true, data: { id: 'association-a' } }),
        { status: 200 },
      ),
    );
    for (const key of protectedKeys())
      expect(client.getQueryState(key)).toMatchObject({ isInvalidated: true });
  });
});
