import {
  STATION_ENVELOPE_HEADER,
  STATION_ENVELOPE_HEADER_VALUE,
} from '@kontourai/station-contracts/http';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createRemoteStationForwarder } from '../../../services/remote-stations/remote-station-forwarder.js';
import { classifyPeerChatOperation } from '../peer-chat-policy.js';
import { createPeerChatRoutes } from '../peer-chat-routes.js';

function fixture() {
  const state = {
    enabled: true,
    current: true,
    identity: 'desktop-win',
    peer: {
      environmentId: 'desktop-win',
      apiBase: 'https://desktop.test',
      credential: 'test-peer',
      scope: 'orchestration:read orchestration:operate projects:read',
      label: 'desktop-win',
      createdAt: 1,
      updatedAt: 1,
    },
  };
  const peers = { get: vi.fn(() => ({ ...state.peer })) };
  const remote = createRemoteStationForwarder({
    peers,
    ssh: { list: () => [], connect: vi.fn() },
  });
  const app = createPeerChatRoutes({
    peers,
    remote,
    current: () => state.current,
    owner: () => true,
    preview: {
      select: (branches) =>
        state.enabled ? branches.enabled() : branches.disabled(),
    },
  });
  const fetch = vi.fn(
    async (input: string | URL | Request, _init?: RequestInit) => {
      if (String(input).endsWith('/.well-known/station/v1'))
        return Response.json({ environmentId: state.identity });
      return Response.json(
        { success: true, data: { sessionId: 'remote-session' } },
        {
          headers: {
            'Set-Cookie': 'remote=secret',
            Location: 'https://elsewhere.test',
          },
        },
      );
    },
  );
  vi.stubGlobal('fetch', fetch);
  const call = (path = '/api/projects', body?: unknown) =>
    app.request(`/desktop-win/chat-api${path}`, {
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
      headers: {
        Authorization: 'Bearer source-credential',
        Cookie: 'source-cookie=secret',
        'Content-Type': 'application/json',
      },
    });
  return { state, peers, fetch, call };
}

afterEach(() => vi.unstubAllGlobals());

describe('paired Station foreground chat bridge', () => {
  test.each([
    { type: 'interruptTurn', threadId: 'one' },
    {
      type: 'steerTurn',
      threadId: 'one',
      input: 'Hello',
      clientInputId: 'key',
    },
    {
      type: 'steerTurnOnce',
      threadId: 'one',
      input: 'Hello',
      clientInputId: 'key',
    },
    {
      type: 'inspectSteerInput',
      threadId: 'one',
      input: 'Hello',
      clientInputId: 'key',
    },
    {
      type: 'respondToRequest',
      threadId: 'one',
      requestId: 'request',
      decision: 'decline',
    },
    { type: 'stopSession', threadId: 'one' },
    { type: 'discardDraft', threadId: 'one' },
  ])('reparses and forwards the actual $type command', async (command) => {
    const { call, fetch } = fixture();
    expect((await call('/api/orchestration/commands', command)).status).toBe(
      200,
    );
    expect(JSON.parse(String(fetch.mock.calls[1]![1]!.body))).toEqual(command);
  });

  test.each([
    { type: 'adoptSession', sourceThreadId: 'one' },
    {
      type: 'releaseUnknownOwnedWork',
      threadId: 'one',
      confirmation: 'child-process-may-still-be-running',
    },
  ])('denies $type even when its receiver schema is valid', async (command) => {
    const { call, fetch } = fixture();
    expect((await call('/api/orchestration/commands', command)).status).toBe(
      400,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([true, false])(
    'known pre-effect codes require receiver attribution: marked=%s',
    async (marked) => {
      const { call, fetch } = fixture();
      fetch.mockImplementation(async (input) =>
        String(input).endsWith('/.well-known/station/v1')
          ? Response.json({ environmentId: 'desktop-win' })
          : Response.json(
              { success: false, code: 'provider_turn_in_progress' },
              {
                status: 409,
                headers: marked
                  ? { [STATION_ENVELOPE_HEADER]: STATION_ENVELOPE_HEADER_VALUE }
                  : {},
              },
            ),
      );
      const response = await call('/api/orchestration/chat', {
        target: { environment: { kind: 'current' }, agent: 'codex' },
        message: 'Hello',
        clientTurnId: 'key',
      });
      expect(response.status).toBe(marked ? 424 : 409);
      if (marked)
        expect(await response.json()).toMatchObject({
          details: {
            remoteStatus: 409,
            refusalCode: 'provider_turn_in_progress',
            mutationKey: 'key',
          },
        });
    },
  );
  test.each([
    ['GET', '/.well-known/station/v1'],
    ['GET', '/api/projects'],
    ['GET', '/api/agents'],
    ['GET', '/api/agents/codex'],
    ['GET', '/api/connections/agents'],
    ['GET', '/api/connections/models'],
    ['GET', '/api/conversations/chat:one/open'],
    ['GET', '/api/orchestration/events'],
    ['GET', '/api/orchestration/sessions'],
    ['GET', '/api/orchestration/sessions/one?view=window-v1'],
    ['GET', '/api/orchestration/conversations/one/event-window?turnLimit=5'],
    ['GET', '/api/orchestration/sessions/one/requests/request/content-binding'],
    ['GET', '/api/orchestration/sessions/one/input-requests/request'],
    [
      'GET',
      '/api/orchestration/sessions/one/child-work/child/transcript?limit=10',
    ],
    ['GET', '/api/orchestration/sessions/one/child-work/child/instructions'],
    ['GET', '/api/orchestration/sessions/one/checkpoints'],
    ['GET', '/api/orchestration/sessions/one/checkpoint-restores'],
    ['GET', '/api/orchestration/sessions/one/usage-limit'],
    ['GET', '/api/orchestration/conversations/one/usage-tree'],
    ['GET', '/api/orchestration/conversations/one/context-boundary/key'],
    ['GET', '/api/orchestration/conversations/one/inbox'],
    ['POST', '/api/orchestration/conversations/one/inbox'],
    ['DELETE', '/api/orchestration/conversations/one/inbox/key'],
    ['GET', '/api/orchestration/conversations/one/turn-deliveries/key'],
    ['GET', '/api/orchestration/commands/receipts?threadId=one'],
    ['GET', '/api/orchestration/commands/receipts/one'],
    ['POST', '/api/orchestration/chat'],
    ['POST', '/api/orchestration/chat/one/continue'],
    ['POST', '/api/orchestration/commands'],
    ['GET', '/api/orchestration/providers'],
    ['GET', '/api/orchestration/providers/codex/models'],
    ['GET', '/api/orchestration/providers/codex/commands'],
    [
      'POST',
      '/api/orchestration/sessions/one/checkpoints/turn/restore-preview',
    ],
    ['POST', '/api/orchestration/sessions/one/checkpoints/turn/restore'],
    ['GET', '/api/attachments/ref'],
    ['GET', '/api/orchestration/attachment-staging/capability'],
    ['POST', '/api/orchestration/attachment-staging/prepare'],
    ['POST', '/api/orchestration/attachment-staging/reconcile'],
    [
      'PUT',
      '/api/orchestration/attachment-staging/stage_11111111-1111-4111-8111-111111111111',
    ],
    [
      'DELETE',
      '/api/orchestration/attachment-staging/stage_11111111-1111-4111-8111-111111111111',
    ],
  ])('admits exactly %s %s', (method, path) => {
    const [pathname, query] = path.split('?');
    expect(classifyPeerChatOperation(method, pathname!, query)).not.toBeNull();
    expect(classifyPeerChatOperation('PATCH', pathname!, query)).toBeNull();
  });

  test.each([
    '/api/peers',
    '/api/pairing',
    '/api/auth/authority',
    '/api/access',
    '/api/users',
    '/api/people',
    '/api/groups',
    '/api/config',
    '/api/settings',
    '/api/secrets',
    '/api/connections/credentials',
    '/api/acp',
    '/api/terminals',
    '/api/unattended-grants',
    '/api/station-control',
    '/api/orchestration/chat/background',
    '/api/orchestration/chat/delegated',
    '/api/orchestration/delegations',
    '/api/orchestration/delegations/one',
    '/api/orchestration/conversations/one/handoff',
    '/api/projects?environmentId=third',
    '/api/orchestration/events?includeGeneral=1',
    '/api/orchestration/events?threadId=a%2fb',
    '/api/orchestration/events?threadId=a%252fb',
    '/api/orchestration/sessions/loaded?view=window-v1',
    '/api/orchestration/sessions/read-model?view=window-v1',
    '/api/orchestration/events?threadId=a&threadId=b',
    '/api/orchestration/sessions/one',
    '/api/agents/%2fconfig',
    '/api/agents/%252fconfig',
    '/api/agents/%2e%2e',
    '/api/agents/..',
    '/api/agents/a%5cb',
  ])('denies all methods on %s', (path) => {
    const [pathname, query] = path.split('?');
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
      expect(classifyPeerChatOperation(method, pathname!, query)).toBeNull();
  });

  test.each([
    'userId',
    'automaticBackground',
    'delegation',
    'preparation',
    'actor',
  ])('rejects spoofed %s before any target read', async (field) => {
    const { call, fetch } = fixture();
    expect(
      (
        await call('/api/orchestration/chat', {
          target: { environment: { kind: 'current' }, agent: 'codex' },
          message: 'Hello',
          [field]: true,
        })
      ).status,
    ).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  test('uses only the saved peer credential, confirms identity, and never publishes remote cookies', async () => {
    const { call, fetch } = fixture();
    const response = await call('/api/orchestration/chat', {
      target: {
        environment: { kind: 'current' },
        agent: 'codex',
        workspace: { kind: 'project', projectSlug: 'receiver-project' },
      },
      conversationId: 'chat:one',
      clientTurnId: 'turn-one',
      message: 'Which machine is this?',
      whenBusy: 'queue',
    });
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, init] = fetch.mock.calls[1]!;
    expect(url).toBe('https://desktop.test/api/orchestration/chat');
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      'Bearer test-peer',
    );
    expect(new Headers(init?.headers).get('Cookie')).toBeNull();
    expect(JSON.parse(String(init?.body))).toEqual({
      target: {
        environment: { kind: 'current' },
        agent: 'codex',
        workspace: { kind: 'project', projectSlug: 'receiver-project' },
      },
      conversationId: 'chat:one',
      clientTurnId: 'turn-one',
      message: 'Which machine is this?',
      whenBusy: 'queue',
    });
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(response.headers.get('Location')).toBeNull();
    expect(await response.text()).not.toContain('test-peer');
  });

  test("forwards the transcript's revisioned checkpoint read to the receiver", async () => {
    const { call, fetch } = fixture();
    // The exact URL `useActiveChatTranscript` issues through the relay.
    const response = await call(
      '/api/orchestration/sessions/claude%3A1794521333066/checkpoints?revision=4',
    );
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]![0]).toBe(
      'https://desktop.test/api/orchestration/sessions/claude%3A1794521333066/checkpoints?revision=4',
    );
    expect(
      classifyPeerChatOperation(
        'GET',
        '/api/orchestration/sessions/one/checkpoints',
        '?revision=4&view=all',
      ),
    ).toBeNull();
    expect(
      classifyPeerChatOperation(
        'GET',
        '/api/orchestration/sessions/one/usage-limit',
        '?revision=4',
      ),
    ).toBeNull();
  });

  test('rechecks preview and request authority on the same composed route before any peer read', async () => {
    const { call, state, peers, fetch } = fixture();
    state.enabled = false;
    expect(await (await call()).json()).toMatchObject({
      code: 'feature_preview_disabled',
    });
    expect(peers.get).not.toHaveBeenCalled();
    state.enabled = true;
    state.current = false;
    expect((await call()).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    state.current = true;
    expect((await call()).status).toBe(200);
  });

  test.each([
    ['/api/orchestration/delegations', {}],
    [
      '/api/orchestration/chat',
      { target: { agent: 'codex' }, message: 'No environment' },
    ],
    [
      '/api/orchestration/chat',
      {
        target: {
          environment: { kind: 'saved', id: 'third-host' },
          agent: 'codex',
        },
        message: 'Forward this',
      },
    ],
    [
      '/api/orchestration/chat',
      {
        target: {
          environment: { kind: 'current' },
          agent: 'codex',
          workspace: { kind: 'directory', cwd: '/private' },
        },
        message: 'Run here',
      },
    ],
    [
      '/api/orchestration/commands',
      { type: 'startSession', input: { threadId: 'new', provider: 'codex' } },
    ],
  ])(
    'refuses unsupported operation %s without contacting a peer',
    async (path, body) => {
      const { call, fetch } = fixture();
      expect((await call(path, body)).status).toBeGreaterThanOrEqual(400);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  test('a wrong remote identity refuses before dispatch; rotated credentials withhold an in-flight read', async () => {
    const { call, state, fetch } = fixture();
    state.identity = 'different-station';
    expect((await call()).status).toBe(409);
    expect(fetch).toHaveBeenCalledTimes(1);
    state.identity = 'desktop-win';
    fetch.mockImplementation(async (input) => {
      if (String(input).endsWith('/.well-known/station/v1'))
        return Response.json({ environmentId: state.identity });
      state.peer.credential = 'replacement-credential';
      return Response.json({ success: true, data: ['private-project'] });
    });
    const response = await call();
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('private-project');
  });
  test('publishes spilled content as inert text and preserves its content protocol headers', async () => {
    const { call, fetch } = fixture();
    fetch.mockImplementation(async (input) =>
      String(input).endsWith('/.well-known/station/v1')
        ? Response.json({ environmentId: 'desktop-win' })
        : new Response('<script>untrusted</script>', {
            headers: {
              'Content-Type': 'text/html',
              'X-Station-Content-Kind': 'string',
              'X-Station-Content-Complete': 'true',
            },
          }),
    );
    const response = await call('/api/orchestration/sessions/one/content/ref');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/plain');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Station-Content-Kind')).toBe('string');
    expect(await response.text()).toBe('<script>untrusted</script>');
  });
  test('an identity transport failure does not claim a foreground send was attempted', async () => {
    const { call, fetch } = fixture();
    fetch.mockRejectedValue(new Error('offline'));
    const response = await call('/api/orchestration/chat', {
      target: { environment: { kind: 'current' }, agent: 'codex' },
      message: 'Hello',
    });
    expect(response.status).toBe(502);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await response.json()).toMatchObject({
      error: 'Could not reach the paired Station. Reconnect and try again.',
    });
  });

  test('content refusals retain the JSON error envelope', async () => {
    const { call, fetch } = fixture();
    fetch.mockImplementation(async (input) =>
      String(input).endsWith('/.well-known/station/v1')
        ? Response.json({ environmentId: 'desktop-win' })
        : Response.json(
            { success: false, error: 'Content unavailable' },
            { status: 404 },
          ),
    );
    const response = await call('/api/orchestration/sessions/one/content/ref');
    expect(response.status).toBe(404);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(await response.json()).toMatchObject({
      error: 'Content unavailable',
    });
  });
});

test('relays only the value-free managed policy read, with the receiver credential', async () => {
  const { call, fetch } = fixture();
  expect((await call('/api/settings/managed-policy')).status).toBe(200);
  expect(fetch.mock.calls[1]?.[0]).toBe(
    'https://desktop.test/api/settings/managed-policy',
  );
  expect(
    new Headers(fetch.mock.calls[1]?.[1]?.headers).get('Authorization'),
  ).toBe('Bearer test-peer');
  expect(
    classifyPeerChatOperation('POST', '/api/settings/managed-policy'),
  ).toBeNull();
  expect(classifyPeerChatOperation('GET', '/api/settings')).toBeNull();
});
