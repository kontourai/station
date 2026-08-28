import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';

// Spread the real module rather than listing the instruments this route
// happens to use today. A hand-written whole-module mock of a 274-export
// module goes stale the moment a handler records a new instrument, and the
// failure lands on whoever gates next: every mutating handler here threw
// `No "toolDefinitionOps" export is defined on the mock` because the route
// gained that counter and the mock did not.
vi.mock('../../../telemetry/metrics.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../telemetry/metrics.js')>()),
  toolCalls: { add: vi.fn() },
}));

// Spread rather than replaced: `runtime-agent-identity.js` imports
// `ReservedAgentIdentityError` from the same module and throws it on the
// reserved-key path this route still exercises.
vi.mock('../../../domain/agent-registry.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../domain/agent-registry.js')
  >()),
  registryOwnsAgentAtHome: vi.fn(),
}));

const { registryOwnsAgentAtHome } = await import(
  '../../../domain/agent-registry.js'
);
const { createAgentToolRoutes } = await import('../agent-tools.js');

/**
 * The route asks the READ-ONLY question — does the registry own this id —
 * rather than loading (and potentially seeding) the whole registry, so the
 * diagnosis path cannot fail with a 500 on the request it exists to explain
 * (archive#3158 review).
 */
function stubRegistry(defaultAgentIds: string[]) {
  vi.mocked(registryOwnsAgentAtHome).mockImplementation(async (_home, id) =>
    defaultAgentIds.includes(String(id)),
  );
}

function createMockRuntimeContext() {
  const beginMutation = vi.fn();
  return {
    beginMutation,
    activeAgents: new Map([['default', { model: 'claude-3' }]]),
    agentTools: new Map([
      [
        'default',
        [{ name: 'myServer_read', id: 't1', description: 'Read files' }],
      ],
    ]),
    toolNameMapping: new Map([
      [
        'myServer_read',
        {
          original: 'read',
          normalized: 'myServer_read',
          server: 'myServer',
          tool: 'read',
        },
      ],
    ]),
    agentSpecs: new Map([['default', { tools: { mcpServers: ['myServer'] } }]]),
    agentStatus: new Map([['default', 'idle']]),
    mcpConnectionStatus: new Map([['myServer', { connected: true }]]),
    integrationMetadata: new Map([
      ['myServer', { type: 'mcp', transport: 'stdio', toolCount: 1 }],
    ]),
    memoryAdapters: new Map([['default', {}]]),
    configLoader: {
      // The route resolves the home to ask the registry a read-only
      // question; without it the diagnosis path throws and 500s.
      getProjectHomeDir: () => '/tmp/station-home',
      loadAgent: vi.fn().mockResolvedValue({
        tools: { mcpServers: ['myServer'], available: ['*'] },
      }),
      updateAgent: vi.fn().mockResolvedValue(undefined),
      listAgents: vi.fn().mockResolvedValue([{ slug: 'planner' }]),
    },
    initialize: vi.fn().mockResolvedValue(undefined),
    reloadAgents: vi.fn().mockResolvedValue(undefined),
    applyAgentConfigurationMutation: vi.fn(
      async <T>(operation: (beginMutation: () => void) => Promise<T>) =>
        operation(beginMutation),
    ),
  };
}

describe('Agent Tool Routes', () => {
  test('GET /:slug/tools returns tool list', async () => {
    const app = createAgentToolRoutes(createMockRuntimeContext() as any);
    const body = await json(await app.request('/station/tools'));
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].server).toBe('myServer');
  });

  // archive#3158 — the three cases below shared one 404 reading "Agent not
  // found or not active", which left the caller unable to tell "pick a
  // different agent" from "this one's runtime is down".
  test('GET /:slug/tools reports an agent nothing knows about as not found', async () => {
    stubRegistry(['station']);
    const app = createAgentToolRoutes(createMockRuntimeContext() as any);

    const res = await app.request('/unknown/tools');

    expect(res.status).toBe(404);
    expect((await json(res)).error).toBe("Agent 'unknown' not found");
  });

  test('GET /:slug/tools reports a persisted but inactive agent as inactive, not missing', async () => {
    stubRegistry(['station']);
    const app = createAgentToolRoutes(createMockRuntimeContext() as any);

    // `planner` is in the persisted catalog; nothing put it in activeAgents.
    const res = await app.request('/planner/tools');

    expect(res.status).toBe(409);
    expect((await json(res)).error).toBe(
      "Agent 'planner' exists but is not active",
    );
  });

  test('GET /:slug/tools says "activating" while activation is still owed', async () => {
    // "Not active" and "not active YET" are different answers. A create whose
    // activation outran its deadline returns `configurationActivation:
    // pending`; a client that then polls tools was told 409 "exists but is
    // not active", which reads as a dead end rather than "try again".
    stubRegistry(['station']);
    const ctx = createMockRuntimeContext() as any;
    // The real signal: a per-slug map of activations actually running.
    const inFlight = new Set(['planner']);
    ctx.isAgentConfigurationActivationPending = (slug: string) =>
      inFlight.has(slug);
    const app = createAgentToolRoutes(ctx);

    const res = await app.request('/planner/tools');

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('1');
    expect((await json(res)).error).toBe(
      "Agent 'planner' is activating; retry shortly",
    );
  });

  test('a settled runtime still reports a genuinely inactive agent as 409', async () => {
    // The discriminating half: without this, "activating" could be returned
    // unconditionally and the test above would still pass.
    stubRegistry(['station']);
    const ctx = createMockRuntimeContext() as any;
    ctx.isAgentConfigurationActivationPending = () => false;
    const app = createAgentToolRoutes(ctx);

    const res = await app.request('/planner/tools');

    expect(res.status).toBe(409);
    expect(res.headers.get('Retry-After')).toBeNull();
  });

  test('an abandoned activation answers 409 WITH the reason, not a shrug', async () => {
    // "Exists but is not active" is true and useless — the sentence a user
    // stares at with nothing to do. Once the runtime stops retrying it knows
    // why, and that is the only thing a caller can act on.
    stubRegistry(['station']);
    const ctx = createMockRuntimeContext() as any;
    ctx.isAgentConfigurationActivationPending = () => false;
    ctx.getAgentActivationFailure = (slug: string) =>
      slug === 'planner'
        ? {
            reason: 'prompt template references a missing variable',
            at: '2026-08-20T00:00:00.000Z',
          }
        : undefined;
    const app = createAgentToolRoutes(ctx);

    const res = await app.request('/planner/tools');

    expect(res.status).toBe(409);
    // No Retry-After: retrying is exactly what the runtime stopped doing.
    expect(res.headers.get('Retry-After')).toBeNull();
    expect((await json(res)).error).toBe(
      "Agent 'planner' could not be activated: prompt template references a missing variable",
    );
  });

  test('while it is still activating the reason is not spoken yet', async () => {
    // Ordering matters: a recorded failure from an earlier attempt must not
    // outrank the fact that a new attempt is in flight.
    stubRegistry(['station']);
    const ctx = createMockRuntimeContext() as any;
    ctx.isAgentConfigurationActivationPending = () => true;
    ctx.getAgentActivationFailure = () => ({
      reason: 'stale reason',
      at: '2026-08-20T00:00:00.000Z',
    });
    const app = createAgentToolRoutes(ctx);

    const res = await app.request('/planner/tools');

    expect(res.status).toBe(503);
    expect((await json(res)).error).toMatch(/is activating/);
  });

  test('another agent activating does not make THIS one report activating', async () => {
    // The defect the per-slug signal replaced: a global "reconciliation is
    // scheduled" flag told every inactive agent it was activating.
    stubRegistry(['station']);
    const ctx = createMockRuntimeContext() as any;
    const inFlight = new Set(['someone-else']);
    ctx.isAgentConfigurationActivationPending = (slug: string) =>
      inFlight.has(slug);
    const app = createAgentToolRoutes(ctx);

    const res = await app.request('/planner/tools');

    expect(res.status).toBe(409);
    expect(res.headers.get('Retry-After')).toBeNull();
  });

  test('a slug that does not exist is 404 even mid-activation', async () => {
    // Activation pending is not a licence to imply an Agent exists.
    stubRegistry(['station']);
    const ctx = createMockRuntimeContext() as any;
    ctx.isAgentConfigurationActivationPending = () => true;
    const app = createAgentToolRoutes(ctx);

    const res = await app.request('/unknown/tools');

    expect(res.status).toBe(404);
  });

  // The discriminating case for consulting the registry at all: a
  // registry-default agent has no file under `agents/`, so a check that reads
  // only the persisted catalog calls the built-in agent missing at exactly the
  // moment its runtime is down.
  test('GET /:slug/tools reports the inactive built-in station agent as inactive, not missing', async () => {
    stubRegistry(['station']);
    const ctx = createMockRuntimeContext();
    ctx.activeAgents.delete('default');
    const app = createAgentToolRoutes(ctx as any);

    const res = await app.request('/station/tools');

    expect(res.status).toBe(409);
    expect((await json(res)).error).toBe(
      "Agent 'station' exists but is not active",
    );
  });

  test('POST /:slug/tools adds tool to agent', async () => {
    const ctx = createMockRuntimeContext();
    const app = createAgentToolRoutes(ctx as any);
    const body = await json(
      await app.request('/station/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolId: 'newServer' }),
      }),
    );
    expect(body.success).toBe(true);
    expect(ctx.applyAgentConfigurationMutation).toHaveBeenCalled();
    expect(ctx.reloadAgents).not.toHaveBeenCalled();
    expect(ctx.initialize).not.toHaveBeenCalled();
  });

  test('POST /:slug/tools does not begin an unchanged mutation', async () => {
    const ctx = createMockRuntimeContext();
    const app = createAgentToolRoutes(ctx as any);

    const response = await app.request('/station/tools', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolId: 'myServer' }),
    });

    expect(response.status).toBe(200);
    expect(ctx.beginMutation).not.toHaveBeenCalled();
    expect(ctx.configLoader.updateAgent).not.toHaveBeenCalled();
  });

  test('DELETE /:slug/tools/:toolId removes tool', async () => {
    const ctx = createMockRuntimeContext();
    const app = createAgentToolRoutes(ctx as any);
    const body = await json(
      await app.request('/station/tools/myServer', { method: 'DELETE' }),
    );
    expect(body.success).toBe(true);
  });

  test('DELETE /:slug/tools/:toolId does not begin a missing mutation', async () => {
    const ctx = createMockRuntimeContext();
    const app = createAgentToolRoutes(ctx as any);

    const response = await app.request('/station/tools/not-installed', {
      method: 'DELETE',
    });

    expect(response.status).toBe(200);
    expect(ctx.beginMutation).not.toHaveBeenCalled();
    expect(ctx.configLoader.updateAgent).not.toHaveBeenCalled();
  });

  test('GET /:slug/health returns health status', async () => {
    const app = createAgentToolRoutes(createMockRuntimeContext() as any);
    const body = await json(await app.request('/station/health'));
    expect(body.success).toBe(true);
    expect(body.healthy).toBe(true);
    expect(body.checks.loaded).toBe(true);
    expect(body.integrations).toHaveLength(1);
  });

  test('GET /:slug/health returns 404 for unknown agent', async () => {
    stubRegistry(['station']);
    const app = createAgentToolRoutes(createMockRuntimeContext() as any);
    const res = await app.request('/unknown/health');
    expect(res.status).toBe(404);
    expect((await json(res)).error).toBe("Agent 'unknown' not found");
  });

  // The same `!activeAgents.get(...)` condition /tools already diagnoses.
  // Answering "Agent not found" here is not vague, it is false — and a health
  // check is asked precisely when a runtime is suspected to be down.
  test('GET /:slug/health reports a persisted but inactive agent as inactive, not missing', async () => {
    stubRegistry(['station']);
    const app = createAgentToolRoutes(createMockRuntimeContext() as any);

    const res = await app.request('/planner/health');

    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({
      success: false,
      healthy: false,
      error: "Agent 'planner' exists but is not active",
      checks: { loaded: false },
    });
  });

  test('GET /:slug/health reports the inactive built-in station agent as inactive', async () => {
    stubRegistry(['station']);
    const ctx = createMockRuntimeContext();
    ctx.activeAgents.delete('default');
    const app = createAgentToolRoutes(ctx as any);

    const res = await app.request('/station/health');

    expect(res.status).toBe(409);
    expect((await json(res)).error).toBe(
      "Agent 'station' exists but is not active",
    );
  });
});
