import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  agentOps: { add: vi.fn() },
}));

const { createAgentRoutes } = await import('../agents.js');

function setup(getRuntimeConnections?: any, getProjectSlugs?: any) {
  const agentService = {
    getEnrichedAgents: vi.fn().mockResolvedValue([]),
    listAgents: vi.fn().mockResolvedValue([]),
    loadAgentSpec: vi.fn().mockResolvedValue({ name: 'Default' }),
    createAgent: vi
      .fn()
      .mockResolvedValue({ slug: 'new', spec: { name: 'New' } }),
    updateAgent: vi.fn(),
    deleteAgent: vi.fn().mockResolvedValue({ success: true }),
  };
  const skillService = {
    listSkills: vi.fn().mockReturnValue([]),
  };
  const reinitialize = vi.fn(
    async <T>(operation: (beginMutation: () => void) => Promise<T>) =>
      operation(() => undefined),
  );
  const getVoltAgent = vi.fn().mockReturnValue({
    getAgents: vi.fn().mockResolvedValue([]),
  });
  const app = createAgentRoutes(
    agentService as any,
    skillService as any,
    reinitialize as any,
    getVoltAgent,
    undefined,
    getRuntimeConnections,
    getProjectSlugs,
  );
  return { app, agentService, skillService };
}

describe('Agent Routes — station#975 D-3 validation findings', () => {
  test('PUT /:slug on a codex-bound agent with authored skills returns 200 with validation.findings naming Codex', async () => {
    const getRuntimeConnections = vi.fn().mockResolvedValue([
      {
        id: 'codex',
        type: 'codex',
        engineId: 'codex',
        name: 'Codex',
        enabled: true,
        status: 'ready',
      },
    ]);
    const { app, agentService } = setup(getRuntimeConnections);
    agentService.updateAgent.mockResolvedValue({
      name: 'Codex Agent',
      skills: ['writing'],
      execution: { agentConnectionId: 'codex' },
    });

    const res = await app.request('/codex-agent', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Codex Agent' }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.success).toBe(true);
    expect(body.validation.findings).toEqual([
      {
        capability: 'skills',
        engineId: 'codex',
        message: "Codex can't receive skills from Station",
      },
    ]);
  });

  test('a Station-agent save using a Bedrock model connection omits validation', async () => {
    // Bedrock is a Model connection. Station owns this agent's prompt and
    // skills, so its runtime lookup contains external engines only.
    const getRuntimeConnections = vi.fn().mockResolvedValue([]);
    const { app, agentService } = setup(getRuntimeConnections);
    agentService.updateAgent.mockResolvedValue({
      name: 'Managed Agent',
      prompt: 'You are helpful.',
      skills: ['writing'],
      execution: { modelConnectionId: 'bedrock-runtime' },
    });

    const res = await app.request('/managed-agent', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Managed Agent' }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.validation).toBeUndefined();
  });

  test('a matched runtime connection without canonical engine identity degrades validation', async () => {
    const getRuntimeConnections = vi.fn().mockResolvedValue([
      {
        id: 'codex',
        type: 'codex',
        name: 'Codex',
        enabled: true,
        status: 'ready',
      },
    ]);
    const { app, agentService } = setup(getRuntimeConnections);
    agentService.updateAgent.mockResolvedValue({
      name: 'Codex Agent',
      skills: ['writing'],
      execution: { agentConnectionId: 'codex' },
    });

    const res = await app.request('/codex-agent', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Codex Agent' }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.success).toBe(true);
    expect(body.validation).toEqual({ findings: [], degraded: true });
  });

  test('a canonical unknown external engine keeps conservative findings and its display name', async () => {
    const getRuntimeConnections = vi.fn().mockResolvedValue([
      {
        id: 'custom-engine',
        type: 'custom-runtime',
        engineId: 'mystery',
        name: 'My Engine',
        enabled: true,
        status: 'ready',
      },
    ]);
    const { app, agentService } = setup(getRuntimeConnections);
    agentService.updateAgent.mockResolvedValue({
      name: 'Custom Agent',
      prompt: 'You are helpful.',
      skills: ['writing'],
      execution: { agentConnectionId: 'custom-engine' },
    });

    const res = await app.request('/custom-agent', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Custom Agent' }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.validation.findings).toEqual([
      {
        capability: 'prompt',
        engineId: 'unknown',
        message: "My Engine can't receive a system prompt from Station",
      },
      {
        capability: 'skills',
        engineId: 'unknown',
        message: "My Engine can't receive skills from Station",
      },
    ]);
  });

  test('a runtime-connection fetch failure marks the response degraded, never a 500', async () => {
    const getRuntimeConnections = vi
      .fn()
      .mockRejectedValue(new Error('connection service unavailable'));
    const { app, agentService } = setup(getRuntimeConnections);
    agentService.updateAgent.mockResolvedValue({
      name: 'Codex Agent',
      skills: ['writing'],
      execution: { agentConnectionId: 'codex' },
    });

    const res = await app.request('/codex-agent', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Codex Agent' }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.success).toBe(true);
    expect(body.validation).toEqual({ findings: [], degraded: true });
  });

  test('a timed-out discovery marks the response degraded', async () => {
    const getRuntimeConnections = vi.fn(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve([]), 10_000);
        }),
    ) as any;
    const { app, agentService } = setup(getRuntimeConnections);
    agentService.updateAgent.mockResolvedValue({
      name: 'Codex Agent',
      skills: ['writing'],
      execution: { agentConnectionId: 'codex' },
    });

    const start = Date.now();
    const res = await app.request('/codex-agent', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Codex Agent' }),
    });
    const elapsedMs = Date.now() - start;
    expect(res.status).toBe(200);
    expect(elapsedMs).toBeLessThan(5_000);
    const body = await json(res);
    expect(body.success).toBe(true);
    expect(body.validation).toEqual({ findings: [], degraded: true });
  });

  test('concurrent saves share one connection discovery invocation', async () => {
    let resolveFetch: (value: unknown[]) => void = () => {};
    const getRuntimeConnections = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    ) as any;
    const { app, agentService } = setup(getRuntimeConnections);
    agentService.updateAgent.mockResolvedValue({
      name: 'Codex Agent',
      skills: ['writing'],
      execution: { agentConnectionId: 'codex' },
    });

    const request = () =>
      app.request('/codex-agent', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Codex Agent' }),
      });

    // Two saves fired before the underlying discovery call settles. Each
    // request handler runs through several awaits (skill validation, the
    // mutation, `agentService.updateAgent`) before it reaches
    // `computeValidationOutcome`, so wait for the first invocation to
    // actually land before firing the second and asserting no second one
    // followed it.
    const first = request();
    await vi.waitFor(() =>
      expect(getRuntimeConnections).toHaveBeenCalledTimes(1),
    );
    const second = request();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getRuntimeConnections).toHaveBeenCalledTimes(1);

    resolveFetch([
      {
        id: 'codex',
        type: 'codex',
        engineId: 'codex',
        name: 'Codex',
        enabled: true,
        status: 'ready',
      },
    ]);

    const [res1, res2] = await Promise.all([first, second]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(getRuntimeConnections).toHaveBeenCalledTimes(1);

    // Once settled, the NEXT save starts a fresh fetch rather than reusing
    // a permanently-cached result.
    const third = request();
    await vi.waitFor(() =>
      expect(getRuntimeConnections).toHaveBeenCalledTimes(2),
    );
    resolveFetch([]);
    await third;
  });

  test('POST / also attaches validation.findings when the created agent authors an undeliverable capability', async () => {
    const getRuntimeConnections = vi.fn().mockResolvedValue([
      {
        id: 'codex',
        type: 'codex',
        engineId: 'codex',
        name: 'Codex',
        enabled: true,
        status: 'ready',
      },
    ]);
    const { app, agentService } = setup(getRuntimeConnections);
    // archive#1195: codex's toolServers cell flipped from unsupported to
    // session/wire (Codex can now receive tool servers), so `tools:
    // {mcpServers: [...]}` no longer produces an undeliverable finding for
    // codex — this fixture now authors `skills` instead, which codex's
    // matrix still marks unsupported, to keep proving the SAME thing this
    // test is actually about: an authored-but-undeliverable capability
    // attaches a validation.findings entry on POST /, not just PUT /:slug.
    agentService.createAgent.mockResolvedValue({
      slug: 'codex-agent',
      spec: {
        name: 'Codex Agent',
        skills: ['writing'],
        execution: { agentConnectionId: 'codex' },
      },
    });

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Codex Agent', slug: 'codex-agent' }),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.validation.findings).toEqual([
      {
        capability: 'skills',
        engineId: 'codex',
        message: "Codex can't receive skills from Station",
      },
    ]);
  });

  describe('project ownership findings (station#1004 §1 A1, unification slice 7)', () => {
    test('PUT save response carries the ownership finding for an A1-preserved orphan', async () => {
      const getProjectSlugs = vi.fn().mockResolvedValue(['real-project']);
      const { app, agentService } = setup(undefined, getProjectSlugs);
      agentService.updateAgent.mockResolvedValue({
        name: 'Orphaned Agent',
        project: 'ghost-project',
      });

      const res = await app.request('/orphaned-agent', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Orphaned Agent' }),
      });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.validation.findings).toEqual([
        {
          code: 'unknown_owner_project',
          project: 'ghost-project',
          message:
            "This agent's owning project 'ghost-project' no longer exists.",
        },
      ]);
    });

    test('POST save response carries the ownership finding when the created agent already names a nonexistent project', async () => {
      const getProjectSlugs = vi.fn().mockResolvedValue([]);
      const { app, agentService } = setup(undefined, getProjectSlugs);
      agentService.createAgent.mockResolvedValue({
        slug: 'orphaned-agent',
        spec: { name: 'Orphaned Agent', project: 'ghost-project' },
      });

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Orphaned Agent',
          slug: 'orphaned-agent',
        }),
      });
      expect(res.status).toBe(201);
      const body = await json(res);
      expect(body.validation.findings).toEqual([
        {
          code: 'unknown_owner_project',
          project: 'ghost-project',
          message:
            "This agent's owning project 'ghost-project' no longer exists.",
        },
      ]);
    });

    test('a clean save owned by a real project omits validation entirely', async () => {
      const getProjectSlugs = vi.fn().mockResolvedValue(['real-project']);
      const { app, agentService } = setup(undefined, getProjectSlugs);
      agentService.updateAgent.mockResolvedValue({
        name: 'Owned Agent',
        project: 'real-project',
      });

      const res = await app.request('/owned-agent', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Owned Agent' }),
      });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.validation).toBeUndefined();
    });

    test('a project-slugs fetch failure omits the ownership finding, never a 500', async () => {
      const getProjectSlugs = vi
        .fn()
        .mockRejectedValue(new Error('project listing unavailable'));
      const { app, agentService } = setup(undefined, getProjectSlugs);
      agentService.updateAgent.mockResolvedValue({
        name: 'Orphaned Agent',
        project: 'ghost-project',
      });

      const res = await app.request('/orphaned-agent', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Orphaned Agent' }),
      });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.success).toBe(true);
      expect(body.validation).toBeUndefined();
    });
  });
});
