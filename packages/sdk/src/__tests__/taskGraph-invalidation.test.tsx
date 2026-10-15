// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect, test, vi } from 'vitest';
import {
  useCreateTaskMutation,
  useDispatchTaskMutation,
  useUpdateTaskStatusMutation,
} from '../query-domains/taskGraph';
import { taskQueries } from '../queryFactories';

vi.mock('../api', () => ({ _getApiBase: async () => 'http://station.test' }));
vi.mock('../client/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../client/http')>()),
  authenticatedFetch: async () =>
    Response.json({ success: true, data: { id: 'task-new' } }),
}));

test.each([
  [
    'create',
    () => {
      const mutation = useCreateTaskMutation();
      return async () => {
        await mutation.mutateAsync({ projectId: 'alpha', title: 'New task' });
      };
    },
  ],
  [
    'status',
    () => {
      const mutation = useUpdateTaskStatusMutation();
      return async () => {
        await mutation.mutateAsync({ taskId: 'task-new', status: 'ready' });
      };
    },
  ],
  [
    'dispatch',
    () => {
      const mutation = useDispatchTaskMutation();
      return async () => {
        await mutation.mutateAsync({ taskId: 'task-new' });
      };
    },
  ],
] as const)(
  '%s invalidates every Task list without invalidating other domains',
  async (_name, useMutate) => {
    const client = new QueryClient();
    const listKeys = [
      taskQueries.list().queryKey,
      taskQueries.list('alpha').queryKey,
      taskQueries.list('beta').queryKey,
      taskQueries.list('alpha', {
        apiBase: 'http://station.test',
        authorityKey: 'local',
      }).queryKey,
    ];
    const otherKeys = [
      ['projects', 'alpha'],
      taskQueries.graph('task-new').queryKey,
    ];
    for (const queryKey of [...listKeys, ...otherKeys]) {
      client.setQueryData(queryKey, []);
    }
    const view = renderHook(useMutate, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    try {
      await act(async () => {
        await view.result.current();
      });
      for (const queryKey of listKeys) {
        expect(
          client.getQueryState(queryKey)?.isInvalidated,
          JSON.stringify(queryKey),
        ).toBe(true);
      }
      for (const queryKey of otherKeys) {
        expect(
          client.getQueryState(queryKey)?.isInvalidated,
          JSON.stringify(queryKey),
        ).toBe(false);
      }
    } finally {
      view.unmount();
      client.clear();
    }
  },
);
