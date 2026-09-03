/** @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode, useLayoutEffect, useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

let resolveDocument: ((value: unknown) => void) | undefined;
let documentSignal: AbortSignal | undefined;
const documentRequests: Array<{
  init: RequestInit;
  resolve(value: unknown): void;
}> = [];
type StreamCallbacks = {
  onCheckpoint?(id: string): void;
  onConnectionCreated?(id: string): void;
  onConnectionClosed?(id: string): void;
  onEvent(event: { kind: string; value?: unknown }): void;
};
let callbacks: StreamCallbacks | undefined;
const streamConnections: Array<{
  taskId: string;
  callbacks: StreamCallbacks;
  close: ReturnType<typeof vi.fn>;
}> = [];

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
    taskId: string,
    input: StreamCallbacks,
  ) => {
    callbacks = input;
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const close = vi.fn(complete);
    streamConnections.push({ taskId, callbacks: input, close });
    return { close, restart: vi.fn(), completed };
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
  useProjectTaskRoomDocumentQuery,
  useProjectTaskRoomStream,
} from '../query-domains/projectTaskRooms';

afterEach(() => {
  resolveDocument = undefined;
  documentSignal = undefined;
  documentRequests.splice(0);
  callbacks = undefined;
  streamConnections.splice(0);
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

test('initial SSE snapshot cancels the older GET before cache publication and preserves mounted editor text', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const rendered = renderHook(
    () => {
      const document = useProjectTaskRoomDocumentQuery('task-1');
      const [editorText, setEditorText] = useState('');
      useProjectTaskRoomStream('task-1', {
        onAuthoritativeDocument: (next) => setEditorText(next.text),
      });
      return { document: document.data, editorText };
    },
    { wrapper },
  );
  await waitFor(() => expect(callbacks).toBeDefined());
  await waitFor(() => expect(documentRequests).toHaveLength(1));

  act(() =>
    callbacks!.onEvent({
      kind: 'snapshot',
      value: {
        document: {
          kind: 'snapshot',
          revision: 'stream-new',
          text: 'new editor text',
        },
      },
    }),
  );
  expect(documentRequests[0]?.init.signal?.aborted).toBe(true);
  expect(
    client.getQueryData(projectTaskRoomQueries.document('task-1').queryKey),
  ).toEqual({
    kind: 'snapshot',
    revision: 'stream-new',
    text: 'new editor text',
  });
  documentRequests[0]?.resolve({
    kind: 'snapshot',
    revision: 'http-old',
    text: 'old editor text',
  });
  await Promise.resolve();

  await waitFor(() =>
    expect(rendered.result.current.editorText).toBe('new editor text'),
  );
  expect(rendered.result.current.document).toEqual({
    kind: 'snapshot',
    revision: 'stream-new',
    text: 'new editor text',
  });
});

test.each([
  ['duplicate', { kind: 'duplicate', revision: 'rev-duplicate' }],
  ['malformed', { kind: 'unexpected' }],
] as const)(
  'an active document observer recovers a %s event through the no-cache authoritative read',
  async (_label, value) => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const rendered = renderHook(
      () => {
        const document = useProjectTaskRoomDocumentQuery('task-1');
        useProjectTaskRoomStream('task-1');
        return document.data;
      },
      { wrapper },
    );
    await waitFor(() => expect(callbacks).toBeDefined());
    await waitFor(() => expect(documentRequests).toHaveLength(1));
    documentRequests[0]?.resolve({
      kind: 'snapshot',
      revision: 'baseline',
      text: 'baseline',
    });
    await waitFor(() =>
      expect(rendered.result.current).toMatchObject({ revision: 'baseline' }),
    );

    act(() => callbacks!.onEvent({ kind: 'document', value }));
    await waitFor(() => expect(documentRequests).toHaveLength(2));
    expect(documentRequests[1]?.init.headers).toEqual({
      'Cache-Control': 'no-cache',
    });
    documentRequests[1]?.resolve({
      kind: 'snapshot',
      revision: 'recovered',
      text: 'recovered text',
    });

    await waitFor(() =>
      expect(rendered.result.current).toEqual({
        kind: 'snapshot',
        revision: 'recovered',
        text: 'recovered text',
      }),
    );
  },
);

test('applies a parsed accepted document synchronously without a recovery refetch', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const applied: Array<{ revision: string; beforeReturn: boolean }> = [];
  let returned = false;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  renderHook(
    () => {
      useProjectTaskRoomStream('task-1', {
        onAuthoritativeDocument: (document) =>
          applied.push({
            revision: document.revision,
            beforeReturn: !returned,
          }),
      });
    },
    { wrapper },
  );
  await waitFor(() => expect(callbacks).toBeDefined());

  callbacks!.onEvent({
    kind: 'document',
    value: { kind: 'committed', revision: 'rev2', text: 'two' },
  });
  returned = true;

  expect(applied).toEqual([{ revision: 'rev2', beforeReturn: true }]);
  expect(documentRequests).toHaveLength(0);
  expect(invalidate).not.toHaveBeenCalled();
  expect(
    client.getQueryData(projectTaskRoomQueries.document('task-1').queryKey),
  ).toEqual({ kind: 'snapshot', revision: 'rev2', text: 'two' });
});

test('isolates throwing document observers without delaying cache normalization', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rawObserver = vi.fn(() => {
    throw new Error('raw observer failed');
  });
  const authoritativeObserver = vi.fn(() => {
    throw new Error('authoritative observer failed');
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  renderHook(
    () => {
      useProjectTaskRoomStream('task-1', {
        onDocument: rawObserver,
        onAuthoritativeDocument: authoritativeObserver,
      });
    },
    { wrapper },
  );
  await waitFor(() => expect(callbacks).toBeDefined());

  expect(() =>
    callbacks!.onEvent({
      kind: 'document',
      value: { kind: 'committed', revision: 'rev2', text: 'two' },
    }),
  ).not.toThrow();

  expect(rawObserver).toHaveBeenCalledOnce();
  expect(authoritativeObserver).toHaveBeenCalledOnce();
  expect(
    client.getQueryData(projectTaskRoomQueries.document('task-1').queryKey),
  ).toEqual({ kind: 'snapshot', revision: 'rev2', text: 'two' });
});

test('rejects callbacks from the previous Task during the render-to-cleanup handoff', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const delivered: string[] = [];
  let injectedOldConnection = false;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const rendered = renderHook(
    ({ taskId }: { taskId: string }) => {
      useProjectTaskRoomStream(taskId, {
        onAuthoritativeDocument: (document) =>
          delivered.push(`${taskId}:document:${document.text}`),
        onCheckpoint: (id) => delivered.push(`${taskId}:checkpoint:${id}`),
        onTerminal: () => delivered.push(`${taskId}:terminal`),
      });
      // This is the review's exact window: Task B has committed and the stream
      // hook's layout fence has advanced, but Task A's passive cleanup has not
      // run yet. Hook layout effects execute in declaration order.
      useLayoutEffect(() => {
        if (
          taskId !== 'task-b' ||
          injectedOldConnection ||
          !streamConnections[0]
        )
          return;
        injectedOldConnection = true;
        streamConnections[0].callbacks.onCheckpoint?.('late-a');
        streamConnections[0].callbacks.onEvent({
          kind: 'document',
          value: { kind: 'committed', revision: 'rev-a', text: 'task a' },
        });
        streamConnections[0].callbacks.onEvent({ kind: 'terminal' });
      }, [taskId]);
    },
    { initialProps: { taskId: 'task-a' }, wrapper },
  );
  await waitFor(() => expect(streamConnections).toHaveLength(1));

  rendered.rerender({ taskId: 'task-b' });

  expect(delivered).toEqual([]);
  expect(
    client.getQueryData(projectTaskRoomQueries.document('task-a').queryKey),
  ).toBeUndefined();
  await waitFor(() => expect(streamConnections).toHaveLength(2));
  streamConnections[1].callbacks.onEvent({
    kind: 'document',
    value: { kind: 'committed', revision: 'rev-b', text: 'task b' },
  });
  expect(delivered).toEqual(['task-b:document:task b']);
});

test('closes the originating lifecycle exactly once across Task and generation changes', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const lifecycle: string[] = [];
  const documents: string[] = [];
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const rendered = renderHook(
    ({ taskId, generation }: { taskId: string; generation: number }) =>
      useProjectTaskRoomStream(
        taskId,
        {
          onConnectionCreated: (id) =>
            lifecycle.push(`${taskId}:created:${id}`),
          onConnectionClosed: (id) => lifecycle.push(`${taskId}:closed:${id}`),
          onAuthoritativeDocument: (document) =>
            documents.push(`${taskId}:${document.text}`),
        },
        generation,
      ),
    {
      initialProps: { taskId: 'task-a', generation: 0 },
      wrapper,
    },
  );
  await waitFor(() => expect(streamConnections).toHaveLength(1));
  await waitFor(() => expect(lifecycle).toHaveLength(1));
  const firstId = lifecycle[0].split(':created:')[1];

  rendered.rerender({ taskId: 'task-b', generation: 0 });
  await waitFor(() => expect(streamConnections).toHaveLength(2));
  await waitFor(() =>
    expect(lifecycle).toEqual(
      expect.arrayContaining([
        `task-a:closed:${firstId}`,
        expect.stringMatching(/^task-b:created:task-b:/),
      ]),
    ),
  );
  expect(streamConnections[0].close).toHaveBeenCalledOnce();
  streamConnections[0].callbacks.onEvent({
    kind: 'document',
    value: { kind: 'committed', revision: 'late-a', text: 'late task a' },
  });
  expect(documents).toEqual([]);
  const secondCreated = lifecycle.find((entry) =>
    entry.startsWith('task-b:created:'),
  );
  const secondId = secondCreated?.split(':created:')[1];

  rendered.rerender({ taskId: 'task-b', generation: 1 });
  await waitFor(() => expect(streamConnections).toHaveLength(3));
  await waitFor(() => expect(lifecycle).toContain(`task-b:closed:${secondId}`));
  expect(streamConnections[1].close).toHaveBeenCalledOnce();
  expect(
    lifecycle.filter((entry) => entry === `task-a:closed:${firstId}`),
  ).toHaveLength(1);
  expect(
    lifecycle.filter((entry) => entry === `task-b:closed:${secondId}`),
  ).toHaveLength(1);
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
