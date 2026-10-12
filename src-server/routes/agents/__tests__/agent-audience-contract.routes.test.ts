/**
 * #3276 R1: the Agent audience declaration at the server boundary.
 *
 * Real pieces: `createAgentRoutes` over a real `AgentService` and
 * `ConfigLoader` writing a real Station home, so the refusal is the one every
 * Agent write and read applies (`validator.validateAgentSpec`), not a helper.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_AUDIENCE_VERSION } from '@kontourai/station-contracts/agent';
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { effectiveAgentAudience } from '../../../services/agents/agent-audience.js';
import { AgentService } from '../../../services/agents/agent-service.js';
import { createAgentRoutes } from '../agents.js';

const makeTempDir = trackTempDirs();

function fixture() {
  const home = makeTempDir('station-agent-audience-');
  // An Agent may only be owned by a Project that exists (`owningProjectExists`).
  mkdirSync(join(home, 'projects', 'clients'), { recursive: true });
  writeFileSync(
    join(home, 'projects', 'clients', 'project.json'),
    JSON.stringify({ name: 'Clients', slug: 'clients' }),
  );
  const configLoader = new ConfigLoader({ projectHomeDir: home });
  const agentService = new AgentService(
    configLoader,
    { findLayoutsUsingAgent: () => [] } as never,
    new Map(),
    new Map(),
    new Map(),
    { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  );
  const app = new Hono();
  app.route(
    '/api/agents',
    createAgentRoutes(
      agentService,
      { listSkills: () => [] } as never,
      (async (operation: (begin: () => void) => Promise<unknown>) =>
        operation(() => undefined)) as never,
      () => undefined,
    ),
  );
  const create = async (body: Record<string, unknown>) => {
    const res = await app.request('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Concierge', prompt: 'Help.', ...body }),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { home, configLoader, create };
}

describe('Agent audience at the server boundary (#3276 R1)', () => {
  test('a member audience on a Project-owned Agent is persisted as declared', async () => {
    const { configLoader, create } = fixture();
    const audience = {
      version: AGENT_AUDIENCE_VERSION,
      kind: 'project-permission',
      permission: 'discuss',
    };
    const created = await create({
      slug: 'concierge',
      project: 'clients',
      audience,
    });
    expect(created.status).toBe(201);
    expect((await configLoader.loadAgent('concierge')).audience).toEqual(
      audience,
    );
    const roles = await create({
      slug: 'triage',
      project: 'clients',
      audience: {
        version: AGENT_AUDIENCE_VERSION,
        kind: 'project-roles',
        roles: ['viewer', 'contributor'],
      },
    });
    expect(roles.status).toBe(201);
  });

  test.each([
    [
      'an unknown version',
      { version: 'station.agent-audience/v2', kind: 'operator' },
      "audience.version must be 'station.agent-audience/v1'",
    ],
    [
      'an unknown kind',
      { version: AGENT_AUDIENCE_VERSION, kind: 'everyone' },
      'audience.kind must be one of',
    ],
    [
      'an unknown permission',
      {
        version: AGENT_AUDIENCE_VERSION,
        kind: 'project-permission',
        permission: 'chat',
      },
      'audience.permission must be one of',
    ],
    [
      'an empty role set',
      { version: AGENT_AUDIENCE_VERSION, kind: 'project-roles', roles: [] },
      'audience.roles must be a non-empty list',
    ],
    [
      'an unknown role',
      {
        version: AGENT_AUDIENCE_VERSION,
        kind: 'project-roles',
        roles: ['guest'],
      },
      'audience.roles must contain only',
    ],
    [
      'an extra key',
      {
        version: AGENT_AUDIENCE_VERSION,
        kind: 'operator',
        permission: 'view',
      },
      "audience.permission is not allowed for kind 'operator'",
    ],
  ])(
    'refuses %s with its reason and writes nothing',
    async (_label, audience, reason) => {
      const { configLoader, create } = fixture();
      const refused = await create({
        slug: 'concierge',
        project: 'clients',
        audience,
      });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toContain(reason);
      await expect(configLoader.loadAgent('concierge')).rejects.toThrow();
    },
  );

  test('refuses a member audience on a global Agent: membership is per Project', async () => {
    const { configLoader, create } = fixture();
    const refused = await create({
      slug: 'concierge',
      audience: {
        version: AGENT_AUDIENCE_VERSION,
        kind: 'project-permission',
        permission: 'view',
      },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain(
      'the Agent must name its owning project',
    );
    await expect(configLoader.loadAgent('concierge')).rejects.toThrow();
  });

  test('an existing agent.json with no audience still loads and reads as operator-only', async () => {
    const { home, configLoader } = fixture();
    // The exact shape an Agent written before #3276 has on disk.
    const dir = join(home, 'agents', 'legacy');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'agent.json'),
      JSON.stringify({ name: 'Legacy', prompt: 'Old.', project: 'clients' }),
    );
    const spec = await configLoader.loadAgent('legacy');
    expect(spec.audience).toBeUndefined();
    expect(effectiveAgentAudience(spec.audience)).toEqual({
      version: AGENT_AUDIENCE_VERSION,
      kind: 'operator',
    });
    const listed = (await configLoader.listAgents()).find(
      (agent) => agent.slug === 'legacy',
    );
    expect(listed).toBeDefined();
    expect(listed?.audience).toBeUndefined();
  });
});
