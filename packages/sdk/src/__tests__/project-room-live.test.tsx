/** @vitest-environment jsdom */

import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import type {
  ProjectRoomActor,
  ProjectRoomAppendInput,
  ProjectRoomHistory,
  ProjectRoomIdentity,
  ProjectRoomMessage,
} from '@kontourai/station-contracts/project-room';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setClientCredentialResolver } from '../client/http';

// The host's capability handshake has its own suite; here the host serves
// the shared stream.
vi.mock('../client/project-room-live', async (original) => ({
  ...(await original<typeof import('../client/project-room-live')>()),
  readProjectRoomLiveCapability: async () => true,
}));
const { useProjectRoom, useProjectRoomLiveIndex } = await import(
  '../query-domains/projectRooms'
);

const scope = {
  stationId: 'station',
  localProjectId: 'project',
  localProjectSlug: 'team',
  portableProjectId: 'portable',
};
const actor = { id: 'person', displayName: 'Ada', kind: 'person' as const };
const other = { id: 'other', displayName: 'Lin', kind: 'person' as const };
const current = () => {};
interface RoomStoreFixture {
  ensureRoom(s: typeof scope, current: () => void): ProjectRoomIdentity;
  append(
    s: typeof scope,
    actor: ProjectRoomActor,
    input: ProjectRoomAppendInput,
    current: () => void,
  ): ProjectRoomMessage;
  history(s: typeof scope, after?: number, limit?: number): ProjectRoomHistory;
  deleteMessage(
    s: typeof scope,
    actor: ProjectRoomActor,
    messageId: string,
    input: { intentId: string },
    current: () => void,
  ): ProjectRoomMessage;
}
let db: DatabaseSync;
let store: RoomStoreFixture;
let roomId: string;
let apiBase: string;
let server: ReturnType<typeof createServer>;
/** Each live connection the client opened, with the rooms it asked for. */
let connections: { channels: string[]; response: ServerResponse }[];
let reads: { after: number; limit: number }[];
let typingPosts: { typing: boolean }[];
let clients: QueryClient[];
/** History answers 503 while set: an outage the stream does not see. */
let historyFailure: boolean;
/** The next history read is answered only when `heldHistory` is called. */
let holdNextHistory: boolean;
let heldHistory: (() => void) | undefined;
/** When set, only a read starting `after` this sequence is held. */
let holdOnlyAfter: number | undefined;

beforeEach(async () => {
  db = new DatabaseSync(':memory:');
  const storePath =
    '../../../../src-server/services/projects/project-room-store.ts';
  const {
    ProjectRoomStore,
  }: { ProjectRoomStore: new (db: DatabaseSync) => RoomStoreFixture } =
    await import(storePath);
  store = new ProjectRoomStore(db);
  roomId = store.ensureRoom(scope, current).roomId;
  connections = [];
  reads = [];
  typingPosts = [];
  clients = [];
  historyFailure = false;
  holdNextHistory = false;
  heldHistory = undefined;
  holdOnlyAfter = undefined;
  server = createServer(async (request, response) => {
    const url = new URL(request.url!, apiBase);
    const ok = (data: unknown) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ success: true, data }));
    };
    if (url.pathname.endsWith('/rooms/live')) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.flushHeaders();
      connections.push({
        channels: url.searchParams.getAll('channel'),
        response,
      });
      return;
    }
    if (url.pathname.endsWith('/presence')) {
      for await (const _ of request);
      ok([]);
      return;
    }
    if (url.pathname.endsWith('/typing')) {
      let body = '';
      for await (const chunk of request) body += chunk;
      typingPosts.push(JSON.parse(body));
      ok({ typing: JSON.parse(body).typing });
      return;
    }
    if (url.pathname.endsWith('/messages')) {
      const after = Number(url.searchParams.get('after'));
      const limit = Number(url.searchParams.get('limit'));
      reads.push({ after, limit });
      const snapshot = store.history(scope, after, limit);
      if (historyFailure) {
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({ success: false, error: 'History is unavailable.' }),
        );
        return;
      }
      if (
        holdNextHistory &&
        (holdOnlyAfter === undefined || after === holdOnlyAfter)
      ) {
        holdNextHistory = false;
        heldHistory = () => ok(snapshot);
        return;
      }
      ok(snapshot);
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
  setClientCredentialResolver(() => ({
    origin: apiBase,
    credential: 'fixture',
    requestAuthority: { apiBase, authorityKey: 'one', isCurrent: () => true },
  }));
});
afterEach(async () => {
  cleanup();
  for (const client of clients) client.clear();
  setClientCredentialResolver(undefined);
  for (const connection of connections) connection.response.end();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  db.close();
});

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}
function push(event: string, data: Record<string, unknown>) {
  const connection = connections[connections.length - 1];
  if (!connection) throw new Error('No live connection');
  connection.response.write(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}
function append(text: string, who: ProjectRoomActor = other) {
  return store.append(scope, who, { intentId: randomUUID(), text }, current);
}
function seed(count: number) {
  for (let index = 1; index <= count; index++) append(`Update ${index}`);
}
/** Mounts the default room and waits for its first reconciliation. */
async function openRoom() {
  const hook = renderHook(
    () => {
      const value = useProjectRoom(
        { apiBase, authorityKey: 'one' },
        'team',
        scope.localProjectId,
      );
      // React Query re-renders for what a render reads; read what is asserted.
      void [value.history.status, value.history.data, value.history.isFetching];
      return value;
    },
    { wrapper: wrapper() },
  );
  await waitFor(() => expect(connections).toHaveLength(1));
  await waitFor(() => expect(hook.result.current.history.isSuccess).toBe(true));
  const { lastSeq } = store.history(scope).checkpoint;
  const initial = reads.length;
  push('subscribed', { key: roomId, roomId, lastSeq, activity: 0 });
  // The (re)connection's one reconciliation read.
  await waitFor(() => expect(reads.length).toBeGreaterThan(initial));
  await waitFor(() =>
    expect(hook.result.current.history.isFetching).toBe(false),
  );
  await waitFor(() => expect(hook.result.current.lastSeq).toBe(lastSeq));
  return hook;
}
const seqs = (hook: Awaited<ReturnType<typeof openRoom>>) =>
  hook.result.current.history.data?.pages[0]?.messages.map((m) => m.seq);

test('ten rooms and the open one share one live connection', async () => {
  const channels = [roomId, ...Array.from({ length: 9 }, () => randomUUID())];
  const index = renderHook(
    () =>
      useProjectRoomLiveIndex(
        { apiBase, authorityKey: 'one' },
        'team',
        channels,
        true,
      ),
    { wrapper: wrapper() },
  );
  const room = renderHook(
    () =>
      useProjectRoom(
        { apiBase, authorityKey: 'one' },
        'team',
        scope.localProjectId,
      ),
    { wrapper: wrapper() },
  );
  await waitFor(() =>
    expect(room.result.current.discovery.isSuccess).toBe(true),
  );
  await waitFor(() => expect(connections.length).toBeGreaterThan(0));
  // Give the hub its settle time: any second connection would open now.
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(connections).toHaveLength(1);
  expect([...connections[0]!.channels].sort()).toEqual([...channels].sort());
  push('subscribed', {
    key: channels[4]!,
    roomId: channels[4]!,
    lastSeq: 0,
    activity: 0,
  });
  push('typing', { key: channels[4]!, actors: [other] });
  await waitFor(() =>
    expect(index.result.current.get(channels[4]!)?.typing).toEqual([other]),
  );
});

test('a live append is merged into the cached history without re-reading it', async () => {
  seed(3);
  const hook = await openRoom();
  expect(seqs(hook)).toEqual([1, 2, 3]);
  const before = reads.length;
  const message = append('Live one');
  push('append', { key: roomId, message });
  await waitFor(() => expect(seqs(hook)).toEqual([1, 2, 3, 4]));
  expect(hook.result.current.lastSeq).toBe(4);
  expect(reads).toHaveLength(before);
});

test('a sequence gap is backfilled from history before the frame after it, never skipped', async () => {
  seed(2);
  const hook = await openRoom();
  const before = reads.length;
  // Messages 3 and 4 commit, but only 5's frame arrives.
  append('missed three');
  append('missed four');
  const five = append('five');
  push('append', { key: roomId, message: five });
  await waitFor(() => expect(seqs(hook)).toEqual([1, 2, 3, 4, 5]));
  expect(reads.slice(before)).toEqual([{ after: 2, limit: 2 }]);
  expect(
    hook.result.current.history.data?.pages[0]?.messages.map((m) => m.text),
  ).toEqual(['Update 1', 'Update 2', 'missed three', 'missed four', 'five']);
});

test('an update whose activity range does not start where the cache is re-reads the room', async () => {
  seed(1);
  const hook = await openRoom();
  const message = store.history(scope).messages[0]!;
  const before = reads.length;
  // In order: merged, no read.
  push('update', {
    key: roomId,
    messages: [
      {
        ...message,
        text: 'edited in place',
        editedAt: new Date().toISOString(),
      },
    ],
    fromActivity: 0,
    activity: 1,
  });
  await waitFor(() =>
    expect(hook.result.current.history.data?.pages[0]?.messages[0]?.text).toBe(
      'edited in place',
    ),
  );
  expect(reads).toHaveLength(before);
  // Activity 1 → 2 was missed: this frame starts at 2, so the room re-reads.
  push('update', {
    key: roomId,
    messages: [message],
    fromActivity: 2,
    activity: 3,
  });
  await waitFor(() => expect(reads.length).toBeGreaterThan(before));
});

test('typing shows other people only, and the reader’s own typing is sent and stopped', async () => {
  const hook = await openRoom();
  push('typing', { key: roomId, actors: [actor, other] });
  await waitFor(() => expect(hook.result.current.typing).toEqual([other]));
  act(() => hook.result.current.notifyTyping(true));
  act(() => hook.result.current.notifyTyping(true));
  await waitFor(() =>
    expect(typingPosts).toEqual([expect.objectContaining({ typing: true })]),
  );
  act(() => hook.result.current.notifyTyping(false));
  await waitFor(() =>
    expect(typingPosts.map((post) => post.typing)).toEqual([true, false]),
  );
  // A dropped connection clears what it reported.
  push('typing', { key: roomId, actors: [other] });
  await waitFor(() => expect(hook.result.current.typing).toEqual([other]));
  connections[connections.length - 1]!.response.destroy();
  await waitFor(() => expect(hook.result.current.typing).toEqual([]));
});

test('agent activity comes from the stream’s request records', async () => {
  const hook = await openRoom();
  const request = {
    requestId: randomUUID(),
    agentId: 'writer',
    actor,
    state: 'started',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  push('agents', { key: roomId, requests: [request] });
  await waitFor(() =>
    expect(hook.result.current.agents.map((r) => r.state)).toEqual(['started']),
  );
  push('agents', {
    key: roomId,
    requests: [{ ...request, state: 'published' }],
  });
  await waitFor(() =>
    expect(hook.result.current.agents.map((r) => r.state)).toEqual([
      'published',
    ]),
  );
});

test('a room opened after the sidebar already holds the connection still backfills a gap, never skips it', async () => {
  // The sidebar's index opens the Project's one connection, and the server
  // announces the room before the room hook (which waits for discovery)
  // joins. The room must still learn where the stream stands.
  seed(2);
  const index = renderHook(
    () =>
      useProjectRoomLiveIndex(
        { apiBase, authorityKey: 'one' },
        'team',
        [roomId],
        true,
      ),
    { wrapper: wrapper() },
  );
  await waitFor(() => expect(connections).toHaveLength(1));
  const { lastSeq } = store.history(scope).checkpoint;
  push('subscribed', { key: roomId, roomId, lastSeq, activity: 0 });
  push('typing', { key: roomId, actors: [other] });
  await waitFor(() =>
    expect(index.result.current.get(roomId)?.typing).toEqual([other]),
  );
  const room = renderHook(
    () => {
      const value = useProjectRoom(
        { apiBase, authorityKey: 'one' },
        'team',
        scope.localProjectId,
      );
      void [value.history.status, value.history.data, value.history.isFetching];
      return value;
    },
    { wrapper: wrapper() },
  );
  await waitFor(() => expect(room.result.current.history.isSuccess).toBe(true));
  // The connection was not reopened for the room, and the room knows the
  // stream's position and who is typing.
  await waitFor(() => expect(room.result.current.lastSeq).toBe(lastSeq));
  await waitFor(() => expect(room.result.current.typing).toEqual([other]));
  expect(connections).toHaveLength(1);
  await waitFor(() =>
    expect(room.result.current.history.isFetching).toBe(false),
  );
  const before = reads.length;
  append('missed three');
  const four = append('four');
  push('append', { key: roomId, message: four });
  await waitFor(() =>
    expect(
      room.result.current.history.data?.pages[0]?.messages.map((m) => m.seq),
    ).toEqual([1, 2, 3, 4]),
  );
  expect(reads.slice(before)).toEqual([{ after: 2, limit: 1 }]);
});

// #4985 review: the cursor follows what history actually delivered, never
// what the stream announced while history was failing.
test('a resync whose history read fails never lets the next append skip the messages it announced', async () => {
  seed(1);
  const hook = await openRoom();
  // 2 and 3 commit, but their frames never arrive.
  append('missed two');
  append('missed three');
  historyFailure = true;
  push('resync', { key: roomId, lastSeq: 3, activity: 0 });
  await waitFor(() => expect(hook.result.current.history.isError).toBe(true));
  // History recovers on the same open connection.
  historyFailure = false;
  const four = append('four');
  push('append', { key: roomId, message: four });
  await waitFor(() => expect(hook.result.current.lastSeq).toBe(4));
  await waitFor(() => expect(seqs(hook)).toEqual([1, 2, 3, 4]));
});

test('a reconnection whose history read fails never lets the next append skip the messages it announced', async () => {
  seed(1);
  const hook = await openRoom();
  append('missed two');
  append('missed three');
  historyFailure = true;
  // The connection is announced again (a reconnect) while history is down.
  push('subscribed', { key: roomId, roomId, lastSeq: 3, activity: 0 });
  await waitFor(() => expect(hook.result.current.history.isError).toBe(true));
  historyFailure = false;
  const four = append('four');
  push('append', { key: roomId, message: four });
  await waitFor(() => expect(hook.result.current.lastSeq).toBe(4));
  await waitFor(() => expect(seqs(hook)).toEqual([1, 2, 3, 4]));
});

test('a history read already in flight never undoes a live append, in the cache or for its caller', async () => {
  seed(1);
  const hook = await openRoom();
  holdNextHistory = true;
  const waiting = hook.result.current.history.refetch();
  await waitFor(() => expect(heldHistory).toBeDefined());
  // The held read captured [1]; 2 is appended and delivered meanwhile.
  const two = append('two');
  push('append', { key: roomId, message: two });
  await waitFor(() => expect(seqs(hook)).toEqual([1, 2]));
  heldHistory!();
  const answer = await waiting;
  await waitFor(() =>
    expect(hook.result.current.history.isFetching).toBe(false),
  );
  expect(seqs(hook)).toEqual([1, 2]);
  expect(answer.data?.pages[0]?.messages.map((m) => m.seq)).toEqual([1, 2]);
});

// #4985 delta review: the hook remembers at most 500 merged rows. A read that
// began before more merges than that must not be trusted with what it read.
async function appendDuringHeldRead(count: number) {
  seed(1);
  const hook = await openRoom();
  holdNextHistory = true;
  const waiting = hook.result.current.history.refetch();
  await waitFor(() => expect(heldHistory).toBeDefined());
  for (let index = 0; index < count; index++)
    push('append', { key: roomId, message: append(`during read ${index}`) });
  await waitFor(() => expect(hook.result.current.lastSeq).toBe(count + 1), {
    timeout: 10_000,
  });
  heldHistory!();
  const answer = await waiting;
  await waitFor(() =>
    expect(hook.result.current.history.isFetching).toBe(false),
  );
  return { hook, answer };
}
const allSeqs = (to: number) => Array.from({ length: to }, (_, i) => i + 1);

test('a read held across as many merges as the hook remembers keeps every row (control)', async () => {
  const { hook, answer } = await appendDuringHeldRead(500);
  expect(seqs(hook)).toEqual(allSeqs(501));
  expect(answer.data?.pages[0]?.messages.map((m) => m.seq)).toEqual(
    allSeqs(501),
  );
});

test('a read held across more merges than the hook remembers is read again, never trusted to drop one', async () => {
  const { hook, answer } = await appendDuringHeldRead(501);
  expect(seqs(hook)).toEqual(allSeqs(502));
  expect(answer.data?.pages[0]?.messages.map((m) => m.seq)).toEqual(
    allSeqs(502),
  );
  push('append', { key: roomId, message: append('after read') });
  await waitFor(() => expect(hook.result.current.lastSeq).toBe(503));
  expect(seqs(hook)).toEqual(allSeqs(503));
});

test('a deletion merged during a held read stays deleted however many merges follow it', async () => {
  seed(1);
  const hook = await openRoom();
  const one = store.history(scope).messages[0]!;
  holdNextHistory = true;
  const waiting = hook.result.current.history.refetch();
  await waitFor(() => expect(heldHistory).toBeDefined());
  const tombstone = store.deleteMessage(
    scope,
    other,
    one.messageId,
    { intentId: randomUUID() },
    current,
  );
  push('update', {
    key: roomId,
    fromActivity: 0,
    activity: 1,
    messages: [tombstone],
  });
  await waitFor(() =>
    expect(
      hook.result.current.history.data?.pages[0]?.messages[0]?.deletedAt,
    ).toBeDefined(),
  );
  for (let index = 0; index < 500; index++)
    push('append', { key: roomId, message: append(`after delete ${index}`) });
  await waitFor(() => expect(hook.result.current.lastSeq).toBe(501), {
    timeout: 10_000,
  });
  heldHistory!();
  const answer = await waiting;
  await waitFor(() =>
    expect(hook.result.current.history.isFetching).toBe(false),
  );
  const cached = hook.result.current.history.data?.pages[0]?.messages[0];
  const read = answer.data?.pages[0]?.messages[0];
  expect(cached?.deletedAt).toBeDefined();
  expect(cached?.text).toBe('');
  expect(read?.deletedAt).toBeDefined();
  expect(read?.text).toBe('');
});

test('a read outlived on every attempt fails rather than answer with rows it lost, and the cache keeps them', async () => {
  seed(1);
  const hook = await openRoom();
  // A long window is read in several pages: hold only each attempt's first.
  holdOnlyAfter = 0;
  holdNextHistory = true;
  const waiting = hook.result.current.history.refetch();
  let lastSeq = 1;
  // Each attempt (the first read and both re-reads) is held while more rows
  // merge than the hook remembers.
  for (let attempt = 0; attempt < 3; attempt++) {
    await waitFor(() => expect(heldHistory).toBeDefined());
    const release = heldHistory!;
    heldHistory = undefined;
    for (let index = 0; index < 501; index++)
      push('append', {
        key: roomId,
        message: append(`burst ${attempt}.${index}`),
      });
    lastSeq += 501;
    await waitFor(() => expect(hook.result.current.lastSeq).toBe(lastSeq), {
      timeout: 10_000,
    });
    holdNextHistory = attempt < 2;
    release();
  }
  const answer = await waiting;
  expect(answer.isError).toBe(true);
  expect(String(answer.error)).toContain(
    'changed faster than it could be read',
  );
  expect(seqs(hook)).toEqual(allSeqs(lastSeq));
});
