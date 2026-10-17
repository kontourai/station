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
import {
  authorizeDeviceAgentCaller,
  mintDeviceAgentGrant,
} from '../../services/devices/device-agent-authority.js';
import { DeviceAutomation } from '../../services/devices/device-automation.js';
import { DeviceSessionService } from '../../services/devices/device-session-service.js';
import {
  DeviceToolsService,
  deviceControlConflict,
} from '../../services/devices/device-tools.js';
import {
  claimAgentControl,
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
import { createDeviceToolsRoutes } from '../device-tools.js';

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const dispose of disposals.splice(0)) await dispose();
  vi.useRealTimers();
});

type ToolResult = {
  content: { type: string; text?: string; data?: string }[];
  isError?: boolean;
};
type Tool = (args: Record<string, unknown>) => Promise<ToolResult>;
const parsed = (result: ToolResult) => JSON.parse(result.content[0]!.text!);

function harness(
  channel:
    | 'sdk-in-process'
    | 'url-token'
    | 'http-header-token' = 'sdk-in-process',
  options: { operator?: boolean; idleEndMs?: number } = {},
) {
  const sessionId = `device-test-${Math.random()}`;
  const { token } = mintStationControlMcpToken(sessionId, channel);
  let shared = true;
  let active = true;
  let enabled = true;
  let operator = options.operator === true;
  let principalId = 'admin';
  let conversationId = 'conversation';
  let callingSession = sessionId;
  const extraTokens: string[] = [];
  const record = () => ({
    principal: { id: principalId, source: 'session-owner' as const },
    localProjectId: 'project',
    projectIdSource: 'session-record' as const,
    conversationId,
  });
  const caller = () => resolveStationControlCallerFromToken(token, record);
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
  let finishCapture: (() => void | Promise<void>) | undefined;
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
      if (finishCapture) await finishCapture();
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
    ...(options.idleEndMs !== undefined
      ? { idleEndMs: options.idleEndMs }
      : {}),
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
  const access = {
    agentAccessEnabled: () => enabled,
    resolveCaller: () =>
      callingSession === sessionId
        ? caller()
        : resolveStationControlCallerFromToken(callingSession, record),
    authorizePrincipal: createBrowserPrincipalAuthorizer({
      isOperatorPrincipal: () => operator,
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
  };
  const routes = createDeviceAgentRoutes({
    ...access,
    isInternalRequest: () => true,
    resolveCaller: (request) => {
      const presented = request.headers.get(
        STATION_CONTROL_CALLER_TOKEN_HEADER,
      );
      return presented === token
        ? caller()
        : resolveStationControlCallerFromToken(presented, record);
    },
    automation,
  });
  const humanTools = createDeviceToolsRoutes({
    isRequestPrincipalCurrent: () => true,
    access: {
      isOperator: async () => true,
      hasStanding: async () => true,
      mayAccessDevice: async () => true,
    },
    resolveHumanCaller: () => ({ principal: 'admin', device: 'viewer' }),
    controlConflict: (human, platform, deviceId) =>
      deviceControlConflict({ sessions, surfaces }, platform, deviceId, human),
    tools: new DeviceToolsService({
      runner: { run: async () => '' },
      hub: { connect: host.connect },
    }),
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
    withStationControlCallerContext(
      {
        token: callingSession === sessionId ? token : callingSession,
        resolve: access.resolveCaller,
      },
      () => (registered[name]!.handler ?? registered[name]!.callback)!(args),
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
    for (const extra of extraTokens) revokeStationControlMcpToken(extra);
    await sessions.dispose();
    await surfaces.dispose();
  });
  return {
    run,
    raw: (operation: string, body: unknown) =>
      routes.request(`/${operation}`, {
        method: 'POST',
        headers: {
          [STATION_CONTROL_CALLER_TOKEN_HEADER]: token,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      }),
    access,
    device,
    humanAction: () =>
      humanTools.request(
        '/hosts/local/devices/android/emulator-5554/tools/actions',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'set-appearance', appearance: 'dark' }),
        },
      ),
    setOperator: (value: boolean) => {
      operator = value;
    },
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    setIdentity: (principal: string, conversation: string) => {
      principalId = principal;
      conversationId = conversation;
    },
    asAnotherAgent: () => {
      const other = `device-test-${Math.random()}`;
      extraTokens.push(other);
      callingSession = mintStationControlMcpToken(
        other,
        'sdk-in-process',
      ).token;
    },
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
    duringCapture: (fn: () => void | Promise<void>) => {
      finishCapture = fn;
    },
  };
}

test('bound tool input reaches the device socket, and human control refuses the next action', async () => {
  const h = harness();
  const id = await h.open();
  const entry = h.surfaces.get(h.sessions.get(id)!.surfaceId)!;
  expect(entry.lease.snapshot().holder, 'open releases its lease').toBeNull();
  expect(
    parsed(
      await h.run('device_input', {
        deviceSessionId: id,
        events: [{ kind: 'text', text: 'hello' }],
      }),
    ),
  ).toMatchObject({ ok: true, accepted: 1 });
  expect(h.packets).toEqual([{ type: 'text', text: 'hello', ack: false }]);
  expect(entry.lease.snapshot().holder, 'input releases its lease').toBeNull();
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
    const result = parsed(
      await h.run('device_input', {
        deviceSessionId: id,
        events: [{ kind: 'text', text: 'blocked' }],
      }),
    );
    expect(result).toMatchObject({ ok: false, code: 'not-authorized' });
    expect(
      result,
      'unadmitted callers must not receive current lease metadata',
    ).not.toHaveProperty('lease');
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

test('snapshot reaches the device tools seam and operator close ends an owned session without shutdown', async () => {
  const h = harness('sdk-in-process', { operator: true });
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
  expect(h.packets).toHaveLength(5);
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

test.each(['device_screenshot', 'device_snapshot'])(
  '%s releases the lease so the human Tools path is available immediately',
  async (tool) => {
    const h = harness();
    const id = (await h.sessions.open(h.device)).sessionId;
    const entry = h.surfaces.get(h.sessions.get(id)!.surfaceId)!;
    expect(parsed(await h.run(tool, { deviceSessionId: id }))).toMatchObject({
      ok: true,
    });
    expect(
      entry.lease.snapshot().holder,
      'observation must release control',
    ).toBeNull();
    const human = await h.humanAction();
    expect(
      human.status,
      'human Tools action must not be device-controlled-by-other',
    ).toBe(200);
    expect(await human.json()).toMatchObject({ success: true });
    await h.take(id);
  },
);

test('failed observations release the lease', async () => {
  const h = harness();
  const id = await h.open();
  h.host.capture.mockRejectedValueOnce(new Error('capture failed'));
  expect(
    parsed(await h.run('device_screenshot', { deviceSessionId: id })),
  ).toMatchObject({ ok: false });
  expect(
    h.surfaces.get(h.sessions.get(id)!.surfaceId)!.lease.snapshot().holder,
  ).toBeNull();
});

test('surface authorization rechecks a minted grant after share revocation without claiming again', async () => {
  const h = harness();
  const id = await h.open();
  const decided = await authorizeDeviceAgentCaller(h.access);
  if (!decided.ok) throw new Error('fixture caller refused');
  const grant = mintDeviceAgentGrant(h.access, decided.authority, h.device);
  const entry = h.surfaces.get(h.sessions.get(id)!.surfaceId)!;
  expect(await entry.authorize('admin', 'view', { agentGrant: grant })).toBe(
    true,
  );
  h.revokeShare();
  expect(
    await entry.authorize('admin', 'view', { agentGrant: grant }),
    'revoked minted grant must be refused at surface seam',
  ).toBe(false);
});

test('share revocation during capture refuses publication and releases control', async () => {
  const h = harness();
  const id = await h.open();
  h.duringCapture(h.revokeShare);
  const result = await h.run('device_screenshot', { deviceSessionId: id });
  expect(
    parsed(result),
    'post-capture authorization must prevent publication',
  ).toMatchObject({ ok: false, code: 'interrupted' });
  expect(result.content.some((item) => item.type === 'image')).toBe(false);
  expect(
    h.surfaces.get(h.sessions.get(id)!.surfaceId)!.lease.snapshot().holder,
  ).toBeNull();
});

test('activity renews an unwatched session idle grace without keeping it forever', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const h = harness('sdk-in-process', { idleEndMs: 100 });
  const id = await h.open();
  await vi.advanceTimersByTimeAsync(80);
  expect(
    parsed(await h.run('device_snapshot', { deviceSessionId: id })),
  ).toMatchObject({ ok: true });
  await vi.advanceTimersByTimeAsync(40);
  expect(
    h.sessions.get(id),
    'agent activity must renew idle grace',
  ).toBeDefined();
  await vi.advanceTimersByTimeAsync(61);
  expect(h.sessions.get(id)).toBeUndefined();
});

test('invalid device ID is refused by the route before touching the host', async () => {
  const h = harness('sdk-in-process', { operator: true });
  const response = await h.raw('open', {
    platform: 'android',
    deviceId: '../escape',
  });
  expect(await response.json()).toMatchObject({
    ok: false,
    code: 'invalid-target',
  });
  expect(h.host.inventory).not.toHaveBeenCalled();
});

test('non-operator cannot end an agent-created shared session for everyone', async () => {
  const h = harness();
  const id = await h.open();
  expect(
    parsed(await h.run('device_close', { deviceSessionId: id })),
  ).toMatchObject({ ok: false, code: 'operator-required' });
  expect(h.sessions.get(id)).toBeDefined();
});

test('share revocation between input events stops delivery at the next event', async () => {
  const h = harness();
  const id = await h.open();
  h.duringSend(h.revokeShare);
  expect(
    parsed(
      await h.run('device_input', {
        deviceSessionId: id,
        events: [
          { kind: 'text', text: 'first' },
          { kind: 'text', text: 'revoked' },
        ],
      }),
    ),
  ).toMatchObject({ ok: false, code: 'not-authorized', accepted: 1 });
  expect(h.packets).toEqual([{ type: 'text', text: 'first', ack: false }]);
});

test('operator Agent access opt-in gates tools and revokes existing grants', async () => {
  const h = harness();
  h.setEnabled(false);
  expect(parsed(await h.run('device_list'))).toMatchObject({
    ok: false,
    code: 'agent-access-disabled',
  });
  expect(h.host.inventory).not.toHaveBeenCalled();
  h.setEnabled(true);
  const id = await h.open();
  h.duringCapture(() => h.setEnabled(false));
  expect(
    parsed(await h.run('device_screenshot', { deviceSessionId: id })),
  ).toMatchObject({ ok: false, code: 'interrupted' });
});

test.each([
  ['other-conversation', 'admin', 'different'],
  ['other-principal', 'other-admin', 'conversation'],
])(
  '%s cannot close a session it did not create',
  async (_name, principal, conversation) => {
    const h = harness('sdk-in-process', { operator: true });
    const id = await h.open();
    h.setIdentity(principal!, conversation!);
    expect(
      parsed(await h.run('device_close', { deviceSessionId: id })),
    ).toMatchObject({ ok: false, code: 'not-session-owner' });
    expect(h.sessions.get(id)).toBeDefined();
  },
);

test('another agent is refused while a bound agent holds an in-flight operation', async () => {
  const h = harness();
  const id = await h.open();
  const decided = await authorizeDeviceAgentCaller(h.access);
  if (!decided.ok) throw new Error('fixture caller refused');
  const entry = h.surfaces.get(h.sessions.get(id)!.surfaceId)!;
  const claim = await claimAgentControl(
    entry,
    {
      kind: 'agent',
      principal: 'admin',
      sessionId: decided.authority.sessionId,
    },
    'admin',
    { agentGrant: mintDeviceAgentGrant(h.access, decided.authority, h.device) },
  );
  expect(claim).toMatchObject({ ok: true });
  h.asAnotherAgent();
  expect(
    parsed(await h.run('device_snapshot', { deviceSessionId: id })),
  ).toMatchObject({ ok: false, code: 'held-by-other' });
  expect(h.accessibility).not.toHaveBeenCalled();
});

test('route refuses 65-event batches and oversized bodies before device dispatch', async () => {
  const h = harness();
  const id = await h.open();
  const response = await h.raw('input', {
    deviceSessionId: id,
    events: Array.from({ length: 65 }, () => ({ kind: 'text', text: 'x' })),
  });
  expect(await response.json(), 'route event bound').toMatchObject({
    ok: false,
    code: 'invalid-request',
  });
  const large = await h.raw('input', {
    deviceSessionId: id,
    events: [{ kind: 'text', text: 'x' }],
    padding: 'x'.repeat(17 * 1024),
  });
  expect(await large.json(), 'route body bound').toMatchObject({
    ok: false,
    code: 'invalid-request',
  });
  expect(h.packets).toHaveLength(0);
});

test('opening a non-shared device is refused before host access', async () => {
  const h = harness();
  h.revokeShare();
  expect(parsed(await h.run('device_open', h.device))).toMatchObject({
    ok: false,
    code: 'not-authorized',
  });
  expect(h.host.inventory).not.toHaveBeenCalled();
});

test('device tool refusals set MCP isError', async () => {
  const h = harness();
  h.setEnabled(false);
  expect(await h.run('device_list')).toMatchObject({
    isError: true,
    content: [{ type: 'text' }],
  });
});

test.each([false, true])(
  'parallel same-agent calls retain the lease until the last operation finishes (human takeover=%s)',
  async (takeover) => {
    const h = harness();
    const id = await h.open();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.duringCapture(() => {
      entered();
      return held;
    });
    const capture = h.run('device_screenshot', { deviceSessionId: id });
    try {
      await started;
      expect(
        parsed(
          await h.run('device_input', {
            deviceSessionId: id,
            events: [{ kind: 'text', text: 'parallel' }],
          }),
        ),
      ).toMatchObject({ ok: true, accepted: 1 });
      if (takeover) await h.take(id);
      release();
      expect(
        parsed(await capture),
        'parallel input must not interrupt the capture',
      ).toMatchObject(
        takeover ? { ok: false, code: 'interrupted' } : { ok: true },
      );
      const holder = h.surfaces
        .get(h.sessions.get(id)!.surfaceId)!
        .lease.snapshot().holder;
      if (takeover)
        expect(holder).toMatchObject({ kind: 'human', principal: 'admin' });
      else
        expect(
          holder,
          'last concurrent operation must release control',
        ).toBeNull();
    } finally {
      release();
      await capture;
    }
  },
);

test.each([
  [{ kind: 'pointer', type: 'down', x: 10, y: 20, pointerType: 'touch' }],
  [{ kind: 'pointer', type: 'up', x: 10, y: 20, pointerType: 'touch' }],
  [{ kind: 'key', type: 'down', key: 'Enter', code: 'Enter' }],
  [{ kind: 'key', type: 'up', key: 'Enter', code: 'Enter' }],
])(
  'split-call gesture %j is refused before delivering any event',
  async (event) => {
    const h = harness();
    const id = await h.open();
    expect(
      parsed(
        await h.run('device_input', {
          deviceSessionId: id,
          events: [{ kind: 'text', text: 'must not send' }, event],
        }),
      ),
    ).toMatchObject({ ok: false, code: 'incomplete-gesture', accepted: 0 });
    expect(h.packets).toEqual([]);
  },
);

test('input returns the current lease after the final operation releases it', async () => {
  const h = harness();
  const id = await h.open();
  const result = parsed(
    await h.run('device_input', {
      deviceSessionId: id,
      events: [{ kind: 'text', text: 'done' }],
    }),
  );
  expect(result).toMatchObject({
    ok: true,
    accepted: 1,
    lease: { holder: null },
  });
  expect(result.lease).toEqual(
    h.surfaces.get(h.sessions.get(id)!.surfaceId)!.lease.snapshot(),
  );
});

test('unsupported input kinds reject the entire batch before a supported event is delivered', async () => {
  const h = harness();
  const id = await h.open();
  const entry = h.surfaces.get(h.sessions.get(id)!.surfaceId)!;
  // A producer advertising fewer supported kinds exercises the public producer
  // contract without adding a fictitious wire event or weakening route parsing.
  Object.defineProperty(entry.producer, 'capabilities', {
    value: { ...entry.producer.capabilities, input: ['text'] },
  });
  expect(
    parsed(
      await h.run('device_input', {
        deviceSessionId: id,
        events: [
          { kind: 'text', text: 'must not send' },
          { kind: 'device-button', button: 'home' },
        ],
      }),
    ),
  ).toMatchObject({ ok: false, code: 'unsupported-input', accepted: 0 });
  expect(h.packets).toEqual([]);
});

test.each([false, true])(
  'admin close is refused before claiming or renewing idle grace (human holder=%s)',
  async (human) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const h = harness('sdk-in-process', { idleEndMs: 100 });
    const id = await h.open();
    await vi.advanceTimersByTimeAsync(80);
    if (human) await h.take(id);
    expect(
      parsed(await h.run('device_close', { deviceSessionId: id })),
    ).toMatchObject({ ok: false, code: 'operator-required' });
    await vi.advanceTimersByTimeAsync(21);
    expect(
      h.sessions.get(id),
      'refused close must not renew idle grace',
    ).toBeUndefined();
  },
);

test('operator standing revoked during control admission cannot close the shared session', async () => {
  const h = harness('sdk-in-process', { operator: true });
  const id = await h.open();
  const entry = h.surfaces.get(h.sessions.get(id)!.surfaceId)!;
  const authorize = entry.authorize;
  vi.spyOn(entry, 'authorize').mockImplementation(async (...args) => {
    h.setOperator(false);
    return authorize(...args);
  });
  expect(
    parsed(await h.run('device_close', { deviceSessionId: id })),
  ).toMatchObject({ ok: false, code: 'operator-required' });
  expect(h.sessions.get(id)).toBeDefined();
  expect(entry.lease.snapshot().holder).toBeNull();
});

test('parallel input batches deliver complete gestures without interleaving their pointer events', async () => {
  const h = harness();
  const id = await h.open();
  const first = h.run('device_input', {
    deviceSessionId: id,
    events: [
      { kind: 'pointer', type: 'down', x: 10, y: 20, pointerType: 'touch' },
      { kind: 'pointer', type: 'up', x: 10, y: 20, pointerType: 'touch' },
    ],
  });
  const second = h.run('device_input', {
    deviceSessionId: id,
    events: [
      { kind: 'pointer', type: 'down', x: 80, y: 160, pointerType: 'touch' },
      { kind: 'pointer', type: 'up', x: 80, y: 160, pointerType: 'touch' },
    ],
  });
  for (const result of await Promise.all([first, second]))
    expect(parsed(result)).toMatchObject({ ok: true, accepted: 2 });
  const a = [
    { type: 'touch', action: 'down', x: 0.1, y: 0.1, ack: false },
    { type: 'touch', action: 'up', x: 0.1, y: 0.1, ack: false },
  ];
  const b = [
    { type: 'touch', action: 'down', x: 0.8, y: 0.8, ack: false },
    { type: 'touch', action: 'up', x: 0.8, y: 0.8, ack: false },
  ];
  expect(
    h.packets,
    'both complete gestures must reach the device',
  ).toHaveLength(4);
  expect(
    [
      [...a, ...b],
      [...b, ...a],
    ],
    'each input batch must remain contiguous',
  ).toContainEqual(h.packets);
});

test('failed input cancels held state without waiting for a parallel observation', async () => {
  const h = harness();
  const id = await h.open();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.duringCapture(() => {
    entered();
    return held;
  });
  const capture = h.run('device_screenshot', { deviceSessionId: id });
  try {
    await started;
    h.duringSend(h.revokeShare);
    expect(
      parsed(
        await h.run('device_input', {
          deviceSessionId: id,
          events: [
            {
              kind: 'pointer',
              type: 'down',
              x: 10,
              y: 20,
              pointerType: 'touch',
            },
            { kind: 'pointer', type: 'up', x: 10, y: 20, pointerType: 'touch' },
          ],
        }),
      ),
    ).toMatchObject({ ok: false, code: 'not-authorized', accepted: 1 });
    expect(
      h.surfaces.get(h.sessions.get(id)!.surfaceId)!.lease.snapshot().holder,
      'failed input must release immediately to cancel held state',
    ).toBeNull();
    expect(h.packets.at(-1)).toMatchObject({ type: 'touch', action: 'up' });
  } finally {
    release();
    await capture;
  }
});
