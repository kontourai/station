import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type { ToolLibrarySource } from '@kontourai/station-contracts/tool-library';
import { describe, expect, test, vi } from 'vitest';
import { readJson } from '../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { createStagedPreToolPolicyEvaluator } from '../../runtime/agents/pre-tool-policy.js';
import {
  ToolLibraryRefusal,
  ToolLibraryService,
} from '../../services/plugins/tool-library-service.js';
import {
  createToolLibraryRoutes,
  type ToolLibraryActor,
} from '../tool-library.js';

const temp = trackTempDirs();
function setup() {
  const home = temp('shared-tools-');
  const service = new ToolLibraryService(home);
  let role: 'operator' | 'admin' | 'viewer' = 'admin';
  let projectId = 'project-original';
  const source: ToolLibrarySource = {
    id: 'reports',
    kind: 'integration',
    name: 'Reports',
    from: 'Team catalog',
    origin: { kind: 'registry', registryId: 'team' },
    installed: false,
    enabled: false,
    permitted: true,
    operatorOnly: false,
    tools: [],
  };
  const stored = new Map<string, AgentSpec>();
  const actor = async (
    _c: unknown,
    slug?: string,
  ): Promise<ToolLibraryActor> => ({
    access: {
      principalId: role === 'operator' ? 'operator' : 'alice',
      name: role === 'operator' ? 'Operator' : 'Alice',
      station: {
        name: 'Test Station',
        operator: role === 'operator',
        canInstallTools: role === 'operator',
      },
      projects: [],
    },
    project: slug ? { id: projectId, slug, name: 'Design' } : undefined,
    canManageAgents: role !== 'viewer',
    canManagePolicy: role === 'operator',
  });
  const install = vi.fn(async () => {
    source.installed = true;
    source.enabled = true;
  });
  const saveAgent = vi.fn(
    async (
      slug: string | undefined,
      draft: {
        name: string;
        prompt: string;
        tools: NonNullable<AgentSpec['tools']>;
      },
      project: { id: string; slug: string },
      authorize: () => Promise<void>,
    ) => {
      await authorize();
      const saved = slug ?? 'new-agent';
      stored.set(saved, { ...draft, project: project.slug });
      return saved;
    },
  );
  const app = createToolLibraryRoutes({
    service,
    actor,
    withinProject: async (_c, _actor, fn) => fn(),
    sources: async () => [structuredClone(source)],
    install,
    listAgents: async () =>
      [...stored].map(([slug, spec]) => ({ slug, project: spec.project })),
    getAgent: async (slug) => stored.get(slug)!,
    saveAgent,
    changed: async () => {},
  });
  const request = (path: string, body?: unknown, method = 'POST') =>
    app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const propose = () =>
    request('/requests', {
      sourceId: 'reports',
      kind: 'integration',
      project: 'design',
      projectId,
      expectedActor: 'alice',
    });
  return {
    home,
    service,
    source,
    stored,
    install,
    saveAgent,
    app,
    request,
    propose,
    setRole: (next: typeof role) => {
      role = next;
    },
    replaceProject: () => {
      projectId = 'replacement';
    },
  };
}
async function data(response: Response) {
  return (await readJson(response)).data;
}
describe('Project tool acquisition and authoring', () => {
  test('admin requests are durable, scoped and deduplicated; they never install code', async () => {
    const h = setup();
    const first = await data(await h.propose());
    const second = await data(await h.propose());
    expect(first).toMatchObject({
      requesterId: 'alice',
      projectId: 'project-original',
      status: 'pending',
      registryId: 'team',
    });
    expect(second.id).toBe(first.id);
    expect(h.install).not.toHaveBeenCalled();
    expect(new ToolLibraryService(h.home).requests()).toHaveLength(1);
    h.setRole('viewer');
    expect((await h.propose()).status).toBe(403);
    expect(h.service.requests()).toHaveLength(1);
  });
  test('operator approval installs and admits the source, and a retry cannot undo a decline', async () => {
    const h = setup();
    const request = await data(await h.propose());
    expect(
      (
        await h.request(`/requests/${request.id}/approve`, {
          expectedActor: 'alice',
        })
      ).status,
    ).toBe(403);
    h.setRole('operator');
    expect(
      await data(
        await h.request(`/requests/${request.id}/approve`, {
          expectedActor: 'operator',
        }),
      ),
    ).toMatchObject({ status: 'available' });
    expect(h.install).toHaveBeenCalledOnce();
    expect(h.service.allows('project-original', 'reports')).toBe(true);
    expect(
      (
        await h.request(`/requests/${request.id}/decline`, {
          expectedActor: 'operator',
        })
      ).status,
    ).toBe(409);
  });
  test('an install failure stays failed after restart and does not grant Project use', async () => {
    const h = setup();
    const request = await data(await h.propose());
    h.setRole('operator');
    await h.service.setPolicy(
      'project-original',
      { mode: 'selected', sources: ['reports'] },
      1,
      async () => {},
    );
    h.install.mockImplementationOnce(async () => {
      throw new ToolLibraryRefusal('unavailable', 'Installation failed.');
    });
    expect(
      (
        await h.request(`/requests/${request.id}/approve`, {
          expectedActor: 'operator',
        })
      ).status,
    ).toBe(503);
    expect(new ToolLibraryService(h.home).requests()[0]?.status).toBe('failed');
    expect(h.source.installed).toBe(false);
  });
  test('setup completion requires the installed and enabled exact source', async () => {
    const h = setup();
    const request = await data(await h.propose());
    h.setRole('operator');
    expect(
      (
        await data(
          await h.request(`/requests/${request.id}/complete`, {
            expectedActor: 'operator',
          }),
        )
      ).status,
    ).toBe('pending');
    h.source.installed = true;
    h.source.enabled = true;
    h.source.origin = { kind: 'registry', registryId: 'other' };
    expect(
      (
        await h.request(`/requests/${request.id}/complete`, {
          expectedActor: 'operator',
        })
      ).status,
    ).toBe(409);
    expect(h.service.requests()[0]?.status).toBe('pending');
  });
  test('same-slug Project replacement and caller swaps cannot approve old requests', async () => {
    const h = setup();
    const request = await data(await h.propose());
    h.setRole('operator');
    h.replaceProject();
    expect(
      (
        await h.request(`/requests/${request.id}/approve`, {
          expectedActor: 'operator',
        })
      ).status,
    ).toBe(409);
    expect(h.install).not.toHaveBeenCalled();
    expect(
      (
        await h.request('/add', {
          id: 'reports',
          kind: 'integration',
          expectedActor: 'alice',
        })
      ).status,
    ).toBe(409);
  });
  test('installation approval cannot widen an Owner policy, and obsolete requests can be declined', async () => {
    const h = setup();
    const request = await data(await h.propose());
    await h.service.setPolicy(
      'project-original',
      { mode: 'selected', sources: [] },
      1,
      async () => {},
    );
    expect((await h.propose()).status).toBe(403);
    h.setRole('operator');
    expect(
      (
        await h.request(`/requests/${request.id}/approve`, {
          expectedActor: 'operator',
        })
      ).status,
    ).toBe(403);
    expect(h.service.policy('project-original').sources).toEqual([]);
    h.replaceProject();
    expect(
      (
        await h.request(`/requests/${request.id}/decline`, {
          expectedActor: 'operator',
        })
      ).status,
    ).toBe(200);
    expect(h.service.requests()[0]?.status).toBe('declined');
  });
  test('sources needing setup stay pending until setup completes after restart', async () => {
    const h = setup();
    const request = await data(await h.propose());
    h.setRole('operator');
    h.install.mockImplementationOnce(async () => {
      h.source.installed = true;
    });
    expect(
      await data(
        await h.request(`/requests/${request.id}/approve`, {
          expectedActor: 'operator',
        }),
      ),
    ).toMatchObject({ status: 'setting-up' });
    expect(new ToolLibraryService(h.home).requests()[0]?.status).toBe(
      'setting-up',
    );
    h.source.enabled = true;
    expect(
      await data(
        await h.request(`/requests/${request.id}/complete`, {
          expectedActor: 'operator',
        }),
      ),
    ).toMatchObject({ status: 'available' });
  });
  test('Project policy caps agent selections and caller input cannot create Station configuration', async () => {
    const h = setup();
    h.source.installed = true;
    h.source.enabled = true;
    await h.service.setPolicy(
      'project-original',
      { mode: 'selected', sources: [] },
      1,
      async () => {},
    );
    const body = {
      expectedActor: 'alice',
      projectId: 'project-original',
      draft: {
        name: 'Analyst',
        prompt: 'Read reports',
        engineId: 'claude',
        tools: { mcpServers: ['reports'], available: ['reports_read'] },
      },
    };
    expect((await h.request('/projects/design/agents', body)).status).toBe(403);
    await h.service.setPolicy(
      'project-original',
      { mode: 'all', sources: [] },
      2,
      async () => {},
    );
    const created = await data(
      await h.request('/projects/design/agents', body),
    );
    expect(h.service.agentBinding(created.slug)).toEqual({
      projectId: 'project-original',
      projectSlug: 'design',
    });
    expect(h.stored.get(created.slug)?.project).toBe('design');
    expect(
      (
        await h.request('/projects/design/agents', {
          ...body,
          draft: { ...body.draft, command: 'sh' },
        })
      ).status,
    ).toBe(400);
    expect(
      (await h.request('/projects/design/agents/station', body, 'PUT')).status,
    ).toBe(403);
    h.replaceProject();
    expect(
      (
        await h.request(
          `/projects/design/agents/${created.slug}`,
          { ...body, projectId: 'replacement' },
          'PUT',
        )
      ).status,
    ).toBe(403);
  });
  test('Project policy revocation blocks a granted tool on the actual pre-tool decision path', async () => {
    const h = setup();
    const spec: AgentSpec = {
      name: 'Global analyst',
      prompt: '',
      tools: { mcpServers: ['reports'] },
    };
    const evaluate = createStagedPreToolPolicyEvaluator({
      spec,
      toolNameMapping: new Map(),
      isGranted: () => true,
      projectToolPolicy: () =>
        h.service.assertAgent('global', spec, 'project-original'),
      logger: { info() {}, warn() {} },
    });
    const tool = {
      toolName: 'reports_read',
      toolCallId: 'read-one',
      toolArgs: {},
    };
    expect(
      await evaluate(tool, { agentSlug: 'global' }, { interaction: 'managed' }),
    ).toEqual({ behavior: 'allow', toolGrant: true });
    await h.service.setPolicy(
      'project-original',
      { mode: 'selected', sources: [] },
      1,
      async () => {},
    );
    expect(
      await evaluate(tool, { agentSlug: 'global' }, { interaction: 'managed' }),
    ).toMatchObject({ behavior: 'deny' });
    expect(() =>
      h.service.assertAgent(
        'station',
        {
          name: 'Station',
          prompt: '',
          tools: { mcpServers: ['station-control'] },
        },
        'project-original',
      ),
    ).not.toThrow();
  });
  test('a permitted plugin admits its actual servers without changing Owner policy and respects later withdrawal', async () => {
    const h = setup();
    const request = await h.service.request(
      {
        projectId: 'project-original',
        projectSlug: 'design',
        projectName: 'Design',
        requesterId: 'alice',
        requesterName: 'Alice',
        sourceId: 'reports-plugin',
        sourceKind: 'plugin',
        sourceName: 'Reports plugin',
        registryId: 'team',
      },
      async () => {},
    );
    await h.service.setPolicy(
      'project-original',
      { mode: 'selected', sources: ['reports-plugin'] },
      1,
      async () => {},
    );
    const source: ToolLibrarySource = {
      ...h.source,
      id: 'reports-plugin',
      kind: 'plugin',
      installed: true,
      enabled: true,
      serverIds: ['reports'],
    };
    await h.service.admitRequest(request.id, source, async () => {});
    expect(h.service.allows('project-original', 'reports')).toBe(true);
    expect(h.service.policy('project-original').sources).toEqual([
      'reports-plugin',
    ]);
    await h.service.setShared('reports-plugin', false, async () => {});
    expect(h.service.allows('project-original', 'reports')).toBe(false);
    await expect(
      h.service.admitRequest(request.id, source, async () => {}),
    ).rejects.toThrow('no longer shared');
  });
  test('revoked policy rejects both explicit and inherited tools on the execution path', async () => {
    const h = setup();
    await h.service.bindAgent(
      'analyst',
      'project-original',
      'design',
      async () => {},
    );
    const spec: AgentSpec = {
      name: 'Analyst',
      prompt: '',
      project: 'design',
      tools: { mcpServers: ['reports'] },
    };
    expect(() =>
      h.service.assertAgent('analyst', spec, 'project-original'),
    ).not.toThrow();
    await h.service.setPolicy(
      'project-original',
      { mode: 'selected', sources: [] },
      1,
      async () => {},
    );
    for (const slug of ['analyst', 'existing-agent']) {
      expect(() =>
        h.service.assertAgent(slug, spec, 'project-original'),
      ).toThrow('does not allow');
    }
    expect(() =>
      h.service.assertAgent(
        'analyst',
        { ...spec, tools: { mcpServers: [] } },
        'project-original',
        ['reports'],
      ),
    ).toThrow('does not allow');
    expect(() => h.service.assertAgent('analyst', spec, 'replacement')).toThrow(
      'incarnation',
    );
  });
});
