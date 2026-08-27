/** @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

let resolveDocument: ((value: unknown) => void) | undefined;
let documentSignal: AbortSignal | undefined;
const documentRequests: Array<{
  init: RequestInit;
  resolve(value: unknown): void;
}> = [];
let callbacks:
  | { onEvent(event: { kind: string; value?: unknown }): void }
  | undefined;

vi.mock('../api', () => ({ _getApiBase: async () => 'https://station.test' }));
vi.mock('../client/project-task-rooms', () => ({
  fetchProjectTaskRoomDocument: (
    _base: string,
    _task: string,
    _cursor: unknown,
    init: RequestInit,
  ) =>
    new Promise((resolve) => {
      documentSignal = init.signal as AbortSignal;
      resolveDocument = resolve;
      documentRequests.push({ init, resolve });
    }),
  subscribeProjectTaskRoomEvents: (
    _base: string,
    _task: string,
    input: typeof callbacks,
  ) => {
    callbacks = input;
    return { close: vi.fn(), restart: vi.fn(), completed: Promise.resolve() };
  },
  parseAuthoritativeProjectTaskRoomDocumentEvent: (value: any) =>
    value?.kind === 'committed'
      ? { kind: 'snapshot', revision: value.revision, text: value.text }
      : value?.kind === 'gap'
        ? value
        : undefined,
  parseProjectTaskRoomDocumentResponse: (value: any) => value,
  parseProjectTaskRoomBrowserLiveSnapshot: () => undefined,
  appendProjectTaskRoomHumanMessage: vi.fn(),
  commandProjectTaskRoomLive: vi.fn(),
  discoverProjectTaskRoom: vi.fn(),
  fetchProjectTaskRoomHistory: vi.fn(),
  planProjectTaskRoomEdit: vi.fn(),
  submitProjectTaskRoomBatch: vi.fn(),
}));

import {
  adoptCommittedProjectTaskRoomDocument,
  projectTaskRoomQueries,
  refetchAuthoritativeProjectTaskRoomDocument,
  useProjectTaskRoomStream,
} from '../query-domains/projectTaskRooms';

afterEach(() => {
  resolveDocument = undefined;
  documentSignal = undefined;
  documentRequests.splice(0);
  callbacks = undefined;
});

test('committed settlement replaces only its exact observed document object', () => {
  const client = new QueryClient();
  const observed = { kind: 'snapshot' as const, revision: 'rev1', text: 'one' };
  client.setQueryData(
    projectTaskRoomQueries.document('task-1').queryKey,
    observed,
  );

  const adoption = adoptCommittedProjectTaskRoomDocument(
    client,
    'task-1',
    observed,
    { kind: 'committed', revision: 'rev2', text: 'two' },
  );

  expect(adoption).toEqual({ kind: 'snapshot', revision: 'rev2', text: 'two' });
  if (!adoption) throw new Error('expected cache adoption');
  expect(
    client.getQueryData(projectTaskRoomQueries.document('task-1').queryKey),
  ).toEqual(adoption);
});

test('committed settlement reuses a matching stream document', () => {
  const client = new QueryClient();
  const observed = { kind: 'snapshot' as const, revision: 'rev1', text: 'one' };
  const stream = { kind: 'delta' as const, revision: 'rev2', text: 'two' };
  client.setQueryData(
    projectTaskRoomQueries.document('task-1').queryKey,
    stream,
  );

  const adoption = adoptCommittedProjectTaskRoomDocument(
    client,
    'task-1',
    observed,
    { kind: 'committed', revision: 'rev2', text: 'receipt two' },
  );

  expect(adoption).toBe(stream);
  expect(
    client.getQueryData(projectTaskRoomQueries.document('task-1').queryKey),
  ).toBe(stream);
});

test('committed settlement preserves a stream document that changed during the batch', () => {
  const client = new QueryClient();
  const observed = { kind: 'snapshot' as const, revision: 'rev1', text: 'one' };
  const stream = {
    kind: 'snapshot' as const,
    revision: 'opaque-next',
    text: 'three',
  };
  client.setQueryData(
    projectTaskRoomQueries.document('task-1').queryKey,
    stream,
  );

  const adoption = adoptCommittedProjectTaskRoomDocument(
    client,
    'task-1',
    observed,
    { kind: 'committed', revision: 'opaque-commit', text: 'two' },
  );

  expect(adoption).toBe(stream);
  expect(
    client.getQueryData(projectTaskRoomQueries.document('task-1').queryKey),
  ).toBe(stream);
});

test.each([
  { label: 'gap', value: { kind: 'gap', floor: 'rev1' } },
  { label: 'unavailable', value: { kind: 'unavailable' } },
  { label: 'missing', value: undefined },
  { label: 'invalid custom object', value: { kind: 'snapshot', revision: 2 } },
])(
  'committed settlement requires refetch for $label cache truth',
  ({ value }) => {
    const client = new QueryClient();
    const observed = {
      kind: 'snapshot' as const,
      revision: 'rev1',
      text: 'one',
    };
    if (value !== undefined)
      client.setQueryData(
        projectTaskRoomQueries.document('task-1').queryKey,
        value,
      );

    const adoption = adoptCommittedProjectTaskRoomDocument(
      client,
      'task-1',
      observed,
      { kind: 'committed', revision: 'rev2', text: 'two' },
    );

    expect(adoption).toBeUndefined();
    expect(
      client.getQueryData(projectTaskRoomQueries.document('task-1').queryKey),
    ).toBe(value);
  },
);

test('committed settlement treats accessor and custom-prototype cache values as a refetch boundary', () => {
  const accessor = Object.defineProperty({}, 'kind', {
    get: () => {
      throw new Error('cache accessor must not run');
    },
  });
  const customObject = Object.assign(Object.create({}), {
    kind: 'invalid',
  });
  for (const value of [accessor, customObject]) {
    const client = new QueryClient();
    const observed = {
      kind: 'snapshot' as const,
      revision: 'rev1',
      text: 'one',
    };
    client.setQueryData(
      projectTaskRoomQueries.document('task-1').queryKey,
      value,
    );

    expect(
      adoptCommittedProjectTaskRoomDocument(client, 'task-1', observed, {
        kind: 'committed',
        revision: 'rev2',
        text: 'two',
      }),
    ).toBeUndefined();
    expect(
      client.getQueryData(projectTaskRoomQueries.document('task-1').queryKey),
    ).toBe(value);
  }
});

test('authoritative refetch bypasses a fresh canonical cache entry with no-cache headers', async () => {
  const client = new QueryClient();
  client.setQueryData(projectTaskRoomQueries.document('task-1').queryKey, {
    kind: 'snapshot',
    revision: 'cached',
    text: 'cached text',
  });

  const refreshed = refetchAuthoritativeProjectTaskRoomDocument(
    client,
    'task-1',
  );
  await waitFor(() => expect(documentRequests).toHaveLength(1));
  expect(documentRequests[0]?.init.headers).toEqual({
    'Cache-Control': 'no-cache',
  });
  documentRequests[0]?.resolve({
    kind: 'snapshot',
    revision: 'fresh',
    text: 'fresh text',
  });

  await expect(refreshed).resolves.toEqual({
    kind: 'snapshot',
    revision: 'fresh',
    text: 'fresh text',
  });
});

test('authoritative refetch cancels an ordinary in-flight canonical GET instead of joining it', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let ordinarySignal: AbortSignal | undefined;
  void client
    .fetchQuery({
      queryKey: projectTaskRoomQueries.document('task-1').queryKey,
      queryFn: ({ signal }) => {
        ordinarySignal = signal;
        return new Promise(() => {});
      },
    })
    .catch(() => {});
  await waitFor(() => expect(ordinarySignal).toBeDefined());

  const refreshed = refetchAuthoritativeProjectTaskRoomDocument(
    client,
    'task-1',
  );
  await waitFor(() => expect(ordinarySignal?.aborted).toBe(true));
  await waitFor(() => expect(documentRequests).toHaveLength(1));
  documentRequests[0]?.resolve({
    kind: 'snapshot',
    revision: 'authoritative',
    text: 'authoritative text',
  });

  await expect(refreshed).resolves.toEqual({
    kind: 'snapshot',
    revision: 'authoritative',
    text: 'authoritative text',
  });
});

test('a committed SSE cancels an authoritative GET and preserves its newer canonical cache', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  renderHook(
    () => {
      useProjectTaskRoomStream('task-1');
    },
    { wrapper },
  );
  await waitFor(() => expect(callbacks).toBeDefined());

  const refreshed = refetchAuthoritativeProjectTaskRoomDocument(
    client,
    'task-1',
  );
  const settled = refreshed.catch(() => {});
  await waitFor(() => expect(documentRequests).toHaveLength(1));
  callbacks!.onEvent({
    kind: 'document',
    value: { kind: 'committed', revision: 'rev3', text: 'three' },
  });
  await waitFor(() =>
    expect(documentRequests[0]?.init.signal?.aborted).toBe(true),
  );
  documentRequests[0]?.resolve({
    kind: 'snapshot',
    revision: 'rev2',
    text: 'two',
  });
  await settled;

  expect(
    client.getQueryData(projectTaskRoomQueries.document('task-1').queryKey),
  ).toEqual({ kind: 'snapshot', revision: 'rev3', text: 'three' });
});

test('committed SSE cancels a deferred older GET and duplicate cannot regress cache', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  renderHook(
    () => {
      useProjectTaskRoomStream('task-1');
    },
    { wrapper },
  );
  void client
    .fetchQuery({
      queryKey: projectTaskRoomQueries.document('task-1').queryKey,
      queryFn: ({ signal }) => {
        documentSignal = signal;
        return new Promise((resolve) => {
          resolveDocument = resolve;
        });
      },
    })
    .catch(() => {});
  await waitFor(() => expect(callbacks).toBeDefined());
  await waitFor(() => expect(resolveDocument).toBeDefined());
  callbacks!.onEvent({
    kind: 'document',
    value: { kind: 'committed', revision: 'rev3', text: 'three' },
  });
  await waitFor(() =>
    expect(
      client.getQueryData(projectTaskRoomQueries.document('task-1').queryKey),
    ).toEqual({ kind: 'snapshot', revision: 'rev3', text: 'three' }),
  );
  expect(documentSignal?.aborted).toBe(true);
  resolveDocument!({ kind: 'snapshot', revision: 'rev2', text: 'two' });
  callbacks!.onEvent({
    kind: 'document',
    value: { kind: 'duplicate', revision: 'rev2', text: 'two' },
  });
  await Promise.resolve();
  expect(
    client.getQueryData(projectTaskRoomQueries.document('task-1').queryKey),
  ).toEqual({ kind: 'snapshot', revision: 'rev3', text: 'three' });
});

test('a gap recovery GET cannot overwrite a later committed SSE', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  renderHook(
    () => {
      useProjectTaskRoomStream('task-1');
    },
    { wrapper },
  );
  void client
    .fetchQuery({
      queryKey: projectTaskRoomQueries.document('task-1').queryKey,
      queryFn: ({ signal }) => {
        documentSignal = signal;
        return new Promise((resolve) => {
          resolveDocument = resolve;
        });
      },
    })
    .catch(() => {});
  await waitFor(() => expect(callbacks).toBeDefined());
  await waitFor(() => expect(resolveDocument).toBeDefined());
  callbacks!.onEvent({
    kind: 'document',
    value: { kind: 'gap', floor: 'rev1' },
  });
  callbacks!.onEvent({
    kind: 'document',
    value: { kind: 'committed', revision: 'rev3', text: 'three' },
  });
  await waitFor(() => expect(documentSignal?.aborted).toBe(true));
  resolveDocument!({ kind: 'snapshot', revision: 'rev2', text: 'two' });
  await Promise.resolve();
  expect(
    client.getQueryData(projectTaskRoomQueries.document('task-1').queryKey),
  ).toEqual({ kind: 'snapshot', revision: 'rev3', text: 'three' });
});
