// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  answerSupportQueries,
  useAnswerSupportBundlesQuery,
} from '../answer-support.js';
import { useTaskTurnReferencesQuery } from '../query-domains/taskGraph.js';
import { taskQueries } from '../queryFactories.js';
import {
  useAttachTaskUserInputReferenceMutation,
  useTaskUserInputReferencesQuery,
} from '../task-user-input-references.js';

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://station.test'),
}));

afterEach(() => vi.unstubAllGlobals());

const taskId = 'task-a';

describe('Task user-input protected cache revocation', () => {
  it('settles a mounted 503 as a retryable empty projection and restores only after an explicit retry', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false }), { status: 503 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            data: [
              {
                id: 'input-after-retry',
                state: 'available',
                sessionId: 'session-after',
                eventId: 'event-after',
                turnId: 'turn-after',
                input: { prompt: 'restored', attachments: [] },
              },
            ],
          }),
        ),
      );
    vi.stubGlobal('fetch', fetch);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client }, children);
    client.setQueryData(taskQueries.turnReferences(taskId).queryKey, [
      { id: 'sibling' },
    ]);
    const observer = renderHook(() => useTaskUserInputReferencesQuery(taskId), {
      wrapper,
    });
    await waitFor(() => {
      expect(observer.result.current.data).toBeUndefined();
      expect(observer.result.current.error).toMatchObject({ status: 503 });
      expect(observer.result.current.isLoading).toBe(false);
      expect(
        client.getQueryData(taskQueries.userInputReferences(taskId).queryKey),
      ).toMatchObject({ status: 503 });
      expect(
        client.getQueryData(taskQueries.turnReferences(taskId).queryKey),
      ).toBeUndefined();
    });
    await observer.result.current.refetch();
    await waitFor(() =>
      expect(observer.result.current.data).toEqual([
        expect.objectContaining({
          input: { prompt: 'restored', attachments: [] },
        }),
      ]),
    );
    expect(
      client.getQueryData(taskQueries.userInputReferences(taskId).queryKey),
    ).toEqual([
      expect.objectContaining({
        input: { prompt: 'restored', attachments: [] },
      }),
    ]);
  });

  it.each([404, 503])(
    'withholds and removes every Task reference projection after %i following prior success',
    async (status) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              success: true,
              data: [
                {
                  id: 'input-link',
                  state: 'available',
                  sessionId: 'session-secret',
                  eventId: 'event-secret',
                  turnId: 'turn-secret',
                  input: {
                    prompt: 'prior authorized input',
                    attachments: [
                      { name: 'prior.txt', mediaType: 'text/plain', size: 1 },
                    ],
                  },
                },
              ],
            }),
          ),
        )
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              success: false,
              error: 'tuple=secret-session/event-secret input=private',
            }),
            { status },
          ),
        );
      vi.stubGlobal('fetch', fetch);
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client }, children);
      const observer = renderHook(
        () => ({
          inputs: useTaskUserInputReferencesQuery(taskId),
          turns: useTaskTurnReferencesQuery(taskId, { enabled: false }),
        }),
        { wrapper },
      );

      await waitFor(() =>
        expect(observer.result.current.inputs.data).toEqual([
          expect.objectContaining({
            input: {
              prompt: 'prior authorized input',
              attachments: [
                { name: 'prior.txt', mediaType: 'text/plain', size: 1 },
              ],
            },
          }),
        ]),
      );
      client.setQueryData(taskQueries.turnReferences(taskId).queryKey, [
        { id: 'turn-link', answer: { content: 'prior answer' } },
      ]);
      client.setQueryData(
        ['answer-support', taskId, 'reference-a', 'bundles'],
        [{ id: 'bundle-secret' }],
      );

      await client.invalidateQueries({
        queryKey: taskQueries.userInputReferences(taskId).queryKey,
        exact: true,
      });
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      await waitFor(() => {
        expect(observer.result.current.inputs.data).toBeUndefined();
        expect(
          client.getQueryData(taskQueries.userInputReferences(taskId).queryKey),
        ).toMatchObject({ status });
        expect(
          client.getQueryData(taskQueries.turnReferences(taskId).queryKey),
        ).toBeUndefined();
        expect(
          client.getQueryData([
            'answer-support',
            taskId,
            'reference-a',
            'bundles',
          ]),
        ).toBeUndefined();
      });
      expect(observer.result.current.turns.data).toBeUndefined();
    },
  );

  it.each([404, 503])(
    'synchronously revokes mounted input, turn, and answer-support observers after attach failure %i',
    async (status) => {
      let mutationFailed = false;
      const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
        const path = String(url);
        if (path.endsWith('/references') && init?.method === 'POST') {
          mutationFailed = true;
          return new Response(
            JSON.stringify({
              success: false,
              error: 'session-secret/event-secret private prompt',
            }),
            { status },
          );
        }
        if (path.endsWith('/user-input-references')) {
          return new Response(
            JSON.stringify({
              success: !mutationFailed,
              data: mutationFailed
                ? undefined
                : [
                    {
                      id: 'input-link',
                      state: 'available',
                      sessionId: 'session-a',
                      eventId: 'event-a',
                      turnId: 'turn-a',
                      input: {
                        prompt: 'authorized prompt',
                        attachments: [
                          {
                            name: 'brief.txt',
                            mediaType: 'text/plain',
                            size: 5,
                          },
                        ],
                      },
                    },
                  ],
            }),
            { status: mutationFailed ? 404 : 200 },
          );
        }
        if (path.endsWith('/turn-references')) {
          return new Response(
            JSON.stringify({
              success: !mutationFailed,
              data: mutationFailed
                ? undefined
                : [
                    {
                      id: 'turn-link',
                      state: 'available',
                      sessionId: 'session-a',
                      turnId: 'turn-a',
                      answer: {
                        role: 'assistant',
                        parts: [{ type: 'text', text: 'authorized answer' }],
                      },
                      support: { state: 'unassessed' },
                    },
                  ],
            }),
            { status: mutationFailed ? 404 : 200 },
          );
        }
        if (path.endsWith('/support/bundles')) {
          return new Response(
            JSON.stringify({
              success: !mutationFailed,
              data: mutationFailed ? undefined : [{ id: 'bundle-a' }],
            }),
            { status: mutationFailed ? 404 : 200 },
          );
        }
        throw new Error(`unexpected request ${path}`);
      });
      vi.stubGlobal('fetch', fetch);
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client }, children);
      const observer = renderHook(
        () => ({
          inputs: useTaskUserInputReferencesQuery(taskId),
          turns: useTaskTurnReferencesQuery(taskId),
          support: useAnswerSupportBundlesQuery(taskId, 'turn-link'),
          attach: useAttachTaskUserInputReferenceMutation(),
        }),
        { wrapper },
      );

      await waitFor(() => {
        expect(observer.result.current.inputs.data).toEqual([
          expect.objectContaining({
            input: {
              prompt: 'authorized prompt',
              attachments: [
                { name: 'brief.txt', mediaType: 'text/plain', size: 5 },
              ],
            },
          }),
        ]);
        expect(observer.result.current.turns.data).toHaveLength(1);
        expect(observer.result.current.support.data).toEqual([
          { id: 'bundle-a' },
        ]);
      });
      client.setQueryData(taskQueries.graph(taskId).queryKey, {
        id: taskId,
        links: [{ id: 'graph-reference' }],
      });

      await expect(
        observer.result.current.attach.mutateAsync({
          taskId,
          sessionId: 'session-b',
          eventId: 'event-b',
        }),
      ).rejects.toMatchObject({ status });

      await waitFor(() => {
        expect(observer.result.current.inputs.data).toBeUndefined();
        expect(observer.result.current.turns.data).toBeUndefined();
        expect(observer.result.current.support.data).toBeUndefined();
        const cachedInputError = client.getQueryData<{ status?: number }>(
          taskQueries.userInputReferences(taskId).queryKey,
        );
        expect([404, 503]).toContain(cachedInputError?.status);
        expect(JSON.stringify(cachedInputError)).not.toContain(
          'authorized prompt',
        );
        expect(
          client.getQueryData(taskQueries.turnReferences(taskId).queryKey),
        ).toBeUndefined();
        expect(
          client.getQueryData(
            answerSupportQueries.bundles(taskId, 'turn-link').queryKey,
          ),
        ).toBeUndefined();
        expect(
          client.getQueryData(taskQueries.graph(taskId).queryKey),
        ).toBeUndefined();
      });
    },
  );
});
