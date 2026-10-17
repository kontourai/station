import { EventEmitter } from 'node:events';
import type { MobileDeviceInventory } from '@kontourai/station-contracts/mobile-device';
import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, expect, test, vi } from 'vitest';
import { resolveStationControlCallerFromToken } from '../../runtime/mcp/station-control-caller.js';
import {
  mintStationControlMcpToken,
  revokeStationControlMcpToken,
} from '../../runtime/mcp/station-control-mcp-token.js';
import { createBrowserPrincipalAuthorizer } from '../../services/browser/browser-agent-authority.js';
import { DeviceAutomation } from '../../services/devices/device-automation.js';
import { DeviceSessionService } from '../../services/devices/device-session-service.js';
import {
  claimHumanControl,
  LiveSurfaceRegistry,
} from '../../services/live-surface/registry.js';
import { registerDeviceTools } from '../../tools/station-control-device-tools.js';
import { StationControlToolRegistry } from '../../tools/station-control-mcp-server.js';
import {
  STATION_CONTROL_CALLER_TOKEN_HEADER,
  withStationControlCallerContext,
} from '../../tools/station-control-shared.js';
import { createDeviceAgentRoutes } from '../device-agent.js';

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const dispose of disposals.splice(0)) await dispose();
});

type ToolResult = { content: { type: string; text?: string; data?: string }[] };
type Tool = (args: Record<string, unknown>) => Promise<ToolResult>;
const parsed = (result: ToolResult) => JSON.parse(result.content[0]!.text!);

function harness(
  channel:
    | 'sdk-in-process'
    | 'url-token'
    | 'http-header-token' = 'sdk-in-process',
) {
  const sessionId = `device-test-${Math.random()}`;
  const { token } = mintStationControlMcpToken(sessionId, channel);
  let shared = true;
  let active = true;
  const caller = () =>
    resolveStationControlCallerFromToken(token, () => ({
      principal: { id: 'admin', source: 'session-owner' },
      localProjectId: 'project',
      projectIdSource: 'session-record',
      conversationId: 'conversation',
    }));
  const packets: unknown[] = [];
  let onSend: (() => void) | undefined;
  class Socket extends EventEmitter {
    readyState = 1;
    send(data: string, callback: (error?: Error) => void) {
      packets.push(JSON.parse(data));
      onSend?.();
      callback();
    }
    close() {
      this.readyState = 3;
    }
  }
  const socket = new Socket();
  const device = {
    hostId: 'local',
    platform: 'android' as const,
    deviceId: 'emulator-5554',
    name: 'Test',
    runtime: 'Android 16',
    booted: true,
  };
  let finishCapture: (() => void) | undefined;
  const host = {
    inventory: vi.fn(
      async (): Promise<MobileDeviceInventory> => ({
        hostId: 'local',
        state: 'ready',
        observedAt: new Date().toISOString(),
        devices: [device],
      }),
    ),
    boot: vi.fn(),
    attachStream: vi.fn(),
    shutdown: vi.fn(),
    screenshot: vi.fn(async () => ({
      png: Buffer.alloc(0),
      width: 100,
      height: 200,
    })),
    capture: vi.fn(async () => {
      if (finishCapture) finishCapture();
      return {
        captureId: 'capture',
        target: device,
        capturedAt: new Date().toISOString(),
        mimeType: 'image/png' as const,
        width: 1,
        height: 1,
        pngBase64: 'cG5n',
      };
    }),
    connect: async () => ({
      ok: true as const,
      connection: {
        baseUrl: 'http://127.0.0.1:43871',
        request: async () => new Response(null),
        openWebSocket: () => {
          queueMicrotask(() => socket.emit('open'));
          return socket as never;
        },
      },
    }),
  };
  const surfaces = new LiveSurfaceRegistry();
  // Human authority remains separate; this fixture grants a real human takeover.
  const sessions = new DeviceSessionService({
    host,
    endpoint: { onExit: () => () => {} },
    surfaces,
    access: {
      isOperator: async () => true,
      hasStanding: async () => true,
      mayAccessDevice: async () => true,
    },
  });
  const accessibility = vi.fn(async () => ({
    readAt: new Date().toISOString(),
    space: { width: 100, height: 200 },
    elements: [],
    truncated: false,
  }));
  const automation = new DeviceAutomation({
    host,
    sessions,
    surfaces,
    tools: { accessibility },
  });
  const routes = createDeviceAgentRoutes({
    isInternalRequest: () => true,
    resolveCaller: (request) =>
      request.headers.get(STATION_CONTROL_CALLER_TOKEN_HEADER) === token
        ? caller()
        : null,
    authorizePrincipal: createBrowserPrincipalAuthorizer({
      isOperatorPrincipal: () => false,
      membership: {
        admissionsForResolvedPrincipal: () =>
          active
            ? [
                {
                  scope: { localProjectId: 'project' },
                  member: { status: 'active', role: 'admin' },
                },
              ]
            : [],
      },
    }),
    shares: {
      list: () =>
        shared
          ? [
              {
                ...device,
                deviceId: 'Test',
                label: 'Test',
                addedBy: 'operator',
                addedAt: new Date().toISOString(),
              },
            ]
          : [],
    },
    resolveAndroidAvd: async () => 'Test',
    automation,
  });
  const server = new McpServer({ name: 'device-test', version: '1' });
  registerDeviceTools(new StationControlToolRegistry(server));
  const registered = (
    server as unknown as {
      _registeredTools: Record<string, { handler?: Tool; callback?: Tool }>;
    }
  )._registeredTools;
  vi.stubEnv('STATION_API_BASE', 'http://device.test');
  vi.stubGlobal('fetch', (url: string, init: RequestInit) =>
    routes.request(
      url.replace('http://device.test/api/device-agent', ''),
      init,
    ),
  );
  const run = (name: string, args: Record<string, unknown> = {}) =>
    withStationControlCallerContext({ token, resolve: caller }, () =>
      (registered[name]!.handler ?? registered[name]!.callback)!(args),
    );
  const open = async () => {
    const result = parsed(await run('device_open', device));
    expect(
      result,
      'open through tool, route and surface authorizer',
    ).toMatchObject({ ok: true, paneRevealed: false });
    return result.session.sessionId as string;
  };
  const take = async (id: string) => {
    const entry = surfaces.get(sessions.get(id)!.surfaceId)!;
    expect(
      await claimHumanControl(entry, {
        kind: 'human',
        principal: 'admin',
        device: 'viewer',
      }),
    ).toMatchObject({ ok: true });
  };
  disposals.push(async () => {
    revokeStationControlMcpToken(sessionId);
    await sessions.dispose();
    await surfaces.dispose();
  });
  return {
    run,
    open,
    take,
    packets,
    host,
    sessions,
    surfaces,
    accessibility,
    revokeToken: () => revokeStationControlMcpToken(sessionId),
    revokeShare: () => {
      shared = false;
    },
    revokeMember: () => {
      active = false;
    },
    duringSend: (fn: () => void) => {
      onSend = fn;
    },
    duringCapture: (fn: () => void) => {
      finishCapture = fn;
    },
  };
}

test('bound tool input reaches the device socket, and human control refuses the next action', async () => {
  const h = harness();
  const id = await h.open();
  expect(
    parsed(
      await h.run('device_input', {
        deviceSessionId: id,
        events: [{ kind: 'text', text: 'hello' }],
      }),
    ),
  ).toMatchObject({ ok: true, accepted: 1 });
  expect(h.packets).toEqual([{ type: 'text', text: 'hello', ack: false }]);
  await h.take(id);
  expect(
    parsed(
      await h.run('device_input', {
        deviceSessionId: id,
        events: [{ kind: 'text', text: 'blocked' }],
      }),
    ),
  ).toMatchObject({ ok: false, code: 'human-controlling' });
  expect(h.packets).toHaveLength(1);
});

test('takeover during a batch fences remaining sends even if the old agent retries', async () => {
  const h = harness();
  const id = await h.open();
  let takeover: Promise<void> | undefined;
  h.duringSend(() => {
    takeover = h.take(id);
  });
  const result = parsed(
    await h.run('device_input', {
      deviceSessionId: id,
      events: [
        { kind: 'text', text: 'first' },
        { kind: 'text', text: 'stale' },
      ],
    }),
  );
  await takeover;
  expect(result).toMatchObject({ ok: false, accepted: 1 });
  expect(h.packets).toEqual([{ type: 'text', text: 'first', ack: false }]);
  expect(
    parsed(
      await h.run('device_input', {
        deviceSessionId: id,
        events: [{ kind: 'text', text: 'retry' }],
      }),
    ),
  ).toMatchObject({ ok: false, code: 'human-controlling' });
});

test.each(['url-token', 'http-header-token'] as const)(
  '%s cannot start the host or open a device',
  async (channel) => {
    const h = harness(channel);
    expect(
      parsed(
        await h.run('device_open', {
          platform: 'android',
          deviceId: 'emulator-5554',
        }),
      ),
    ).toMatchObject({ ok: false, code: 'caller-not-bound' });
    expect(h.host.inventory).not.toHaveBeenCalled();
  },
);

test.each(['share', 'membership'] as const)(
  'revoked %s denies an already-open device',
  async (kind) => {
    const h = harness();
    const id = await h.open();
    if (kind === 'share') h.revokeShare();
    else h.revokeMember();
    expect(
      parsed(
        await h.run('device_input', {
          deviceSessionId: id,
          events: [{ kind: 'text', text: 'blocked' }],
        }),
      ),
    ).toMatchObject({ ok: false, code: 'not-authorized' });
    expect(h.packets).toHaveLength(0);
  },
);

test('screenshot returns an image, then refuses publication after takeover during capture', async () => {
  const h = harness();
  const id = await h.open();
  const image = await h.run('device_screenshot', { deviceSessionId: id });
  expect(image.content[1]).toMatchObject({ type: 'image', data: 'cG5n' });
  let takeover: Promise<void> | undefined;
  h.duringCapture(() => {
    takeover = h.take(id);
  });
  const interrupted = parsed(
    await h.run('device_screenshot', { deviceSessionId: id }),
  );
  await takeover;
  expect(interrupted).toMatchObject({ ok: false, code: 'interrupted' });
});

test('snapshot reaches the device tools seam and close ends an owned session without shutdown', async () => {
  const h = harness();
  const id = await h.open();
  expect(
    parsed(await h.run('device_snapshot', { deviceSessionId: id })),
  ).toMatchObject({
    ok: true,
    tree: { space: { width: 100, height: 200 }, elements: [] },
  });
  expect(h.accessibility).toHaveBeenCalledOnce();
  expect(parsed(await h.run('device_list'))).toMatchObject({
    ok: true,
    sessions: [{ sessionId: id }],
  });
  expect(parsed(await h.run('device_close', { deviceSessionId: id }))).toEqual({
    ok: true,
    shutdown: false,
  });
  expect(h.sessions.get(id)).toBeUndefined();
  expect(h.host.shutdown).not.toHaveBeenCalled();
});

test('tap, swipe and key events traverse the existing producer mapping', async () => {
  const h = harness();
  const id = await h.open();
  const events = [
    { kind: 'pointer', type: 'down', x: 10, y: 20, pointerType: 'touch' },
    { kind: 'pointer', type: 'move', x: 50, y: 100, pointerType: 'touch' },
    { kind: 'pointer', type: 'up', x: 50, y: 100, pointerType: 'touch' },
    { kind: 'key', type: 'down', key: 'Enter', code: 'Enter' },
    { kind: 'key', type: 'up', key: 'Enter', code: 'Enter' },
  ];
  expect(
    parsed(await h.run('device_input', { deviceSessionId: id, events })),
  ).toMatchObject({ ok: true, accepted: 5 });
  expect(h.packets.slice(0, 3)).toEqual([
    { type: 'touch', action: 'down', x: 0.1, y: 0.1, ack: false },
    { type: 'touch', action: 'move', x: 0.5, y: 0.5, ack: false },
    { type: 'touch', action: 'up', x: 0.5, y: 0.5, ack: false },
  ]);
});

test('a human-opened session can be joined but cannot be closed by the agent', async () => {
  const h = harness();
  const session = await h.sessions.open({
    hostId: 'local',
    platform: 'android',
    deviceId: 'emulator-5554',
  });
  expect(await h.open()).toBe(session.sessionId);
  expect(
    parsed(await h.run('device_close', { deviceSessionId: session.sessionId })),
  ).toMatchObject({ ok: false, code: 'not-session-owner' });
  expect(h.sessions.get(session.sessionId)).toBeDefined();
});

test('revoked token and forged grant cannot authorize device input', async () => {
  const h = harness();
  const id = await h.open();
  const entry = h.surfaces.get(h.sessions.get(id)!.surfaceId)!;
  expect(await entry.authorize('admin', 'input', { agentGrant: {} })).toBe(
    false,
  );
  h.revokeToken();
  expect(
    parsed(
      await h.run('device_input', {
        deviceSessionId: id,
        events: [{ kind: 'text', text: 'blocked' }],
      }),
    ),
  ).toMatchObject({ ok: false, code: 'caller-required' });
  expect(h.packets).toHaveLength(0);
});
