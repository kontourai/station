import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createSshEnvironmentRoutes } from '../../routes/operations/ssh-environments.js';
import type { OpenSshEnvironmentAdapter } from '../../services/ssh/openssh-environment-adapter.js';
import {
  type OpenSshWorkerProbeResult,
  SSH_WORKER_PROTOCOL_VERSION,
} from '../../services/ssh/openssh-worker-probe.js';
import { SshEnvironmentService } from '../../services/ssh/ssh-environment-service.js';

/**
 * station#1136: integration-style tests for the SSH environment MANAGEMENT
 * verbs (`create_ssh_environment`, `get_ssh_environment`,
 * `connect_ssh_environment`, `disconnect_ssh_environment`,
 * `remove_ssh_environment`).
 *
 * Unlike `station-control-operations-tools.test.ts`'s "mock the HTTP
 * boundary and assert the exact request" characterization style, these
 * tests wire a REAL `SshEnvironmentService` (with a stubbed OpenSSH
 * adapter — no real `ssh` process) behind a REAL
 * `createSshEnvironmentRoutes` Hono app, and bridge the global `fetch` the
 * tools call through into that app in-process. That is deliberate: AC1
 * (round-trip) and AC3 (no duplicated store/connect logic) both require
 * proving the tools actually drive `SshEnvironmentService`, not a parallel
 * reimplementation — a plain fetch mock returning canned JSON couldn't
 * distinguish "the tool called the service" from "the tool called
 * something that returns the same shape."
 */

process.env.STATION_API_BASE = 'http://control-ssh-tools-test.local';
delete process.env.STATION_PORT;

const API_BASE = 'http://control-ssh-tools-test.local';
const SSH_PREFIX = `${API_BASE}/api/environments/ssh`;

type ToolResult = { content: Array<{ type: 'text'; text: string }> };
type ToolHandler = (...args: any[]) => Promise<ToolResult>;

async function registerTools(): Promise<Record<string, ToolHandler>> {
  const { registerOperationsTools } = await import(
    '../station-control-operations-tools.js'
  );
  const { StationControlToolRegistry } = await import(
    '../station-control-mcp-server.js'
  );
  const server = new McpServer({
    name: 'ssh-environment-tools-test',
    version: '0.0.0',
  });
  registerOperationsTools(new StationControlToolRegistry(server));
  const registry = (
    server as unknown as {
      _registeredTools: Record<string, { handler: ToolHandler }>;
    }
  )._registeredTools;
  const handlers: Record<string, ToolHandler> = {};
  for (const [name, tool] of Object.entries(registry)) {
    handlers[name] = tool.handler;
  }
  return handlers;
}

function toolBody(result: ToolResult): any {
  return JSON.parse(result.content[0].text);
}

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Bridges the tools' `fetch('${API_BASE}/api/environments/ssh/...')` calls
 * into a real, in-process `createSshEnvironmentRoutes` app, and — since
 * `app.request()` gives no native `AbortSignal` handling of its own —
 * races the in-process request against the caller's abort signal exactly
 * as real `fetch`/undici would, so `connect_ssh_environment`'s
 * short-timeout race (AC2) is exercised for real rather than assumed.
 */
function bridgeFetch(
  app: ReturnType<typeof createSshEnvironmentRoutes>,
): (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response> {
  return (input, init) => {
    const url = String(input);
    if (!url.startsWith(SSH_PREFIX)) {
      return Promise.reject(
        new Error(`Unexpected request in SSH environment tool test: ${url}`),
      );
    }
    const suffix = url.slice(SSH_PREFIX.length) || '/';
    const requestPromise = Promise.resolve(app.request(suffix, init));
    const signal = init?.signal;
    if (!signal) return requestPromise;
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise<Response>((resolve, reject) => {
      requestPromise.then(resolve, reject);
      signal.addEventListener('abort', () => reject(abortError()), {
        once: true,
      });
    });
  };
}

const homes: string[] = [];

function home(): string {
  const value = mkdtempSync(join(tmpdir(), 'station-control-ssh-tools-'));
  homes.push(value);
  return value;
}

const HOST = {
  alias: 'brian-media',
  hostname: 'brian-media.internal',
  user: 'brian',
  port: 22,
  identityAgent: 'default' as const,
  proxyJump: null,
  strictHostKeyChecking: 'ask',
};
const WORKER = {
  protocolVersion: SSH_WORKER_PROTOCOL_VERSION,
  nodeVersion: 'v24.18.0',
  platform: 'linux',
  arch: 'x64',
  remoteHome: '/home/brian',
  remoteProjectPath: '/home/brian/dev/github/kontourai/station',
  environmentId: '11111111-1111-4111-8111-111111111111',
  instanceId: 'brian-media-dogfood',
  sha: 'a'.repeat(40),
  bootId: '22222222-2222-4222-8222-222222222222',
} satisfies OpenSshWorkerProbeResult;

/** A stubbed SSH runner (AC1): resolves to `connected` quickly, no real `ssh` spawned. */
function fakeConnectingTunnel() {
  return {
    start: vi.fn(async () => ({
      phase: 'connected' as const,
      localUrl: 'http://127.0.0.1:45123',
      host: HOST,
    })),
    probeWorker: vi.fn(async () => WORKER),
    stop: vi.fn(async () => undefined),
  };
}

function serviceWithAdapter(createTunnel: (options: any) => any) {
  return new SshEnvironmentService(home(), {
    adapter: { createTunnel } as unknown as OpenSshEnvironmentAdapter,
  });
}

describe('station-control SSH environment management tools', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.STATION_SSH_CONNECT_POLL_TIMEOUT_MS;
    for (const value of homes.splice(0)) {
      rmSync(value, { recursive: true, force: true });
    }
  });

  test('AC1: create -> connect -> get -> disconnect -> remove round-trips through the tool surface with a stubbed SSH runner', async () => {
    const tunnel = fakeConnectingTunnel();
    const createTunnel = vi.fn(() => tunnel);
    const service = serviceWithAdapter(createTunnel);
    await service.initialize();
    const app = createSshEnvironmentRoutes(service);
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(bridgeFetch(app));
    const tools = await registerTools();

    const created = toolBody(
      await tools.create_ssh_environment({
        hostAlias: 'brian-media',
        remoteProjectPath: '~/dev/github/kontourai/station',
      }),
    );
    expect(created.success).toBe(true);
    expect(created.data.state).toEqual({ phase: 'idle' });
    const id = created.data.profile.id;
    expect(typeof id).toBe('string');

    const listed = toolBody(await tools.get_ssh_environment({ id }));
    expect(listed.success).toBe(true);
    expect(listed.data.profile.hostAlias).toBe('brian-media');

    const connected = toolBody(await tools.connect_ssh_environment({ id }));
    expect(connected.success).toBe(true);
    expect(connected.polling).toBe(false);
    expect(connected.data.state.phase).toBe('connected');
    expect(connected.data.profile.verifiedProjectPath).toBe(
      WORKER.remoteProjectPath,
    );
    expect(connected.data.profile.remoteHome).toBe(WORKER.remoteHome);
    expect(createTunnel).toHaveBeenCalledTimes(1);

    const disconnected = toolBody(
      await tools.disconnect_ssh_environment({ id }),
    );
    expect(disconnected.success).toBe(true);
    expect(disconnected.data.state).toEqual({
      phase: 'disconnected',
      reason: 'stopped',
    });
    expect(tunnel.stop).toHaveBeenCalledTimes(1);

    const removed = toolBody(await tools.remove_ssh_environment({ id }));
    expect(removed).toEqual({ success: true });

    const afterRemoval = toolBody(await tools.get_ssh_environment({ id }));
    expect(afterRemoval).toEqual({
      success: false,
      error: 'SSH environment not found',
    });
  });

  test('AC3: each tool calls the injected SshEnvironmentService directly, proving no duplicated store/connect logic', async () => {
    const tunnel = fakeConnectingTunnel();
    const service = serviceWithAdapter(vi.fn(() => tunnel));
    await service.initialize();
    const addSpy = vi.spyOn(service, 'add');
    const connectSpy = vi.spyOn(service, 'connect');
    const getSpy = vi.spyOn(service, 'get');
    const disconnectSpy = vi.spyOn(service, 'disconnect');
    const removeSpy = vi.spyOn(service, 'remove');
    const app = createSshEnvironmentRoutes(service);
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(bridgeFetch(app));
    const tools = await registerTools();

    const created = toolBody(
      await tools.create_ssh_environment({
        hostAlias: 'brian-media',
        remoteProjectPath: '~/dev/github/kontourai/station',
      }),
    );
    const id = created.data.profile.id;
    expect(addSpy).toHaveBeenCalledWith({
      hostAlias: 'brian-media',
      remoteProjectPath: '~/dev/github/kontourai/station',
    });

    await tools.get_ssh_environment({ id });
    expect(getSpy).toHaveBeenCalledWith(id);

    await tools.connect_ssh_environment({ id });
    expect(connectSpy).toHaveBeenCalledWith(id);

    await tools.disconnect_ssh_environment({ id });
    expect(disconnectSpy).toHaveBeenCalledWith(id);

    await tools.remove_ssh_environment({ id });
    expect(removeSpy).toHaveBeenCalledWith(id);

    // One call per tool invocation above — nothing in the tool layer calls
    // the service an extra time or reaches around it.
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  test('AC2: a connect landing in host-key returns that state promptly instead of blocking, and never auto-accepts', async () => {
    process.env.STATION_SSH_CONNECT_POLL_TIMEOUT_MS = '20';
    let capturedOnStateChange: ((state: unknown) => void) | undefined;
    const neverSettles = new Promise<never>(() => {});
    const tunnel = {
      start: vi.fn(() => {
        // Mirrors the real adapter's timing: OpenSSH's diagnostic lands on
        // `onStateChange` synchronously, long before `start()` itself would
        // ever resolve (real OpenSSH would sit here for its own ~120s
        // timeout with a human nowhere near the prompt).
        capturedOnStateChange?.({
          phase: 'host-key',
          reason: 'confirmation-required',
        });
        return neverSettles;
      }),
      probeWorker: vi.fn(async () => WORKER),
      stop: vi.fn(async () => undefined),
    };
    const createTunnel = vi.fn((options: { onStateChange?: any }) => {
      capturedOnStateChange = options.onStateChange;
      return tunnel;
    });
    const service = serviceWithAdapter(createTunnel);
    await service.initialize();
    const app = createSshEnvironmentRoutes(service);
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(bridgeFetch(app));
    const tools = await registerTools();

    const created = toolBody(
      await tools.create_ssh_environment({
        hostAlias: 'brian-media',
        remoteProjectPath: '~/dev/github/kontourai/station',
      }),
    );
    const id = created.data.profile.id;

    const startedAt = Date.now();
    const result = toolBody(await tools.connect_ssh_environment({ id }));
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(2_000);
    expect(result.polling).toBe(true);
    expect(result.success).toBe(true);
    expect(result.data.state).toEqual({
      phase: 'host-key',
      reason: 'confirmation-required',
    });
    // Never supplied a credential or answered the prompt on its own.
    expect(tunnel.probeWorker).not.toHaveBeenCalled();

    // A follow-up connect_ssh_environment call reuses the same in-flight
    // connect rather than starting a second tunnel.
    await tools.connect_ssh_environment({ id });
    expect(createTunnel).toHaveBeenCalledTimes(1);
  });

  test('create_ssh_environment surfaces the shared route validation failure for a flag-like hostAlias without reaching the service', async () => {
    const service = serviceWithAdapter(vi.fn());
    await service.initialize();
    const addSpy = vi.spyOn(service, 'add');
    const app = createSshEnvironmentRoutes(service);
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(bridgeFetch(app));
    const tools = await registerTools();

    const result = toolBody(
      await tools.create_ssh_environment({
        hostAlias: '-oProxyCommand=bad',
        remoteProjectPath: '/srv/station',
      }),
    );
    expect(result.success).toBe(false);
    expect(addSpy).not.toHaveBeenCalled();
  });

  // sol review finding 2: the configured-alias gate and its
  // `allowUnknownHost` escape hatch are retired, so the agent/tool path
  // registers a raw address the same way the HTTP route does — the profile
  // is a note, not a grant. Reaching that host still requires its key in the
  // operator's own known_hosts (pinned on the master argv), which no tool
  // call can write.
  test('create_ssh_environment registers an alias absent from the SSH config, identically to the HTTP route', async () => {
    const tunnel = fakeConnectingTunnel();
    const service = new SshEnvironmentService(home(), {
      adapter: {
        createTunnel: vi.fn(() => tunnel),
      } as unknown as OpenSshEnvironmentAdapter,
    });
    await service.initialize();
    const app = createSshEnvironmentRoutes(service);
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(bridgeFetch(app));
    const tools = await registerTools();

    const created = toolBody(
      await tools.create_ssh_environment({
        hostAlias: '203.0.113.42',
        remoteProjectPath: '~/dev/github/kontourai/station',
      }),
    );
    expect(created.success).toBe(true);
    expect(created.data.profile.hostAlias).toBe('203.0.113.42');
  });
});
