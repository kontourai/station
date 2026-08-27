// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { setClientCredentialResolver } from '../client/http';
import { taskQueries } from '../queryFactories';
import { taskBasisQueries } from '../task-basis';
import {
  taskToolResultQueries,
  useAttachTaskToolResultReferenceMutation,
  useSessionToolResultQuery,
  useTaskToolResultReferencesQuery,
} from '../task-tool-results';

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://station.test'),
}));
afterEach(() => {
  cleanup();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});
const requestScope = {
  apiBase: 'http://station.test',
  authorityKey: 'connection-a:1',
};
const nextRequestScope = {
  apiBase: 'http://station.test',
  authorityKey: 'connection-b:2',
};
beforeEach(() => {
  setClientCredentialResolver(() => ({
    origin: requestScope.apiBase,
    requestAuthority: { ...requestScope, isCurrent: () => true },
  }));
});
function ref(resultId: string) {
  return {
    authority: '@kontourai/thread',
    schemaVersion: '1.2.0',
    kind: 'result',
    threadId: 'session-a',
    resultId,
  };
}

function available(id: string) {
  return {
    success: true,
    data: [
      {
        id: `link-${id}`,
        state: 'available',
        ref: ref(id),
        result: {
          resultId: id,
          name: 'fixture-tool',
          terminalStatus: 'success',
          content: [{ type: 'text', text: `protected-${id}` }],
          truncated: false,
          omittedParts: 0,
          omittedTextBytes: 0,
          omittedMetadataBytes: 0,
        },
      },
    ],
  };
}
function direct(id: string) {
  return {
    success: true,
    data: {
      sessionId: 'session-a',
      eventId: id,
      result: {
        resultId: id,
        name: 'fixture-tool',
        terminalStatus: 'success',
        content: [{ type: 'text', text: `protected-${id}` }],
        truncated: false,
        omittedParts: 0,
        omittedTextBytes: 0,
        omittedMetadataBytes: 0,
      },
    },
  };
}
function attached(taskId: string, eventId: string) {
  return {
    success: true,
    data: {
      id: `link-${eventId}`,
      sourceType: 'task',
      sourceId: taskId,
      targetType: 'tool_result',
      targetId: `tool-result/session-a/${eventId}`,
      relationType: 'references_tool_result',
      confidence: 1,
      createdAt: '2026-08-25T00:00:00.000Z',
      source: 'user',
    },
  };
}
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}
function harness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
  return { client, wrapper };
}

describe('protected tool-result query lifecycle', () => {
  test.each([401, 403, 404, 503, 'malformed', 'network'] as const)(
    'withholds prior content and settles a %s failure until explicit retry',
    async (failure) => {
      const { client, wrapper } = harness();
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(response(available('old')));
      if (failure === 'network')
        fetch.mockRejectedValueOnce(new Error('PRIVATE_URL_CANARY'));
      else
        fetch.mockResolvedValueOnce(
          response(
            failure === 'malformed'
              ? { success: true, data: [{ private: 'PRIVATE_BODY_CANARY' }] }
              : { success: false, error: 'PRIVATE_BODY_CANARY' },
            typeof failure === 'number' ? failure : 200,
          ),
        );
      fetch.mockResolvedValueOnce(response(available('after-retry')));
      vi.stubGlobal('fetch', fetch);
      const observer = renderHook(
        () => useTaskToolResultReferencesQuery('task-a'),
        { wrapper },
      );
      await waitFor(() =>
        expect(observer.result.current.data).toMatchObject([
          { result: { resultId: 'old' } },
        ]),
      );
      client.setQueryData(taskQueries.turnReferences('task-a').queryKey, [
        { secret: 'prior-answer' },
      ]);
      await act(async () => {
        await observer.result.current.refetch();
      });
      await waitFor(() => {
        expect(observer.result.current.data).toBeUndefined();
        expect(observer.result.current.error?.message).toBe(
          'Tool result unavailable',
        );
        expect(observer.result.current.isLoading).toBe(false);
      });
      const cached = client.getQueryData(
        taskToolResultQueries.references('task-a').queryKey,
      );
      expect(JSON.stringify(cached)).not.toContain('protected-old');
      expect(JSON.stringify(cached)).not.toContain('PRIVATE_');
      expect(
        client.getQueryData(taskQueries.turnReferences('task-a').queryKey),
      ).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(2);
      await act(async () => {
        await observer.result.current.refetch();
      });
      await waitFor(() =>
        expect(observer.result.current.data).toMatchObject([
          { result: { resultId: 'after-retry' } },
        ]),
      );
      observer.unmount();
      client.clear();
    },
  );

  test('task replacement cannot display a late prior-task read', async () => {
    const { client, wrapper } = harness();
    let releaseOld!: (response: Response) => void;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseOld = resolve;
          }),
      )
      .mockResolvedValueOnce(response(available('new-task')));
    vi.stubGlobal('fetch', fetch);
    const observer = renderHook(
      ({ taskId }) => useTaskToolResultReferencesQuery(taskId),
      {
        wrapper,
        initialProps: { taskId: 'task-old' },
      },
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const oldSignal = fetch.mock.calls[0]?.[1]?.signal;
    observer.rerender({ taskId: 'task-new' });
    await waitFor(() =>
      expect(observer.result.current.data).toMatchObject([
        { result: { resultId: 'new-task' } },
      ]),
    );
    expect(oldSignal).toBeInstanceOf(AbortSignal);
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => {
      releaseOld(response(available('old-task')));
    });
    expect(observer.result.current.data).toMatchObject([
      { result: { resultId: 'new-task' } },
    ]);
    expect(
      client.getQueryData(
        taskToolResultQueries.references('task-old').queryKey,
      ),
    ).toBeUndefined();
    observer.unmount();
    client.clear();
  });

  test('tuple replacement and unmount abort direct result reads', async () => {
    const { client, wrapper } = harness();
    let releaseOld!: (response: Response) => void;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseOld = resolve;
          }),
      )
      .mockResolvedValueOnce(response(direct('event-new')))
      .mockImplementationOnce(() => new Promise(() => {}));
    vi.stubGlobal('fetch', fetch);
    const observer = renderHook(
      ({ eventId }) =>
        useSessionToolResultQuery('session-a', eventId, { requestScope }),
      { wrapper, initialProps: { eventId: 'event-old' } },
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const oldSignal = fetch.mock.calls[0]?.[1]?.signal;
    observer.rerender({ eventId: 'event-new' });
    await waitFor(() =>
      expect(observer.result.current.data?.resultId).toBe('event-new'),
    );
    expect(oldSignal).toBeInstanceOf(AbortSignal);
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => releaseOld(response(direct('event-old'))));
    expect(observer.result.current.data?.resultId).toBe('event-new');

    void observer.result.current.refetch().catch(() => undefined);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    const unmountSignal = fetch.mock.calls[2]?.[1]?.signal;
    observer.unmount();
    await waitFor(() => expect(unmountSignal?.aborted).toBe(true));
    client.clear();
  });

  test('direct result lookup fails closed before fetching without a bound scope', async () => {
    const { client, wrapper } = harness();
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetch);
    const observer = renderHook(
      () => useSessionToolResultQuery('session-a', 'event-a'),
      { wrapper },
    );
    await waitFor(() => expect(observer.result.current.isFetching).toBe(false));
    expect(observer.result.current.data).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    observer.unmount();
    client.clear();
  });

  test('successful keep invalidates only the destination task basis and kept list', async () => {
    const { client, wrapper } = harness();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(response(attached('task-a', 'event-a'))),
    );
    const mutation = renderHook(
      () => useAttachTaskToolResultReferenceMutation({ requestScope }),
      { wrapper },
    );
    await act(async () => {
      await mutation.result.current.mutateAsync({
        taskId: 'task-a',
        sessionId: 'session-a',
        eventId: 'event-a',
        sourceSurface: 'nativeBasis',
      });
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: taskToolResultQueries.references('task-a', requestScope)
        .queryKey,
      exact: true,
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: taskBasisQueries.scope('task-a', requestScope),
    });
    expect(invalidate).not.toHaveBeenCalledWith({
      queryKey: taskToolResultQueries.references('task-b', requestScope)
        .queryKey,
      exact: true,
    });
    mutation.unmount();
    client.clear();
  });

  test('a pending keep settles against its invocation scope and callbacks after a rerender', async () => {
    const { client, wrapper } = harness();
    let release!: (value: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof globalThis.fetch>().mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      ),
    );
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const onSuccessA = vi.fn();
    const onSuccessB = vi.fn();
    const mutation = renderHook(
      ({ requestScope, onSuccess }) =>
        useAttachTaskToolResultReferenceMutation({ requestScope, onSuccess }),
      {
        wrapper,
        initialProps: { requestScope, onSuccess: onSuccessA },
      },
    );
    const pending = mutation.result.current.mutateAsync({
      taskId: 'task-a',
      sessionId: 'session-a',
      eventId: 'event-a',
      sourceSurface: 'nativeBasis',
    });
    await waitFor(() => expect(release).toBeTypeOf('function'));
    mutation.rerender({
      requestScope: nextRequestScope,
      onSuccess: onSuccessB,
    });
    release(response(attached('task-a', 'event-a')));
    await pending;
    expect(onSuccessA).toHaveBeenCalledOnce();
    expect(onSuccessB).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: taskToolResultQueries.references('task-a', requestScope)
        .queryKey,
      exact: true,
    });
    expect(invalidate).not.toHaveBeenCalledWith({
      queryKey: taskToolResultQueries.references('task-a', nextRequestScope)
        .queryKey,
      exact: true,
    });
    mutation.unmount();
    client.clear();
  });

  test('failed keep tombstones both mounted observers without touching another task', async () => {
    const { client, wrapper } = harness();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(available('event-a')))
      .mockResolvedValueOnce(response({ success: false }, 403))
      .mockResolvedValueOnce(response({ success: false }, 403));
    vi.stubGlobal('fetch', fetch);
    client.setQueryData(
      taskToolResultQueries.references('task-b', requestScope).queryKey,
      [
        {
          id: 'link-b',
          state: 'available',
          ref: ref('event-b'),
          result: { private: 'other-task' },
        },
      ],
    );
    client.setQueryData(
      taskToolResultQueries.references('task-a', nextRequestScope).queryKey,
      [{ private: 'other-authority' }],
    );
    client.setQueryData(
      taskBasisQueries.task('task-a', undefined, requestScope),
      {
        private: 'basis-a',
      },
    );
    const first = renderHook(
      () => useTaskToolResultReferencesQuery('task-a', { requestScope }),
      { wrapper },
    );
    const second = renderHook(
      () => useTaskToolResultReferencesQuery('task-a', { requestScope }),
      { wrapper },
    );
    await waitFor(() => {
      expect(first.result.current.data).toHaveLength(1);
      expect(second.result.current.data).toHaveLength(1);
    });
    const mutation = renderHook(
      () => useAttachTaskToolResultReferenceMutation({ requestScope }),
      { wrapper },
    );
    await expect(
      mutation.result.current.mutateAsync({
        taskId: 'task-a',
        sessionId: 'session-a',
        eventId: 'event-a',
        sourceSurface: 'nativeBasis',
      }),
    ).rejects.toMatchObject({ message: 'Tool result unavailable' });
    await waitFor(() => {
      expect(first.result.current.data).toBeUndefined();
      expect(second.result.current.data).toBeUndefined();
      expect(
        client.getQueryData(
          taskToolResultQueries.references('task-a', requestScope).queryKey,
        ),
      ).not.toMatchObject([
        { result: { content: [{ text: 'protected-event-a' }] } },
      ]);
      expect(
        client.getQueryData(
          taskBasisQueries.task('task-a', undefined, requestScope),
        ),
      ).toBeUndefined();
    });
    expect(
      client.getQueryData(
        taskToolResultQueries.references('task-b', requestScope).queryKey,
      ),
    ).toMatchObject([{ result: { private: 'other-task' } }]);
    expect(
      client.getQueryData(
        taskToolResultQueries.references('task-a', nextRequestScope).queryKey,
      ),
    ).toMatchObject([{ private: 'other-authority' }]);
    first.unmount();
    second.unmount();
    mutation.unmount();
    client.setQueryData(
      taskToolResultQueries.references('task-a', requestScope).queryKey,
      [{ private: 'inactive-protected-result' }],
    );
    const inactiveMutation = renderHook(
      () => useAttachTaskToolResultReferenceMutation({ requestScope }),
      { wrapper },
    );
    await expect(
      inactiveMutation.result.current.mutateAsync({
        taskId: 'task-a',
        sessionId: 'session-a',
        eventId: 'event-a',
        sourceSurface: 'nativeBasis',
      }),
    ).rejects.toMatchObject({ message: 'Tool result unavailable' });
    expect(
      client.getQueryData(
        taskToolResultQueries.references('task-a', requestScope).queryKey,
      ),
    ).toBeUndefined();
    inactiveMutation.unmount();
    client.clear();
  });
});
