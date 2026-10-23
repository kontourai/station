import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setClientCredentialResolver } from '../client/http';
import {
  discoverProjectRoom,
  fetchProjectRoomHistory,
  initializeProjectRoom,
  parseProjectRoomMessageIntent,
  saveProjectRoomNote,
  sendProjectRoomMessage,
} from '../client/project-rooms';

const roomId = '11111111-1111-4111-8111-111111111111';
const intentId = '22222222-2222-4222-8222-222222222222';
const messageId = '33333333-3333-4333-8333-333333333333';
const scope = {
  stationId: 'station',
  localProjectId: 'project',
  localProjectSlug: 'team',
  portableProjectId: 'portable',
};
const actor = { id: 'person-one', displayName: 'Ada', kind: 'person' };
const requestScope = {
  apiBase: 'https://room.example',
  authorityKey: 'room-authority',
};
const guards = {
  expectedRoomId: roomId,
  expectedProjectId: 'project',
  expectedActorId: actor.id,
};
const proposal = { ...guards, intentId, text: 'Hello team' };
const at = '2026-10-22T12:00:00.000Z';
const message = {
  roomId,
  intentId,
  messageId,
  seq: 1,
  actor,
  text: proposal.text,
  createdAt: at,
};
const view = {
  scope,
  roomId,
  actor,
  presence: [],
  capabilities: { view: true, discuss: true, edit: true, execute: false },
  checkpoint: { roomId, lastSeq: 1 },
  note: null,
};
beforeEach(() =>
  setClientCredentialResolver(() => ({
    origin: requestScope.apiBase,
    requestAuthority: { ...requestScope, isCurrent: () => true },
  })),
);
afterEach(() => {
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});
const ok = (data: unknown) => Response.json({ success: true, data });
test('independent clients see a committed shared message and retry a lost acknowledgement with the exact retained payload', async () => {
  let committed: typeof message | undefined;
  let lost = true;
  const writes: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const payload = JSON.parse(String(init.body));
        writes.push(payload);
        if (
          payload.expectedActorId !== actor.id ||
          payload.expectedProjectId !== scope.localProjectId
        )
          return Response.json(
            { success: false, error: 'Refused' },
            { status: 403 },
          );
        committed ??= message;
        if (lost) {
          lost = false;
          throw new TypeError('Connection lost after commit');
        }
        return ok(committed);
      }
      if (url.includes('/messages?'))
        return ok({
          scope,
          roomId,
          messages: committed ? [committed] : [],
          checkpoint: { roomId, lastSeq: committed ? 1 : 0 },
          nextAfter: null,
        });
      return ok(view);
    }),
  );
  // Browser A retains before sending; Browser B owns an independent request context.
  const retained = JSON.stringify(proposal);
  await expect(
    sendProjectRoomMessage(requestScope, 'team', proposal),
  ).rejects.toThrow('Connection lost');
  const browserB = { ...requestScope };
  expect(
    (
      await fetchProjectRoomHistory(browserB, 'team', {
        roomId,
        projectId: 'project',
      })
    ).messages,
  ).toEqual([message]);
  const reloaded = parseProjectRoomMessageIntent(JSON.parse(retained));
  expect(await sendProjectRoomMessage(requestScope, 'team', reloaded)).toEqual(
    message,
  );
  expect(writes).toEqual([proposal, proposal]);
  await expect(
    sendProjectRoomMessage(requestScope, 'team', {
      ...reloaded,
      expectedActorId: 'other-person',
    }),
  ).rejects.toMatchObject({ status: 403 });
});
test('rejects a replacement project, foreign-room history, unknown/private fields and oversized responses', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ok(view)),
  );
  await expect(
    discoverProjectRoom(requestScope, 'team', 'replacement'),
  ).rejects.toThrow('identity changed');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ok({ ...view, privateSessionId: 'private' })),
  );
  await expect(
    discoverProjectRoom(requestScope, 'team', 'project'),
  ).rejects.toThrow('incompatible');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      ok({
        scope,
        roomId,
        messages: [{ ...message, roomId: intentId }],
        checkpoint: view.checkpoint,
        nextAfter: null,
      }),
    ),
  );
  await expect(
    fetchProjectRoomHistory(requestScope, 'team', {
      roomId,
      projectId: 'project',
    }),
  ).rejects.toThrow('identity changed');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('x'.repeat(600000))),
  );
  await expect(
    discoverProjectRoom(requestScope, 'team', 'project'),
  ).rejects.toThrow('too large');
});
test('preserves notes CAS conflicts and rejects mismatched message acknowledgements', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        { success: false, error: 'Notes changed' },
        { status: 409 },
      ),
    ),
  );
  await expect(
    saveProjectRoomNote(requestScope, 'team', {
      ...guards,
      expectedRevision: 1,
      markdown: 'Decision',
      sourceMessageIds: [],
    }),
  ).rejects.toMatchObject({ status: 409 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ok({ ...message, text: 'Different payload' })),
  );
  await expect(
    sendProjectRoomMessage(requestScope, 'team', proposal),
  ).rejects.toThrow('does not match');
});

test('initialization validates the returned Project identity and preserves discuss denial', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      ok({ scope: { ...scope, localProjectId: 'replacement' }, roomId }),
    ),
  );
  await expect(
    initializeProjectRoom(requestScope, 'team', 'project'),
  ).rejects.toThrow('identity changed');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        { error: { code: 'project_room_access_changed' } },
        { status: 403 },
      ),
    ),
  );
  await expect(
    initializeProjectRoom(requestScope, 'team', 'project'),
  ).rejects.toMatchObject({ status: 403, code: 'project_room_access_changed' });
});
