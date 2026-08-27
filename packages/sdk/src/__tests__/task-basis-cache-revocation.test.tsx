/** @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const getTaskBasis = vi.hoisted(() => vi.fn());
vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://station.test'),
}));
vi.mock('../client/task-basis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../client/task-basis')>()),
  getTaskBasis,
}));

const { TaskBasisRequestError, taskBasisQueries, useTaskBasisQuery } =
  await import('../task-basis');

const projection = {
  version: 'surface.basis-projection/v1',
  answer: {
    owner: { authority: '@kontourai/thread' },
    state: 'available',
    observedAt: '2026-08-25T00:00:00.000Z',
    value: {
      ref: {
        authority: '@kontourai/thread',
        schemaVersion: '1.2.0',
        kind: 'assistant-message',
        standing: 'observed',
        threadId: 'session-a',
        messageId: 'message-a',
      },
      fact: 'answer-observed',
      observedAt: '2026-08-25T00:00:00.000Z',
    },
  },
  standing: 'execution-only',
  unresolvedReason: null,
  assessment: {
    owner: { authority: '@kontourai/surface' },
    state: 'not-captured',
    observedAt: '2026-08-25T00:00:00.000Z',
  },
  regions: {
    inputs: [],
    execution: [],
    process: [],
    outcomes: [],
    support: [],
    sources: [],
    live: [],
  },
  relationships: [],
  gaps: [],
};

describe('Task Basis protected-cache revocation', () => {
  beforeEach(() => {
    getTaskBasis.mockReset();
    getTaskBasis.mockImplementation(
      async (
        _apiBase: string,
        taskId: string,
        options: { answerReferenceId?: string },
      ) =>
        options.answerReferenceId
          ? projection
          : {
              version: 'station.task-basis-collection/v4',
              taskId,
              answers: [
                {
                  answerReferenceId: 'answer-a',
                  projection,
                },
              ],
              unassociated: [],
              keptToolResults: [],
              keptGateEvaluations: [],
              gaps: [],
            },
    );
  });

  test('tombstones selected and Whole Task siblings while the rejected observer settles', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const whole = renderHook(() => useTaskBasisQuery('task-a'), { wrapper });
    const selected = renderHook(
      () => useTaskBasisQuery('task-a', { answerReferenceId: 'answer-a' }),
      { wrapper },
    );
    await waitFor(() => {
      expect(whole.result.current.data).toBeDefined();
      expect(selected.result.current.data).toBeDefined();
    });
    expect(client.getQueryData(taskBasisQueries.task('task-a'))).toBeDefined();
    expect(
      client.getQueryData(taskBasisQueries.task('task-a', 'answer-a')),
    ).toBeDefined();

    const priorWhole = client.getQueryData(taskBasisQueries.task('task-a'));
    let resolveWhole: ((value: unknown) => void) | undefined;
    getTaskBasis.mockImplementation(
      async (
        _apiBase: string,
        _taskId: string,
        options: { answerReferenceId?: string },
      ) => {
        if (options.answerReferenceId) throw new TaskBasisRequestError(403);
        return await new Promise((resolve) => {
          resolveWhole = resolve;
        });
      },
    );
    void whole.result.current.refetch();
    await waitFor(() => expect(resolveWhole).toBeDefined());
    await act(async () => {
      await selected.result.current.refetch();
    });
    resolveWhole?.(priorWhole);
    await waitFor(() => {
      expect(client.getQueryData(taskBasisQueries.task('task-a'))).toBeNull();
      expect(
        client.getQueryData(taskBasisQueries.task('task-a', 'answer-a')),
      ).toBeNull();
      expect(whole.result.current.data).toBeUndefined();
      expect(selected.result.current.data).toBeUndefined();
      expect(selected.result.current.isFetching).toBe(false);
      expect(selected.result.current.error).toBeInstanceOf(
        TaskBasisRequestError,
      );
    });
    getTaskBasis.mockImplementation(
      async (
        _apiBase: string,
        _taskId: string,
        options: { answerReferenceId?: string },
      ) => (options.answerReferenceId ? projection : priorWhole),
    );
    await act(async () => {
      await selected.result.current.refetch();
    });
    await waitFor(() =>
      expect(selected.result.current.data).toEqual(projection),
    );
  });
});
