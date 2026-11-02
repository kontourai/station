import { afterEach, describe, expect, test, vi } from 'vitest';
import { createRemoteStationForwarder } from '../../../services/remote-stations/remote-station-forwarder.js';
import { createPeerChatRoutes } from '../peer-chat-routes.js';

function fixture() {
  const state = {
    enabled: true,
    current: true,
    identity: 'desktop-win',
    peer: {
      environmentId: 'desktop-win',
      apiBase: 'https://desktop.test',
      credential: 'receiver-secret-123456',
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
      userId: 'forged-owner',
      automaticBackground: true,
    });
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, init] = fetch.mock.calls[1]!;
    expect(url).toBe('https://desktop.test/api/orchestration/chat');
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      'Bearer receiver-secret-123456',
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
    });
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(response.headers.get('Location')).toBeNull();
    expect(await response.text()).not.toContain('receiver-secret');
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
    expect(response.status).toBe(409);
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
