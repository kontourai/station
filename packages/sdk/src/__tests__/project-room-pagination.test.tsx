/** @vitest-environment jsdom */

import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import {
  PROJECT_ROOM_LIMITS,
  type ProjectRoomActor,
  type ProjectRoomAppendInput,
  type ProjectRoomHistory,
  type ProjectRoomIdentity,
  type ProjectRoomMessage,
} from '@kontourai/station-contracts/project-room';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { setClientCredentialResolver } from '../client/http';
import { projectRoomKey, useProjectRoom } from '../query-domains/projectRooms';

const initialScope = {
  stationId: 'station',
  localProjectId: 'project',
  localProjectSlug: 'team',
  portableProjectId: 'portable',
};
let scope = initialScope;
const actor = { id: 'person', displayName: 'Ada', kind: 'person' as const };
const current = () => {};
let db: DatabaseSync;
interface RoomStoreFixture {
  ensureRoom(
    scope: typeof initialScope,
    current: () => void,
  ): ProjectRoomIdentity;
  append(
    scope: typeof initialScope,
    actor: ProjectRoomActor,
    input: ProjectRoomAppendInput,
    current: () => void,
  ): ProjectRoomMessage;
  history(
    scope: typeof initialScope,
    after?: number,
    limit?: number,
  ): ProjectRoomHistory;
}
let store: RoomStoreFixture;
let roomId: string;
let apiBase: string;
let authority: string;
let server: ReturnType<typeof createServer>;
let streams: ServerResponse[];
let release: (() => void) | undefined;
let held: Promise<void> | undefined;
let holdAfter: number | undefined;
let corrupt: 'stalled' | 'malformed' | undefined;
let corruptAfter: number | undefined;
let reads: Array<{
  after: number;
  limit: number;
  count: number;
  bytes: number;
  authorization?: string;
}>;
let clients: QueryClient[];
let discoveryFailure: { status: number; code: string } | undefined;
let initializations: unknown[];
let initializationDenied: boolean;

beforeEach(async () => {
  scope = initialScope;
  discoveryFailure = undefined;
  initializations = [];
  initializationDenied = false;
  corruptAfter = undefined;
  db = new DatabaseSync(':memory:');
  // Load the real server owner at runtime: the SDK's isolated TS project must
  // not pull server implementation files into its published compilation root.
  const storePath =
    '../../../../src-server/services/projects/project-room-store.ts';
  const {
    ProjectRoomStore,
  }: { ProjectRoomStore: new (db: DatabaseSync) => RoomStoreFixture } =
    await import(storePath);
  store = new ProjectRoomStore(db);
  roomId = store.ensureRoom(scope, current).roomId;
  authority = 'one';
  streams = [];
  reads = [];
  clients = [];
  holdAfter = undefined;
  corrupt = undefined;
  release = undefined;
  held = undefined;
  server = createServer(async (request, response) => {
    const url = new URL(request.url!, apiBase);
    const ok = (data: unknown) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ success: true, data }));
    };
    if (url.pathname.endsWith('/init')) {
      let body = '';
      for await (const chunk of request) body += chunk;
      initializations.push(JSON.parse(body));
      if (initializationDenied) {
        response.writeHead(403, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({ error: { code: 'project_room_access_changed' } }),
        );
        return;
      }
      discoveryFailure = undefined;
      ok(store.ensureRoom(scope, current));
      return;
    }
    if (url.pathname.endsWith('/events')) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.flushHeaders();
      streams.push(response);
      return;
    }
    if (url.pathname.endsWith('/presence')) {
      request.resume();
      ok([]);
      return;
    }
    if (url.pathname.endsWith('/messages')) {
      const after = Number(url.searchParams.get('after'));
      const limit = Number(url.searchParams.get('limit'));
      const page = store.history(scope, after, limit);
      reads.push({
        after,
        limit,
        count: page.messages.length,
        bytes: Buffer.byteLength(JSON.stringify(page.messages)),
        authorization: request.headers.authorization,
      });
      if (after === holdAfter) await held;
      ok(
        corrupt && after === corruptAfter
          ? { ...page, nextAfter: corrupt === 'stalled' ? after : 'bad-cursor' }
          : page,
      );
      return;
    }
    if (discoveryFailure) {
      response.writeHead(discoveryFailure.status, {
        'Content-Type': 'application/json',
      });
      response.end(JSON.stringify({ error: { code: discoveryFailure.code } }));
      return;
    }
    ok({
      ...store.ensureRoom(scope, current),
      actor,
      presence: [],
      note: null,
      capabilities: { view: true, discuss: true, edit: true, execute: false },
      checkpoint: store.history(scope).checkpoint,
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing HTTP address');
  apiBase = `http://127.0.0.1:${address.port}`;
  setClientCredentialResolver(() => {
    const captured = authority;
    return {
      origin: apiBase,
      credential: `fixture-${captured}`,
      requestAuthority: {
        apiBase,
        authorityKey: captured,
        isCurrent: () => authority === captured,
      },
    };
  });
});
afterEach(async () => {
  release?.();
  cleanup();
  for (const client of clients) client.clear();
  setClientCredentialResolver(undefined);
  for (const stream of streams) stream.end();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  db.close();
});
function seed(count: number, escaped = false) {
  for (let seq = 1; seq <= count; seq++)
    store.append(
      scope,
      actor,
      {
        intentId: randomUUID(),
        text: escaped
          ? `${seq}:` +
            '\u0001'.repeat(
              PROJECT_ROOM_LIMITS.textBytes - String(seq).length - 1,
            )
          : `Update ${seq}`,
      },
      current,
    );
}
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const hook = renderHook(
    ({ authorityKey, projectId }) =>
      useProjectRoom({ apiBase, authorityKey }, 'team', projectId),
    {
      initialProps: {
        authorityKey: authority,
        projectId: scope.localProjectId,
      },
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  return { ...hook, client };
}
const sequence = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

test('finishes byte-capped forward continuations before moving to nonoverlapping older windows', async () => {
  seed(57, true);
  const hook = mount();
  await waitFor(() => expect(hook.result.current.history.isSuccess).toBe(true));
  expect(reads[0].count).toBeLessThan(25);
  expect(reads[0].bytes).toBeGreaterThan(PROJECT_ROOM_LIMITS.textBytes * 25);
  expect(
    reads.every((read) => read.authorization === 'Bearer fixture-one'),
  ).toBe(true);
  expect(
    hook.result.current.history.data?.pages[0].messages.map((m) => m.seq),
  ).toEqual(sequence(33, 57));
  await act(async () => {
    await hook.result.current.history.fetchNextPage();
  });
  await waitFor(() =>
    expect(hook.result.current.history.data?.pages).toHaveLength(2),
  );
  await act(async () => {
    await hook.result.current.history.fetchNextPage();
  });
  await waitFor(() =>
    expect(hook.result.current.history.data?.pages).toHaveLength(3),
  );
  const pages = hook.result.current.history.data!.pages;
  expect(pages.map((page) => page.messages.map((m) => m.seq))).toEqual([
    sequence(33, 57),
    sequence(8, 32),
    sequence(1, 7),
  ]);
  const all = pages.flatMap((page) => page.messages);
  expect(new Set(all.map((m) => m.messageId)).size).toBe(57);
  expect([...all].sort((a, b) => a.seq - b.seq).map((m) => m.seq)).toEqual(
    sequence(1, 57),
  );
  expect(hook.result.current.history.hasNextPage).toBe(false);
});

test('older history remains reachable past the retained 20-page cache bound', async () => {
  seed(526);
  const hook = mount();
  await waitFor(() => expect(hook.result.current.history.isSuccess).toBe(true));
  const seen = hook.result.current.history.data!.pages[0].messages.map(
    (m) => m.seq,
  );
  while (hook.result.current.history.hasNextPage && reads.length < 23) {
    const previous = hook.result.current.history.data;
    await act(async () => {
      await hook.result.current.history.fetchNextPage();
    });
    await waitFor(() =>
      expect(hook.result.current.history.data).not.toBe(previous),
    );
    const pages = hook.result.current.history.data!.pages;
    seen.push(...pages[pages.length - 1].messages.map((m) => m.seq));
  }
  expect(seen.sort((a, b) => a - b)).toEqual(sequence(1, 526));
  expect(hook.result.current.history.hasNextPage).toBe(false);
  expect(hook.result.current.history.data!.pages).toHaveLength(20);
});

test.each(['stalled', 'malformed'] as const)(
  'refuses a %s continuation without caching a partial window',
  async (mode) => {
    seed(30, true);
    corrupt = mode;
    corruptAfter = 10;
    const hook = mount();
    await waitFor(() => expect(hook.result.current.history.isError).toBe(true));
    expect(hook.result.current.history.error?.message).toMatch(
      /cursor did not advance|incompatible/,
    );
    expect(reads).toHaveLength(2);
    expect(hook.result.current.history.data).toBeUndefined();
    expect(
      hook.client
        .getQueriesData({
          queryKey: [
            ...projectRoomKey(
              { apiBase, authorityKey: 'one' },
              'project',
              roomId,
            ),
            'history',
          ],
        })
        .every(([, data]) => data === undefined),
    ).toBe(true);
  },
);

test.each([
  'authority',
  'lost-authority',
  'room-incarnation',
  'project-incarnation',
  'revocation',
  'cancellation',
] as const)(
  'withholds late continuation pages after %s, from cache and waiting caller',
  async (change) => {
    seed(57, true);
    const hook = mount();
    await waitFor(() =>
      expect(hook.result.current.history.isSuccess).toBe(true),
    );
    const oldRoomId = roomId;
    holdAfter = 12;
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let waiting!: ReturnType<typeof hook.result.current.history.fetchNextPage>;
    act(() => {
      waiting = hook.result.current.history.fetchNextPage();
    });
    await waitFor(() =>
      expect(reads.some((read) => read.after === 12)).toBe(true),
    );
    if (change === 'authority') {
      authority = 'two';
      hook.rerender({
        authorityKey: authority,
        projectId: scope.localProjectId,
      });
    } else if (
      change === 'room-incarnation' ||
      change === 'project-incarnation'
    ) {
      scope = {
        ...scope,
        ...(change === 'project-incarnation'
          ? { localProjectId: 'replacement' }
          : { portableProjectId: 'replacement' }),
      };
      roomId = store.ensureRoom(scope, current).roomId;
      if (change === 'project-incarnation')
        hook.rerender({
          authorityKey: authority,
          projectId: scope.localProjectId,
        });
      else
        await act(async () => {
          await hook.result.current.discovery.refetch();
        });
      await waitFor(() =>
        expect(hook.result.current.discovery.data?.roomId).toBe(roomId),
      );
    } else if (change === 'lost-authority') {
      authority = 'two';
    } else if (change === 'revocation') {
      await waitFor(() => expect(streams.length).toBeGreaterThan(0));
      act(() => {
        streams[0].write(
          'event: revoked\ndata: {"reason":"access_changed"}\n\n',
        );
      });
      await waitFor(() => expect(hook.result.current.stopped).toBe(true));
    } else {
      await act(async () => {
        await hook.client.cancelQueries({
          queryKey: projectRoomKey({ apiBase, authorityKey: 'one' }, 'project'),
        });
      });
    }
    let result: Awaited<typeof waiting>;
    await act(async () => {
      release!();
      result = await waiting;
    });
    expect(
      result!.data?.pages
        .flatMap((page) => page.messages)
        .some((m) => m.seq <= 32) ?? false,
    ).toBe(false);
    const old = hook.client.getQueriesData<{
      pages: Array<{ messages: Array<{ seq: number }> }>;
    }>({
      queryKey: [
        ...projectRoomKey(
          { apiBase, authorityKey: 'one' },
          'project',
          oldRoomId,
        ),
        'history',
      ],
    });
    expect(
      old
        .flatMap(
          ([, data]) => data?.pages.flatMap((page) => page.messages) ?? [],
        )
        .some((m) => m.seq <= 32),
    ).toBe(false);
    if (change === 'lost-authority') {
      expect(result!.isError).toBe(true);
      expect(result!.error?.message).toMatch(/authority/);
      expect(old).toHaveLength(1);
    } else if (change !== 'cancellation') expect(old).toEqual([]);
  },
);

test('exposes unprovisioned discovery and initializes only on explicit mutation before refreshing discovery', async () => {
  discoveryFailure = { status: 404, code: 'project_room_not_found' };
  const hook = mount();
  await waitFor(() => expect(hook.result.current.unprovisioned).toBe(true));
  expect(hook.result.current.stopped).toBe(false);
  expect(initializations).toEqual([]);
  expect(reads).toEqual([]);
  let identity: Awaited<
    ReturnType<typeof hook.result.current.initialize.mutateAsync>
  >;
  await act(async () => {
    identity = await hook.result.current.initialize.mutateAsync();
  });
  expect(initializations).toEqual([{ expectedProjectId: 'project' }]);
  expect(identity!).toEqual({ scope, roomId });
  await waitFor(() =>
    expect(hook.result.current.discovery.isSuccess).toBe(true),
  );
  expect(hook.result.current.unprovisioned).toBe(false);
  expect(hook.result.current.discovery.data?.roomId).toBe(roomId);
});

test.each([
  { status: 401, code: 'authentication_required' },
  { status: 403, code: 'project_room_access_changed' },
  { status: 404, code: 'project_not_found' },
])(
  'does not treat discovery $status/$code as an unprovisioned room',
  async (failure) => {
    discoveryFailure = failure;
    const hook = mount();
    await waitFor(() =>
      expect(
        hook.result.current.discovery.isError || hook.result.current.stopped,
      ).toBe(true),
    );
    expect(hook.result.current.unprovisioned).toBe(false);
    expect(initializations).toEqual([]);
    expect(reads).toEqual([]);
    if (failure.status !== 404)
      await waitFor(() => expect(hook.result.current.stopped).toBe(true));
  },
);

test('initialization discuss denial remains observable to its caller and stops the room hook', async () => {
  discoveryFailure = { status: 404, code: 'project_room_not_found' };
  initializationDenied = true;
  const hook = mount();
  await waitFor(() => expect(hook.result.current.unprovisioned).toBe(true));
  await act(async () => {
    await expect(
      hook.result.current.initialize.mutateAsync(),
    ).rejects.toMatchObject({
      status: 403,
      code: 'project_room_access_changed',
    });
  });
  await waitFor(() => expect(hook.result.current.stopped).toBe(true));
  expect(initializations).toEqual([{ expectedProjectId: 'project' }]);
  expect(reads).toEqual([]);
  expect(
    hook.client.getQueriesData({
      queryKey: projectRoomKey({ apiBase, authorityKey: authority }, 'project'),
    }),
  ).toEqual([]);
});
