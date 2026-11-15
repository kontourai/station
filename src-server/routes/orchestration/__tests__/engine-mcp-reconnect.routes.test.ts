import { join } from 'node:path';
import type { EngineCommandOutcome } from '@kontourai/station-contracts/engine-commands';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness';
import { awaitSessionAttachmentSettled } from '../../../__test-utils__/session-runtime-barriers.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventBus } from '../../../services/orchestration/event-bus';
import { EventStore } from '../../../services/orchestration/event-store';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service';
import { createOrchestrationRoutes } from '../orchestration';

/**
 * `POST /sessions/:threadId/mcp-servers/:serverName/reconnect`, through the
 * real router and service: who may ask, what reaches the adapter's
 * `reconnectMcpServer`, and that the engine's outcome comes back as given.
 */
const NOW = '2026-11-13T10:00:00.000Z';
const THREAD = 'session-mcp';

const makeTempDir = trackTempDirs();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(options: { reconnect?: boolean; live?: boolean } = {}) {
  const directory = makeTempDir('station-mcp-reconnect-');
  const store = new EventStore(join(directory, 'events.sqlite'));
  const adapter = new GateTestAdapter() as GateTestAdapter & {
    reconnectMcpServer?: (
      threadId: string,
      serverName: string,
      options: { startOAuth: boolean },
    ) => Promise<EngineCommandOutcome>;
  };
  vi.spyOn(adapter, 'hasSession').mockResolvedValue(options.live ?? true);
  const reconnect = vi.fn(
    async (): Promise<EngineCommandOutcome> => ({
      kind: 'answered',
      success: true,
    }),
  );
  if (options.reconnect ?? true) adapter.reconnectMcpServer = reconnect;
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus: new EventBus(),
    eventStore: store,
    logger: { debug: vi.fn(), warn: vi.fn() },
  });
  service.initialize();
  await awaitSessionAttachmentSettled(service);
  store.upsertSession({
    provider: 'claude',
    threadId: THREAD,
    status: 'ready',
    createdAt: NOW,
    updatedAt: NOW,
  });
  store.appendEvent({
    eventId: 'configured-mcp',
    provider: 'claude',
    threadId: THREAD,
    method: 'session.configured',
    sessionId: THREAD,
    createdAt: NOW,
    metadata: { userId: 'owner' },
  });
  let user = 'owner';
  let principalCurrent = true;
  const app = createOrchestrationRoutes(service, {
    eventBus: new EventBus(),
    logger: { debug: vi.fn() },
    getUserId: () => user,
    isRequestPrincipalCurrent: () => principalCurrent,
  });
  cleanups.push(async () => {
    await service.shutdown();
    store.close();
  });
  return {
    app,
    reconnect,
    setUser: (value: string) => {
      user = value;
    },
    revoke: () => {
      principalCurrent = false;
    },
  };
}

const post = (
  f: Awaited<ReturnType<typeof fixture>>,
  serverName: string,
  body?: unknown,
) =>
  f.app.request(
    `/sessions/${THREAD}/mcp-servers/${encodeURIComponent(serverName)}/reconnect`,
    {
      method: 'POST',
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: { 'Content-Type': 'application/json' },
          }),
    },
  );

describe('engine MCP reconnect route', () => {
  test("the Session's owner reaches the adapter, and the engine's outcome comes back as given", async () => {
    const f = await fixture();
    f.reconnect.mockResolvedValueOnce({
      kind: 'answered',
      success: false,
      text: 'Server docs is not configured',
    });
    const response = await post(f, 'docs', { startOAuth: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: {
        kind: 'answered',
        success: false,
        text: 'Server docs is not configured',
      },
    });
    expect(f.reconnect).toHaveBeenCalledWith(THREAD, 'docs', {
      startOAuth: true,
    });
  });

  test('no body is a plain reconnect, never a sign-in', async () => {
    const f = await fixture();
    expect((await post(f, 'docs')).status).toBe(200);
    expect(f.reconnect).toHaveBeenCalledWith(THREAD, 'docs', {
      startOAuth: false,
    });
  });

  test('anyone but the current owner gets 404 and nothing reaches the engine', async () => {
    const other = await fixture();
    other.setUser('someone-else');
    expect((await post(other, 'docs')).status).toBe(404);
    expect(other.reconnect).not.toHaveBeenCalled();

    const revoked = await fixture();
    revoked.revoke();
    expect((await post(revoked, 'docs')).status).toBe(404);
    expect(revoked.reconnect).not.toHaveBeenCalled();
  });

  test('a name past the bound, and a body key the route does not take, are refused 400', async () => {
    const f = await fixture();
    // 128 is the bound (ENGINE_MCP_SERVER_NAME_MAX_CHARS); 129 is refused.
    expect((await post(f, 'a'.repeat(129))).status).toBe(400);
    expect((await post(f, 'docs', { startOAuth: true, url: 'x' })).status).toBe(
      400,
    );
    expect((await post(f, 'docs', { startOAuth: 'yes' })).status).toBe(400);
    expect(f.reconnect).not.toHaveBeenCalled();
    expect((await post(f, 'a'.repeat(128))).status).toBe(200);
  });

  test('an adapter with no reconnect answers unsupported', async () => {
    const f = await fixture({ reconnect: false });
    const response = await post(f, 'docs');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { kind: 'unsupported' },
    });
  });

  test('a Session with no live engine is refused 409, and none is started for it', async () => {
    const f = await fixture({ live: false });
    expect((await post(f, 'docs')).status).toBe(409);
    expect(f.reconnect).not.toHaveBeenCalled();
  });
});
