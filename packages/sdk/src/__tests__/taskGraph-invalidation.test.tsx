// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  StationRequestAuthorityError,
  setClientCredentialResolver,
} from '../client/http';
import { useUpdateProjectMutation } from '../index';
import {
  useCreateTaskMutation,
  useCreateTaskReferenceMutation,
  useDispatchTaskMutation,
  useTasksQuery,
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
afterEach(() => {
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

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

test('returning to a Project refreshes a status changed while its Task list was unmounted', async () => {
  let status = 'todo';
  let reads = 0;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/tasks' && init?.method === undefined) {
      expect(url.searchParams.get('projectId')).toBe('alpha');
      reads += 1;
      return Response.json({
        success: true,
        data: [{ id: 'task-one', status }],
      });
    }
    if (
      url.pathname === '/api/tasks/task-one/status' &&
      init?.method === 'PATCH'
    ) {
      status = JSON.parse(String(init.body)).status;
      return Response.json({ success: true, data: { id: 'task-one', status } });
    }
    throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
  });
  vi.stubGlobal('fetch', fetch);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  let list = renderHook(() => useTasksQuery('alpha'), { wrapper });
  const changeStatus = renderHook(() => useUpdateTaskStatusMutation(), {
    wrapper,
  });
  try {
    await waitFor(() =>
      expect(list.result.current.data?.[0]?.status).toBe('todo'),
    );
    list.unmount();
    list = renderHook(() => useTasksQuery('alpha'), { wrapper });
    expect(list.result.current.data?.[0]?.status).toBe('todo');
    expect(reads).toBe(1);
    list.unmount();
    await act(async () => {
      await changeStatus.result.current.mutateAsync({
        taskId: 'task-one',
        status: 'in_progress',
      });
    });
    list = renderHook(() => useTasksQuery('alpha'), { wrapper });
    await waitFor(() =>
      expect(list.result.current.data?.[0]?.status).toBe('in_progress'),
    );
    expect(reads).toBe(2);
  } finally {
    list.unmount();
    changeStatus.unmount();
    client.clear();
  }
});

const creatingAccount = {
  apiBase: 'http://station.test',
  authorityKey: 'creating-account',
};

test.each([
  {
    method: 'POST',
    path: '/api/tasks',
    useEffectMutation: () => {
      const { mutateAsync } = useCreateTaskMutation();
      return () =>
        mutateAsync({
          requestScope: creatingAccount,
          projectId: 'alpha',
          title: 'Continuation',
        });
    },
    getCacheKey: (scope: typeof creatingAccount) =>
      taskQueries.list('alpha', scope).queryKey,
  },
  {
    method: 'POST',
    path: '/api/tasks/task-new/references',
    useEffectMutation: () => {
      const { mutateAsync } = useCreateTaskReferenceMutation();
      return () =>
        mutateAsync({
          requestScope: creatingAccount,
          taskId: 'task-new',
          kind: 'turn',
          sessionId: 'session',
          turnId: 'turn',
        });
    },
    getCacheKey: (scope: typeof creatingAccount) =>
      taskQueries.list('alpha', scope).queryKey,
  },
  {
    method: 'PUT',
    path: '/api/projects/alpha',
    useEffectMutation: () => {
      const { mutateAsync } = useUpdateProjectMutation();
      return () =>
        mutateAsync({
          requestScope: creatingAccount,
          slug: 'alpha',
          description: 'Project brief',
        });
    },
    getCacheKey: (scope: typeof creatingAccount) => [
      'projects',
      'alpha',
      'page-view',
      scope.apiBase,
      scope.authorityKey,
    ],
  },
])(
  '$method $path keeps same-origin accounts separate',
  async ({ method, path, useEffectMutation, getCacheKey }) => {
    const otherAccount = { ...creatingAccount, authorityKey: 'other-account' };
    let active = otherAccount;
    setClientCredentialResolver(() => {
      const captured = active;
      return {
        origin: captured.apiBase,
        requestAuthority: { ...captured, isCurrent: () => active === captured },
      };
    });
    const fetch = vi.mocked(globalThis.fetch);
    const client = new QueryClient();
    const creatingKey = getCacheKey(creatingAccount);
    const otherKey = getCacheKey(otherAccount);
    client.setQueryData(creatingKey, []);
    client.setQueryData(otherKey, []);
    const view = renderHook(useEffectMutation, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    try {
      await act(async () => {
        await expect(view.result.current()).rejects.toBeInstanceOf(
          StationRequestAuthorityError,
        );
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(client.getQueryState(creatingKey)?.isInvalidated).toBe(false);
      expect(client.getQueryState(otherKey)?.isInvalidated).toBe(false);

      active = creatingAccount;
      await act(async () => {
        await expect(view.result.current()).resolves.toEqual({
          id: 'task-new',
        });
      });
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledWith(
        `${creatingAccount.apiBase}${path}`,
        expect.objectContaining({ method }),
      );
      expect(
        JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)),
      ).not.toHaveProperty('requestScope');
      expect(client.getQueryState(creatingKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(otherKey)?.isInvalidated).toBe(false);
    } finally {
      view.unmount();
      client.clear();
    }
  },
);

test('scoped Task creation refreshes the Project list that is already open', async () => {
  setClientCredentialResolver(() => ({
    origin: creatingAccount.apiBase,
    requestAuthority: { ...creatingAccount, isCurrent: () => true },
  }));
  const task = { id: 'task-created', title: 'Continuation' };
  const tasks: (typeof task)[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname !== '/api/tasks')
      throw new Error(`Unexpected Task request: ${url}`);
    if (init?.method === 'POST') {
      tasks.push(task);
      return Response.json({ success: true, data: task });
    }
    expect(url.searchParams.get('projectId')).toBe('alpha');
    return Response.json({ success: true, data: tasks });
  });
  vi.stubGlobal('fetch', fetch);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false } },
  });
  const view = renderHook(
    () => ({
      list: useTasksQuery('alpha'),
      mutation: useCreateTaskMutation(),
    }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  try {
    await waitFor(() => expect(view.result.current.list.data).toEqual([]));
    await act(async () => {
      await expect(
        view.result.current.mutation.mutateAsync({
          requestScope: creatingAccount,
          projectId: 'alpha',
          title: task.title,
        }),
      ).resolves.toEqual(task);
    });
    await waitFor(() => expect(view.result.current.list.data).toEqual([task]));
  } finally {
    view.unmount();
    client.clear();
  }
});
