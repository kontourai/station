// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setClientCredentialResolver } from '../client/http';
import {
  fetchTaskChildren,
  setTaskWorkChat,
} from '../client/task-relationships';
import {
  taskRelationshipKey,
  useSetTaskParentMutation,
} from '../query-domains/taskRelationships';

beforeEach(() =>
  setClientCredentialResolver(() => ({
    origin: scope.apiBase,
    requestAuthority: scope,
  })),
);
afterEach(() => {
  cleanup();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});
const child = { taskId: 'child', taskCreatedAt: '2026-10-01T00:00:00.000Z' };
const old = { ...child, taskId: 'old' };
const next = { ...child, taskId: 'next' };
const scope = {
  apiBase: 'http://station.test',
  authorityKey: 'viewer',
  isCurrent: () => true,
};
const result = { child, parent: next, previousParent: old, revision: 2 };

function harness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

test('reparent refreshes both parent lists and child, preserving other connection and unrelated relationship caches', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ success: true, data: result })),
  );
  const { client, wrapper } = harness();
  const keys = [child, old, next].map((task) =>
    taskRelationshipKey(scope, task, 'children'),
  );
  const unrelated = taskRelationshipKey(
    scope,
    { ...child, taskId: 'other' },
    'children',
  );
  const otherAuthority = taskRelationshipKey(
    { ...scope, authorityKey: 'another-viewer' },
    old,
    'children',
  );
  for (const key of [...keys, unrelated, otherAuthority])
    client.setQueryData(key, []);
  const hook = renderHook(() => useSetTaskParentMutation(scope), { wrapper });
  await act(async () => {
    await hook.result.current.mutateAsync({
      operationId: 'move',
      child,
      parent: next,
      expectedRevision: 1,
    });
  });
  expect(keys.map((key) => client.getQueryState(key)?.isInvalidated)).toEqual([
    true,
    true,
    true,
  ]);
  expect(client.getQueryState(unrelated)?.isInvalidated).toBe(false);
  expect(client.getQueryState(otherAuthority)?.isInvalidated).toBe(false);
});

test('lost authority rejects the waiting mutation and keeps the canonical relationship cache untouched', async () => {
  let deliver!: (response: Response) => void;
  const fetch = vi.fn<typeof globalThis.fetch>(
    () =>
      new Promise<Response>((resolve) => {
        deliver = resolve;
      }),
  );
  vi.stubGlobal('fetch', fetch);
  let valid = true;
  const captured = { ...scope, isCurrent: () => valid };
  const { client, wrapper } = harness();
  const key = taskRelationshipKey(captured, child, 'children');
  client.setQueryData(key, ['authorized baseline']);
  const hook = renderHook(() => useSetTaskParentMutation(captured), {
    wrapper,
  });
  let pending!: Promise<unknown>;
  act(() => {
    pending = hook.result.current.mutateAsync({
      operationId: 'move',
      child,
      parent: next,
      expectedRevision: 1,
    });
  });
  // Wait for transport admission, then retire the captured reader before settlement.
  await act(async () => {
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  });
  valid = false;
  await act(async () => {
    deliver(Response.json({ success: true, data: result }));
    await expect(pending).rejects.toThrow('connection changed');
  });
  expect(client.getQueryData(key)).toEqual(['authorized baseline']);
  expect(client.getQueryState(key)?.isInvalidated).toBe(false);
});

test('dedicated client sends exact canonical conversation identity, revision and incarnation using encoded paths', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ success: true, data: { task: child, chats: [] } }),
  );
  vi.stubGlobal('fetch', fetch);
  await fetchTaskChildren(
    scope.apiBase,
    { ...child, taskId: 'child/slash' },
    { requestScope: scope },
  );
  await setTaskWorkChat(
    scope.apiBase,
    {
      operationId: 'unlink',
      task: child,
      conversationId: 'conversation-not-session',
      expectedRevision: 3,
      linked: false,
    },
    { requestScope: scope },
  );
  expect(String(fetch.mock.calls[0][0])).toContain(
    '/api/tasks/child%2Fslash/children?taskCreatedAt=',
  );
  expect(fetch.mock.calls[1][1]).toMatchObject({
    method: 'DELETE',
    body: JSON.stringify({
      operationId: 'unlink',
      task: child,
      conversationId: 'conversation-not-session',
      expectedRevision: 3,
    }),
  });
});
