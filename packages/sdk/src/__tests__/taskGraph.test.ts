import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reactQueryMocks = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
  useMutation: vi.fn((options) => options),
  useQuery: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  hashKey: vi.fn(() => 'task-graph-test-query'),
  useMutation: reactQueryMocks.useMutation,
  useQuery: reactQueryMocks.useQuery,
  useQueryClient: vi.fn(() => ({
    invalidateQueries: reactQueryMocks.invalidateQueries,
    getQueryDefaults: vi.fn(() => ({})),
  })),
}));

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  // This test exercises query-option wiring, not React's effect lifecycle.
  useEffect: vi.fn(),
}));

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://example.test'),
}));

import { setClientCredentialResolver } from '../client/http';
import type { TaskReferenceInput, TaskWorkspaceBinding } from '../index';
import {
  createTask,
  createTaskReference,
  dispatchTask,
  fetchSessionRelations,
  fetchTaskGraph,
  fetchTasks,
  fetchTaskTurnReferences,
  updateTaskStatus,
  useCreateTaskReferenceMutation,
  useTaskTurnReferencesQuery,
} from '../query-domains/taskGraph';
import { taskQueries } from '../queryFactories';
import { useAttachTaskUserInputReferenceMutation } from '../task-user-input-references';

function mockJsonResponse(payload: unknown, ok = true) {
  vi.mocked(fetch).mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => payload,
  } as Response);
}

describe('taskGraph SDK domain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    setClientCredentialResolver(undefined);
    vi.unstubAllGlobals();
  });

  it('fetches tasks for a project', async () => {
    mockJsonResponse({ success: true, data: [{ id: 'task-1' }] });

    await expect(fetchTasks({ projectId: 'project-alpha' })).resolves.toEqual([
      { id: 'task-1' },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/tasks?projectId=project-alpha',
    );
  });

  it('keeps Task query keys isolated by task id', () => {
    expect(taskQueries.task('task-a').queryKey).toEqual(['task', 'task-a']);
    expect(taskQueries.task('task-b').queryKey).toEqual(['task', 'task-b']);
    expect(taskQueries.graph('task-a').queryKey).toEqual([
      'task-graph',
      'task-a',
    ]);
    expect(taskQueries.graph('task-b').queryKey).toEqual([
      'task-graph',
      'task-b',
    ]);
    expect(taskQueries.turnReferences('task-a').queryKey).toEqual([
      'task-turn-references',
      'task-a',
    ]);
    expect(taskQueries.userInputReferences('task-a').queryKey).toEqual([
      'task-user-input-references',
      'task-a',
    ]);
  });

  it('reauthorizes protected Task answer references whenever the workspace remounts', () => {
    reactQueryMocks.useQuery.mockReturnValue({
      data: [],
      isFetching: false,
      isLoading: false,
    });
    useTaskTurnReferencesQuery('task-a');
    expect(reactQueryMocks.useQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ['task-turn-references', 'task-a'],
        refetchOnMount: 'always',
      }),
    );
  });

  it('withholds cached protected answers while mount reauthorization is in flight', () => {
    reactQueryMocks.useQuery.mockReturnValue({
      data: [{ id: 'old-link', state: 'available' }],
      isFetching: true,
      isLoading: false,
    });
    const result = useTaskTurnReferencesQuery('task-a');
    expect(result.data).toBeUndefined();
    expect(result.isLoading).toBe(true);
  });

  it('withholds cached protected answers when an offline mount is paused before reauthorization', () => {
    reactQueryMocks.useQuery.mockReturnValue({
      data: [{ id: 'old-link', state: 'available' }],
      isFetching: false,
      isLoading: false,
      isFetchedAfterMount: false,
      fetchStatus: 'paused',
    });
    const result = useTaskTurnReferencesQuery('task-a');
    expect(result.data).toBeUndefined();
    expect(result.isLoading).toBe(true);
  });

  it('withholds prior protected data after the new mount reauthorization fails', () => {
    reactQueryMocks.useQuery.mockReturnValue({
      data: [{ id: 'old-link', state: 'available' }],
      isFetching: false,
      isLoading: false,
      isFetchedAfterMount: true,
      status: 'error',
      fetchStatus: 'idle',
      error: new Error('Assistant answer not found'),
    });
    const result = useTaskTurnReferencesQuery('task-a');
    expect(result.data).toBeUndefined();
  });

  it('creates tasks and updates task status', async () => {
    mockJsonResponse({ success: true, data: { id: 'task-2' } });

    await expect(
      createTask({
        projectId: 'project-alpha',
        title: 'Create SDK task',
        priority: 'normal',
      }),
    ).resolves.toEqual({ id: 'task-2' });
    const [createUrl, createInit] = vi.mocked(fetch).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(createUrl).toBe('http://example.test/api/tasks');
    expect(createInit.method).toBe('POST');
    expect(createInit.body).toBe(
      JSON.stringify({
        projectId: 'project-alpha',
        title: 'Create SDK task',
        priority: 'normal',
      }),
    );
    expect(new Headers(createInit.headers).get('Content-Type')).toBe(
      'application/json',
    );

    mockJsonResponse({
      success: true,
      data: { id: 'task-2', status: 'ready' },
    });
    await expect(
      updateTaskStatus({ taskId: 'task-2', status: 'ready' }),
    ).resolves.toEqual({ id: 'task-2', status: 'ready' });
    expect(fetch).toHaveBeenCalledTimes(2);
    const [statusUrl, statusInit] = vi.mocked(fetch).mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect(statusUrl).toBe('http://example.test/api/tasks/task-2/status');
    expect(statusInit.method).toBe('PATCH');
    expect(statusInit.body).toBe(JSON.stringify({ status: 'ready' }));
    expect(new Headers(statusInit.headers).get('Content-Type')).toBe(
      'application/json',
    );
  });

  it('creates an encoded Task reference through authenticated transport', async () => {
    setClientCredentialResolver(() => ({
      credential: 'sdk-task-reference-token',
      origin: 'http://example.test',
    }));
    mockJsonResponse({ success: true, data: { id: 'link-1' } });

    await expect(
      createTaskReference({
        taskId: 'task / 1',
        kind: 'artifact',
        targetId: 'artifact://plans/1',
        metadata: { label: 'Plan' },
        sourceSurface: 'task-workspace',
      }),
    ).resolves.toEqual({ id: 'link-1' });

    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/tasks/task%20%2F%201/references',
      expect.objectContaining({ method: 'POST' }),
    );
    const init = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('Authorization')).toBe(
      'Bearer sdk-task-reference-token',
    );
    expect(new Headers(init.headers).get('Content-Type')).toBe(
      'application/json',
    );
    expect(init.body).toBe(
      JSON.stringify({
        kind: 'artifact',
        targetId: 'artifact://plans/1',
        metadata: { label: 'Plan' },
        sourceSurface: 'task-workspace',
      }),
    );
  });

  it('surfaces Task reference API errors', async () => {
    mockJsonResponse({ success: false, error: 'Reference is invalid' }, false);

    await expect(
      createTaskReference({
        taskId: 'task-1',
        kind: 'receipt',
        targetId: 'receipt://build-1',
      }),
    ).rejects.toThrow('Reference is invalid');
  });

  it('creates a typed turn reference without a caller-built target id', async () => {
    mockJsonResponse({ success: true, data: { id: 'turn-link-1' } });

    await expect(
      createTaskReference({
        taskId: 'task-1',
        kind: 'turn',
        sessionId: 'session-1',
        turnId: 'turn-1',
        sourceSurface: 'chat',
      }),
    ).resolves.toEqual({ id: 'turn-link-1' });

    const init = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBe(
      JSON.stringify({
        kind: 'turn',
        sessionId: 'session-1',
        turnId: 'turn-1',
        sourceSurface: 'chat',
      }),
    );
  });

  it('maps available Task answers and keeps unavailable references source-free', async () => {
    mockJsonResponse({
      success: true,
      data: [
        {
          id: 'link-1',
          state: 'available',
          sessionId: 'session-1',
          turnId: 'turn-1',
          answer: {
            role: 'assistant',
            parts: [{ type: 'text', text: 'Exact answer' }],
            metadata: { turnId: 'turn-1', provenance: { envelopeVersion: 99 } },
          },
          support: { state: 'unassessed' },
        },
        { id: 'link-2', state: 'unavailable' },
      ],
    });

    await expect(fetchTaskTurnReferences('task-1')).resolves.toEqual([
      {
        id: 'link-1',
        state: 'available',
        sessionId: 'session-1',
        turnId: 'turn-1',
        answer: {
          role: 'assistant',
          content: 'Exact answer',
          contentParts: [{ type: 'text', content: 'Exact answer' }],
          turnId: 'turn-1',
          provenance: { envelopeVersion: 99 },
        },
        support: { state: 'unassessed' },
      },
      { id: 'link-2', state: 'unavailable' },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/tasks/task-1/turn-references',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('exports Task workspace and reference types', () => {
    const workspace: TaskWorkspaceBinding = {
      workingDirectory: '/workspace/task-1',
      branch: 'feature/task-1',
    };
    const reference: TaskReferenceInput = {
      kind: 'external',
      targetId: 'flow:run-1',
    };

    expect(workspace.branch).toBe('feature/task-1');
    expect(reference.kind).toBe('external');
  });

  it('invalidates only the submitted Task detail, graph, and answer projection after reference creation', async () => {
    const mutation = useCreateTaskReferenceMutation() as {
      onSuccess?: (
        data: unknown,
        variables: { taskId: string },
      ) => void | Promise<void>;
    };

    await mutation.onSuccess?.({ id: 'link-1' }, { taskId: 'task-a' });

    expect(reactQueryMocks.invalidateQueries).toHaveBeenNthCalledWith(1, {
      queryKey: ['tasks', 'all'],
      exact: true,
    });
    expect(reactQueryMocks.invalidateQueries).toHaveBeenNthCalledWith(2, {
      queryKey: ['task', 'task-a'],
      exact: true,
    });
    expect(reactQueryMocks.invalidateQueries).toHaveBeenNthCalledWith(3, {
      queryKey: ['task-graph', 'task-a'],
      exact: true,
    });
    expect(reactQueryMocks.invalidateQueries).toHaveBeenNthCalledWith(4, {
      queryKey: ['task-turn-references', 'task-a'],
      exact: true,
    });
    expect(reactQueryMocks.invalidateQueries).toHaveBeenNthCalledWith(5, {
      queryKey: ['task-user-input-references', 'task-a'],
      exact: true,
    });
    expect(reactQueryMocks.invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ['task', 'task-b'],
    });
    expect(reactQueryMocks.invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ['task-graph', 'task-b'],
    });
  });

  it('keeps the typed user-input attach mutation on the same exact success invalidation scope', async () => {
    const mutation = useAttachTaskUserInputReferenceMutation() as {
      onSuccess?: (
        data: unknown,
        variables: { taskId: string },
      ) => void | Promise<void>;
    };

    await mutation.onSuccess?.({ id: 'input-link' }, { taskId: 'task-a' });

    expect(reactQueryMocks.invalidateQueries).toHaveBeenNthCalledWith(1, {
      queryKey: ['tasks', 'all'],
      exact: true,
    });
    expect(reactQueryMocks.invalidateQueries).toHaveBeenNthCalledWith(2, {
      queryKey: ['task', 'task-a'],
      exact: true,
    });
    expect(reactQueryMocks.invalidateQueries).toHaveBeenNthCalledWith(3, {
      queryKey: ['task-graph', 'task-a'],
      exact: true,
    });
    expect(reactQueryMocks.invalidateQueries).toHaveBeenNthCalledWith(4, {
      queryKey: ['task-turn-references', 'task-a'],
      exact: true,
    });
    expect(reactQueryMocks.invalidateQueries).toHaveBeenNthCalledWith(5, {
      queryKey: ['task-user-input-references', 'task-a'],
      exact: true,
    });
  });

  it('dispatches tasks and reads relation graph surfaces', async () => {
    mockJsonResponse({
      success: true,
      data: {
        dispatch: { sessionId: 'session-1' },
        links: [{ relationType: 'spawned_session' }],
      },
    });

    await expect(
      dispatchTask({
        taskId: 'task-3',
        dispatch: { relatedFiles: ['src/index.ts'] },
      }),
    ).resolves.toEqual({
      dispatch: { sessionId: 'session-1' },
      links: [{ relationType: 'spawned_session' }],
    });
    const [dispatchUrl, dispatchInit] = vi.mocked(fetch).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(dispatchUrl).toBe('http://example.test/api/tasks/task-3/dispatch');
    expect(dispatchInit.method).toBe('POST');
    expect(dispatchInit.body).toBe(
      JSON.stringify({ relatedFiles: ['src/index.ts'] }),
    );
    expect(new Headers(dispatchInit.headers).get('Content-Type')).toBe(
      'application/json',
    );

    mockJsonResponse({
      success: true,
      data: { task: { id: 'task-3' }, links: [] },
    });
    await expect(fetchTaskGraph('task-3')).resolves.toEqual({
      task: { id: 'task-3' },
      links: [],
    });
    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/tasks/task-3/graph',
    );

    mockJsonResponse({
      success: true,
      data: { sessionId: 'session-1', links: [] },
    });
    await expect(fetchSessionRelations('session-1')).resolves.toEqual({
      sessionId: 'session-1',
      links: [],
    });
    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/tasks/sessions/session-1/relations',
    );
  });
});
