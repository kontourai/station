/**
 * Security review H1: a remote read through this Station presents the
 * Station-wide outbound peer bearer, so the real auth boundary must admit
 * only the bound owner. Real paired devices, the real scope table and the
 * same owner/current predicates runtime-routes.ts composes for the mount;
 * only the remote Station behind the tunnel is a stub.
 */
import { pairingScopePresetString } from '@kontourai/station-contracts/environment-security';
import { describe, expect, test, vi } from 'vitest';
import { peerChatRuntime } from '../../__test-utils__/peer-chat-runtime.js';
import { createGlobalConversationRoutes } from '../../routes/chat/conversations.js';
import { createSshEnvironmentRoutes } from '../../routes/operations/ssh-environments.js';
import { runtimeRemoteStationReadAuthority } from '../../security/remote-station-read-authority.js';
import { runtimeRemoteMessageSearch } from '../../services/ssh/remote-session-reader.js';
import { HOSTED_TENANT_REGISTRY_FILE_ENV } from '../bootstrap/hosted-tenant-mode.js';

const ENV_ID = '22222222-2222-4222-8222-222222222222';
const THREAD = 'external:claude:0123456789abcdef0123456789abcdef';
const HISTORY = `/api/environments/ssh/sessions/${ENV_ID}/${encodeURIComponent(THREAD)}/history`;
const SEARCH = '/api/conversations/search?query=cobalt%20albatross';

const LOCAL_MATCH = {
  conversationId: 'local-conversation',
  messageId: 'local-message',
  role: 'user' as const,
  excerpt: 'local cobalt albatross',
};
const REMOTE_MATCH = {
  conversationId: 'remote-conversation',
  messageId: 'remote-message',
  sourceInstanceId: ENV_ID,
  sourceInstanceName: 'Home media',
  role: 'assistant' as const,
  excerpt: 'remote cobalt albatross',
};

const silent = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  fatal() {},
  child() {
    return this;
  },
  setLevel() {},
  getLevel() {
    return 'info' as const;
  },
};

async function world(environment: NodeJS.ProcessEnv = {}) {
  const source = await peerChatRuntime();
  // The same factory call runtime-routes.ts makes, with the same kind of
  // argument: the runtime's own environment security service.
  const reads = runtimeRemoteStationReadAuthority(source.security, environment);
  // Revokes the caller's device after the auth boundary admitted it and
  // before the route runs: a principal that stopped being current mid-request.
  const revokeMidRequest = { deviceId: undefined as string | undefined };
  source.app.use('*', async (_c, next) => {
    if (revokeMidRequest.deviceId)
      source.security.devicePairing.revokeDevice(
        revokeMidRequest.deviceId,
        'operator-credential',
      );
    await next();
  });
  const ssh = {
    list: () => [
      {
        profile: { id: ENV_ID, name: 'Home media', environmentId: 'peer' },
        state: { phase: 'connected', localUrl: 'http://127.0.0.1:1' },
      },
    ],
  };
  const peers = { get: () => ({ credential: 'peer-bearer-for-test' }) };
  const fetchHistory = vi.fn(async () => ({
    protocolVersion: 1 as const,
    session: { threadId: THREAD } as never,
    events: [],
    hasMore: false,
    watermark: 0,
  }));
  source.app.route(
    '/api/environments/ssh',
    createSshEnvironmentRoutes(
      ssh as never,
      undefined,
      peers as never,
      undefined,
      fetchHistory,
      reads,
    ),
  );
  // The remote Station's own answer to its search route.
  const searchRemote = vi.fn(async () => [REMOTE_MATCH]);
  source.app.route(
    '/api/conversations',
    createGlobalConversationRoutes(
      new Map(),
      { getConversation: () => null },
      silent as never,
      undefined,
      {
        searchSessionMessages: vi.fn(() => [LOCAL_MATCH]),
        readSessionConversation: vi.fn(),
        listConversationHistoryPage: vi.fn(),
      } as never,
      () => 'owner',
      undefined,
      undefined,
      undefined,
      // The same composition runtime-routes.ts wires the route with.
      runtimeRemoteMessageSearch(
        reads,
        ssh as never,
        peers as never,
        searchRemote,
      ),
    ),
  );
  return { source, fetchHistory, searchRemote, revokeMidRequest };
}

async function searchResult(response: Response) {
  expect(response.status).toBe(200);
  return (await response.json()) as {
    data: Array<{ conversationId: string }>;
    instances: Array<{ instanceId: string }>;
  };
}

describe('remote session reads at the real auth boundary', () => {
  test("the owner's own operate device reads a remote session's history", async () => {
    const { source, fetchHistory } = await world();
    const owner = source.pair(pairingScopePresetString('standard'));
    const response = await source.call(HISTORY, owner.credential);
    expect(response.status).toBe(200);
    expect(fetchHistory).toHaveBeenCalledTimes(1);
  });

  test('an operate device bound to another person is refused before the remote', async () => {
    const { source, fetchHistory } = await world();
    const guest = source.pair(
      pairingScopePresetString('standard'),
      'device',
      'guest@example.test',
    );
    const response = await source.call(HISTORY, guest.credential);
    expect(response.status).toBe(403);
    expect(
      (await source.call('/api/environments/ssh/sessions', guest.credential))
        .status,
    ).toBe(403);
    expect(fetchHistory).not.toHaveBeenCalled();
  });

  test("the owner's device acting as an agent tool is refused", async () => {
    const { source, fetchHistory } = await world();
    const owner = source.pair(pairingScopePresetString('standard'));
    const response = await source.call(HISTORY, owner.credential, {
      headers: { 'x-station-control-origin': 'agent-tool' },
    });
    expect(response.status).toBe(403);
    expect(fetchHistory).not.toHaveBeenCalled();
  });

  test('a read-only device is refused by scope on the history path', async () => {
    const { source, fetchHistory } = await world();
    const readOnly = source.pair(pairingScopePresetString('read-only'));
    const response = await source.call(HISTORY, readOnly.credential);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'insufficient_scope' },
    });
    expect(fetchHistory).not.toHaveBeenCalled();
  });

  test('a revoked owner device reads nothing', async () => {
    const { source, fetchHistory } = await world();
    const owner = source.pair(pairingScopePresetString('standard'));
    source.security.devicePairing.revokeDevice(
      owner.device.id,
      'operator-credential',
    );
    const response = await source.call(HISTORY, owner.credential);
    expect(response.status).not.toBe(200);
    expect(fetchHistory).not.toHaveBeenCalled();
  });

  test('the runtime composition serves no remote read on a hosted Station', async () => {
    const { source, fetchHistory } = await world({
      [HOSTED_TENANT_REGISTRY_FILE_ENV]: '/hosted/tenants.json',
    });
    const owner = source.pair(pairingScopePresetString('standard'));
    expect((await source.call(HISTORY, owner.credential)).status).toBe(404);
    expect(fetchHistory).not.toHaveBeenCalled();
  });

  test('a principal that stops being current after admission reads nothing remote', async () => {
    const { source, fetchHistory, searchRemote, revokeMidRequest } =
      await world();
    const owner = source.pair(pairingScopePresetString('standard'));
    revokeMidRequest.deviceId = owner.device.id;
    expect((await source.call(HISTORY, owner.credential)).status).toBe(403);
    expect(fetchHistory).not.toHaveBeenCalled();
    const search = await source.call(SEARCH, owner.credential);
    expect(search.status).not.toBe(500);
    expect(searchRemote).not.toHaveBeenCalled();
  });
});

describe('remote message search at the real auth boundary', () => {
  test("the owner's search includes the remote Station's excerpts", async () => {
    const { source, searchRemote } = await world();
    const owner = source.pair(pairingScopePresetString('standard'));
    const body = await searchResult(
      await source.call(SEARCH, owner.credential),
    );
    expect(body.data.map((match) => match.conversationId)).toEqual([
      'local-conversation',
      'remote-conversation',
    ]);
    expect(body.instances.map((instance) => instance.instanceId)).toEqual([
      'local',
      ENV_ID,
    ]);
    expect(searchRemote).toHaveBeenCalledTimes(1);
  });

  test('a device bound to another person keeps local results; the remote part is withheld and never sent', async () => {
    const { source, searchRemote } = await world();
    const guest = source.pair(
      pairingScopePresetString('standard'),
      'device',
      'guest@example.test',
    );
    const body = await searchResult(
      await source.call(SEARCH, guest.credential),
    );
    expect(body.data.map((match) => match.conversationId)).toEqual([
      'local-conversation',
    ]);
    expect(body.instances.map((instance) => instance.instanceId)).toEqual([
      'local',
    ]);
    expect(searchRemote).not.toHaveBeenCalled();
  });

  test("the owner's device acting as an agent tool gets local results only", async () => {
    const { source, searchRemote } = await world();
    const owner = source.pair(pairingScopePresetString('standard'));
    const body = await searchResult(
      await source.call(SEARCH, owner.credential, {
        headers: { 'x-station-control-origin': 'agent-tool' },
      }),
    );
    expect(body.data.map((match) => match.conversationId)).toEqual([
      'local-conversation',
    ]);
    expect(searchRemote).not.toHaveBeenCalled();
  });

  test('a hosted Station searches no remote Station', async () => {
    const { source, searchRemote } = await world({
      [HOSTED_TENANT_REGISTRY_FILE_ENV]: '/hosted/tenants.json',
    });
    const owner = source.pair(pairingScopePresetString('standard'));
    const body = await searchResult(
      await source.call(SEARCH, owner.credential),
    );
    expect(body.instances.map((instance) => instance.instanceId)).toEqual([
      'local',
    ]);
    expect(searchRemote).not.toHaveBeenCalled();
  });
});
