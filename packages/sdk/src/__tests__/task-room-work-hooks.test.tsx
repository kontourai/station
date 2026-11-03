/** @vitest-environment jsdom */
import { TASK_ROOM_WORK_VERSION } from '@kontourai/station-contracts/task-room-work';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { _setApiBase } from '../api-core';
import {
  type ClientCredential,
  setClientCredentialResolver,
} from '../client/http';
import { TaskRoomWorkNotSentError } from '../client/task-room-work';
import { useAppendProjectTaskRoomHumanMessageMutation } from '../query-domains/projectTaskRooms';
import { useTasksQuery } from '../query-domains/taskGraph';
import { useSetTaskWorkChatMutation } from '../query-domains/taskRelationships';
import { useSubmitTaskRoomAgentRequestMutation } from '../query-domains/taskRoomWork';

const apiBase = 'https://room.test';
const incarnation = '2026-09-30T12:00:00.000Z';
const input = {
  operationId: 'operation-1',
  agentId: 'researcher',
  prompt: 'Explore this idea',
};
const clients: QueryClient[] = [];
function wrapper() {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  clients.push(client);
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}
function response(data: unknown) {
  return new Response(JSON.stringify({ success: true, data }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
function credential(isCurrent: () => boolean): ClientCredential {
  return {
    origin: apiBase,
    credential: 'room-test-credential',
    requestAuthority: { apiBase, authorityKey: 'room-a', isCurrent },
  };
}
function messageReceipt() {
  return response({
    kind: 'committed',
    receipt: {
      schemaVersion: 'station.project-task-room-append-receipt/v1',
      proposalId: 'message-1',
      proposalDigest: 'a'.repeat(64),
      envelopeDigest: 'b'.repeat(64),
      coordinate: { channelId: 'channel-1', epoch: 0, seq: 1 },
      checkpoint: {
        channelId: 'channel-1',
        epoch: 0,
        throughSeq: 1,
        checkpointDigest: 'c'.repeat(64),
        retainedAnchorSeq: 0,
        retainedAnchorDigest: 'd'.repeat(64),
      },
      committedAt: incarnation,
      assurance: 'L0',
    },
  });
}
afterEach(() => {
  clients.splice(0).forEach((client) => client.clear());
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

test('the real request mutation refreshes readiness and refuses another create when the agent becomes unavailable', async () => {
  const scope = { apiBase, authorityKey: 'room-a', isCurrent: () => true };
  setClientCredentialResolver(() => credential(scope.isCurrent));
  let ready = true;
  let dispatched = false;
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    if (String(url).endsWith('/api/tasks'))
      return response([
        {
          id: 'task-1',
          workChatConversationIds: dispatched ? ['task:123'] : [],
        },
      ]);
    if (String(url).endsWith('/delegations/options'))
      return response({
        environment: { id: 'current', name: 'This Station', kind: 'current' },
        project: { slug: 'demo' },
        targets: [
          {
            id: 'researcher',
            name: 'Researcher',
            kind: 'agent',
            ready,
            models: [],
            capabilities: {
              resume: true,
              interrupt: true,
              approvals: true,
              modelSelection: false,
            },
          },
        ],
      });
    if (String(url).endsWith('/agent-requests'))
      return response({
        version: TASK_ROOM_WORK_VERSION,
        kind: 'available',
        records: [],
      });
    if (String(url).endsWith('/delegations')) {
      dispatched = true;
      return response({
        kind: 'recorded',
        replayed: false,
        record: {
          version: TASK_ROOM_WORK_VERSION,
          taskId: 'task-1',
          projectId: 'project-1',
          taskCreatedAt: incarnation,
          ...input,
          requesterId: 'task-room-requester:alice',
          sessionId: 'task:123',
          createdAt: incarnation,
          state: 'dispatched',
        },
      });
    }
    throw new Error(`Unexpected request: ${String(url)}`);
  });
  vi.stubGlobal('fetch', fetcher);
  const { result } = renderHook(
    () => ({
      tasks: useTasksQuery(undefined, { requestScope: scope }),
      mutation: useSubmitTaskRoomAgentRequestMutation(
        'task-1',
        incarnation,
        'demo',
        scope,
      ),
    }),
    { wrapper: wrapper() },
  );
  await waitFor(() =>
    expect(result.current.tasks.data?.[0].workChatConversationIds).toEqual([]),
  );
  await act(async () => {
    await expect(
      result.current.mutation.mutateAsync(input),
    ).resolves.toMatchObject({
      kind: 'recorded',
    });
  });
  await waitFor(() =>
    expect(result.current.tasks.data?.[0].workChatConversationIds).toEqual([
      'task:123',
    ]),
  );
  ready = false;
  await act(async () => {
    await expect(
      result.current.mutation.mutateAsync(input),
    ).rejects.toBeInstanceOf(TaskRoomWorkNotSentError);
  });
  expect(
    fetcher.mock.calls.filter(([url]) => String(url).endsWith('/delegations')),
  ).toHaveLength(1);
});

test('linking and unlinking a work chat refreshes an already mounted Task list', async () => {
  const scope = { apiBase, authorityKey: 'room-a', isCurrent: () => true };
  setClientCredentialResolver(() => credential(scope.isCurrent));
  const task = { taskId: 'task-1', taskCreatedAt: incarnation };
  let linked = false;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/api/tasks'))
      return response([
        {
          id: task.taskId,
          workChatConversationIds: linked ? ['work-chat'] : [],
        },
      ]);
    if (String(url).endsWith('/work-chats')) {
      linked = init?.method === 'POST';
      return response({
        task,
        conversationId: 'work-chat',
        linked,
        revision: linked ? 1 : 2,
      });
    }
    throw new Error(`Unexpected request: ${String(url)}`);
  });
  vi.stubGlobal('fetch', fetcher);
  const { result } = renderHook(
    () => ({
      tasks: useTasksQuery(undefined, { requestScope: scope }),
      mutation: useSetTaskWorkChatMutation(scope),
    }),
    { wrapper: wrapper() },
  );
  await waitFor(() =>
    expect(result.current.tasks.data?.[0].workChatConversationIds).toEqual([]),
  );
  for (const value of [true, false]) {
    await act(async () => {
      await result.current.mutation.mutateAsync({
        operationId: `link-${value}`,
        task,
        conversationId: 'work-chat',
        linked: value,
        expectedRevision: value ? 0 : 1,
      });
    });
    await waitFor(() =>
      expect(result.current.tasks.data?.[0].workChatConversationIds).toEqual(
        value ? ['work-chat'] : [],
      ),
    );
  }
});

test('a scoped human message ignores ambient Home selection and carries the exact incarnation', async () => {
  _setApiBase('https://ambient.test');
  const scope = { apiBase, authorityKey: 'room-a', isCurrent: () => true };
  setClientCredentialResolver(() => credential(scope.isCurrent));
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(messageReceipt());
  vi.stubGlobal('fetch', fetcher);
  const { result } = renderHook(
    () =>
      useAppendProjectTaskRoomHumanMessageMutation('task-1', {
        requestScope: scope,
        taskCreatedAt: incarnation,
      }),
    { wrapper: wrapper() },
  );
  await act(async () => {
    await expect(
      result.current.mutateAsync({
        proposalId: 'message-1',
        text: 'Private discussion',
      }),
    ).resolves.toMatchObject({ kind: 'committed' });
  });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0][0]).toBe(
    `${apiBase}/api/tasks/task-1/room/messages`,
  );
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
    proposalId: 'message-1',
    text: 'Private discussion',
    expectedTaskCreatedAt: incarnation,
  });
});

test('a principal rotation during credential resolution sends no human message under the new authority', async () => {
  let current = true;
  const scope = { apiBase, authorityKey: 'room-a', isCurrent: () => current };
  let release!: (value: ClientCredential) => void;
  const gate = new Promise<ClientCredential>((resolve) => {
    release = resolve;
  });
  const resolver = vi.fn(() => gate);
  setClientCredentialResolver(resolver);
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(messageReceipt());
  vi.stubGlobal('fetch', fetcher);
  const { result } = renderHook(
    () =>
      useAppendProjectTaskRoomHumanMessageMutation('task-1', {
        requestScope: scope,
        taskCreatedAt: incarnation,
      }),
    { wrapper: wrapper() },
  );
  let outcome!: Promise<unknown>;
  act(() => {
    outcome = result.current
      .mutateAsync({ proposalId: 'message-1', text: 'Private discussion' })
      .catch((error: unknown) => error);
  });
  await waitFor(() => expect(resolver).toHaveBeenCalled());
  current = false;
  await act(async () => {
    release(credential(scope.isCurrent));
    await expect(outcome).resolves.toBeInstanceOf(Error);
  });
  expect(fetcher).not.toHaveBeenCalled();
});

test('a late human acknowledgement cannot become success after its captured connection expires', async () => {
  let current = true;
  const scope = { apiBase, authorityKey: 'room-a', isCurrent: () => current };
  setClientCredentialResolver(() => credential(scope.isCurrent));
  let release!: (value: Response) => void;
  const gate = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const fetcher = vi.fn<typeof fetch>(() => gate);
  vi.stubGlobal('fetch', fetcher);
  const { result } = renderHook(
    () =>
      useAppendProjectTaskRoomHumanMessageMutation('task-1', {
        requestScope: scope,
        taskCreatedAt: incarnation,
      }),
    { wrapper: wrapper() },
  );
  let outcome!: Promise<unknown>;
  act(() => {
    outcome = result.current
      .mutateAsync({ proposalId: 'message-1', text: 'Private discussion' })
      .catch((error: unknown) => error);
  });
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  current = false;
  await act(async () => {
    release(messageReceipt());
    await expect(outcome).resolves.toBeInstanceOf(Error);
  });
  expect(result.current.isSuccess).toBe(false);
});
