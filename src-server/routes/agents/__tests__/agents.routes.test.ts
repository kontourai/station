import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  agentOps: { add: vi.fn() },
}));

// station#3121: the suites below — the create-warning tests and the bare
// catalog's read path — run the REAL `resolveManagedAvailabilityReason`
// instead of a `resolveAvailability` stub. A stub is exactly what hid this
// defect: it can be made to answer anything and never exercises the
// derivation the route actually receives in production (`runtime-routes.ts`
// wires the real probe). Only the AWS reach-outs that derivation can touch
// are stubbed, mirroring
// `runtime/plugins/__tests__/runtime-provider-resolution.test.ts` — no SDK
// client and no network from a route unit test.
vi.mock('../../../providers/connection-factories.js', () => ({
  createLLMProvider: vi.fn(),
  createEmbeddingProvider: vi.fn(() => null),
  createVectorDbProvider: vi.fn(() => null),
}));
vi.mock('../../../providers/llm/bedrock-models.js', () => ({
  BedrockModelCatalog: class {
    resolveModelId(modelId: string) {
      return Promise.resolve(modelId);
    }
    dispose() {}
  },
}));

const { createAgentRoutes, deriveAgentCatalog } = await import('../agents.js');
const { AgentService } = await import(
  '../../../services/agents/agent-service.js'
);
const { resolveManagedAvailabilityReason } = await import(
  '../../../runtime/plugins/runtime-provider-resolution.js'
);

function setup() {
  const agentService = {
    getEnrichedAgents: vi
      .fn()
      .mockResolvedValue([{ slug: 'station', name: 'Default' }]),
    listAgents: vi
      .fn()
      .mockResolvedValue([{ slug: 'station', name: 'Default' }]),
    loadAgentSpec: vi.fn().mockResolvedValue({ name: 'Default' }),
    createAgent: vi
      .fn()
      .mockResolvedValue({ slug: 'new', spec: { name: 'New' } }),
    materializeEngineAgent: vi
      .fn()
      .mockResolvedValue({ slug: 'new', created: true, spec: { name: 'New' } }),
    updateAgent: vi.fn().mockResolvedValue({ name: 'Updated' }),
    deleteAgent: vi.fn().mockResolvedValue({ success: true }),
  };
  const skillService = {
    listSkills: vi
      .fn()
      .mockReturnValue([{ name: 'known-skill', description: 'A skill' }]),
  };
  const reinitialize = vi.fn(
    async <T>(
      operation: (beginMutation: () => void) => Promise<T>,
      _options?: unknown,
    ) => operation(() => undefined),
  );
  const getVoltAgent = vi.fn().mockReturnValue({
    getAgents: vi.fn().mockResolvedValue([{ id: 'station' }]),
  });
  const app = createAgentRoutes(
    agentService as any,
    skillService as any,
    reinitialize as any,
    getVoltAgent,
  );
  return { app, agentService, skillService, reinitialize, getVoltAgent };
}

describe('Agent Routes', () => {
  test('GET / returns enriched agents', async () => {
    const { app } = setup();
    const body = await json(await app.request('/'));
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
  });

  test('GET / surfaces persisted-but-unregistered agents as available:false with a concrete reason (#chat)', async () => {
    const { agentService, skillService, reinitialize, getVoltAgent } = setup();
    // `ghost` is on disk (listAgents) but never registered with VoltAgent
    // (absent from getEnrichedAgents) because its model wouldn't resolve.
    agentService.getEnrichedAgents.mockResolvedValue([
      { slug: 'station', name: 'Default' },
    ]);
    agentService.listAgents.mockResolvedValue([
      { slug: 'station', name: 'Default' },
      { slug: 'ghost', name: 'Ghost' },
    ]);
    agentService.loadAgentSpec.mockImplementation(async (slug: string) =>
      slug === 'ghost' ? { name: 'Ghost', prompt: 'boo' } : { name: 'Default' },
    );
    const reason =
      'Multiple enabled LLM provider connections require an explicit default.';
    const resolveAvailability = vi.fn((spec: { name?: string }) =>
      spec.name === 'Ghost' ? reason : null,
    );
    const app = createAgentRoutes(
      agentService as any,
      skillService as any,
      reinitialize as any,
      getVoltAgent,
      resolveAvailability as any,
    );

    const body = await json(await app.request('/'));
    expect(body.success).toBe(true);
    const ghost = body.data.find((a: any) => a.slug === 'ghost');
    expect(ghost).toMatchObject({
      slug: 'ghost',
      name: 'Ghost',
      available: false,
      unavailableReason: reason,
    });
    // Registered agents keep their current shape — no availability fields.
    const def = body.data.find((a: any) => a.slug === 'station');
    expect(def.available).toBeUndefined();
    expect(def.unavailableReason).toBeUndefined();
  });

  test('the boot aggregate derives the same persisted-but-unregistered agent catalog as GET /', async () => {
    const { agentService, skillService, reinitialize, getVoltAgent } = setup();
    agentService.listAgents.mockResolvedValue([
      { slug: 'station', name: 'Default' },
      { slug: 'ghost', name: 'Ghost' },
    ]);
    agentService.loadAgentSpec.mockImplementation(async (slug: string) =>
      slug === 'ghost' ? { name: 'Ghost', prompt: 'boo' } : { name: 'Default' },
    );
    const reason = 'No model is available.';
    const resolveAvailability = vi.fn(() => reason);
    const app = createAgentRoutes(
      agentService as any,
      skillService as any,
      reinitialize as any,
      getVoltAgent,
      resolveAvailability as any,
    );
    const routeCatalog = (await json(await app.request('/'))).data;
    const aggregateCatalog = await deriveAgentCatalog(
      agentService as any,
      await agentService.getEnrichedAgents(await getVoltAgent().getAgents()),
      resolveAvailability,
    );
    expect(aggregateCatalog).toEqual(routeCatalog);
    expect(aggregateCatalog).toContainEqual(
      expect.objectContaining({
        slug: 'ghost',
        available: false,
        unavailableReason: reason,
      }),
    );
  });

  // station#3121 — the READ path. `deriveAgentCatalog` applied the
  // Station-engine model-resolution probe to every store-only record, and an
  // AUTHORED external-engine agent is a store-only record BY DESIGN (it is
  // deliberately skipped from VoltAgent registration —
  // `runtime-agent-registry.ts`). On a home with no LLM provider connection
  // that reported a perfectly runnable agent as unavailable, with a reason
  // about a concept its engine does not have — and this bare route is what
  // station-control's `list_agents` tool forwards verbatim to a delegating
  // agent.
  describe('external-engine-bound store-only records (#3121)', () => {
    // The exact wiring `runtime-routes.ts` gives the route in production,
    // against a home that has no LLM provider connection at all.
    const resolveAvailabilityForEmptyHome = (spec: unknown) =>
      resolveManagedAvailabilityReason(spec as never, {
        appConfig: {} as never,
        listProviderConnections: () => [],
      });

    const MANAGED_REFUSAL = 'No enabled LLM provider connection is configured.';
    const externalSpec = {
      name: 'Reviewer',
      prompt: 'review',
      execution: { agentConnectionId: 'claude-code' },
    };
    const stationSpec = { name: 'Ghost', prompt: 'boo' };

    function setupCatalog() {
      const { agentService, skillService, reinitialize, getVoltAgent } =
        setup();
      agentService.getEnrichedAgents.mockResolvedValue([
        { slug: 'station', name: 'Default' },
      ]);
      agentService.listAgents.mockResolvedValue([
        { slug: 'station', name: 'Default' },
        { slug: 'reviewer', name: 'Reviewer' },
        { slug: 'ghost', name: 'Ghost' },
      ]);
      agentService.loadAgentSpec.mockImplementation(async (slug: string) => {
        if (slug === 'reviewer') return externalSpec;
        if (slug === 'ghost') return stationSpec;
        return { name: 'Default' };
      });
      const app = createAgentRoutes(
        agentService as any,
        skillService as any,
        reinitialize as any,
        getVoltAgent,
        resolveAvailabilityForEmptyHome as any,
      );
      return { app, agentService, getVoltAgent };
    }

    // Discriminating precondition. Without this, a green external-engine
    // assertion below could just mean the real probe happened to return
    // `null` for that spec (a quiet derivation), proving nothing about the
    // guard. The probe refuses BOTH specs identically, so the only thing
    // that can separate them downstream is the engine classification.
    test('the REAL managed probe refuses both specs identically on this home', () => {
      expect(resolveAvailabilityForEmptyHome(externalSpec)).toBe(
        MANAGED_REFUSAL,
      );
      expect(resolveAvailabilityForEmptyHome(stationSpec)).toBe(
        MANAGED_REFUSAL,
      );
    });

    test('GET / lists an external-engine-bound agent without a model-provider reason', async () => {
      const { app } = setupCatalog();
      const body = await json(await app.request('/'));
      const reviewer = body.data.find((a: any) => a.slug === 'reviewer');
      expect(reviewer).toBeDefined();
      // Consumers key on `available === false`; omitting the pair is this
      // route's established "no availability claim" shape (registered
      // agents omit it too). Not `false`, and specifically not the managed
      // refusal — an external engine has no model-provider concept.
      expect(reviewer.available).toBeUndefined();
      expect(reviewer.unavailableReason).toBeUndefined();
      expect(JSON.stringify(reviewer)).not.toContain('LLM provider');
    });

    test('GET / still marks a Station-engine agent unavailable with the concrete model reason', async () => {
      const { app } = setupCatalog();
      const body = await json(await app.request('/'));
      const ghost = body.data.find((a: any) => a.slug === 'ghost');
      expect(ghost).toMatchObject({
        slug: 'ghost',
        available: false,
        unavailableReason: MANAGED_REFUSAL,
      });
    });

    // The step-3 decision, pinned: this route performs no connection lookup,
    // so it cannot honestly evaluate external readiness and therefore states
    // nothing either way — not a fabricated `available: true`, and not the
    // managed refusal. `GET /api/agents` (`enriched-agents.ts`) is the
    // authority on a missing/disabled/unready engine connection.
    test('the omission holds even when the bound engine connection does not exist', async () => {
      const { app } = setupCatalog();
      const body = await json(await app.request('/'));
      const reviewer = body.data.find((a: any) => a.slug === 'reviewer');
      // No runtime connection named 'claude-code' exists anywhere in this
      // wiring — the route never looked, and says so by saying nothing.
      expect(reviewer.available).toBeUndefined();
      expect(reviewer.unavailableReason).toBeUndefined();
      expect(reviewer.execution).toEqual({ agentConnectionId: 'claude-code' });
    });

    test('the boot aggregate derives the same external-engine treatment as GET /', async () => {
      const { app, agentService, getVoltAgent } = setupCatalog();
      const routeCatalog = (await json(await app.request('/'))).data;
      const aggregateCatalog = await deriveAgentCatalog(
        agentService as any,
        await agentService.getEnrichedAgents(await getVoltAgent().getAgents()),
        resolveAvailabilityForEmptyHome as any,
      );
      expect(aggregateCatalog).toEqual(routeCatalog);
      expect(
        aggregateCatalog.find((a: any) => a.slug === 'reviewer'),
      ).not.toHaveProperty('unavailableReason');
    });
  });

  test('POST / attaches a non-blocking warning when the new agent will not resolve a model (#chat)', async () => {
    const { agentService, skillService, reinitialize, getVoltAgent } = setup();
    agentService.createAgent.mockResolvedValue({
      slug: 'amb',
      spec: { name: 'Amb' },
    });
    const reason =
      'Multiple enabled LLM provider connections require an explicit default.';
    const resolveAvailability = vi.fn(() => reason);
    const app = createAgentRoutes(
      agentService as any,
      skillService as any,
      reinitialize as any,
      getVoltAgent,
      resolveAvailability as any,
    );

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Amb', prompt: 'x' }),
    });

    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.warnings).toEqual([
      `Agent saved but not launchable: ${reason}`,
    ]);
  });

  /**
   * station#3121. The warning above is computed by a STATION-ENGINE model
   * probe, and every test that covered it stubbed the probe — so nothing ever
   * observed what the real derivation says about a spec bound to Claude
   * Code/Codex/ACP. It says "No enabled LLM provider connection is
   * configured.", which is true and irrelevant: that Agent never wanted one.
   * The canonical "I only use Claude Code" home has zero provider connections,
   * so EVERY Agent the picker's Enable and the first-run engines chapter
   * create was warned "saved but not launchable" while `GET /agents` reported
   * that same Agent available.
   */
  describe('POST / — the create warning against the REAL availability probe', () => {
    const realResolveAvailability = (spec: unknown) =>
      resolveManagedAvailabilityReason(spec as never, {
        // A home with no LLM provider connection at all.
        appConfig: {} as never,
        listProviderConnections: () => [],
      });

    async function createWith(spec: Record<string, unknown>) {
      const { agentService, skillService, reinitialize, getVoltAgent } =
        setup();
      agentService.createAgent.mockResolvedValue({ slug: 'created', spec });
      const app = createAgentRoutes(
        agentService as any,
        skillService as any,
        reinitialize as any,
        getVoltAgent,
        realResolveAvailability as any,
      );
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Created', prompt: 'x' }),
      });
      expect(res.status).toBe(201);
      return json(res);
    }

    test('an external-engine-bound Agent is not warned about a model it never wanted', async () => {
      const spec = {
        name: 'Codex Agent',
        prompt: '',
        execution: { agentConnectionId: 'codex' },
      };
      // The discriminating half: the probe itself DOES refuse this spec, so a
      // pass here cannot come from the derivation happening to stay quiet.
      expect(realResolveAvailability(spec)).toBe(
        'No enabled LLM provider connection is configured.',
      );
      expect(await createWith(spec)).not.toHaveProperty('warnings');
    });

    test('a Station-engine Agent still gets its warning', async () => {
      const body = await createWith({ name: 'Station Agent', prompt: '' });
      expect(body.warnings).toEqual([
        'Agent saved but not launchable: No enabled LLM provider connection is configured.',
      ]);
    });
  });

  test('GET / returns 500 when voltAgent not initialized', async () => {
    const { app, getVoltAgent } = setup();
    getVoltAgent.mockReturnValue(null);
    const res = await app.request('/');
    expect(res.status).toBe(500);
  });

  test('POST / creates agent and reinitializes', async () => {
    const { app, reinitialize } = setup();
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New', prompt: 'test' }),
    });
    expect(res.status).toBe(201);
    expect(reinitialize).toHaveBeenCalled();
  });

  test('passes the persisted CRUD agent identity to narrow runtime activation', async () => {
    const { app, reinitialize } = setup();
    await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New', prompt: 'test' }),
    });
    await app.request('/writer', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Writer' }),
    });
    await app.request('/writer', { method: 'DELETE' });

    const activationOptions = reinitialize.mock.calls.map(
      (call) =>
        call[1] as
          | {
              resolveAgentSlug: (result: unknown) => string;
              activationMode: 'wait' | 'defer';
            }
          | undefined,
    );
    // Every agent mutation defers. Create briefly did not — it waited, to
    // make the tools read answer 200 immediately — which moved runtime
    // activation inside the serialized queues where a stalled activation
    // wedges every later mutation. The tools route reports "activating"
    // instead, so the durable write can return the moment it is durable.
    expect(activationOptions.map((option) => option?.activationMode)).toEqual([
      'defer',
      'defer',
      'defer',
    ]);
    expect(activationOptions[0]?.resolveAgentSlug({ slug: 'created' })).toBe(
      'created',
    );
    expect(activationOptions[1]?.resolveAgentSlug({})).toBe('writer');
    expect(activationOptions[2]?.resolveAgentSlug({})).toBe('writer');
  });

  describe('POST /materialize-engine (AC2)', () => {
    function materializeSetup() {
      const base = setup();
      base.agentService.materializeEngineAgent.mockResolvedValue({
        slug: 'claude',
        created: true,
        spec: {
          name: 'Claude Code',
          prompt: '',
          execution: { agentConnectionId: 'claude' },
          provenance: {
            origin: 'engine-detection',
            engineId: 'claude',
            detectedAt: '2026-08-20T00:00:00.000Z',
          },
        },
      });
      return base;
    }

    test('takes only an engine id and returns the resolved Agent', async () => {
      const { app, agentService } = materializeSetup();
      const res = await app.request('/materialize-engine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engineId: 'claude' }),
      });
      expect(res.status).toBe(201);
      const body = await json(res);
      expect(agentService.materializeEngineAgent).toHaveBeenCalledWith(
        'claude',
      );
      expect(body).toMatchObject({
        success: true,
        created: true,
        data: {
          slug: 'claude',
          name: 'Claude Code',
          provenance: { origin: 'engine-detection', engineId: 'claude' },
        },
      });
    });

    test('a second call is 200 and created:false, never a second row', async () => {
      const { app, agentService } = materializeSetup();
      agentService.materializeEngineAgent.mockResolvedValue({
        slug: 'claude',
        created: false,
        spec: { name: 'Claude Code' },
      });
      const res = await app.request('/materialize-engine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engineId: 'claude' }),
      });
      expect(res.status).toBe(200);
      expect((await json(res)).created).toBe(false);
    });

    test('defers activation and names the slug reconciliation must activate', async () => {
      // `resolveAgentSlug` is what lets the runtime record THIS slug as
      // awaiting reconciliation, which is what the tools route reports as
      // "activating" until it is live.
      const { app, reinitialize } = materializeSetup();
      await app.request('/materialize-engine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engineId: 'claude' }),
      });
      const options = reinitialize.mock.calls.at(-1)?.[1] as any;
      expect(options.activationMode).toBe('defer');
      expect(options.resolveAgentSlug({ slug: 'claude' })).toBe('claude');
    });

    test('an unknown engine id is refused, not minted', async () => {
      const { app, agentService } = materializeSetup();
      agentService.materializeEngineAgent.mockRejectedValue(
        new Error("No engine connection 'bogus' is registered."),
      );
      const res = await app.request('/materialize-engine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engineId: 'bogus' }),
      });
      expect(res.status).toBe(400);
      expect((await json(res)).error).toMatch(/is registered/);
    });
  });

  test('returns an explicit accepted receipt when persistence commits before activation fails', async () => {
    const { agentService, skillService, getVoltAgent } = setup();
    const reinitialize = vi.fn(async (operation: any) => {
      const activation = { status: 'applied' as 'applied' | 'pending' };
      const result = await operation(() => undefined, activation);
      activation.status = 'pending';
      Object.assign(activation, {
        reason:
          'Configuration was saved, but runtime activation is pending reconciliation.',
      });
      return result;
    });
    const app = createAgentRoutes(
      agentService as any,
      skillService as any,
      reinitialize,
      getVoltAgent,
    );

    const response = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New', prompt: 'test' }),
    });

    expect(response.status).toBe(202);
    expect(await json(response)).toMatchObject({
      success: true,
      data: { slug: 'new' },
      configurationActivation: { status: 'pending' },
    });
    expect(agentService.createAgent).toHaveBeenCalledOnce();
  });

  test('PUT /:slug updates agent', async () => {
    const { app } = setup();
    const body = await json(
      await app.request('/station', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      }),
    );
    expect(body.success).toBe(true);
  });

  test('PUT /:slug returns promptly with an honest deferred-activation receipt', async () => {
    const { agentService, skillService, getVoltAgent } = setup();
    const reinitialize = vi.fn(async (operation: any) => {
      const activation = { status: 'applied' as 'applied' | 'pending' };
      const result = await operation(() => undefined, activation);
      activation.status = 'pending';
      Object.assign(activation, {
        reason:
          'Configuration was saved, but runtime activation is pending reconciliation.',
      });
      return result;
    });
    const app = createAgentRoutes(
      agentService as any,
      skillService as any,
      reinitialize,
      getVoltAgent,
    );

    const response = await app.request('/writer', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Writer' }),
    });

    expect(response.status).toBe(202);
    expect(await json(response)).toMatchObject({
      success: true,
      configurationActivation: {
        status: 'pending',
        reason: expect.stringContaining('saved'),
      },
    });
  });

  test('PUT /:slug with project: null clears ownership; omitting project preserves it (station#1004 §4)', async () => {
    const { app, agentService } = setup();
    await app.request('/station', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated', project: null }),
    });
    expect(agentService.updateAgent).toHaveBeenCalledWith('station', {
      name: 'Updated',
      project: null,
    });

    await app.request('/station', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated Again' }),
    });
    expect(agentService.updateAgent).toHaveBeenLastCalledWith('station', {
      name: 'Updated Again',
    });
  });

  test('DELETE /:slug deletes agent', async () => {
    const { app } = setup();
    const body = await json(
      await app.request('/station', { method: 'DELETE' }),
    );
    expect(body.success).toBe(true);
  });

  test('DELETE /:slug returns 400 when agent has dependents', async () => {
    const { app, agentService } = setup();
    agentService.deleteAgent.mockResolvedValue({
      success: false,
      error: 'Referenced by layouts',
    });
    const res = await app.request('/station', { method: 'DELETE' });
    expect(res.status).toBe(400);
  });

  test('POST / rejects unknown skills with 400', async () => {
    const { app } = setup();
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Agent',
        skills: ['unknown-skill'],
      }),
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toContain('Unknown skills');
  });

  test('PUT /:slug rejects unknown skills with 400', async () => {
    const { app } = setup();
    const res = await app.request('/station', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skills: ['nonexistent'] }),
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toContain('Unknown skills');
  });

  test('PUT /:slug rejects removed prompts bindings with 400', async () => {
    const { app } = setup();
    const res = await app.request('/station', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompts: ['legacy-id'] }),
    });
    expect(res.status).toBe(400);
  });

  test('POST / allows known skills', async () => {
    const { app } = setup();
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Agent',
        skills: ['known-skill'],
      }),
    });
    expect(res.status).toBe(201);
  });

  test('reinitialize failure does not crash the route handler', async () => {
    const agentService = {
      getEnrichedAgents: vi.fn().mockResolvedValue([]),
      listAgents: vi.fn().mockResolvedValue([]),
      loadAgentSpec: vi.fn().mockResolvedValue({ name: 'Test' }),
      createAgent: vi
        .fn()
        .mockResolvedValue({ slug: 'test', spec: { name: 'Test' } }),
      deleteAgent: vi.fn().mockResolvedValue({ success: true }),
    };
    const skillService = { listSkills: vi.fn().mockReturnValue([]) };
    const reinitialize = vi.fn().mockRejectedValue(new Error('reload failed'));
    const getVoltAgent = vi
      .fn()
      .mockReturnValue({ getAgents: vi.fn().mockResolvedValue([]) });
    const app = createAgentRoutes(
      agentService as any,
      skillService as any,
      reinitialize,
      getVoltAgent,
    );

    // POST should return 400 (error bubbles) but not crash the process
    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test', prompt: 'test' }),
    });
    expect(createRes.status).toBe(400);

    // Server should still respond to GET after a failed reinitialize
    const listRes = await app.request('/');
    expect(listRes.status).toBe(200);
  });
});

/**
 * station#3662 delta-2 HIGH: the reserved Station identity's engine is app
 * state, so a write that submits one must be REFUSED, not silently stripped.
 *
 * These run against a REAL `AgentService` over a mock ConfigLoader, because
 * the claim is about the composition: the refusal lives at the service seam
 * (so REST, the SDK, the CLI and any future caller share it) and the route
 * is only responsible for giving it the right status. A mocked service would
 * test the fixture.
 */
describe('the Station Agent cannot be rebound through the API', () => {
  const STATION_SETTING = 'builtinAgentEngineConnectionId';

  function realServiceApp() {
    const configLoader = {
      listAgents: vi.fn().mockResolvedValue([]),
      loadAgent: vi.fn(async (slug: string) => ({
        name: slug,
        prompt: '',
      })),
      createAgent: vi.fn(async (spec: Record<string, unknown>) => ({
        slug: String(spec.slug ?? 'created'),
        spec,
      })),
      updateAgent: vi.fn(async (slug: string, updates: unknown) => ({
        name: slug,
        ...(updates as Record<string, unknown>),
      })),
      loadACPConfig: vi.fn().mockResolvedValue({ connections: [] }),
    };
    const agentService = new AgentService(
      configLoader as never,
      { findLayoutsUsingAgent: () => [] } as never,
      new Map(),
      new Map(),
      new Map(),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    );
    const app = createAgentRoutes(
      agentService as never,
      { listSkills: vi.fn().mockReturnValue([]) } as never,
      (async <T>(operation: (begin: () => void) => Promise<T>) =>
        operation(() => undefined)) as never,
      vi.fn().mockReturnValue({ getAgents: vi.fn().mockResolvedValue([]) }),
    );
    return { app, configLoader };
  }

  const put = (app: ReturnType<typeof realServiceApp>['app'], body: unknown) =>
    app.request('/station', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  test('PUT /station with a binding answers 409 and names where the setting lives', async () => {
    const { app, configLoader } = realServiceApp();

    const response = await put(app, {
      name: 'Station',
      execution: { agentConnectionId: 'claude' },
    });

    // 409, not 400: the request is well-formed, it names a field this
    // identity does not own. And not 200 — which is what it used to be, for a
    // write the persistence boundary then threw away.
    expect(response.status).toBe(409);
    const body = await json(response);
    expect(body.success).toBe(false);
    expect(body.error).toContain(STATION_SETTING);
    expect(body.error).toContain('Settings');
    // The refused write never reached persistence at all.
    expect(configLoader.updateAgent).not.toHaveBeenCalled();
  });

  test('POST / cannot dodge the refusal by omitting the slug', async () => {
    // `createAgentConfig` derives `station` from the name, so a create body
    // without a slug lands on the same record.
    const { app, configLoader } = realServiceApp();

    const response = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Station',
        prompt: '',
        execution: { agentConnectionId: 'claude' },
      }),
    });

    expect(response.status).toBe(409);
    expect((await json(response)).error).toContain(STATION_SETTING);
    expect(configLoader.createAgent).not.toHaveBeenCalled();
  });

  test('`execution: null` — "runs on Station\'s own engine" — is still accepted', async () => {
    const { app, configLoader } = realServiceApp();

    const response = await put(app, { name: 'Station', execution: null });

    expect(response.status).toBe(200);
    expect(configLoader.updateAgent).toHaveBeenCalledWith(
      'station',
      expect.objectContaining({ execution: null }),
    );
  });

  test('a modelId-only execution block is still accepted', async () => {
    // The refusal is scoped to the binding. Everything else on `execution` is
    // ordinary Agent state that this identity owns like any other.
    const { app, configLoader } = realServiceApp();

    const response = await put(app, {
      name: 'Station',
      execution: { modelId: 'my-pinned-model' },
    });

    expect(response.status).toBe(200);
    expect(configLoader.updateAgent).toHaveBeenCalledWith(
      'station',
      expect.objectContaining({ execution: { modelId: 'my-pinned-model' } }),
    );
  });

  test('an empty agentConnectionId is "no engine", not an attempt to bind', async () => {
    const { app } = realServiceApp();

    const response = await put(app, {
      name: 'Station',
      execution: { agentConnectionId: '' },
    });

    expect(response.status).toBe(200);
  });

  test('every other Agent still binds freely', async () => {
    // If the refusal ever widened past the reserved identity, every external
    // Agent would become unbindable through the API.
    const { app, configLoader } = realServiceApp();

    const response = await app.request('/writer', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ execution: { agentConnectionId: 'claude' } }),
    });

    expect(response.status).toBe(200);
    expect(configLoader.updateAgent).toHaveBeenCalledWith(
      'writer',
      expect.objectContaining({
        execution: { agentConnectionId: 'claude' },
      }),
    );
  });
});
