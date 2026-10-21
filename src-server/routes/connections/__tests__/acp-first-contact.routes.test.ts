import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { loadOrCreateAgentRegistry } from '../../../domain/agent-registry.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import { ACPManager } from '../../../services/acp/acp-manager.js';

/**
 * A first add whose request-budget probe runs out of time on a never-connected
 * engine (a cold start) continues on the cold budget in the background. These
 * drive the real ACPManager and the real routes; only the engine probe is
 * replaced, and it settles the way `ACPProbe.runProbe` does.
 */

vi.stubEnv('STATION_DISABLE_LOGIN_PATH_RESOLVE', '1');
vi.mock('../../../telemetry/metrics.js', () => ({
  acpOps: { add: vi.fn() },
}));
let providerEntries: Array<{
  builtin?: boolean;
  source: string;
  provider: any;
}> = [];
vi.mock('../../../providers/registries/registry.js', () => ({
  listProviders: (type: string) =>
    providerEntries.filter((entry) => entry.source.startsWith(type)),
}));

const { createACPRoutes } = await import('../acp.js');

type Run = { ok: boolean; deadline?: boolean; message?: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Each probe run takes the next scripted outcome for its initiator. */
function scriptedProbes() {
  const script: Record<'request' | 'background', Array<Promise<Run> | Run>> = {
    request: [],
    background: [],
  };
  const initiators: string[] = [];
  const createProbe = () => {
    let inFlight: Promise<boolean> | null = null;
    const probe = {
      lastProbeAt: 0,
      handshakeObservedAt: 0,
      lastSuccess: false,
      deadline: false,
      lastError: null as { phase: string; message: string } | null,
      getModes: () => [],
      getConfigOptions: () => [],
      getCapabilities: () => undefined,
      getHandshakeObservedAt: () => probe.handshakeObservedAt,
      isAvailable: () => probe.lastSuccess,
      isProbeInFlight: () => inFlight !== null,
      firstContactTimedOut: () =>
        probe.handshakeObservedAt === 0 && !probe.lastSuccess && probe.deadline,
      probe(initiator: 'request' | 'background' = 'request') {
        if (inFlight) return inFlight;
        initiators.push(initiator);
        const next = script[initiator].shift() ?? { ok: false };
        inFlight = Promise.resolve(next).then((run) => {
          probe.lastProbeAt = Date.now();
          probe.lastSuccess = run.ok;
          probe.deadline = !run.ok && run.deadline === true;
          if (run.ok) {
            probe.handshakeObservedAt = probe.lastProbeAt;
            probe.lastError = null;
          } else {
            probe.lastError = {
              phase: 'initialize',
              message: run.message ?? 'Timed out after 10000ms',
            };
          }
          inFlight = null;
          return run.ok;
        });
        return inFlight;
      },
      async dispose() {},
    };
    return probe;
  };
  return { script, initiators, createProbe };
}

function asOperator(routes: Hono): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
      credential: 'operator-credential',
      authority: 'operator-credential',
      source: 'bearer',
    });
    await next();
  });
  app.route('/', routes);
  return app;
}

const homes: string[] = [];

async function createContext(createProbe: () => any) {
  const home = mkdtempSync(join(tmpdir(), 'station-acp-first-contact-'));
  homes.push(home);
  const configLoader = new ConfigLoader({ projectHomeDir: home });
  await loadOrCreateAgentRegistry(configLoader);
  // A serialized queue, like the runtime's: each mutation waits for the last.
  let tail: Promise<unknown> = Promise.resolve();
  const applyAgentConfigurationMutation = vi.fn(
    <T>(operation: (begin: () => void) => Promise<T>): Promise<T> => {
      const run = tail.then(() => operation(() => undefined));
      tail = run.catch(() => undefined);
      return run;
    },
  );
  const acpBridge = new ACPManager(
    { warn: () => {}, info: () => {}, debug: () => {} },
    home,
    undefined,
    createProbe,
  );
  const ctx = {
    configLoader,
    acpBridge,
    applyAgentConfigurationMutation,
    logger: { warn: () => {} },
  } as any;
  return { ctx, configLoader, acpBridge };
}

const MUSE = { id: 'muse', name: 'Muse', command: 'muse' };

async function registered(configLoader: ConfigLoader) {
  return (await loadOrCreateAgentRegistry(configLoader)).engineConnections.map(
    ({ id }) => String(id),
  );
}

describe('first-contact continuation of a cold engine add', () => {
  beforeEach(() => {
    providerEntries = [
      {
        source: 'acpConnectionRegistry:core',
        builtin: true,
        provider: { listAvailable: () => [MUSE] },
      },
    ];
  });
  afterEach(() => {
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a timed-out first add answers probing and registers once the cold probe succeeds, without holding the queue', async () => {
    const { script, initiators, createProbe } = scriptedProbes();
    const cold = deferred<Run>();
    script.request.push({ ok: false, deadline: true });
    script.background.push(cold.promise);
    const { ctx, configLoader } = await createContext(createProbe);
    const app = asOperator(createACPRoutes(ctx));

    const body = await json(
      await app.request('/registry/muse/install', { method: 'POST' }),
    );

    expect(body).toMatchObject({
      success: true,
      data: { id: 'muse', status: 'probing' },
    });
    expect(body.agent).toBeUndefined();
    expect(initiators).toEqual(['request', 'background']);
    // The cold probe is still running and the queue is free.
    await expect(
      ctx.applyAgentConfigurationMutation(async () => 'other mutation'),
    ).resolves.toBe('other mutation');
    expect(await registered(configLoader)).toEqual([]);

    cold.resolve({ ok: true });
    // Registration is queued file I/O; allow for a loaded host.
    await vi.waitFor(
      async () => {
        expect(await registered(configLoader)).toEqual(['muse']);
        expect(await configLoader.agentExists('muse')).toBe(true);
      },
      { timeout: 5_000 },
    );
    expect((await json(await app.request('/connections'))).data).toMatchObject([
      { id: 'muse', status: 'available' },
    ]);
  });

  // A registry reload (`/api/registry`) re-adds every saved connection on
  // the request budget. Replacing the probe would dispose the cold
  // continuation mid-start, and its later success could never register.
  test('a registry reload does not drop a first-start continuation', async () => {
    const { script, initiators, createProbe } = scriptedProbes();
    const cold = deferred<Run>();
    script.request.push({ ok: false, deadline: true });
    script.background.push(cold.promise);
    const { ctx, configLoader, acpBridge } = await createContext(createProbe);
    const app = asOperator(createACPRoutes(ctx));
    await app.request('/registry/muse/install', { method: 'POST' });

    await acpBridge.startAll((await configLoader.loadACPConfig()).connections);
    expect(initiators).toEqual(['request', 'background']);
    expect(acpBridge.getStatus().connections[0]).toMatchObject({
      status: 'probing',
    });

    cold.resolve({ ok: true });
    // Registration is queued file I/O; allow for a loaded host.
    await vi.waitFor(
      async () => {
        expect(await registered(configLoader)).toEqual(['muse']);
        expect(await configLoader.agentExists('muse')).toBe(true);
      },
      { timeout: 5_000 },
    );
    await acpBridge.shutdown();
  });

  // The reload exception lasts only while the continuation runs: once it
  // settles, a reload re-adds the connection like any other.
  test('a finished continuation no longer shields its probe from a reload', async () => {
    const { script, initiators, createProbe } = scriptedProbes();
    const cold = deferred<Run>();
    script.request.push({ ok: false, deadline: true });
    script.background.push(cold.promise);
    const { ctx, configLoader, acpBridge } = await createContext(createProbe);
    const app = asOperator(createACPRoutes(ctx));
    await app.request('/registry/muse/install', { method: 'POST' });

    cold.resolve({ ok: false, message: 'still cold' });
    await vi.waitFor(() =>
      expect(acpBridge.getStatus().connections[0]).toMatchObject({
        status: 'unavailable',
      }),
    );
    await acpBridge.startAll((await configLoader.loadACPConfig()).connections);

    expect(initiators).toEqual(['request', 'background', 'request']);
    await acpBridge.shutdown();
  });

  test('a cold probe whose saved config changed meanwhile registers nothing', async () => {
    const { script, createProbe } = scriptedProbes();
    const cold = deferred<Run>();
    script.request.push({ ok: false, deadline: true });
    script.background.push(cold.promise);
    const { ctx, configLoader } = await createContext(createProbe);
    const app = asOperator(createACPRoutes(ctx));
    await app.request('/registry/muse/install', { method: 'POST' });

    // An edit lands on disk while the cold probe runs.
    const config = await configLoader.loadACPConfig();
    config.connections[0] = { ...config.connections[0], args: ['--other'] };
    await configLoader.saveACPConfig(config);
    cold.resolve({ ok: true });

    // Give the detached completion and the queued check time to run.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await ctx.applyAgentConfigurationMutation(async () => undefined);
    expect(await registered(configLoader)).toEqual([]);
    expect(await configLoader.agentExists('muse')).toBe(false);
  });

  test('a failed cold probe answers unavailable with its reason and registers nothing', async () => {
    const { script, createProbe } = scriptedProbes();
    const cold = deferred<Run>();
    script.request.push({ ok: false, deadline: true });
    script.background.push(cold.promise);
    const { ctx, configLoader, acpBridge } = await createContext(createProbe);
    const app = asOperator(createACPRoutes(ctx));
    await app.request('/registry/muse/install', { method: 'POST' });

    cold.resolve({ ok: false, message: 'Authentication required' });
    await vi.waitFor(() =>
      expect(acpBridge.getStatus().connections[0]).toMatchObject({
        status: 'unavailable',
        lastError: { phase: 'initialize', message: 'Authentication required' },
      }),
    );
    expect(await registered(configLoader)).toEqual([]);
  });

  test('a failure that is not a timeout gets no cold retry', async () => {
    const { script, initiators, createProbe } = scriptedProbes();
    script.request.push({ ok: false, message: 'spawn muse ENOENT' });
    const { ctx } = await createContext(createProbe);
    const app = asOperator(createACPRoutes(ctx));

    const body = await json(
      await app.request('/registry/muse/install', { method: 'POST' }),
    );

    expect(body.data).toMatchObject({ status: 'unavailable' });
    expect(initiators).toEqual(['request']);
  });

  // The related gap: the connection stays in the bridge after its failed
  // add, and the periodic sweep re-probes it on the cold budget. Its success
  // used to change availability and register nothing.
  test('a later sweep that first handshakes a saved, unregistered connection registers it', async () => {
    const { script, createProbe } = scriptedProbes();
    script.request.push({ ok: false, message: 'spawn muse ENOENT' });
    script.background.push({ ok: true });
    const { ctx, configLoader, acpBridge } = await createContext(createProbe);
    const app = asOperator(createACPRoutes(ctx));
    await app.request('/registry/muse/install', { method: 'POST' });
    expect(await registered(configLoader)).toEqual([]);

    // Due again: the staleness gate reads lastProbeAt.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60_000);
    try {
      await acpBridge.sweep();
    } finally {
      vi.mocked(Date.now).mockRestore();
    }

    // Registration is queued file I/O; allow for a loaded host.
    await vi.waitFor(
      async () => {
        expect(await registered(configLoader)).toEqual(['muse']);
        expect(await configLoader.agentExists('muse')).toBe(true);
      },
      { timeout: 5_000 },
    );
  });
});
