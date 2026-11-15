/** @vitest-environment jsdom */
import type { TaskCodeReviewView } from '@kontourai/station-contracts/task-review';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  type ClientCredential,
  StationHttpError,
  setClientCredentialResolver,
} from '../client/http';
import {
  taskCodeReviewQueryKey,
  useTaskCodeReviewQuery,
} from '../query-domains/taskCodeReview';

const scope = {
  apiBase: 'https://station.example.test',
  authorityKey: 'review-authority',
  isCurrent: () => true,
};
const taskCreatedAt = '2026-11-01T00:00:00Z';
const clients: QueryClient[] = [];

function view(projectId: string): TaskCodeReviewView {
  return {
    version: 'station.task-code-review/v1',
    projectId,
    projectCreatedAt: '2026-10-01T00:00:00Z',
    projectSlug: 'same-slug',
    taskCreatedAt,
    workspace: {
      state: 'available',
      kind: 'project-checkout',
      path: `/workspace/${projectId}`,
    },
    canRequest: false,
    requestUnavailableReason: 'execution-not-authorized',
    reviewers: [],
    requests: [],
    omittedRequests: 0,
    requestsUnavailable: false,
  };
}

function response(projectId: string) {
  return new Response(
    JSON.stringify({ success: true, data: view(projectId) }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );
}

function fixture() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnMount: false },
    },
  });
  clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

beforeEach(() => {
  setClientCredentialResolver(
    () =>
      ({
        origin: scope.apiBase,
        credential: 'sdk-test-credential-not-for-production',
        requestAuthority: scope,
      }) satisfies ClientCredential,
  );
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

test('a replacement Project never receives cached review data for the same Task', async () => {
  let release!: (value: Response) => void;
  const held = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const projectId = url.searchParams.get('projectId');
    if (projectId === 'project-A') return response(projectId);
    if (projectId === 'project-B') return held;
    throw new Error('Unexpected Project read');
  });
  vi.stubGlobal('fetch', fetch);
  const { client, wrapper } = fixture();
  try {
    const { result, rerender } = renderHook(
      ({ projectId }) =>
        useTaskCodeReviewQuery(scope, projectId, 'task-1', taskCreatedAt),
      { wrapper, initialProps: { projectId: 'project-A' } },
    );
    await waitFor(() =>
      expect(result.current.data?.projectId).toBe('project-A'),
    );
    rerender({ projectId: 'project-B' });
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await act(async () => release(response('project-B')));
    await waitFor(() =>
      expect(result.current.data?.projectId).toBe('project-B'),
    );
    expect(
      client.getQueryData<TaskCodeReviewView>(
        taskCodeReviewQueryKey(scope, 'project-B', 'task-1', taskCreatedAt),
      )?.projectId,
    ).toBe('project-B');
  } finally {
    release(response('project-B'));
  }
});

test('a denied refresh exposes its error to the caller and hides prior review data', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(response('project-A'))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ success: false, error: 'Task access changed.' }),
        { status: 403 },
      ),
    );
  vi.stubGlobal('fetch', fetch);
  const { client, wrapper } = fixture();
  const { result } = renderHook(
    () => useTaskCodeReviewQuery(scope, 'project-A', 'task-1', taskCreatedAt),
    { wrapper },
  );
  await waitFor(() => expect(result.current.data?.projectId).toBe('project-A'));
  await act(async () => {
    const refreshed = await result.current.refetch({ throwOnError: false });
    expect(refreshed.isError).toBe(true);
    expect(refreshed.error).toBeInstanceOf(StationHttpError);
    expect(refreshed.error).toMatchObject({ status: 403 });
  });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.data).toBeUndefined();
  expect(
    client.getQueryState(
      taskCodeReviewQueryKey(scope, 'project-A', 'task-1', taskCreatedAt),
    )?.status,
  ).toBe('error');
});
