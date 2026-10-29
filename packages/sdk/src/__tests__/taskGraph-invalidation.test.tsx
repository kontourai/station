// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  useCreateTaskMutation,
  useCreateTaskReferenceMutation,
  useDispatchTaskMutation,
  useUpdateTaskStatusMutation,
} from '../query-domains/taskGraph';
import { taskQueries } from '../queryFactories';
import { useAttachTaskUserInputReferenceMutation } from '../task-user-input-references';

vi.mock('../api', () => ({ _getApiBase: async () => 'http://station.test' }));
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ success: true, data: { id: 'task-new' } }),
    ),
  );
});
afterEach(() => vi.unstubAllGlobals());

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
  [
    'reference',
    () => {
      const mutation = useCreateTaskReferenceMutation();
      return async () => {
        await mutation.mutateAsync({
          taskId: 'task-new',
          kind: 'artifact',
          targetId: 'artifact://plan',
        });
      };
    },
  ],
  [
    'user input reference',
    () => {
      const mutation = useAttachTaskUserInputReferenceMutation();
      return async () => {
        await mutation.mutateAsync({
          taskId: 'task-new',
          sessionId: 'session',
          eventId: 'input',
        });
      };
    },
  ],
] as const)(
  '%s refreshes affected Task caches without invalidating unrelated data',
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
    const taskKeys = [
      taskQueries.task('task-new').queryKey,
      taskQueries.graph('task-new').queryKey,
      taskQueries.claim('task-new').queryKey,
    ];
    const referenceKeys = [
      taskQueries.turnReferences('task-new').queryKey,
      taskQueries.userInputReferences('task-new').queryKey,
    ];
    const otherKeys = [
      ['projects', 'alpha'],
      ['sessions'],
      taskQueries.task('unrelated-task').queryKey,
      taskQueries.graph('unrelated-task').queryKey,
      taskQueries.claim('unrelated-task').queryKey,
      taskQueries.turnReferences('unrelated-task').queryKey,
    ];
    for (const queryKey of [
      ...listKeys,
      ...taskKeys,
      ...referenceKeys,
      ...otherKeys,
    ]) {
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
      for (const queryKey of taskKeys) {
        expect(
          client.getQueryState(queryKey)?.isInvalidated,
          JSON.stringify(queryKey),
        ).toBe(_name !== 'create');
      }
      for (const queryKey of referenceKeys) {
        expect(
          client.getQueryState(queryKey)?.isInvalidated,
          JSON.stringify(queryKey),
        ).toBe(_name === 'reference' || _name === 'user input reference');
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
