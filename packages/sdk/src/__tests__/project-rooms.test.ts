import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  StationRequestAuthorityError,
  StationRequestTimeoutError,
  setClientCredentialResolver,
  setClientRequestTimeout,
} from '../client/http';
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
  setClientRequestTimeout(undefined);
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

test.each([200, 502])(
  'preserves body-reader failures instead of reporting malformed JSON (HTTP %i)',
  async (status) => {
    const failures = [
      new StationRequestTimeoutError(requestScope.apiBase, 20, {
        method: 'GET',
      }),
      new StationRequestAuthorityError(),
      new DOMException('Cancelled by caller', 'AbortError'),
      { code: 'caller-cancelled' },
    ];
    for (const failure of failures) {
      const response = new Response('{}', { status });
      vi.spyOn(response, 'json').mockRejectedValue(failure);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      await expect(
        discoverProjectRoom(requestScope, 'team', 'project'),
      ).rejects.toBe(failure);
    }
  },
);

test.each([200, 502])(
  'still classifies malformed JSON using the response status (HTTP %i)',
  async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not JSON', { status })),
    );
    const result = discoverProjectRoom(requestScope, 'team', 'project');
    if (status === 200)
      await expect(result).rejects.toThrow(
        'Project room response is not JSON.',
      );
    else await expect(result).rejects.toMatchObject({ status });
  },
);

test.each(
  [200, 502].flatMap((status) =>
    ['discover', 'initialize'].map((operation) => ({ status, operation })),
  ),
)(
  '$operation rejects a stalled transport body with the canonical deadline (HTTP $status)',
  async ({ status, operation }) => {
    setClientRequestTimeout(20);
    const cancel = vi.fn();
    const transport = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"success":'));
            },
            cancel,
          }),
          { status },
        ),
    );
    setClientCredentialResolver(() => ({
      origin: requestScope.apiBase,
      requestAuthority: { ...requestScope, isCurrent: () => true },
      transport,
    }));
    const request =
      operation === 'discover'
        ? discoverProjectRoom(requestScope, 'team', 'project')
        : initializeProjectRoom(requestScope, 'team', 'project');
    await expect(request).rejects.toBeInstanceOf(StationRequestTimeoutError);
    await expect(request).rejects.toMatchObject({
      timeoutMs: 20,
      method: operation === 'discover' ? 'GET' : 'POST',
      mutation: operation === 'initialize',
    });
    expect(transport).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  },
);

test('a caller cancellation remains observable while the room transport body is pending', async () => {
  const caller = new AbortController();
  const reason = { code: 'caller-cancelled' };
  let reading!: () => void;
  const bodyRead = new Promise<void>((resolve) => {
    reading = resolve;
  });
  const transport = vi.fn(async (_input: unknown, init?: RequestInit) => {
    expect(init?.signal).toBe(caller.signal);
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"success":'));
          init?.signal?.addEventListener(
            'abort',
            () => controller.error(init.signal?.reason),
            { once: true },
          );
        },
      }),
    );
    const clone = response.clone.bind(response);
    vi.spyOn(response, 'clone').mockImplementation(() => {
      const value = clone();
      reading();
      return value;
    });
    return response;
  });
  setClientCredentialResolver(() => ({
    origin: requestScope.apiBase,
    requestAuthority: { ...requestScope, isCurrent: () => true },
    transport,
  }));
  const request = discoverProjectRoom(
    requestScope,
    'team',
    'project',
    caller.signal,
  );
  const rejected = expect(request).rejects.toBe(reason);
  await bodyRead;
  caller.abort(reason);
  await rejected;
  expect(transport).toHaveBeenCalledOnce();
});

test('a room body cannot publish after its captured authority becomes stale', async () => {
  let current = true;
  let reading!: () => void;
  const bodyRead = new Promise<void>((resolve) => {
    reading = resolve;
  });
  let finish!: () => void;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"success":true,"data":'));
        finish = () => {
          controller.enqueue(
            new TextEncoder().encode(`${JSON.stringify(view)}}`),
          );
          controller.close();
        };
      },
    }),
  );
  const clone = response.clone.bind(response);
  vi.spyOn(response, 'clone').mockImplementation(() => {
    const value = clone();
    reading();
    return value;
  });
  const transport = vi.fn(async () => response);
  const resolver = vi.fn(() => ({
    origin: requestScope.apiBase,
    requestAuthority: { ...requestScope, isCurrent: () => current },
    transport,
  }));
  setClientCredentialResolver(resolver);
  const request = discoverProjectRoom(requestScope, 'team', 'project');
  const rejected = expect(request).rejects.toBeInstanceOf(
    StationRequestAuthorityError,
  );
  await bodyRead;
  current = false;
  finish();
  await rejected;
  expect(transport).toHaveBeenCalledOnce();
  expect(resolver).toHaveBeenCalledOnce();
});
