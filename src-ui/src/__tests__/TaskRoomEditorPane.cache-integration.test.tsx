/** @vitest-environment jsdom */

import type { ProjectTaskRoomDocument } from '@kontourai/station-sdk/project-task-rooms';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

type DocumentSnapshot = Extract<
  ProjectTaskRoomDocument,
  { kind: 'snapshot' | 'delta' }
>;
const mocks = vi.hoisted(() => ({
  plan: vi.fn(),
  batch: vi.fn(),
  stream: undefined as
    | { onEvent(event: { kind: string; value: unknown }): void }
    | undefined,
  listeners: new Set<(document: DocumentSnapshot) => void>(),
  delivered: undefined as DocumentSnapshot | undefined,
}));

vi.mock('../../../packages/sdk/src/api', () => ({
  _getApiBase: async () => 'https://station.test',
}));
vi.mock(
  '../../../packages/sdk/src/client/project-task-rooms',
  async (original) => ({
    ...(await original<
      typeof import('../../../packages/sdk/src/client/project-task-rooms')
    >()),
    discoverProjectTaskRoom: async () => ({
      kind: 'existing',
      capabilities: { documentRead: true, documentWrite: true },
    }),
    fetchProjectTaskRoomDocument: async () => ({
      kind: 'snapshot',
      revision: 'r1',
      text: 'initial GET',
    }),
    planProjectTaskRoomEdit: (...args: unknown[]) => mocks.plan(...args),
    submitProjectTaskRoomBatch: (...args: unknown[]) => mocks.batch(...args),
    subscribeProjectTaskRoomEvents: (
      _base: string,
      _task: string,
      callbacks: NonNullable<typeof mocks.stream>,
    ) => {
      mocks.stream = callbacks;
      let finish!: () => void;
      const completed = new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { completed, close: finish, restart: vi.fn() };
    },
  }),
);
vi.mock('../workspace-panes/ProjectTaskRoomContext', () => ({
  useProjectTaskRoomContext: () => ({
    taskId: 'task-1',
    discovery: {
      data: {
        kind: 'existing',
        capabilities: { documentRead: true, documentWrite: true },
      },
      isLoading: false,
    },
    stream: 'live',
    live: { panes: [], cursors: [] },
    command: async () => ({ kind: 'available' }),
    commandPending: false,
    subscribeDocument(listener: (document: DocumentSnapshot) => void) {
      mocks.listeners.add(listener);
      return () => mocks.listeners.delete(listener);
    },
  }),
}));

import {
  projectTaskRoomQueries,
  useProjectTaskRoomStream,
} from '@kontourai/station-sdk/project-task-rooms';
import { TaskRoomEditorPane } from '../workspace-panes/TaskRoomEditorPane';

const clients: QueryClient[] = [];
const key = projectTaskRoomQueries.document('task-1').queryKey;
beforeEach(() => {
  mocks.stream = undefined;
  mocks.delivered = undefined;
  mocks.listeners.clear();
  mocks.plan.mockReset().mockResolvedValue({
    kind: 'planned',
    intentId: 'intent',
    digest: 'a'.repeat(64),
    optimistic: {},
    selection: { anchor: 0, focus: 0 },
    operationCount: 1,
  });
  mocks.batch.mockReset();
});
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

function MountedRoom() {
  useProjectTaskRoomStream('task-1', {
    onAuthoritativeDocument(document) {
      mocks.delivered = document;
      for (const listener of mocks.listeners) listener(document);
    },
  });
  return <TaskRoomEditorPane taskId="task-1" />;
}

async function mountRoom() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  // Existing cache is essential: default structural sharing copies later
  // stream publications instead of preserving the notified object's identity.
  client.setQueryData(key, {
    kind: 'snapshot',
    revision: 'r1',
    text: 'initial GET',
  });
  render(
    <QueryClientProvider client={client}>
      <MountedRoom />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(mocks.stream).toBeDefined());
  await waitFor(() => expect(editor().value).toBe('initial GET'));
  return client;
}

function editor() {
  return screen.getByRole('textbox', {
    name: 'Task document',
  }) as HTMLTextAreaElement;
}
async function deliver(revision: string, text: string) {
  await act(async () => {
    mocks.stream!.onEvent({
      kind: 'document',
      value: { type: 'document', kind: 'committed', revision, text },
    });
  });
}
function save(text: string) {
  fireEvent.change(editor(), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Save shared document' }));
}

test('saves after an existing-cache SSE and again after a structurally shared settlement', async () => {
  const client = await mountRoom();
  await deliver('r2', 'remote edit');
  await waitFor(() => expect(editor().value).toBe('remote edit'));
  expect(client.getQueryData(key)).toEqual(mocks.delivered);
  expect(client.getQueryData(key)).not.toBe(mocks.delivered);

  // The batch response wins the race with its own SSE: no stream event is
  // delivered for either settlement. Real SDK adoption must publish the receipt.
  mocks.batch.mockResolvedValueOnce({
    kind: 'committed',
    revision: 'r3',
    text: 'first save',
  });
  save('first save');
  await waitFor(() =>
    expect(screen.getByText('Shared document saved.')).toBeTruthy(),
  );
  expect(editor().value).toBe('first save');
  expect(client.getQueryData(key)).toMatchObject({
    revision: 'r3',
    text: 'first save',
  });

  mocks.batch.mockResolvedValueOnce({
    kind: 'committed',
    revision: 'r4',
    text: 'second save',
  });
  save('second save');
  await waitFor(() => expect(mocks.batch).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(client.getQueryData(key)).toMatchObject({
      revision: 'r4',
      text: 'second save',
    }),
  );
  expect(editor().value).toBe('second save');
});

test('a later SSE still wins over an older in-flight save receipt', async () => {
  const client = await mountRoom();
  await deliver('r2', 'remote edit');
  await waitFor(() => expect(editor().value).toBe('remote edit'));
  let settle!: (value: unknown) => void;
  mocks.batch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  );
  save('my draft');
  await waitFor(() => expect(mocks.batch).toHaveBeenCalledOnce());
  await deliver('r4', 'newer remote edit');
  await act(async () => {
    settle({ kind: 'committed', revision: 'r3', text: 'my draft' });
  });
  await waitFor(() => expect(editor().value).toBe('newer remote edit'));
  expect(client.getQueryData(key)).toMatchObject({
    revision: 'r4',
    text: 'newer remote edit',
  });
});

test('does not capture unseen newer cache truth as authority for a displayed draft', async () => {
  const client = await mountRoom();
  await deliver('r2', 'remote edit');
  await waitFor(() => expect(editor().value).toBe('remote edit'));
  fireEvent.change(editor(), { target: { value: 'my retained draft' } });
  act(() => {
    // The real query notification is deferred. Save runs while the pane still
    // displays r2, but the canonical cache already holds r3.
    client.setQueryData(key, {
      kind: 'snapshot',
      revision: 'r3',
      text: 'unseen edit',
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Save shared document' }),
    );
  });
  expect(mocks.plan).not.toHaveBeenCalled();
  expect(mocks.batch).not.toHaveBeenCalled();
  expect(editor().value).toBe('my retained draft');
  expect(screen.getByRole('alert').textContent).toContain(
    'Review it before retrying',
  );
});
