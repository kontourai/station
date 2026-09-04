import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKSPACE_BASIS_PANE_DESCRIPTOR } from '@kontourai/station-basis-pane/workspace-basis-pane';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import { agentOwnershipFinding } from '@kontourai/station-contracts/project-reference-integrity';
import { WORKSPACE_CHAT_PANE_DESCRIPTOR_ID } from '@kontourai/station-contracts/workspace-chat-pane';
import {
  WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR_ID,
  WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR_ID,
  WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR_ID,
} from '@kontourai/station-contracts/workspace-coding-panels';
import {
  WORKSPACE_PLAN_PANE_DESCRIPTOR,
  WORKSPACE_PLAN_PANE_INSTANCE_ID,
  WORKSPACE_PLAN_PANE_SOURCE_ID,
  WORKSPACE_READINESS_PANE_DESCRIPTOR,
  WORKSPACE_READINESS_PANE_INSTANCE_ID,
  WORKSPACE_READINESS_PANE_SOURCE_ID,
  WORKSPACE_TRUST_PANE_DESCRIPTOR,
  WORKSPACE_TRUST_PANE_INSTANCE_ID,
  WORKSPACE_TRUST_PANE_SOURCE_ID,
} from '@kontourai/station-contracts/workspace-evidence-panels';
import { resolveWorkspacePaneAvailability } from '@kontourai/station-contracts/workspace-pane-availability';
import { WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR_ID } from '@kontourai/station-contracts/workspace-spatial-board';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import {
  loadAgentConfig,
  saveAgentConfig,
} from '../../../domain/config-loader-agents.js';

const projectOps = { add: vi.fn() };
const projectPaneCatalogDuration = { record: vi.fn() };
const workspacePaneAvailabilityResolutions = { add: vi.fn() };
const routesLogger = { error: vi.fn() };
/** Fixed Project panes that are auto-INSTANTIATED into every layout. */
const FIXED_PROJECT_PANE_DESCRIPTOR_IDS = [
  WORKSPACE_CHAT_PANE_DESCRIPTOR_ID,
  WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR_ID,
];

/**
 * Fixed Project panes the route DECLARES. The Basis pane joined these
 * (`pane:builtin:basis`) but is not auto-instantiated, so the descriptor and
 * instance populations genuinely differ — a single shared constant made the
 * descriptor count right and the instance count wrong (archive#4292). Named
 * by identity rather than folded into a bare count, so each assertion still
 * says WHICH panes it expects.
 */
const FIXED_PROJECT_PANE_DESCRIPTOR_IDS_DECLARED = [
  ...FIXED_PROJECT_PANE_DESCRIPTOR_IDS,
  WORKSPACE_BASIS_PANE_DESCRIPTOR.id,
];

vi.mock('../../../utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    createLogger: (options: { name?: string }) =>
      options?.name === 'projects-routes'
        ? routesLogger
        : (actual as { createLogger: (o: unknown) => unknown }).createLogger(
            options,
          ),
  };
});

// Passes through to the real filesystem unless a test arms one rejection. Only
// EACCES needs it: a chmod-000 directory does not deny a root test runner, and
// the other icon-candidate failures are drivable for real.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, realpath: vi.fn(actual.realpath) };
});

vi.mock('../../../telemetry/metrics.js', () => ({
  projectOps,
  projectPaneCatalogDuration,
  workspacePaneAvailabilityResolutions,
  // archive#1502 — an instrument missing from this factory is
  // `undefined` at call time, so the route throws inside its own try/catch and
  // every assertion below reads a 500 instead of the behavior under test.
  projectBindingOperations: { add: vi.fn() },
  projectResolutionRouteRequests: { add: vi.fn() },
  // Reached transitively: the resolver instruments its own outcomes, and the
  // resolution route is the first thing in this file to call it.
  projectResourceResolutions: { add: vi.fn() },
  projectManifestBackfills: { add: vi.fn() },
}));

const { realpath } = await import('node:fs/promises');
const { createProjectRoutes } = await import('../projects.js');
const { ProjectService } = await import(
  '../../../services/projects/project-service.js'
);
const { FileStorageAdapter } = await import(
  '../../../domain/file-storage-adapter.js'
);
const {
  FileStorageAlreadyExistsError,
  FileStorageConflictError,
  FileStorageNotFoundError,
  FileStorageUnavailableError,
} = await import('../../../domain/project-file-transactions.js');
const { putProject } = await import(
  '../../../domain/__tests__/file-storage-test-helpers.js'
);
const { ProjectBindingsStore } = await import(
  '../../../services/projects/project-binding-store.js'
);
const { ProjectManifestStore, projectManifestPath } = await import(
  '../../../services/projects/project-manifest-store.js'
);
const { ProjectResourceResolver } = await import(
  '../../../services/projects/project-resource-resolver.js'
);

function createMockProjectService() {
  const projects = new Map<string, any>();
  return {
    listProjects: vi.fn(async () =>
      [...projects.values()].map((p) => ({ slug: p.slug, name: p.name })),
    ),
    getProject: vi.fn(async (slug: string) => {
      const p = projects.get(slug);
      if (!p) throw new FileStorageNotFoundError(`Project '${slug}' not found`);
      return p;
    }),
    createProject: vi.fn(async (body: any) => {
      const p = {
        id: 'id-1',
        slug: body.slug || 'test',
        ...body,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      projects.set(p.slug, p);
      return p;
    }),
    updateProject: vi.fn(async (slug: string, updates: any) => {
      const p = projects.get(slug);
      if (!p) throw new Error('Not found');
      Object.assign(p, updates);
      return p;
    }),
    deleteProject: vi.fn(async (slug: string) => {
      projects.delete(slug);
    }),
    reorderProjects: vi.fn(async (order: string[]) => {
      const unknown = order.find((slug) => !projects.has(slug));
      if (unknown) throw new Error(`Unknown project slug '${unknown}'`);
      return order.map((slug) => projects.get(slug));
    }),
  };
}

function createMockStorageAdapter(projectSlugs: string[] = ['test']) {
  const layouts = new Map<string, any>();
  const createLayout = vi.fn((_projectSlug: string, layout: any) => {
    if (layouts.has(layout.slug)) {
      throw new FileStorageConflictError(
        `Layout '${layout.slug}' already exists`,
      );
    }
    layouts.set(layout.slug, layout);
  });
  const getProject = vi.fn((_slug?: string) => ({
    id: 'test',
    slug: 'test',
    name: 'Test',
    workingDirectory: '/tmp',
    agents: ['alpha'],
  }));
  return {
    listLayouts: vi.fn((_slug: string) => [...layouts.values()]),
    getLayout: vi.fn(
      (_slug: string, layoutSlug: string) =>
        layouts.get(layoutSlug) || {
          slug: layoutSlug,
          type: 'chat',
          config: {},
        },
    ),
    saveLayout: vi.fn((_slug: string, layout: any) =>
      layouts.set(layout.slug, layout),
    ),
    layoutRevision: vi.fn((_projectSlug: string, layoutSlug: string) => {
      const value =
        layouts.get(layoutSlug) ||
        ({ slug: layoutSlug, type: 'chat', config: {} } as any);
      return {
        value,
        replace: vi.fn((next: any) => {
          layouts.set(next.slug, next);
          return next;
        }),
        remove: vi.fn(() => {
          layouts.delete(layoutSlug);
        }),
        createLayout: vi.fn((nextLayoutSlug: string, layout: any) => {
          if (nextLayoutSlug !== layout.slug) {
            throw new Error('layout identity mismatch');
          }
          return createLayout(_projectSlug, layout);
        }),
      };
    }),
    createLayout,
    deleteLayout: vi.fn((_slug: string, layoutSlug: string) =>
      layouts.delete(layoutSlug),
    ),
    getProject,
    listProjects: vi.fn(() => [...projectSlugs].map((slug) => ({ slug }))),
    projectRevision: vi.fn((projectSlug: string) => ({
      value: getProject(projectSlug),
      replace: vi.fn(),
      remove: vi.fn(),
      createLayout: vi.fn((layoutSlug: string, layout: any) => {
        if (layoutSlug !== layout.slug)
          throw new Error('layout identity mismatch');
        return createLayout(projectSlug, layout);
      }),
    })),
  };
}

function nestedInitialArguments(depth: number): Record<string, unknown> {
  let initialArguments: Record<string, unknown> = { value: 'leaf' };
  for (let index = 0; index < depth; index += 1) {
    initialArguments = { nested: initialArguments };
  }
  return initialArguments;
}

function expectProjectEvidencePaneInstances(
  instances: readonly Record<string, any>[],
  projectId: string,
) {
  expect(instances).toEqual(
    expect.arrayContaining([
      {
        version: '1.0',
        descriptorId: WORKSPACE_PLAN_PANE_DESCRIPTOR.id,
        instanceId: WORKSPACE_PLAN_PANE_INSTANCE_ID,
        stateKey: WORKSPACE_PLAN_PANE_INSTANCE_ID,
        boundContext: {
          projectId,
          workspaceId: projectId,
          sourceId: WORKSPACE_PLAN_PANE_SOURCE_ID,
        },
      },
      {
        version: '1.0',
        descriptorId: WORKSPACE_READINESS_PANE_DESCRIPTOR.id,
        instanceId: WORKSPACE_READINESS_PANE_INSTANCE_ID,
        stateKey: WORKSPACE_READINESS_PANE_INSTANCE_ID,
        boundContext: {
          projectId,
          workspaceId: projectId,
          sourceId: WORKSPACE_READINESS_PANE_SOURCE_ID,
        },
      },
      {
        version: '1.0',
        descriptorId: WORKSPACE_TRUST_PANE_DESCRIPTOR.id,
        instanceId: WORKSPACE_TRUST_PANE_INSTANCE_ID,
        stateKey: WORKSPACE_TRUST_PANE_INSTANCE_ID,
        boundContext: {
          projectId,
          workspaceId: projectId,
          sourceId: WORKSPACE_TRUST_PANE_SOURCE_ID,
        },
      },
    ]),
  );
}

describe('Project Routes', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createTempProjectHome() {
    const dir = mkdtempSync(join(tmpdir(), 'station-project-routes-'));
    tempDirs.push(dir);
    return dir;
  }

  function writePluginLayout(
    projectHomeDir: string,
    pluginName: string,
    layout: Record<string, unknown>,
  ) {
    const pluginDir = join(projectHomeDir, 'plugins', pluginName);
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: pluginName,
        version: '1.2.3',
        displayName: 'Mixed Layout Plugin',
        layout: { slug: layout.slug, source: 'layout.json' },
      }),
      'utf-8',
    );
    writeFileSync(
      join(pluginDir, 'layout.json'),
      JSON.stringify(layout),
      'utf-8',
    );
  }

  test('GET / returns project list', async () => {
    const app = createProjectRoutes(
      createMockProjectService() as any,
      createMockStorageAdapter() as any,
      '/tmp',
    );
    const body = await json(await app.request('/'));
    expect(body.success).toBe(true);
  });

  test('GET /icon-candidates returns only bounded artwork from the selected workspace', async () => {
    const projectHome = createTempProjectHome();
    const workspace = createTempProjectHome();
    mkdirSync(join(workspace, 'public'), { recursive: true });
    writeFileSync(
      join(workspace, 'public', 'favicon.png'),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
    );
    const app = createProjectRoutes(
      createMockProjectService() as any,
      createMockStorageAdapter() as any,
      projectHome,
    );

    const response = await app.request(
      `/icon-candidates?path=${encodeURIComponent(workspace)}`,
    );
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body.data).toEqual([
      expect.objectContaining({
        relativePath: 'public/favicon.png',
        source: 'favicon',
      }),
    ]);
    expect(JSON.stringify(body)).not.toContain(workspace);
  });

  // archive#3158 — these three shared one 404 reading "Workspace is
  // unavailable or inaccessible", from a `catch {}` that did not even bind the
  // error. The path stays masked; the reason no longer is.
  test('GET /icon-candidates reports a missing workspace as missing, without its path', async () => {
    const app = createProjectRoutes(
      createMockProjectService() as any,
      createMockStorageAdapter() as any,
      createTempProjectHome(),
    );
    const secretPath = join(
      createTempProjectHome(),
      'missing-secret-directory',
    );

    const response = await app.request(
      `/icon-candidates?path=${encodeURIComponent(secretPath)}`,
    );
    const body = await json(response);

    expect(response.status).toBe(404);
    expect(body.error).toBe('Workspace not found');
    expect(JSON.stringify(body)).not.toContain(secretPath);
  });

  test('GET /icon-candidates reports an unreadable workspace as permission denied, without its path', async () => {
    const app = createProjectRoutes(
      createMockProjectService() as any,
      createMockStorageAdapter() as any,
      createTempProjectHome(),
    );
    const secretPath = createTempProjectHome();
    vi.mocked(realpath).mockRejectedValueOnce(
      Object.assign(new Error(`EACCES: permission denied, '${secretPath}'`), {
        code: 'EACCES',
      }),
    );

    const response = await app.request(
      `/icon-candidates?path=${encodeURIComponent(secretPath)}`,
    );
    const body = await json(response);

    expect(response.status).toBe(403);
    expect(body.error).toBe('Permission denied reading this workspace');
    expect(JSON.stringify(body)).not.toContain(secretPath);
  });

  test('GET /icon-candidates reports a file path as a file, not as missing', async () => {
    const app = createProjectRoutes(
      createMockProjectService() as any,
      createMockStorageAdapter() as any,
      createTempProjectHome(),
    );
    const filePath = join(createTempProjectHome(), 'README.md');
    writeFileSync(filePath, '# not a workspace');

    const response = await app.request(
      `/icon-candidates?path=${encodeURIComponent(filePath)}`,
    );
    const body = await json(response);

    expect(response.status).toBe(400);
    expect(body.error).toBe('That path is a file, not a directory');
  });

  test('POST / creates project', async () => {
    const app = createProjectRoutes(
      createMockProjectService() as any,
      createMockStorageAdapter() as any,
      '/tmp',
    );
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test', slug: 'test' }),
    });
    expect(res.status).toBe(201);
  });

  // archive#3315: the static /order segment must reach the reorder handler,
  // never be captured as a project slug by the parameterized routes.
  test('PUT /order persists the sidebar order and refuses an unknown slug', async () => {
    const service = createMockProjectService();
    const app = createProjectRoutes(
      service as any,
      createMockStorageAdapter() as any,
      '/tmp',
    );
    await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alpha', slug: 'alpha' }),
    });
    await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Beta', slug: 'beta' }),
    });

    const ok = await app.request('/order', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: ['beta', 'alpha'] }),
    });
    expect(ok.status).toBe(200);
    expect(service.reorderProjects).toHaveBeenCalledWith(['beta', 'alpha']);
    expect(service.updateProject).not.toHaveBeenCalled();

    const unknown = await app.request('/order', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: ['ghost'] }),
    });
    expect(unknown.status).toBe(400);
    const invalid = await app.request('/order', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: [] }),
    });
    expect(invalid.status).toBe(400);
  });

  test('POST / rejects unknown scoped project agents when agent catalog is available', async () => {
    const app = createProjectRoutes(
      createMockProjectService() as any,
      createMockStorageAdapter() as any,
      '/tmp',
      { listAgents: async () => [{ slug: agentId('alpha') }] },
    );
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Test',
        slug: 'test',
        agents: ['alpha', 'missing'],
      }),
    });
    const body = await json(res);
    expect(res.status).toBe(400);
    expect(body.diagnostics?.[0]?.code).toBe('unknown_project_agent');
  });

  test('POST / preserves an explicit empty project agent scope', async () => {
    const app = createProjectRoutes(
      createMockProjectService() as any,
      createMockStorageAdapter() as any,
      '/tmp',
      { listAgents: async () => [{ slug: agentId('alpha') }] },
    );
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Test',
        slug: 'test',
        agents: [],
      }),
    });
    const body = await json(res);
    expect(res.status).toBe(201);
    expect(body.data.agents).toEqual([]);
  });

  test('POST / preserves unscoped, scoped, and explicitly empty agent scopes', async () => {
    const service = createMockProjectService();
    const app = createProjectRoutes(
      service as any,
      createMockStorageAdapter() as any,
      '/tmp',
      { listAgents: async () => [{ slug: agentId('alpha') }] },
    );

    const scopes = [
      { slug: 'unscoped', expected: undefined },
      { slug: 'scoped', agents: ['alpha'], expected: ['alpha'] },
      { slug: 'empty', agents: [], expected: [] },
    ];

    for (const scope of scopes) {
      const response = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: scope.slug,
          slug: scope.slug,
          ...(scope.agents === undefined ? {} : { agents: scope.agents }),
        }),
      });
      const body = await json(response);

      expect(response.status).toBe(201);
      expect(body.data.agents).toEqual(scope.expected);
    }
  });

  test('POST / rejects a filter entry naming an agent owned by another project (station#1004 §3.3)', async () => {
    const app = createProjectRoutes(
      createMockProjectService() as any,
      createMockStorageAdapter() as any,
      '/tmp',
      {
        listAgents: async () => [
          { slug: agentId('alpha') },
          { slug: agentId('owned-elsewhere'), project: 'other-project' },
        ],
      },
    );
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Test',
        slug: 'test',
        agents: ['alpha', 'owned-elsewhere'],
      }),
    });
    const body = await json(res);
    expect(res.status).toBe(400);
    expect(body.diagnostics?.[0]?.code).toBe('agent_owned_by_other_project');
  });

  test('POST / accepts omitting owned agents from the filter — they are implicitly available (station#1004 §3.3)', async () => {
    const app = createProjectRoutes(
      createMockProjectService() as any,
      createMockStorageAdapter() as any,
      '/tmp',
      {
        listAgents: async () => [
          { slug: agentId('alpha') },
          { slug: agentId('owned-by-test'), project: 'test' },
        ],
      },
    );
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Test',
        slug: 'test',
        agents: ['alpha'],
      }),
    });
    const body = await json(res);
    expect(res.status).toBe(201);
    expect(body.data.agents).toEqual(['alpha']);
  });

  test('GET /:slug surfaces stale agent diagnostics without rewriting project scope', async () => {
    const svc = createMockProjectService();
    await svc.createProject({
      name: 'Test',
      slug: 'test',
      agents: ['alpha', 'missing'],
    });
    const app = createProjectRoutes(
      svc as any,
      createMockStorageAdapter() as any,
      '/tmp',
      { listAgents: async () => [{ slug: agentId('alpha') }] },
    );

    const res = await app.request('/test');
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.data.agents).toEqual(['alpha', 'missing']);
    expect(body.data._integrityDiagnostics).toEqual([
      expect.objectContaining({
        code: 'unknown_project_agent',
        severity: 'warning',
        refId: 'missing',
      }),
    ]);
    expect((await svc.getProject('test')).agents).toEqual(['alpha', 'missing']);
  });

  test('PUT /:slug accepts null agents to clear an existing project scope', async () => {
    const svc = createMockProjectService();
    await svc.createProject({
      name: 'Test',
      slug: 'test',
      agents: ['alpha'],
    });
    const app = createProjectRoutes(
      svc as any,
      createMockStorageAdapter() as any,
      '/tmp',
      { listAgents: async () => [{ slug: agentId('alpha') }] },
    );
    const res = await app.request('/test', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agents: null }),
    });
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.data.agents).toBeUndefined();
  });

  /**
   * 4-HOME-007. The storage layer distinguishes "this project path is already
   * taken" from "someone else committed first"; the route used to flatten both
   * into the CAS sentence, so a user creating a second 'Audit Alpha' was told
   * "Project storage changed before the operation could commit".
   */
  test('POST / answers a slug collision by name, with the first free slug', async () => {
    const service = createMockProjectService();
    service.createProject.mockRejectedValueOnce(
      new FileStorageAlreadyExistsError(
        "Project 'audit-alpha' already exists",
        'audit-alpha',
      ),
    );
    const app = createProjectRoutes(
      service as any,
      createMockStorageAdapter(['audit-alpha', 'audit-alpha-2']) as any,
      '/tmp',
    );

    const response = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Audit Alpha', slug: 'audit-alpha' }),
    });

    expect(response.status).toBe(409);
    const body = await json(response);
    expect(body.error).toBe(
      "A project called 'Audit Alpha' already exists. The slug 'audit-alpha-3' is available.",
    );
    expect(body.error).not.toContain('storage changed');
    expect(body.data).toEqual({
      takenSlug: 'audit-alpha',
      suggestedSlug: 'audit-alpha-3',
    });
  });

  test('POST / still reports a genuine write conflict as a storage conflict', async () => {
    const service = createMockProjectService();
    service.createProject.mockRejectedValueOnce(
      new FileStorageConflictError('Project changed before create'),
    );
    const app = createProjectRoutes(
      service as any,
      createMockStorageAdapter() as any,
      '/tmp',
    );

    const response = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Audit Alpha', slug: 'audit-alpha' }),
    });

    expect(response.status).toBe(409);
    expect((await json(response)).error).toBe(
      'Project storage changed before the operation could commit',
    );
  });

  test('PUT /:slug projects an exact revision conflict as 409', async () => {
    const service = createMockProjectService();
    service.updateProject.mockRejectedValueOnce(
      new FileStorageConflictError('Project changed before update'),
    );
    const app = createProjectRoutes(
      service as any,
      createMockStorageAdapter() as any,
      '/tmp',
    );

    const response = await app.request('/test', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Changed' }),
    });

    expect(response.status).toBe(409);
    expect(await json(response)).toEqual({
      success: false,
      error: 'Project storage changed before the operation could commit',
    });
  });

  test('GET /:slug returns 404 for missing', async () => {
    const app = createProjectRoutes(
      createMockProjectService() as any,
      createMockStorageAdapter() as any,
      '/tmp',
    );
    const res = await app.request('/missing');
    expect(res.status).toBe(404);
  });

  test('GET /:slug projects corrupt or unavailable storage as stable 500', async () => {
    const service = createMockProjectService();
    service.getProject.mockRejectedValueOnce(
      new FileStorageUnavailableError(
        'private path: /station/projects/test/project.json',
      ),
    );
    const app = createProjectRoutes(
      service as any,
      createMockStorageAdapter() as any,
      '/tmp',
    );

    const response = await app.request('/test');
    expect(response.status).toBe(500);
    expect(await json(response)).toEqual({
      success: false,
      error: 'Project storage is unavailable',
    });
  });

  test('GET Layout projects corrupt or unavailable storage as stable 500', async () => {
    const storage = createMockStorageAdapter();
    storage.getLayout.mockImplementationOnce(() => {
      throw new FileStorageUnavailableError(
        'private path: /station/projects/test/layouts/coding.json',
      );
    });
    const app = createProjectRoutes(
      createMockProjectService() as any,
      storage as any,
      '/tmp',
    );

    const response = await app.request('/test/layouts/coding');
    expect(response.status).toBe(500);
    expect(await json(response)).toEqual({
      success: false,
      error: 'Layout storage is unavailable',
    });
  });

  // A plugin layout still on a retired key is refused BY NAME rather than read
  // past. Reading `globalSkills` off a layout that declares `globalPrompts`
  // yields `undefined`, and this route SPREADS the result over the stored
  // config — so before the refusal a resolved layout came back looking healthy
  // with its global actions gone (review M1).
  test.each([
    [
      'globalPrompts',
      { globalPrompts: [{ id: 'g1', label: 'Stand up', prompt: 'x' }] },
      "retired layout key 'globalPrompts'",
    ],
    [
      'tabs[].prompts',
      {
        tabs: [
          {
            id: 'main',
            label: 'Main',
            prompts: [{ type: 'prompt', label: 'Summarise', data: 'x' }],
          },
        ],
      },
      "retired layout key 'prompts'",
    ],
  ])(
    'GET /:slug/layouts/:layoutSlug refuses a plugin layout carrying %s',
    async (_label, extra, expected) => {
      const projectHome = createTempProjectHome();
      writePluginLayout(projectHome, 'retired-plugin', {
        slug: 'retired',
        name: 'Retired',
        tabs: [],
        ...extra,
      });
      const storage = createMockStorageAdapter();
      storage.getLayout.mockImplementation(() => ({
        slug: 'retired',
        type: 'chat',
        config: { plugin: 'retired-plugin' },
      }));
      const app = createProjectRoutes(
        createMockProjectService() as any,
        storage as any,
        projectHome,
      );

      const response = await app.request('/test/layouts/retired');
      const body = await json(response);

      expect(response.status).not.toBe(200);
      expect(body.success).toBe(false);
      expect(body.error).toContain(expected);
      expect(body.error).toContain('ADR-0016');
    },
  );

  test('GET /:slug/layouts/:layoutSlug resolves a plugin layout on the current keys', async () => {
    const projectHome = createTempProjectHome();
    writePluginLayout(projectHome, 'current-plugin', {
      slug: 'current',
      name: 'Current',
      globalSkills: [{ id: 'g1', label: 'Stand up', prompt: 'x' }],
      tabs: [
        {
          id: 'main',
          label: 'Main',
          skills: [{ type: 'prompt', label: 'Summarise', data: 'x' }],
        },
      ],
    });
    const storage = createMockStorageAdapter();
    storage.getLayout.mockImplementation(() => ({
      slug: 'current',
      type: 'chat',
      config: { plugin: 'current-plugin' },
    }));
    const app = createProjectRoutes(
      createMockProjectService() as any,
      storage as any,
      projectHome,
    );

    const body = await json(await app.request('/test/layouts/current'));

    expect(body.success).toBe(true);
    expect(body.data.config.globalSkills).toEqual([
      { id: 'g1', label: 'Stand up', prompt: 'x' },
    ]);
    expect(body.data.config.tabs[0].skills).toEqual([
      { type: 'prompt', label: 'Summarise', data: 'x' },
    ]);
  });

  test('DELETE /:slug deletes project', async () => {
    const svc = createMockProjectService();
    const app = createProjectRoutes(
      svc as any,
      createMockStorageAdapter() as any,
      '/tmp',
    );
    const body = await json(await app.request('/test', { method: 'DELETE' }));
    expect(body.success).toBe(true);
  });

  test('GET /:slug/layouts returns layout list', async () => {
    const app = createProjectRoutes(
      createMockProjectService() as any,
      createMockStorageAdapter() as any,
      '/tmp',
    );
    const body = await json(await app.request('/test/layouts'));
    expect(body.success).toBe(true);
  });

  test('GET /:slug/panes exposes the current data-only built-in Pane catalog', async () => {
    projectOps.add.mockClear();
    projectPaneCatalogDuration.record.mockClear();
    workspacePaneAvailabilityResolutions.add.mockClear();
    const app = createProjectRoutes(
      createMockProjectService() as any,
      createMockStorageAdapter() as any,
      createTempProjectHome(),
    );
    const response = await app.request('/test/panes');
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, data: { version: '1.0' } });
    expect(body.data.descriptors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          renderer: { kind: 'builtin-component', name: 'coding' },
          provenance: { origin: 'builtin' },
          placement: expect.objectContaining({ supportedRegions: ['primary'] }),
        }),
        expect.objectContaining({
          id: 'pane:builtin:workspace-preview:file-preview',
          renderer: {
            kind: 'builtin-component',
            name: 'workspace-file-preview',
          },
        }),
        expect.objectContaining({
          id: 'pane:builtin:workspace-preview:browser-preview',
          renderer: {
            kind: 'builtin-component',
            name: 'workspace-browser-preview',
          },
        }),
      ]),
    );
    expect(
      body.data.instances.every(
        (pane: any) => pane.boundContext.projectId === 'test',
      ),
    ).toBe(true);
    const descriptor = body.data.descriptors.find(
      (pane: any) => pane.provenance.origin === 'builtin',
    );
    const availability = body.data.availability.find(
      (entry: any) => entry.descriptorId === descriptor.id,
    );
    expect(availability.input).toEqual({
      rollout: 'available',
      distribution: 'enabled',
      renderer: 'unknown',
      context: { project: 'present' },
    });
    expect(
      resolveWorkspacePaneAvailability(
        { ...availability.input, renderer: 'present' },
        descriptor.modes[0].contextRequirement,
      ),
    ).toMatchObject({ state: 'available', reason: { code: 'ready' } });
    expect(body.data.availability).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          descriptorId: 'pane:builtin:workspace-preview:file-preview',
          input: expect.objectContaining({
            rollout: 'available',
            distribution: 'enabled',
            renderer: 'unknown',
            context: { project: 'present' },
          }),
          availability: expect.objectContaining({
            state: 'unsupported',
            reason: expect.objectContaining({ code: 'renderer-unknown' }),
          }),
        }),
      ]),
    );
    expect(
      body.data.availability.find(
        (entry: any) =>
          entry.descriptorId === 'pane:builtin:workspace-preview:file-preview',
      ),
    ).not.toHaveProperty('instanceId');
    expect(projectOps.add).toHaveBeenCalledWith(1, {
      op: 'list_panes',
      outcome: 'success',
    });
    expect(projectPaneCatalogDuration.record).toHaveBeenCalledWith(
      expect.any(Number),
      { outcome: 'success' },
    );
    expect(workspacePaneAvailabilityResolutions.add).toHaveBeenCalledWith(1, {
      descriptor: 'pane:builtin:workspace-preview:file-preview',
      state: 'unsupported',
      reason_code: 'renderer-unknown',
    });
  });

  test('GET /:slug/panes derives Files and Diff context from the configured Project workspace', async () => {
    const workspace = createTempProjectHome();
    const gitWorkspace = createTempProjectHome();
    mkdirSync(join(gitWorkspace, '.git'));
    const project = (workingDirectory?: string) => ({
      id: 'project-internal-id',
      slug: 'test',
      name: 'Test',
      ...(workingDirectory ? { workingDirectory } : {}),
    });
    const requestCatalog = async (workingDirectory?: string) => {
      const storage = createMockStorageAdapter();
      storage.getProject.mockReturnValue(project(workingDirectory) as any);
      const app = createProjectRoutes(
        createMockProjectService() as any,
        storage as any,
        createTempProjectHome(),
      );
      return await json(await app.request('/test/panes'));
    };
    const paneAvailability = (body: any, descriptorId: string) => {
      const descriptor = body.data.descriptors.find(
        (candidate: any) => candidate.id === descriptorId,
      );
      const projection = body.data.availability.find(
        (candidate: any) => candidate.descriptorId === descriptorId,
      );
      return resolveWorkspacePaneAvailability(
        { ...projection.input, renderer: 'present' },
        descriptor.modes[0].contextRequirement,
      );
    };

    const gitProject = await requestCatalog(gitWorkspace);
    expect(
      paneAvailability(
        gitProject,
        WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR_ID,
      ),
    ).toMatchObject({ state: 'available', reason: { code: 'ready' } });
    expect(
      paneAvailability(gitProject, WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR_ID),
    ).toMatchObject({ state: 'available', reason: { code: 'ready' } });
    expect(
      paneAvailability(
        gitProject,
        WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR_ID,
      ),
    ).toMatchObject({ state: 'available', reason: { code: 'ready' } });

    const nonGitProject = await requestCatalog(workspace);
    expect(
      paneAvailability(
        nonGitProject,
        WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR_ID,
      ),
    ).toMatchObject({ state: 'available', reason: { code: 'ready' } });
    expect(
      paneAvailability(nonGitProject, WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR_ID),
    ).toMatchObject({
      state: 'not-configured',
      reason: { code: 'missing-git-repository', source: 'context' },
    });

    const withoutWorkspace = await requestCatalog();
    expect(
      paneAvailability(
        withoutWorkspace,
        WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR_ID,
      ),
    ).toMatchObject({
      state: 'not-configured',
      reason: { code: 'missing-workspace', source: 'context' },
    });
    expect(
      paneAvailability(
        withoutWorkspace,
        WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR_ID,
      ),
    ).toMatchObject({
      state: 'not-configured',
      reason: { code: 'missing-workspace', source: 'context' },
    });
  });

  test('DELETE /:slug/terminals/:terminalId closes only the route-bound Project terminal', async () => {
    const terminalService = {
      closeForProject: vi.fn(async (projectSlug: string, terminalId: string) =>
        projectSlug === 'test' && terminalId === 'term-1'
          ? { sessionId: 'test:term-1', projectSlug, terminalId }
          : null,
      ),
    };
    const app = createProjectRoutes(
      createMockProjectService() as any,
      createMockStorageAdapter() as any,
      createTempProjectHome(),
      { terminalService },
    );

    const accepted = await app.request('/test/terminals/term-1', {
      method: 'DELETE',
    });
    expect(accepted.status).toBe(200);
    expect(await json(accepted)).toEqual({
      success: true,
      data: {
        sessionId: 'test:term-1',
        projectSlug: 'test',
        terminalId: 'term-1',
      },
    });

    const wrongProject = await app.request('/other/terminals/term-1', {
      method: 'DELETE',
    });
    expect(wrongProject.status).toBe(404);
    expect(terminalService.closeForProject).toHaveBeenCalledTimes(2);
    expect(terminalService.closeForProject).toHaveBeenCalledWith(
      'test',
      'term-1',
    );
    expect(terminalService.closeForProject).toHaveBeenLastCalledWith(
      'other',
      'term-1',
    );
  });

  test('GET /:slug/panes binds the canonical Project id rather than its route slug', async () => {
    const storage = createMockStorageAdapter();
    storage.getProject.mockReturnValue({
      id: 'project-internal-id',
      slug: 'test',
      name: 'Test',
      workingDirectory: '/tmp',
      agents: ['alpha'],
    });
    const app = createProjectRoutes(
      createMockProjectService() as any,
      storage as any,
      createTempProjectHome(),
    );

    const body = await json(await app.request('/test/panes'));
    // Select the layout-derived instance by IDENTITY, never by array position:
    // the catalog also carries built-in panes (archive#2201 added the chat
    // pane), and a positional pick silently retargets this assertion at
    // whichever pane happens to sort first.
    const instance = body.data.instances.find((candidate: any) =>
      decodeURIComponent(candidate.instanceId).includes(
        'project:project-internal-id:source:',
      ),
    );
    expect(instance).toBeDefined();

    expect(body.data.descriptors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provenance: { origin: 'builtin' } }),
      ]),
    );
    expect(instance.boundContext.projectId).toBe('project-internal-id');
    expect(body.data.projectSlug).toBe('test');
    expect(decodeURIComponent(instance.instanceId)).toContain(
      'project:project-internal-id:source:',
    );
    expect(decodeURIComponent(instance.stateKey)).toContain(
      'project:project-internal-id:source:',
    );
  });

  test('GET /:slug/panes keeps same-tab built-in renderers from separate plugin contributors independent', async () => {
    const first = {
      id: 'plugin:one:shared-layout',
      source: 'plugin',
      plugin: 'one',
      name: 'One',
      slug: 'shared-layout',
      type: 'review',
      sourceIdentity: { id: 'one', kind: 'local', source: 'plugins/one' },
      contribution: {
        id: 'plugin:one:shared-layout',
        version: '1.0.0',
        sourceIdentity: { id: 'one', kind: 'local', source: 'plugins/one' },
        provenance: { origin: 'plugin', pluginId: 'one' },
      },
      lifecycle: {
        itemId: 'plugin:one:shared-layout',
        state: 'installed',
        source: 'one',
      },
      visible: true,
      installable: false,
      enabled: true,
      policy: {},
    } as const;
    const second = {
      ...first,
      id: 'plugin:two:shared-layout',
      plugin: 'two',
      sourceIdentity: { id: 'two', kind: 'local', source: 'plugins/two' },
      contribution: {
        id: 'plugin:two:shared-layout',
        version: '2.0.0',
        sourceIdentity: { id: 'two', kind: 'local', source: 'plugins/two' },
        provenance: { origin: 'plugin', pluginId: 'two' },
      },
      lifecycle: {
        itemId: 'plugin:two:shared-layout',
        state: 'installed',
        source: 'two',
      },
    } as const;
    const definitions = new Map<string, any>([
      [
        first.id,
        {
          item: first,
          pluginName: 'one',
          definition: {
            name: 'One',
            slug: 'shared-layout',
            type: 'review',
            tabs: [
              {
                id: 'shared',
                label: 'Shared',
                component: { kind: 'builtin-component', name: 'file-tree' },
              },
            ],
          },
        },
      ],
      [
        second.id,
        {
          item: second,
          pluginName: 'two',
          definition: {
            name: 'Two',
            slug: 'shared-layout',
            type: 'review',
            tabs: [
              {
                id: 'shared',
                label: 'Different shared label',
                component: { kind: 'builtin-component', name: 'file-tree' },
              },
            ],
          },
        },
      ],
    ]);
    const app = createProjectRoutes(
      createMockProjectService() as any,
      createMockStorageAdapter() as any,
      createTempProjectHome(),
      {
        layoutCatalog: {
          listLayouts: () => [first, second],
          resolveForCatalog: (id: string) => definitions.get(id),
        } as any,
      },
    );

    const response = await app.request('/test/panes');
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body.data.descriptors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'pane:plugin%3Aone:shared-layout:shared',
          name: 'Shared',
          renderer: { kind: 'builtin-component', name: 'file-tree' },
          provenance: { origin: 'plugin', pluginId: 'one' },
        }),
        expect.objectContaining({
          id: 'pane:plugin%3Atwo:shared-layout:shared',
          name: 'Different shared label',
          renderer: { kind: 'builtin-component', name: 'file-tree' },
          provenance: { origin: 'plugin', pluginId: 'two' },
        }),
      ]),
    );
    // The 8 layout/plugin-derived instances this case builds, plus Chat and
    // Work Board, which are fixed Project panes.
    expect(body.data.instances).toHaveLength(
      8 + FIXED_PROJECT_PANE_DESCRIPTOR_IDS.length,
    );
    expect(
      body.data.instances.map((instance: any) => instance.descriptorId),
    ).toEqual(expect.arrayContaining(FIXED_PROJECT_PANE_DESCRIPTOR_IDS));
    expectProjectEvidencePaneInstances(body.data.instances, 'test');
    expect(
      body.data.instances
        .filter((instance: any) =>
          instance.descriptorId.includes('shared-layout'),
        )
        .map((instance: any) => instance.descriptorId)
        .sort(),
    ).toEqual([
      'pane:plugin%3Aone:shared-layout:shared',
      'pane:plugin%3Atwo:shared-layout:shared',
    ]);
  });

  test('GET /:slug/panes accepts depth-32 MCP arguments and bounds depth 33', async () => {
    const depthPlugin = {
      id: 'plugin:depth:boundary',
      source: 'plugin',
      plugin: 'depth',
      name: 'Depth boundary',
      slug: 'depth-boundary',
      type: 'review',
      sourceIdentity: { id: 'depth', kind: 'local', source: 'plugins/depth' },
      contribution: {
        id: 'plugin:depth:boundary',
        version: '1.0.0',
        sourceIdentity: {
          id: 'depth',
          kind: 'local',
          source: 'plugins/depth',
        },
        provenance: { origin: 'plugin', pluginId: 'depth' },
      },
      lifecycle: {
        itemId: 'plugin:depth:boundary',
        state: 'installed',
        source: 'depth',
      },
      visible: true,
      installable: false,
      enabled: true,
      policy: {},
    } as const;
    const appAtDepth = (depth: number) =>
      createProjectRoutes(
        createMockProjectService() as any,
        createMockStorageAdapter() as any,
        createTempProjectHome(),
        {
          layoutCatalog: {
            listLayouts: () => [depthPlugin],
            resolveForCatalog: () => ({
              item: depthPlugin,
              pluginName: 'depth',
              definition: {
                name: 'Depth boundary',
                slug: 'depth-boundary',
                type: 'review',
                tabs: [
                  {
                    id: 'mcp-depth',
                    label: 'MCP depth',
                    component: {
                      kind: 'mcp-tool-ui',
                      ref: 'depth-mcp/arguments',
                      initialArguments: nestedInitialArguments(depth),
                    },
                  },
                ],
              },
            }),
          } as any,
        },
      );

    const accepted = await appAtDepth(32).request('/test/panes');
    expect(accepted.status).toBe(200);
    const acceptedBody = await json(accepted);
    // The 10 descriptors authored here, plus Chat and Work Board, which are
    // fixed Project panes.
    expect(acceptedBody.data.descriptors).toHaveLength(
      10 + FIXED_PROJECT_PANE_DESCRIPTOR_IDS_DECLARED.length,
    );
    expect(acceptedBody.data.descriptors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          renderer: {
            kind: 'mcp-tool-ui',
            ref: 'depth-mcp/arguments',
            initialArguments: nestedInitialArguments(32),
          },
          provenance: {
            origin: 'plugin',
            pluginId: 'depth',
            mcpServerId: 'depth-mcp',
          },
        }),
      ]),
    );
    expect(
      acceptedBody.data.descriptors.map((descriptor: any) => descriptor.id),
    ).toEqual(expect.arrayContaining(FIXED_PROJECT_PANE_DESCRIPTOR_IDS));
    expectProjectEvidencePaneInstances(acceptedBody.data.instances, 'test');

    const rejected = await appAtDepth(33).request('/test/panes');
    expect(rejected.status).toBe(500);
    expect(await json(rejected)).toEqual({
      success: false,
      error: 'Workspace Pane catalog is unavailable',
    });
  });

  test('GET /:slug/panes returns 404 for an unknown project', async () => {
    const storage = createMockStorageAdapter();
    storage.getProject.mockImplementation(() => {
      throw new Error('not found');
    });
    const app = createProjectRoutes(
      createMockProjectService() as any,
      storage as any,
      createTempProjectHome(),
    );

    const response = await app.request('/missing/panes');
    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({
      success: false,
      error: 'Project not found',
    });
  });

  test('GET /:slug/panes returns 400 for invalid client input', async () => {
    const app = createProjectRoutes(
      createMockProjectService() as any,
      createMockStorageAdapter() as any,
      createTempProjectHome(),
    );

    const response = await app.request('/bad%2Fslug/panes');
    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({
      success: false,
      error: 'Invalid project slug',
    });
  });

  test('GET /:slug/panes returns bounded 5xx errors for catalog failures', async () => {
    projectOps.add.mockClear();
    projectPaneCatalogDuration.record.mockClear();
    routesLogger.error.mockClear();
    const app = createProjectRoutes(
      createMockProjectService() as any,
      createMockStorageAdapter() as any,
      createTempProjectHome(),
      {
        layoutCatalog: {
          listLayouts: () => {
            throw new Error('secret path /private/station-layout.json');
          },
        } as any,
      },
    );

    const response = await app.request('/test/panes');
    const body = await json(response);
    expect(response.status).toBe(500);
    expect(body).toEqual({
      success: false,
      error: 'Workspace Pane catalog is unavailable',
    });
    expect(JSON.stringify(body)).not.toContain('private');
    // The cause stays out of the response but must reach the server log with
    // the project identity (archive#2549).
    expect(routesLogger.error).toHaveBeenCalledWith(
      'Workspace Pane catalog read failed',
      {
        projectSlug: 'test',
        error: 'secret path /private/station-layout.json',
      },
    );
    expect(projectOps.add).toHaveBeenCalledWith(1, {
      op: 'list_panes',
      outcome: 'failure',
    });
    expect(projectPaneCatalogDuration.record).toHaveBeenCalledWith(
      expect.any(Number),
      { outcome: 'failure' },
    );
  });

  test('GET /layouts/available projects the shared Coding, Tasks, and Session Board starters', async () => {
    const app = createProjectRoutes(
      createMockProjectService() as any,
      createMockStorageAdapter() as any,
      createTempProjectHome(),
    );

    const response = await app.request('/layouts/available');
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(
      body.data.find((layout: any) => layout.id === 'builtin:coding'),
    ).toMatchObject({
      source: 'builtin',
      name: 'Coding',
      slug: 'coding',
      type: 'coding',
      lifecycle: { state: 'installed' },
    });
    expect(
      body.data.find((layout: any) => layout.id === 'builtin:tasks'),
    ).toMatchObject({
      source: 'builtin',
      name: 'Tasks',
      slug: 'tasks',
      type: 'tasks',
      lifecycle: { state: 'installed' },
    });
    expect(
      body.data.find((layout: any) => layout.id === 'builtin:session-board'),
    ).toMatchObject({
      source: 'builtin',
      name: 'Session Board',
      slug: 'session-board',
      type: 'session-board',
      lifecycle: { state: 'installed' },
    });
  });

  test('POST /:slug/layouts/apply applies an enabled built-in catalog item', async () => {
    const storage = createMockStorageAdapter();
    const app = createProjectRoutes(
      createMockProjectService() as any,
      storage as any,
      createTempProjectHome(),
    );
    const response = await app.request('/test/layouts/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layoutId: 'builtin:coding' }),
    });
    const body = await json(response);
    expect(response.status).toBe(201);
    expect(body.data).toMatchObject({
      slug: 'coding',
      type: 'coding',
      catalogContribution: {
        id: 'builtin:coding',
        version: '1.0.0',
        provenance: { origin: 'builtin' },
      },
      config: { workingDirectory: '/tmp' },
    });
    expect(storage.createLayout).toHaveBeenCalledWith(
      'test',
      expect.objectContaining({ slug: 'coding' }),
    );

    const duplicateResponse = await app.request('/test/layouts/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layoutId: 'builtin:coding' }),
    });
    const duplicateBody = await json(duplicateResponse);
    expect(duplicateResponse.status).toBe(201);
    expect(duplicateBody.data.slug).toBe('coding-2');
  });

  test('POST /:slug/layouts/apply applies the Session Board catalog item', async () => {
    const storage = createMockStorageAdapter();
    const app = createProjectRoutes(
      createMockProjectService() as any,
      storage as any,
      createTempProjectHome(),
    );
    const response = await app.request('/test/layouts/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layoutId: 'builtin:session-board' }),
    });
    const body = await json(response);
    expect(response.status).toBe(201);
    expect(body.data).toMatchObject({
      slug: 'session-board',
      type: 'session-board',
      config: {},
    });
    expect(storage.createLayout).toHaveBeenCalledWith(
      'test',
      expect.objectContaining({ slug: 'session-board', type: 'session-board' }),
    );
  });

  test('POST /:slug/layouts/apply keeps a concurrent catalog create from overwriting', async () => {
    const storage = createMockStorageAdapter();
    const created = new Set<string>();
    storage.listLayouts.mockReturnValue([]);
    storage.createLayout.mockImplementation((_slug: string, layout: any) => {
      if (created.has(layout.slug)) {
        throw new FileStorageConflictError(
          `Layout '${layout.slug}' already exists`,
        );
      }
      created.add(layout.slug);
    });
    const app = createProjectRoutes(
      createMockProjectService() as any,
      storage as any,
      createTempProjectHome(),
    );
    const request = () =>
      app.request('/test/layouts/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layoutId: 'builtin:session-board' }),
      });

    const [first, second] = await Promise.all([request(), request()]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    expect(created).toEqual(new Set(['session-board']));
  });

  test('plugin namespace conflict occurs before any catalog Layout effect', async () => {
    const storage = createMockStorageAdapter();
    storage.projectRevision.mockReturnValueOnce({
      value: storage.getProject('test'),
      replace: vi
        .fn()
        .mockRejectedValue(
          new FileStorageConflictError('concurrent Project update'),
        ),
      remove: vi.fn(),
      createLayout: vi.fn(),
    });
    const layoutCatalog = {
      resolveForApply: () => ({
        item: { source: 'plugin' },
        pluginName: 'docs-plugin',
        definition: {
          type: 'coding',
          name: 'Docs',
          slug: 'docs',
          tabs: [],
        },
      }),
      getPluginManifest: () => ({
        name: 'docs-plugin',
        knowledge: {
          namespaces: [
            { id: 'plugin-docs', label: 'Plugin docs', behavior: 'rag' },
          ],
        },
      }),
      listLayouts: () => [],
    };
    const app = createProjectRoutes(
      createMockProjectService() as any,
      storage as any,
      '/tmp',
      { layoutCatalog: layoutCatalog as any, listAgents: async () => [] },
    );

    const response = await app.request('/test/layouts/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layoutId: 'plugin:docs-plugin' }),
    });

    expect(response.status).toBe(409);
    expect(storage.createLayout).not.toHaveBeenCalled();
  });

  test('POST /:slug/layouts/apply rejects a traversal-shaped project slug before storage', async () => {
    const storage = createMockStorageAdapter();
    const app = createProjectRoutes(
      createMockProjectService() as any,
      storage as any,
      createTempProjectHome(),
    );

    const response = await app.request('/..evil/layouts/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layoutId: 'builtin:coding' }),
    });
    const body = await json(response);

    expect(response.status).toBe(400);
    expect(body.error).toContain('Invalid project slug');
    expect(storage.listLayouts).not.toHaveBeenCalled();
    expect(storage.getProject).not.toHaveBeenCalled();
    expect(storage.saveLayout).not.toHaveBeenCalled();
    expect(storage.createLayout).not.toHaveBeenCalled();
  });

  test('POST /:slug/layouts rejects a traversal layout slug before storage', async () => {
    const storage = createMockStorageAdapter();
    const app = createProjectRoutes(
      createMockProjectService() as any,
      storage as any,
      '/tmp',
    );
    const res = await app.request('/test/layouts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: '../outside',
        name: 'Unsafe',
        type: 'chat',
      }),
    });
    expect(res.status).toBe(400);
    expect(storage.createLayout).not.toHaveBeenCalled();
  });

  test('POST /:slug/layouts creates layout', async () => {
    const app = createProjectRoutes(
      createMockProjectService() as any,
      createMockStorageAdapter() as any,
      '/tmp',
    );
    const res = await app.request('/test/layouts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'new-layout', name: 'New', type: 'chat' }),
    });
    expect(res.status).toBe(201);
  });

  test('POST /:slug/layouts strips a client-supplied catalog contribution', async () => {
    const storage = createMockStorageAdapter();
    const app = createProjectRoutes(
      createMockProjectService() as any,
      storage as any,
      '/tmp',
    );
    const forgedContribution = {
      id: 'plugin:forged:review',
      version: '999.0.0',
      sourceIdentity: {
        id: 'forged',
        kind: 'local',
        source: 'plugins/forged',
      },
      provenance: { origin: 'plugin', pluginId: 'forged' },
    };

    const res = await app.request('/test/layouts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: 'manual-layout',
        name: 'Manual',
        type: 'chat',
        catalogContribution: forgedContribution,
      }),
    });
    const body = await json(res);

    expect(res.status).toBe(201);
    expect(body.data).not.toHaveProperty('catalogContribution');
    expect(storage.getLayout('test', 'manual-layout')).not.toHaveProperty(
      'catalogContribution',
    );
  });

  test('POST /:slug/layouts is create-only and never overwrites a deterministic layout slug', async () => {
    const storage = createMockStorageAdapter();
    await storage.saveLayout('test', {
      slug: 'kit-knowledge-2',
      name: 'Existing Kit layout',
      type: 'kit-observability',
      config: { kit: { contributionRef: 'knowledge', incarnation: 2 } },
    });
    const app = createProjectRoutes(
      createMockProjectService() as any,
      storage as any,
      '/tmp',
    );

    const res = await app.request('/test/layouts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: 'kit-knowledge-2',
        name: 'Replacement attempt',
        type: 'kit-observability',
      }),
    });

    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({
      success: false,
      error: 'Project storage changed before the operation could commit',
    });
    expect(storage.getLayout('test', 'kit-knowledge-2').name).toBe(
      'Existing Kit layout',
    );
  });

  test('POST /:slug/layouts preserves mixed layout tab component refs', async () => {
    const app = createProjectRoutes(
      createMockProjectService() as any,
      createMockStorageAdapter() as any,
      '/tmp',
    );
    const tabs = [
      { id: 'legacy', label: 'Legacy', component: 'legacy-panel' },
      {
        id: 'plugin',
        label: 'Plugin',
        component: { kind: 'plugin-component', name: 'plugin-panel' },
      },
      {
        id: 'builtin',
        label: 'Builtin',
        component: { kind: 'builtin-component', name: 'default' },
      },
      {
        id: 'mcp',
        label: 'MCP',
        component: {
          kind: 'mcp-tool-ui',
          ref: 'station-control/list_project_layouts',
          displayMode: 'fullscreen',
          fallbackComponent: 'mcp-fallback',
          initialArguments: { projectSlug: 'test' },
          approvalPolicy: 'read-only',
        },
      },
    ];

    const res = await app.request('/test/layouts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: 'mixed-layout',
        name: 'Mixed',
        type: 'chat',
        config: { tabs },
      }),
    });
    const body = await json(res);

    expect(res.status).toBe(201);
    expect(body.data.config.tabs).toEqual(tabs);
  });

  test('PUT /:slug/layouts/:layoutSlug preserves structured component refs', async () => {
    const app = createProjectRoutes(
      createMockProjectService() as any,
      createMockStorageAdapter() as any,
      '/tmp',
    );
    const tabs = [
      { id: 'legacy', label: 'Legacy', component: 'legacy-panel' },
      {
        id: 'plugin',
        label: 'Plugin',
        component: { kind: 'plugin-component', name: 'plugin-panel' },
      },
      {
        id: 'builtin',
        label: 'Builtin',
        component: { kind: 'builtin-component', name: 'default' },
      },
      {
        id: 'mcp',
        label: 'MCP',
        component: {
          kind: 'mcp-tool-ui',
          ref: 'station-control/list_project_layouts',
        },
      },
    ];

    const res = await app.request('/test/layouts/mixed-layout', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: 'mixed-layout',
        name: 'Mixed',
        type: 'chat',
        config: { tabs },
      }),
    });
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.data.config.tabs).toEqual(tabs);
  });

  test('PUT /:slug/layouts/:layoutSlug retains a server-issued catalog contribution', async () => {
    const storage = createMockStorageAdapter();
    const contribution = {
      id: 'plugin:installed:review',
      version: '1.2.3',
      sourceIdentity: {
        id: 'installed',
        kind: 'local',
        source: 'plugins/installed',
      },
      provenance: { origin: 'plugin', pluginId: 'installed' },
    };
    await storage.saveLayout('test', {
      id: 'layout-1',
      projectSlug: 'test',
      slug: 'review',
      name: 'Review',
      type: 'chat',
      config: {},
      createdAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:00.000Z',
      catalogContribution: contribution,
    });
    const app = createProjectRoutes(
      createMockProjectService() as any,
      storage as any,
      '/tmp',
    );

    const res = await app.request('/test/layouts/review', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Renamed review',
        catalogContribution: {
          ...contribution,
          version: '999.0.0',
        },
      }),
    });
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.data.catalogContribution).toEqual(contribution);
    expect(storage.getLayout('test', 'review').catalogContribution).toEqual(
      contribution,
    );
  });

  test('layout GET and DELETE reject decoded and double-encoded traversal before storage', async () => {
    const storage = createMockStorageAdapter();
    const app = createProjectRoutes(
      createMockProjectService() as any,
      storage as any,
      '/tmp',
    );
    // URL normalizes a single-encoded dot segment before Hono can route it;
    // the double-encoded form reaches the handler and is rejected after decode.
    for (const path of [
      '/test/layouts/%252e%252e',
      '/test/layouts/safe%252fsecret',
    ]) {
      const get = await app.request(path);
      expect(get.status).toBe(400);
      const deleted = await app.request(path, { method: 'DELETE' });
      expect(deleted.status).toBe(400);
    }
    expect(storage.getLayout).not.toHaveBeenCalled();
    expect(storage.deleteLayout).not.toHaveBeenCalled();
  });

  test('PUT layout path identity wins over the body slug', async () => {
    const storage = createMockStorageAdapter();
    const app = createProjectRoutes(
      createMockProjectService() as any,
      storage as any,
      '/tmp',
    );
    const mismatch = await app.request('/test/layouts/safe-layout', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'config', name: 'Attempt', type: 'chat' }),
    });
    expect(mismatch.status).toBe(409);
    expect(storage.saveLayout).not.toHaveBeenCalled();

    const normal = await app.request('/test/layouts/safe-layout', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Safe', type: 'chat' }),
    });
    expect(normal.status).toBe(200);
    expect(storage.layoutRevision).toHaveBeenCalledWith('test', 'safe-layout');
    expect(storage.getLayout('test', 'safe-layout')).toEqual(
      expect.objectContaining({ slug: 'safe-layout' }),
    );
  });

  test('POST /:slug/layouts rejects malformed structured component refs', async () => {
    const app = createProjectRoutes(
      createMockProjectService() as any,
      createMockStorageAdapter() as any,
      '/tmp',
    );

    const res = await app.request('/test/layouts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: 'bad-layout',
        name: 'Bad',
        type: 'chat',
        config: {
          tabs: [
            {
              id: 'mcp',
              label: 'MCP',
              component: { kind: 'mcp-tool-ui', ref: 'not-slash-form' },
            },
          ],
        },
      }),
    });
    const body = await json(res);

    expect(res.status).toBe(400);
    expect(JSON.stringify(body.details)).toContain('<serverId>/<toolName>');
  });

  test('POST /:slug/layouts rejects layout agents outside the project scope', async () => {
    const app = createProjectRoutes(
      createMockProjectService() as any,
      createMockStorageAdapter() as any,
      '/tmp',
      {
        listAgents: async () => [
          { slug: agentId('alpha') },
          { slug: agentId('beta') },
        ],
      },
    );
    const res = await app.request('/test/layouts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: 'new-layout',
        name: 'New',
        type: 'chat',
        config: { availableAgents: ['beta'] },
      }),
    });
    const body = await json(res);
    expect(res.status).toBe(400);
    expect(body.diagnostics?.[0]?.code).toBe(
      'layout_agent_outside_project_scope',
    );
  });

  test('POST /:slug/layouts/from-plugin preserves mixed plugin layout component refs', async () => {
    const projectHomeDir = createTempProjectHome();
    const tabs = [
      { id: 'legacy', label: 'Legacy', component: 'legacy-panel' },
      {
        id: 'plugin',
        label: 'Plugin',
        component: { kind: 'plugin-component', name: 'plugin-panel' },
      },
      {
        id: 'builtin',
        label: 'Builtin',
        component: { kind: 'builtin-component', name: 'default' },
      },
      {
        id: 'mcp',
        label: 'MCP',
        component: {
          kind: 'mcp-tool-ui',
          ref: 'station-control/list_project_layouts',
          displayMode: 'inline',
          approvalPolicy: 'inherit',
        },
      },
    ];
    writePluginLayout(projectHomeDir, 'mixed-plugin', {
      name: 'Mixed Plugin',
      slug: 'mixed-plugin-layout',
      icon: 'M',
      description: 'Mixed component refs',
      tabs,
    });
    const app = createProjectRoutes(
      createMockProjectService() as any,
      createMockStorageAdapter() as any,
      projectHomeDir,
    );

    const res = await app.request('/test/layouts/from-plugin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plugin: 'mixed-plugin' }),
    });
    const body = await json(res);

    expect(res.status).toBe(201);
    expect(body.data.config.tabs).toEqual(tabs);
    expect(body.data.catalogContribution).toEqual({
      id: 'plugin:mixed-plugin:mixed-plugin-layout',
      version: '1.2.3',
      sourceIdentity: {
        id: 'mixed-plugin',
        kind: 'local',
        source: 'plugins/mixed-plugin',
      },
      provenance: { origin: 'plugin', pluginId: 'mixed-plugin' },
    });
  });

  test('GET /:slug/layouts/:layoutSlug preserves fresh structured refs from plugin layouts', async () => {
    const projectHomeDir = createTempProjectHome();
    const tabs = [
      { id: 'legacy', label: 'Legacy', component: 'legacy-panel' },
      {
        id: 'plugin',
        label: 'Plugin',
        component: { kind: 'plugin-component', name: 'plugin-panel' },
      },
      {
        id: 'builtin',
        label: 'Builtin',
        component: { kind: 'builtin-component', name: 'default' },
      },
      {
        id: 'mcp',
        label: 'MCP',
        component: {
          kind: 'mcp-tool-ui',
          ref: 'station-control/list_project_layouts',
        },
      },
    ];
    writePluginLayout(projectHomeDir, 'mixed-plugin', {
      name: 'Mixed Plugin',
      slug: 'mixed-plugin-layout',
      tabs,
    });
    const storage = createMockStorageAdapter();
    await storage.saveLayout('test', {
      slug: 'mixed-plugin-layout',
      name: 'Mixed Plugin',
      type: 'chat',
      config: { plugin: 'mixed-plugin' },
    });
    const app = createProjectRoutes(
      createMockProjectService() as any,
      storage as any,
      projectHomeDir,
    );

    const res = await app.request('/test/layouts/mixed-plugin-layout');
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.data.config.tabs).toEqual(tabs);
  });

  test('GET /:slug/layouts/:layoutSlug synthesizes plugin provenance for legacy persisted layouts without replacing stored provenance', async () => {
    const projectHomeDir = createTempProjectHome();
    writePluginLayout(projectHomeDir, 'knowledge-docs-starter', {
      name: 'Knowledge Docs',
      slug: 'knowledge-docs',
      type: 'chat',
      tabs: [{ id: 'library', component: 'library' }],
    });
    const storage = createMockStorageAdapter();
    await storage.saveLayout('test', {
      id: 'legacy-layout',
      projectSlug: 'test',
      slug: 'knowledge-docs',
      name: 'Knowledge Docs',
      type: 'chat',
      config: { plugin: 'knowledge-docs-starter' },
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
    });
    const storedContribution = {
      id: 'plugin:knowledge-docs-starter:stored-layout',
      version: '0.9.0',
      sourceIdentity: {
        id: 'knowledge-docs-starter',
        kind: 'local',
        source: 'plugins/knowledge-docs-starter',
      },
      provenance: {
        origin: 'plugin',
        pluginId: 'knowledge-docs-starter',
      },
    };
    await storage.saveLayout('test', {
      id: 'stored-layout',
      projectSlug: 'test',
      slug: 'stored',
      name: 'Stored',
      type: 'chat',
      config: { plugin: 'knowledge-docs-starter' },
      catalogContribution: storedContribution,
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
    });
    const app = createProjectRoutes(
      createMockProjectService() as any,
      storage as any,
      projectHomeDir,
    );

    const legacyResponse = await app.request('/test/layouts/knowledge-docs');
    const legacyBody = await json(legacyResponse);
    const storedResponse = await app.request('/test/layouts/stored');
    const storedBody = await json(storedResponse);

    expect(legacyResponse.status).toBe(200);
    expect(legacyBody.data.catalogContribution).toEqual({
      id: 'plugin:knowledge-docs-starter:knowledge-docs',
      version: '1.2.3',
      sourceIdentity: {
        id: 'knowledge-docs-starter',
        kind: 'local',
        source: 'plugins/knowledge-docs-starter',
      },
      provenance: {
        origin: 'plugin',
        pluginId: 'knowledge-docs-starter',
      },
    });
    expect(storage.getLayout('test', 'knowledge-docs')).not.toHaveProperty(
      'catalogContribution',
    );
    expect(storedResponse.status).toBe(200);
    expect(storedBody.data.catalogContribution).toEqual(storedContribution);
  });

  test('GET /:slug/layouts/:layoutSlug does not synthesize provenance for an uninstalled legacy plugin', async () => {
    const storage = createMockStorageAdapter();
    await storage.saveLayout('test', {
      id: 'uninstalled-layout',
      projectSlug: 'test',
      slug: 'uninstalled',
      name: 'Uninstalled plugin layout',
      type: 'chat',
      config: { plugin: 'uninstalled-plugin' },
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
    });
    const app = createProjectRoutes(
      createMockProjectService() as any,
      storage as any,
      createTempProjectHome(),
    );

    const response = await app.request('/test/layouts/uninstalled');
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body.data).not.toHaveProperty('catalogContribution');
  });

  test('DELETE /:slug/layouts/:layoutSlug deletes layout', async () => {
    const app = createProjectRoutes(
      createMockProjectService() as any,
      createMockStorageAdapter() as any,
      '/tmp',
    );
    const body = await json(
      await app.request('/test/layouts/old', { method: 'DELETE' }),
    );
    expect(body.success).toBe(true);
  });

  // archive#597 — projectCreateSchema allows an omitted slug, but the real
  // FileStorageAdapter previously threw `ERR_INVALID_ARG_TYPE` building the
  // on-disk path from `config.slug`, surfacing as a bare 500. Wire the real
  // ProjectService + FileStorageAdapter (not the route-level mocks above) so
  // this exercises the exact failing request shape end to end.
  describe('POST / with a real ProjectService + FileStorageAdapter (#597)', () => {
    function createRealApp() {
      const projectHomeDir = createTempProjectHome();
      const storage = new FileStorageAdapter(projectHomeDir);
      const projectService = new ProjectService(storage);
      const app = createProjectRoutes(
        projectService as any,
        storage as any,
        projectHomeDir,
      );
      return { app, storage };
    }

    test('creating a project without a slug derives one instead of 500ing', async () => {
      const { app, storage } = createRealApp();
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'My Cool Project' }),
      });
      const body = await json(res);

      expect(res.status).toBe(201);
      expect(body.success).toBe(true);
      expect(body.data.slug).toBe('my-cool-project');
      expect(() => storage.getProject('my-cool-project')).not.toThrow();
    });

    test('creating a project with a blank slug derives one instead of 500ing', async () => {
      const { app } = createRealApp();
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Blank Slug', slug: '' }),
      });
      const body = await json(res);

      expect(res.status).toBe(201);
      expect(body.data.slug).toBe('blank-slug');
    });

    test('rejects an empty saved default environment id', async () => {
      const { app } = createRealApp();
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Invalid Environment',
          defaultEnvironment: { kind: 'saved', id: '' },
        }),
      });

      expect(res.status).toBe(400);
    });

    test('round-trips a saved default environment without filling current defaults', async () => {
      const { app, storage } = createRealApp();
      const createResponse = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Remote Project',
          defaultEnvironment: { kind: 'saved', id: 'env-remote' },
        }),
      });
      const created = await json(createResponse);
      const readResponse = await app.request(`/${created.data.slug}`);
      const read = await json(readResponse);

      expect(createResponse.status).toBe(201);
      expect(read.data.defaultEnvironment).toEqual({
        kind: 'saved',
        id: 'env-remote',
      });
      expect(storage.getProject(created.data.slug).defaultEnvironment).toEqual({
        kind: 'saved',
        id: 'env-remote',
      });

      const localResponse = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Local Project' }),
      });
      const local = await json(localResponse);
      expect(local.data).not.toHaveProperty('defaultEnvironment');

      const clearResponse = await app.request(`/${created.data.slug}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultEnvironment: { kind: 'current' } }),
      });
      const cleared = await json(clearResponse);
      expect(clearResponse.status).toBe(200);
      expect(cleared.data).not.toHaveProperty('defaultEnvironment');
      expect(storage.getProject(created.data.slug)).not.toHaveProperty(
        'defaultEnvironment',
      );
    });

    test('partial layout rename preserves the stored definition and keeps it readable', async () => {
      const { app, storage } = createRealApp();
      const now = '2026-08-01T00:00:00.000Z';
      await putProject(storage, {
        id: 'project-1',
        slug: 'real-project',
        name: 'Real Project',
        createdAt: now,
        updatedAt: now,
      });
      await storage.createLayout('real-project', {
        id: 'layout-1',
        projectSlug: 'real-project',
        slug: 'coding',
        name: 'Original',
        type: 'coding',
        description: 'Preserved description',
        config: { workingDirectory: '/workspace', tabs: [] },
        createdAt: now,
        updatedAt: now,
      });

      const renamed = await app.request('/real-project/layouts/coding', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }),
      });
      expect(renamed.status).toBe(200);
      expect(storage.getLayout('real-project', 'coding')).toMatchObject({
        id: 'layout-1',
        slug: 'coding',
        projectSlug: 'real-project',
        name: 'Renamed',
        type: 'coding',
        description: 'Preserved description',
        // archive#1497 — the rename still preserves the stored definition
        // (`tabs` survives, which is what this test is about), but a coding
        // layout's `workingDirectory` is no longer persisted: the seeded
        // pre-fix copy is cleared by this write and the value is derived from
        // the owning project on read. See
        // `__tests__/layout-working-directory.test.ts`.
        config: { tabs: [] },
        createdAt: now,
      });
      // `toMatchObject` above is recursive-partial and would also pass with the
      // stale copy still present, so the clearing needs its own exact
      // assertion. (The on-disk proof lives in
      // `layout-working-directory.test.ts`; this keeps the claim in the
      // comment above true of this test too.)
      expect(storage.getLayout('real-project', 'coding').config).toEqual({
        tabs: [],
      });
      expect(await app.request('/real-project/layouts/coding')).toHaveProperty(
        'status',
        200,
      );
      expect(await app.request('/real-project/layouts')).toHaveProperty(
        'status',
        200,
      );

      const identityMismatch = await app.request(
        '/real-project/layouts/coding',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'other-layout', name: 'Rejected' }),
        },
      );
      expect(identityMismatch.status).toBe(409);
      expect(storage.getLayout('real-project', 'coding').name).toBe('Renamed');

      const missing = await app.request('/real-project/layouts/missing', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Missing' }),
      });
      expect(missing.status).toBe(404);
      const malformed = await app.request('/real-project/layouts/coding', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '' }),
      });
      expect(malformed.status).toBe(400);
    });
  });

  // archive#1004 §3.3 / §6: deleting a project is a passive `rmSync` of the
  // project's own directory only — no agent cascade exists, so an agent
  // owned by the deleted project is orphaned VISIBLY (survives on disk,
  // ownership intact, flagged by `agentOwnershipFinding` once the project
  // is gone from the catalog) rather than silently deleted. This is the
  // tripwire against any future cascade being added.
  describe('project deletion leaves owned agents intact (station#1004 §3.3/§6)', () => {
    test('deleting a project leaves its owned agents on disk with ownership intact', async () => {
      const projectHomeDir = createTempProjectHome();
      const storage = new FileStorageAdapter(projectHomeDir);
      const projectService = new ProjectService(storage);
      const app = createProjectRoutes(
        projectService as any,
        storage as any,
        projectHomeDir,
      );

      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Doomed Project',
          slug: 'doomed-project',
        }),
      });
      await saveAgentConfig(projectHomeDir, 'owned-agent', {
        name: 'Owned Agent',
        prompt: 'You are owned by doomed-project.',
        project: 'doomed-project',
      });

      const deleteRes = await app.request('/doomed-project', {
        method: 'DELETE',
      });
      expect(deleteRes.status).toBe(200);

      // Never silently deleted: the agent record survives with its
      // ownership untouched.
      const spec = await loadAgentConfig(projectHomeDir, 'owned-agent');
      expect(spec.project).toBe('doomed-project');

      // Orphaned VISIBLY: with the project gone from the catalog, the same
      // finding helper the API/editor/list use now flags it.
      const finding = agentOwnershipFinding(spec.project, new Set());
      expect(finding).toEqual({
        code: 'unknown_owner_project',
        project: 'doomed-project',
        message:
          "This agent's owning project 'doomed-project' no longer exists.",
      });
    });
  });
  // ── archive#1502: the resolution surface ────────────────────────
  //
  // Built over REAL stores on a temp home. The states under test are produced
  // by the resolver from on-disk facts rather than handed in by a fake, so a
  // test cannot pass by asserting what it already stubbed.
  describe('the resolution surface (station#1502, §3.6/§4.1)', () => {
    type RemoteReader = (absolutePath: string) => Promise<
      | { ok: true; remotes: { name: string; url: string }[] }
      | {
          ok: false;
          reason: string;
        }
    >;

    function remotesOk(urls: string[]): RemoteReader {
      return async () => ({
        ok: true,
        remotes: urls.map((url, index) => ({
          name: index === 0 ? 'origin' : `remote-${index}`,
          url,
        })),
      });
    }

    const remotesUnreadable: RemoteReader = async () => ({
      ok: false,
      reason: 'git is not installed on this host',
    });

    function createResolutionApp(
      readRemotes: RemoteReader = remotesOk([]),
      // archive#1502 fix round, MEDIUM-3: lets a test make the POST-write
      // RE-DERIVATION fail while the write itself succeeds.
      overrideResolver?: { resolveProjectResource: (...args: any[]) => any },
    ) {
      const projectHomeDir = createTempProjectHome();
      const storage = new FileStorageAdapter(projectHomeDir);
      const projectService = new ProjectService(storage);
      const bindings = new ProjectBindingsStore(projectHomeDir);
      const manifests = new ProjectManifestStore(projectHomeDir, storage, {
        bindings,
        readRemotes: readRemotes as any,
      });
      const resolver =
        overrideResolver ??
        new ProjectResourceResolver({
          homeDir: projectHomeDir,
          source: storage,
          bindings,
          manifests,
          readRemotes: readRemotes as any,
        });
      const app = createProjectRoutes(
        projectService as any,
        storage as any,
        projectHomeDir,
        {
          resolution: {
            resolver: resolver as any,
            manifests,
            bindings,
            readRemotes: readRemotes as any,
          },
        },
      );
      return { app, projectHomeDir, storage, bindings, manifests };
    }

    async function saveProject(
      storage: any,
      slug: string,
      workingDirectory?: string,
    ) {
      const now = new Date().toISOString();
      await putProject(storage, {
        id: `id-${slug}`,
        slug,
        name: slug,
        createdAt: now,
        updatedAt: now,
        ...(workingDirectory === undefined ? {} : { workingDirectory }),
      });
    }

    function writeManifest(
      projectHomeDir: string,
      slug: string,
      id: string,
      repos: unknown[],
    ) {
      mkdirSync(join(projectHomeDir, 'projects', slug), { recursive: true });
      writeFileSync(
        projectManifestPath(projectHomeDir, slug),
        JSON.stringify({
          schemaVersion: 1,
          id,
          repos,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
        'utf-8',
      );
    }

    function writeRawManifest(
      projectHomeDir: string,
      slug: string,
      contents: string,
    ) {
      mkdirSync(join(projectHomeDir, 'projects', slug), { recursive: true });
      writeFileSync(
        projectManifestPath(projectHomeDir, slug),
        contents,
        'utf-8',
      );
    }

    const gitRepo = (
      canonicalRemote: string,
      role?: 'primary' | 'secondary',
    ) => ({
      kind: 'git',
      id: canonicalRemote,
      canonicalRemote,
      ...(role ? { role } : {}),
    });

    test('GET /:slug/resolution reports `not-backing` for a project that declares nothing and realizes nothing', async () => {
      const { app, storage } = createResolutionApp();
      await saveProject(storage, 'plain');

      const body = await json(await app.request('/plain/resolution'));

      expect(body).toEqual({ success: true, data: { posture: 'not-backing' } });
    });

    test('GET /:slug/resolution reports `bound` when the working directory verifies as the declared resource', async () => {
      const checkout = createTempProjectHome();
      const { app, storage, projectHomeDir } = createResolutionApp(
        remotesOk(['git@github.com:acme/api.git']),
      );
      await saveProject(storage, 'acme', checkout);
      writeManifest(projectHomeDir, 'acme', 'prj_acme', [
        gitRepo('github.com/acme/api', 'primary'),
      ]);

      const body = await json(await app.request('/acme/resolution'));

      expect(body.success).toBe(true);
      expect(body.data).toEqual({
        posture: 'backing',
        resources: [
          {
            state: 'bound',
            resourceId: 'github.com/acme/api',
            path: checkout,
          },
        ],
        primary: { named: true, resourceId: 'github.com/acme/api' },
      });
    });

    test('GET /:slug/resolution reports `unbound` when a resource is declared and nothing here realizes it', async () => {
      const { app, storage, projectHomeDir } = createResolutionApp();
      await saveProject(storage, 'acme');
      writeManifest(projectHomeDir, 'acme', 'prj_acme', [
        gitRepo('github.com/acme/api', 'primary'),
      ]);

      const body = await json(await app.request('/acme/resolution'));

      expect(body.data.posture).toBe('backing');
      expect(body.data.resources[0].state).toBe('unbound');
      // `unbound` names no path of any kind — there is nothing recorded to
      // name. That is the whole difference from `missing` below.
      expect('declaredPath' in body.data.resources[0]).toBe(false);
      expect('path' in body.data.resources[0]).toBe(false);
      expect('unverifiedPath' in body.data.resources[0]).toBe(false);
    });

    test('GET /:slug/resolution reports `missing` — with the record and the declared path — when a declared directory is gone', async () => {
      const { app, storage, projectHomeDir } = createResolutionApp();
      await saveProject(storage, 'acme', '/definitely/not/here');
      writeManifest(projectHomeDir, 'acme', 'prj_acme', [
        gitRepo('github.com/acme/api', 'primary'),
      ]);

      const body = await json(await app.request('/acme/resolution'));

      expect(body.data.posture).toBe('backing');
      expect(body.data.resources[0].state).toBe('missing');
      expect(body.data.resources[0].record).toBe('working-directory');
      expect(body.data.resources[0].declaredPath).toBe('/definitely/not/here');
    });

    test('GET /:slug/resolution reports `drifted` — carrying the observation — when the checkout is a different repository', async () => {
      const checkout = createTempProjectHome();
      const { app, storage, projectHomeDir } = createResolutionApp(
        remotesOk(['git@github.com:someone/else.git']),
      );
      await saveProject(storage, 'acme', checkout);
      writeManifest(projectHomeDir, 'acme', 'prj_acme', [
        gitRepo('github.com/acme/api', 'primary'),
      ]);

      const body = await json(await app.request('/acme/resolution'));

      expect(body.data.resources[0].state).toBe('drifted');
      expect(body.data.resources[0].unverifiedPath).toBe(checkout);
      // The ANSWER slot stays empty: a directory was observed, not verified.
      expect('path' in body.data.resources[0]).toBe(false);
    });

    test('GET /:slug/resolution reports `stale` when the verification could not be run', async () => {
      const checkout = createTempProjectHome();
      const { app, storage, projectHomeDir } =
        createResolutionApp(remotesUnreadable);
      await saveProject(storage, 'acme', checkout);
      writeManifest(projectHomeDir, 'acme', 'prj_acme', [
        gitRepo('github.com/acme/api', 'primary'),
      ]);

      const body = await json(await app.request('/acme/resolution'));

      expect(body.data.resources[0].state).toBe('stale');
      expect(body.data.resources[0].unverifiedPath).toBe(checkout);
      expect('path' in body.data.resources[0]).toBe(false);
    });

    test('GET /:slug/resolution reports `ambiguous` — naming no resource, exposing no repos — for a manifest with two primaries', async () => {
      const { app, storage, projectHomeDir } = createResolutionApp();
      await saveProject(storage, 'acme');
      writeManifest(projectHomeDir, 'acme', 'prj_acme', [
        gitRepo('github.com/acme/api', 'primary'),
        gitRepo('github.com/acme/web', 'primary'),
      ]);

      const response = await app.request('/acme/resolution');
      const raw = await response.clone().text();
      const body = await json(response);

      expect(body.data.posture).toBe('backing');
      // archive#1503: each declared resource still resolves BY ID; the
      // ambiguity is the PRIMARY selection's, and it is what a no-`resourceId`
      // consumer would hit.
      expect(
        body.data.resources.map(
          (entry: { resourceId: string }) => entry.resourceId,
        ),
      ).toEqual(['github.com/acme/api', 'github.com/acme/web']);
      expect(body.data.primary.named).toBe(false);
      expect(body.data.primary.reason).toContain('github.com/acme/api');
      // Trap 2 on the wire: `composeManifest` hands the route a populated
      // `repos` for this INVALID manifest, and none of it crosses the boundary.
      expect(raw).not.toContain('canonicalRemote');
      expect(body.data.repos).toBeUndefined();
    });

    test.each([
      [
        'an unknown schemaVersion',
        JSON.stringify({
          schemaVersion: 99,
          id: 'prj_future',
          repos: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
      ],
      ['corrupt content', '{ not json'],
      ['a zero-length sidecar', ''],
    ])(
      'GET /:slug/resolution reports `unreadable` (never `not-backing`) for %s',
      async (_label, contents) => {
        const { app, storage, projectHomeDir } = createResolutionApp();
        await saveProject(storage, 'acme');
        writeRawManifest(projectHomeDir, 'acme', contents);

        const response = await app.request('/acme/resolution');
        const body = await json(response);

        expect(response.status).toBe(200);
        expect(body.data.posture).toBe('unreadable');
        expect(typeof body.data.reason).toBe('string');
        expect(body.data.reason.length).toBeGreaterThan(0);
      },
    );

    test('GET /:slug/resolution 404s an unknown project', async () => {
      const { app } = createResolutionApp();

      const response = await app.request('/ghost/resolution');
      const body = await json(response);

      expect(response.status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
    });

    test('POST /:slug/bind records the binding when the candidate verifies, and answers with the re-derived view', async () => {
      const checkout = createTempProjectHome();
      const { app, storage, projectHomeDir, bindings } = createResolutionApp(
        remotesOk(['git@github.com:acme/api.git']),
      );
      await saveProject(storage, 'acme');
      writeManifest(projectHomeDir, 'acme', 'prj_acme', [
        gitRepo('github.com/acme/api', 'primary'),
      ]);

      const response = await app.request('/acme/bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: checkout }),
      });
      const body = await json(response);

      expect(response.status).toBe(200);
      expect(body.data).toEqual({
        recorded: true,
        view: {
          posture: 'backing',
          resources: [
            {
              state: 'bound',
              resourceId: 'github.com/acme/api',
              path: checkout,
            },
          ],
          primary: { named: true, resourceId: 'github.com/acme/api' },
        },
      });
      const written = bindings.findBinding('prj_acme', 'github.com/acme/api');
      expect(written?.path).toBe(checkout);
      expect(written?.remotes).toEqual(['github.com/acme/api']);
      expect(written?.state).toBe('bound');
    });

    // ── archive#1503 review H2 — a PLUGIN may not anchor to a project repo ─

    test('applying a plugin layout REFUSES a repo-anchored namespace, before any write', async () => {
      // A plugin cannot know a project's declared resources — those are
      // canonical remotes specific to that project — so any `repoRoot` it
      // declares is a guess, and a wrong guess makes the manifest UNREADABLE
      // and fails every seam closed until someone hand-edits storage.
      const projectHomeDir = createTempProjectHome();
      const storage = new FileStorageAdapter(projectHomeDir);
      const projectService = new ProjectService(storage);
      await saveProject(storage, 'acme');
      const layoutCatalog = {
        resolveForApply: () => ({
          item: { source: 'plugin' },
          pluginName: 'docs-plugin',
          definition: {
            type: 'coding',
            name: 'Docs',
            slug: 'docs',
            tabs: [],
          },
        }),
        getPluginManifest: () => ({
          name: 'docs-plugin',
          knowledge: {
            namespaces: [
              {
                id: 'plugin-docs',
                label: 'Plugin docs',
                behavior: 'rag',
                repoRoot: { repoId: 'github.com/acme/api', path: 'docs' },
              },
            ],
          },
        }),
        listLayouts: () => [],
      };
      const app = createProjectRoutes(
        projectService as any,
        storage as any,
        projectHomeDir,
        { layoutCatalog: layoutCatalog as any, listAgents: async () => [] },
      );

      const response = await app.request('/acme/layouts/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layoutId: 'plugin:docs-plugin' }),
      });
      const body = await json(response);

      expect(response.status).toBe(400);
      expect(body.error).toContain('docs-plugin');
      expect(body.error).toContain('plugin-docs');
      // Refused before namespace convergence or Layout creation.
      expect(storage.listLayouts('acme')).toHaveLength(0);
      expect(storage.getProject('acme').knowledgeNamespaces).toBeUndefined();
    });

    test('applying a plugin layout with an UNANCHORED namespace still works', async () => {
      // The negative control: the guard refuses the anchor, not the feature.
      const projectHomeDir = createTempProjectHome();
      const storage = new FileStorageAdapter(projectHomeDir);
      const projectService = new ProjectService(storage);
      await saveProject(storage, 'acme');
      const layoutCatalog = {
        resolveForApply: () => ({
          item: { source: 'plugin' },
          pluginName: 'docs-plugin',
          definition: {
            type: 'coding',
            name: 'Docs',
            slug: 'docs',
            tabs: [],
          },
        }),
        getPluginManifest: () => ({
          name: 'docs-plugin',
          knowledge: {
            namespaces: [
              { id: 'plugin-docs', label: 'Plugin docs', behavior: 'rag' },
            ],
          },
        }),
        listLayouts: () => [],
      };
      const app = createProjectRoutes(
        projectService as any,
        storage as any,
        projectHomeDir,
        { layoutCatalog: layoutCatalog as any, listAgents: async () => [] },
      );

      const response = await app.request('/acme/layouts/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layoutId: 'plugin:docs-plugin' }),
      });

      expect(response.status).toBe(201);
      expect(
        storage.getProject('acme').knowledgeNamespaces?.map((n: any) => n.id),
      ).toEqual(['plugin-docs']);
    });

    // ── archive#1503 review H2 — repo anchors are refused at the WRITE ────

    test('PUT /:slug refuses a knowledge anchor naming an UNDECLARED repo', async () => {
      // The read side already fails such a project closed as `unreadable`,
      // which is the right outcome in a terrible place: it takes out the
      // session cwd, the knowledge scan, the task workspace and the resolution
      // surface at once, long after whoever caused it has gone.
      const { app, storage, projectHomeDir } = createResolutionApp();
      await saveProject(storage, 'acme');
      writeManifest(projectHomeDir, 'acme', 'prj_acme', [
        gitRepo('github.com/acme/api', 'primary'),
      ]);

      const response = await app.request('/acme', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          knowledgeNamespaces: [
            {
              id: 'api-docs',
              label: 'API docs',
              behavior: 'rag',
              repoRoot: { repoId: 'github.com/acme/ghost', path: 'docs' },
            },
          ],
        }),
      });
      const body = await json(response);

      expect(response.status).toBe(400);
      expect(body.error).toContain('github.com/acme/ghost');
      // Names what IS declared, so the refusal is actionable.
      expect(body.error).toContain('github.com/acme/api');
      // And the project is untouched: the manifest still reads.
      expect(storage.getProject('acme').knowledgeNamespaces).toBeUndefined();
    });

    test.each([
      ['an absolute path', '/etc'],
      ['a parent escape', '../../etc'],
      ['an empty path', ''],
    ])(
      'PUT /:slug refuses a knowledge anchor with %s even for a DECLARED repo',
      async (_label, path) => {
        const { app, storage, projectHomeDir } = createResolutionApp();
        await saveProject(storage, 'acme');
        writeManifest(projectHomeDir, 'acme', 'prj_acme', [
          gitRepo('github.com/acme/api', 'primary'),
        ]);

        const response = await app.request('/acme', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            knowledgeNamespaces: [
              {
                id: 'api-docs',
                label: 'API docs',
                behavior: 'rag',
                repoRoot: { repoId: 'github.com/acme/api', path },
              },
            ],
          }),
        });

        expect(response.status).toBe(400);
        expect((await json(response)).error).toContain('repo-relative');
      },
    );

    test('PUT /:slug ACCEPTS an anchor naming a declared repo', async () => {
      // The negative control: the guard refuses what is wrong and nothing else.
      const { app, storage, projectHomeDir } = createResolutionApp();
      await saveProject(storage, 'acme');
      writeManifest(projectHomeDir, 'acme', 'prj_acme', [
        gitRepo('github.com/acme/api', 'primary'),
      ]);

      const response = await app.request('/acme', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          knowledgeNamespaces: [
            {
              id: 'api-docs',
              label: 'API docs',
              behavior: 'rag',
              repoRoot: { repoId: 'github.com/acme/api', path: 'docs' },
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      expect(
        storage.getProject('acme').knowledgeNamespaces?.[0]?.repoRoot,
      ).toEqual({ repoId: 'github.com/acme/api', path: 'docs' });
    });

    test('PUT /:slug runs SHAPE checks even when nothing declares repos', async () => {
      // No manifest record: the declared-id check is skipped (with no record
      // `composeManifest` never runs, so the unreadable failure is unreachable)
      // but a traversal-shaped path is wrong regardless — it is about to be
      // joined onto a resolved checkout.
      const { app, storage } = createResolutionApp();
      await saveProject(storage, 'acme');

      const response = await app.request('/acme', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          knowledgeNamespaces: [
            {
              id: 'api-docs',
              label: 'API docs',
              behavior: 'rag',
              repoRoot: { repoId: 'anything', path: '../../etc' },
            },
          ],
        }),
      });

      expect(response.status).toBe(400);
      expect((await json(response)).error).toContain('repo-relative');
    });

    // ── archive#1503 — the repair action names ITS resource ────────

    test('POST /:slug/bind records the NAMED resource, not the primary', async () => {
      // A multi-repo project renders one repair form per row. A bind that
      // ignored `resourceId` would write the primary's binding whichever row
      // the operator used — the "the copy names one thing while the button
      // writes another" defect, one resource over.
      const checkout = createTempProjectHome();
      const { app, storage, projectHomeDir, bindings } = createResolutionApp(
        remotesOk(['git@github.com:acme/web.git']),
      );
      await saveProject(storage, 'acme');
      writeManifest(projectHomeDir, 'acme', 'prj_acme', [
        gitRepo('github.com/acme/api', 'primary'),
        gitRepo('github.com/acme/web', 'secondary'),
      ]);

      const response = await app.request('/acme/bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: checkout,
          resourceId: 'github.com/acme/web',
        }),
      });

      expect(response.status).toBe(200);
      expect(
        bindings.findBinding('prj_acme', 'github.com/acme/web')?.path,
      ).toBe(checkout);
      // And nothing was written for the primary.
      expect(
        bindings.findBinding('prj_acme', 'github.com/acme/api'),
      ).toBeUndefined();
    });

    test('POST /:slug/bind REFUSES an UNKNOWN resourceId rather than binding the primary', async () => {
      const checkout = createTempProjectHome();
      const { app, storage, projectHomeDir, bindings } = createResolutionApp(
        remotesOk(['git@github.com:acme/api.git']),
      );
      await saveProject(storage, 'acme');
      writeManifest(projectHomeDir, 'acme', 'prj_acme', [
        gitRepo('github.com/acme/api', 'primary'),
      ]);

      const response = await app.request('/acme/bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: checkout,
          resourceId: 'github.com/acme/ghost',
        }),
      });
      const body = await json(response);

      expect(response.status).toBe(400);
      expect(body.error).toContain('github.com/acme/ghost');
      // Names what IS declared, so the refusal is actionable.
      expect(body.error).toContain('github.com/acme/api');
      expect(
        bindings.findBinding('prj_acme', 'github.com/acme/api'),
      ).toBeUndefined();
    });

    test('POST /:slug/bind WITHOUT a resourceId still binds the primary (slice 4 behaviour)', async () => {
      const checkout = createTempProjectHome();
      const { app, storage, projectHomeDir, bindings } = createResolutionApp(
        remotesOk(['git@github.com:acme/api.git']),
      );
      await saveProject(storage, 'acme');
      writeManifest(projectHomeDir, 'acme', 'prj_acme', [
        gitRepo('github.com/acme/api', 'primary'),
        gitRepo('github.com/acme/web', 'secondary'),
      ]);

      const response = await app.request('/acme/bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: checkout }),
      });

      expect(response.status).toBe(200);
      expect(
        bindings.findBinding('prj_acme', 'github.com/acme/api')?.path,
      ).toBe(checkout);
    });

    test('POST /:slug/bind REFUSES a path that does not exist, and writes no binding', async () => {
      const { app, storage, projectHomeDir, bindings } = createResolutionApp(
        remotesOk(['git@github.com:acme/api.git']),
      );
      await saveProject(storage, 'acme');
      writeManifest(projectHomeDir, 'acme', 'prj_acme', [
        gitRepo('github.com/acme/api', 'primary'),
      ]);

      const response = await app.request('/acme/bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/definitely/not/here' }),
      });
      const body = await json(response);

      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('/definitely/not/here');
      expect(body.error).toContain('does not exist');
      // §3.6: never silently re-bind. A refusal records NOTHING.
      expect(
        bindings.findBinding('prj_acme', 'github.com/acme/api'),
      ).toBeUndefined();
    });

    test('POST /:slug/bind REFUSES a checkout whose remotes do not intersect, and writes no binding', async () => {
      const checkout = createTempProjectHome();
      const { app, storage, projectHomeDir, bindings } = createResolutionApp(
        remotesOk(['git@github.com:someone/else.git']),
      );
      await saveProject(storage, 'acme');
      writeManifest(projectHomeDir, 'acme', 'prj_acme', [
        gitRepo('github.com/acme/api', 'primary'),
      ]);

      const response = await app.request('/acme/bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: checkout }),
      });
      const body = await json(response);

      expect(response.status).toBe(409);
      expect(body.success).toBe(false);
      expect(body.error).toContain('github.com/someone/else');
      expect(body.error).toContain('different repository');
      // The one that matters: a verified-elsewhere checkout is NOT recorded.
      expect(
        bindings.findBinding('prj_acme', 'github.com/acme/api'),
      ).toBeUndefined();
    });

    test('POST /:slug/bind refuses a body with no path before it touches any store', async () => {
      const { app, storage } = createResolutionApp();
      await saveProject(storage, 'acme');

      const response = await app.request('/acme/bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '' }),
      });

      expect(response.status).toBe(400);
    });

    test('POST /:slug/bind 404s an unknown project', async () => {
      const checkout = createTempProjectHome();
      const { app } = createResolutionApp();

      const response = await app.request('/ghost/bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: checkout }),
      });

      expect(response.status).toBe(404);
    });

    // ── archive#1502 fix round ─────────────────────────────────────────────

    test('POST /:slug/bind REFUSES a remote-less directory WITHOUT claiming it is a different repository (HIGH-4)', async () => {
      // `readCheckoutRemotes` answers `{ok: true, remotes: []}` for BOTH "not a
      // git repository at all" (exit 128, no `.git` above it) and "a real repo
      // with no remote configured yet". Neither establishes an identity, so
      // neither supports the sentence "It is a different repository" — nor the
      // action "bind it to the resource it actually is", which names nothing
      // for a directory that is no repository.
      const checkout = createTempProjectHome();
      const { app, storage, projectHomeDir, bindings } = createResolutionApp(
        remotesOk([]),
      );
      await saveProject(storage, 'acme');
      writeManifest(projectHomeDir, 'acme', 'prj_acme', [
        gitRepo('github.com/acme/api', 'primary'),
      ]);

      const response = await app.request('/acme/bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: checkout }),
      });
      const body = await json(response);

      expect(response.status).toBe(409);
      expect(body.success).toBe(false);
      // `describeCheckoutRemotes`'s words, reused rather than re-implemented.
      expect(body.error).toContain('advertises no remotes');
      // The three claims the input does not support.
      expect(body.error).not.toContain('[]');
      expect(body.error).not.toContain('different repository');
      expect(body.error).not.toContain('the resource it actually is');
      // What it says instead.
      expect(body.error).toContain('could not establish which repository');
      expect(body.error).toContain('Nothing was recorded');
      expect(
        bindings.findBinding('prj_acme', 'github.com/acme/api'),
      ).toBeUndefined();
    });

    test('POST /:slug/bind still says "different repository" when an identity WAS established', async () => {
      // The negative control for the branch above: a checkout that really does
      // advertise a remote set keeps the positive identity claim, because here
      // the input supports it.
      const checkout = createTempProjectHome();
      const { app, storage, projectHomeDir } = createResolutionApp(
        remotesOk(['git@github.com:someone/else.git']),
      );
      await saveProject(storage, 'acme');
      writeManifest(projectHomeDir, 'acme', 'prj_acme', [
        gitRepo('github.com/acme/api', 'primary'),
      ]);

      const body = await json(
        await app.request('/acme/bind', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: checkout }),
        }),
      );

      expect(body.error).toContain('different repository');
      expect(body.error).toContain('github.com/someone/else');
    });

    test('POST /:slug/bind records a DIRECTORY on the local-only branch (MEDIUM-2)', async () => {
      const checkout = createTempProjectHome();
      const { app, storage, projectHomeDir, bindings } = createResolutionApp();
      await saveProject(storage, 'acme');
      writeManifest(projectHomeDir, 'acme', 'prj_acme', [
        { kind: 'local-only', id: 'local:acme' },
      ]);

      const response = await app.request('/acme/bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: checkout }),
      });

      expect(response.status).toBe(200);
      const written = bindings.findBinding('prj_acme', 'local:acme');
      expect(written?.path).toBe(checkout);
      expect(written?.kind).toBe('local-directory');
      expect(written?.state).toBe('bound');
    });

    test('POST /:slug/bind REFUSES a regular FILE on the local-only branch, and writes no binding (MEDIUM-2)', async () => {
      // `existsSync` is true for a regular file and for a symlink to one. A
      // recorded binding is handed to seams as a WORKSPACE DIRECTORY and shown
      // under the `bound` ANSWER slot, so a file recorded as `bound` is a
      // verified-just-now claim about a check that only asked for an inode.
      const dir = createTempProjectHome();
      const file = join(dir, 'not-a-directory.txt');
      writeFileSync(file, 'i am a file', 'utf-8');
      const { app, storage, projectHomeDir, bindings } = createResolutionApp();
      await saveProject(storage, 'acme');
      writeManifest(projectHomeDir, 'acme', 'prj_acme', [
        { kind: 'local-only', id: 'local:acme' },
      ]);

      const response = await app.request('/acme/bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: file }),
      });
      const body = await json(response);

      expect(response.status).toBe(400);
      expect(body.error).toContain('is not a directory');
      expect(bindings.findBinding('prj_acme', 'local:acme')).toBeUndefined();
    });

    test('POST /:slug/bind REFUSES a RELATIVE path outright (MEDIUM-2)', async () => {
      // `resolve()` would base it on the server process's cwd — a directory
      // the operator never chose and cannot see.
      const { app, storage, projectHomeDir, bindings } = createResolutionApp();
      await saveProject(storage, 'acme');
      writeManifest(projectHomeDir, 'acme', 'prj_acme', [
        { kind: 'local-only', id: 'local:acme' },
      ]);

      const response = await app.request('/acme/bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'station' }),
      });
      const body = await json(response);

      expect(response.status).toBe(400);
      expect(body.error).toContain('relative path');
      expect(bindings.findBinding('prj_acme', 'local:acme')).toBeUndefined();
    });

    test('POST /:slug/bind REFUSES `no-resources-declared` for a manifest-less project (HIGH-3, at the route)', async () => {
      // The refusal the `missing` + `working-directory` repair form would have
      // hit EVERY time: there is no manifest, so there is no key to bind
      // against. `ensureProjectManifest` has one caller (`createProject`), so
      // every pre-slice-2 project is permanently in this state.
      const checkout = createTempProjectHome();
      const { app, storage } = createResolutionApp();
      await saveProject(storage, 'acme');

      const response = await app.request('/acme/bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: checkout }),
      });
      const body = await json(response);

      expect(response.status).toBe(409);
      expect(body.error).toContain('has no manifest yet');
      expect(body.error).toContain('working directory');
    });

    test('POST /:slug/bind REFUSES `ambiguous` when no single resource can be named', async () => {
      const checkout = createTempProjectHome();
      const { app, storage, projectHomeDir } = createResolutionApp();
      await saveProject(storage, 'acme');
      writeManifest(projectHomeDir, 'acme', 'prj_acme', [
        gitRepo('github.com/acme/api'),
        gitRepo('github.com/acme/web'),
      ]);

      const response = await app.request('/acme/bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: checkout }),
      });
      const body = await json(response);

      expect(response.status).toBe(409);
      expect(body.error).toContain('no single resource to bind');
      expect(body.error).toContain('github.com/acme/api');
    });

    test('POST /:slug/bind REFUSES `unverifiable` when the checkout could not be read', async () => {
      const checkout = createTempProjectHome();
      const { app, storage, projectHomeDir, bindings } =
        createResolutionApp(remotesUnreadable);
      await saveProject(storage, 'acme');
      writeManifest(projectHomeDir, 'acme', 'prj_acme', [
        gitRepo('github.com/acme/api', 'primary'),
      ]);

      const response = await app.request('/acme/bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: checkout }),
      });
      const body = await json(response);

      expect(response.status).toBe(409);
      expect(body.error).toContain('git is not installed on this host');
      expect(body.error).toContain('Nothing was recorded');
      expect(
        bindings.findBinding('prj_acme', 'github.com/acme/api'),
      ).toBeUndefined();
    });

    test('a bind whose RE-DERIVATION throws still reports the write as recorded (MEDIUM-3)', async () => {
      // The write is durable the instant it returns. Answering the follow-up
      // read's failure with `success: false` titles a completed repair "That
      // checkout was not recorded" and sends the operator to redo it.
      const checkout = createTempProjectHome();
      const boom = new Error('the disk caught fire');
      const { app, storage, projectHomeDir, bindings } = createResolutionApp(
        remotesOk(['git@github.com:acme/api.git']),
        {
          resolveProjectResource: async () => {
            throw boom;
          },
        },
      );
      await saveProject(storage, 'acme');
      writeManifest(projectHomeDir, 'acme', 'prj_acme', [
        gitRepo('github.com/acme/api', 'primary'),
      ]);

      const response = await app.request('/acme/bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: checkout }),
      });
      const body = await json(response);

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.recorded).toBe(true);
      expect(body.data.view).toBeUndefined();
      expect(body.data.gap).toContain('The binding was recorded');
      expect(body.data.gap).toContain('the disk caught fire');
      // The claim the envelope makes, checked against the store.
      expect(
        bindings.findBinding('prj_acme', 'github.com/acme/api')?.path,
      ).toBe(checkout);
    });

    test('both resolution routes answer 501 when the runtime did not configure them', async () => {
      const projectHomeDir = createTempProjectHome();
      const storage = new FileStorageAdapter(projectHomeDir);
      const app = createProjectRoutes(
        new ProjectService(storage) as any,
        storage as any,
        projectHomeDir,
        {},
      );

      const read = await app.request('/acme/resolution');
      expect(read.status).toBe(501);
      expect((await json(read)).error).toContain('not configured');

      const write = await app.request('/acme/bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/tmp' }),
      });
      expect(write.status).toBe(501);
      expect((await json(write)).error).toContain('not configured');
    });
  });
});
