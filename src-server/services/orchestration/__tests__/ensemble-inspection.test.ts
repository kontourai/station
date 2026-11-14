import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentMetadata } from '@kontourai/station-contracts/agent';
import { engineConnectionId } from '@kontourai/station-contracts/agent-identity';
import type { CliSessionGroupView } from '@kontourai/station-contracts/delegation-group';
import {
  ENSEMBLE_INSPECTION_LIMITS,
  type EnsembleInspection,
} from '@kontourai/station-contracts/ensemble';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { CodexAdapter } from '../../../providers/adapters/codex-adapter.js';
import { createEnsembleInspectionRoutes } from '../../../routes/orchestration/ensemble-inspection.js';
import { createOrchestrationRequestPrincipalResolver } from '../../../runtime/bootstrap/orchestration-request-principal.js';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import { createLogger } from '../../../utils/logger.js';
import { AgentService } from '../../agents/agent-service.js';
import { KnowledgeService } from '../../knowledge/knowledge-service.js';
import { SchedulerService } from '../../scheduling/scheduler-service.js';
import { FileSecretBindingAdministration } from '../../secrets/secret-binding-administration.js';
import { EnvironmentSecurityService } from '../../ssh/environment-security-service.js';
import { createLocalEnsembleInventory } from '../ensemble-execution-context.js';
import { EnsembleInspectionService } from '../ensemble-inspection.js';
import * as presets from '../ensemble-presets.js';
import { EventBus } from '../event-bus.js';

const temp = trackTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function fixture({
  observeProject = true,
  readGroup,
}: {
  observeProject?: boolean;
  readGroup?: (groupId: string) => Promise<CliSessionGroupView>;
} = {}) {
  vi.stubEnv('STATION_HOSTED_TENANT_REGISTRY_FILE', undefined);
  const root = await realpath(temp('ensemble-inspection-'));
  const home = join(root, 'home');
  await mkdir(home);
  const loader = new ConfigLoader({ projectHomeDir: home });
  await loader.loadStoredAppConfig();
  const storage = new FileStorageAdapter(home);
  const logger = createLogger({ name: 'inspection-test', level: 'error' });
  const agents = new AgentService(
    loader,
    storage,
    new Map(),
    new Map<string, AgentMetadata>(),
    new Map(),
    logger,
  );
  await loader.saveAppConfig({
    defaultModel: 'unused',
    invokeModel: '',
    structureModel: '',
    systemPrompt: 'SECRET_PROMPT',
    defaultWorkspaceIsolation: 'worktree',
  });
  await loader.saveAgent('reviewer', {
    name: 'Reviewer',
    prompt: 'SECRET_PROMPT',
    execution: { agentConnectionId: engineConnectionId('codex') },
    tools: { mcpServers: ['external'] },
  });
  await storage.createProject({
    id: 'project-id',
    slug: 'project',
    name: 'Project',
    workingDirectory: root,
    defaultWorkspaceIsolation: 'shared',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  });
  const preset = {
    version: 'station.ensemble/v1',
    id: 'team',
    name: 'Team',
    stationmaster: 'lead',
    members: [
      {
        id: 'lead',
        codename: 'Lead',
        color: '#123ABC',
        role: 'SECRET_ROLE',
        engine: 'codex',
        model: 'gpt-6.1-sol',
        reasoning: null,
        options: {},
        promptAppends: ['SECRET_PROMPT'],
      },
    ],
  };
  const path = join(root, 'team.json');
  const bytes = `${JSON.stringify(preset, null, 2)}\n`;
  await writeFile(path, bytes);
  const adapter = new CodexAdapter();
  const tripwires = [
    vi.spyOn(adapter, 'startSession'),
    vi.spyOn(adapter, 'sendTurn'),
    vi.spyOn(adapter, 'listModelCatalog'),
    vi.spyOn(adapter, 'observeExecutionAuthentication'),
    vi.spyOn(SchedulerService.prototype, 'listJobs'),
    vi.spyOn(KnowledgeService.prototype, 'getInjectContext'),
    vi.spyOn(KnowledgeService.prototype, 'getRAGContextDetailed'),
    vi.spyOn(FileSecretBindingAdministration.prototype, 'list'),
    vi.spyOn(FileSecretBindingAdministration.prototype, 'get'),
    vi.spyOn(
      FileSecretBindingAdministration.prototype,
      'resolveForIntegration',
    ),
    vi.spyOn(
      FileSecretBindingAdministration.prototype,
      'resolveForAcpProvider',
    ),
  ];
  for (const spy of tripwires)
    spy.mockImplementation(() => {
      throw new Error('Forbidden execution, discovery or secret call');
    });
  let onIntegration = () => {};
  const readIntegration = vi.fn((): ToolDef | undefined => {
    onIntegration();
    return {
      id: 'external',
      kind: 'mcp' as const,
      transport: 'stdio' as const,
      command: 'SECRET_COMMAND',
      args: ['SECRET_ARG'],
      env: { TOKEN: 'SECRET_ENV' },
      headers: { Authorization: 'SECRET_HEADER' },
      endpoint: 'https://user:SECRET_URL@example.test/?key=SECRET_QUERY',
    };
  });
  let environment = 'this-station';
  const inventory = createLocalEnsembleInventory({
    environmentId: () => environment,
    captureAgentConfigurationFence: (ids) =>
      agents.capturePreparationConfigurationFence(ids),
    getProjectRevision: (slug) => storage.projectRevision(slug),
    getProviderRevision: () => 1,
    getAgent: (id) => agents.getAgent(id),
    listEngineConnectionIdentities: async () => [
      { id: engineConnectionId('codex'), engineId: 'codex', type: 'codex' },
    ],
    loadAppConfig: () => loader.loadAppConfig(),
    getProject: (slug) => storage.getProject(slug),
    getProviderAdapter: () => adapter,
  });
  const security = new EnvironmentSecurityService({
    homeDir: join(root, 'security'),
  });
  const { credential: raw } = await security.initialize();
  const offer = security.devicePairing.createOffer({
    endpoint: 'http://127.0.0.1',
  });
  const requested = security.devicePairing.requestPairing({
    requesterPosition: 'off-box',
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: 'Local operator',
  });
  security.devicePairing.confirmRequest(requested.requestId, {
    kind: 'local-grant',
  });
  const local = security.devicePairing.exchange({
    offerId: offer.offerId,
    proof: offer.challenge,
    requestId: requested.requestId,
    locality: 'home-possession',
    mintKind: 'local-grant',
  });
  const browserOffer = security.devicePairing.createOffer({
    endpoint: 'http://127.0.0.1',
  });
  const browserRequest = security.devicePairing.requestPairing({
    requesterPosition: 'off-box',
    offerId: browserOffer.offerId,
    proof: browserOffer.challenge,
    deviceName: 'Host browser',
  });
  security.devicePairing.confirmRequest(browserRequest.requestId, {
    kind: 'ui-bootstrap',
  });
  const browser = security.devicePairing.exchange({
    offerId: browserOffer.offerId,
    proof: browserOffer.challenge,
    requestId: browserRequest.requestId,
    locality: 'home-possession',
    mintKind: 'ui-bootstrap',
  });
  const readProject = vi.fn((slug: string) => storage.getProject(slug));
  const service = new EnsembleInspectionService({
    security,
    inventory,
    readIntegration,
    ...(observeProject ? { readProject } : {}),
    observeKnowledgeRoots: () => storage.observeKnowledgeStoreRoots(),
  });
  const app = new Hono();
  configureRuntimeHttp({
    app: app as never,
    eventBus: new EventBus(),
    logger,
    security: {
      verifyCredential: (candidate, request) =>
        request !== undefined &&
        security.authorizeCredential(candidate, request),
      recognizeCredential: (candidate) => security.verifyCredential(candidate),
      resolveGrantedScope: (candidate) =>
        security.resolveGrantedScope(candidate),
      resolveCredentialAuthority: (candidate) =>
        security.verifyOperatorCredential(candidate)
          ? 'operator-credential'
          : security.identifyDevice(candidate)
            ? 'device-credential'
            : undefined,
      resolveCredentialDeviceId: (candidate) =>
        security.identifyDevice(candidate)?.id,
      resolveCredentialLocality: (candidate) =>
        security.credentialLocality(candidate),
      resolveCredentialMintKind: (candidate) =>
        security.credentialMintKind(candidate),
      allowedOrigins: [],
    },
  });
  const resolvePrincipal = createOrchestrationRequestPrincipalResolver({
    environmentSecurityService: security,
  });
  app.route(
    '/api/orchestration/ensembles',
    createEnsembleInspectionRoutes(
      service,
      resolvePrincipal,
      readGroup ? () => readGroup : undefined,
    ),
  );
  const hash = (await presets.loadEnsemblePreset(path)).sha256;
  const request = (body: unknown, token = local.credential) =>
    app.request('http://127.0.0.1/api/orchestration/ensembles/inspect', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const input = {
    path,
    expectedPresetHash: hash,
    bindings: { lead: { agent: 'reviewer', projectSlug: 'project' } },
  };
  return {
    app,
    request,
    input,
    path,
    bytes,
    root,
    storage,
    preset,
    loader,
    service,
    raw,
    browser: browser.credential,
    revokeBrowser: () =>
      security.devicePairing.revokeDevice(
        browser.device.id,
        'operator-credential',
      ),
    tripwires,
    readIntegration,
    readProject,
    setOnIntegration: (callback: () => void) => {
      onIntegration = callback;
    },
    setEnvironment: (value: string) => {
      environment = value;
    },
    revoke: () =>
      security.devicePairing.revokeDevice(
        local.device.id,
        'operator-credential',
      ),
  };
}

test('the authorized HTTP caller projects real Agent/Project owners without probing or leaking definitions', async () => {
  const f = await fixture();
  const response = await f.request(f.input);
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const body = (await response.json()) as { data: EnsembleInspection };
  expect(body.data.source.sha256).toBe(f.input.expectedPresetHash);
  expect(
    new Set(body.data.facts.map((fact: { category: string }) => fact.category))
      .size,
  ).toBe(7);
  expect(body.data.facts).toContainEqual(
    expect.objectContaining({
      id: 'workspace:lead',
      origin: 'authored',
      value: expect.stringContaining(f.root),
    }),
  );
  expect(body.data.facts).toContainEqual(
    expect.objectContaining({
      id: 'isolation:lead',
      origin: 'authored',
      value: expect.stringContaining('shared'),
    }),
  );
  expect(body.data.facts).toContainEqual(
    expect.objectContaining({
      id: 'tool:lead:external',
      state: 'unknown',
      value: expect.stringContaining('definition currency'),
    }),
  );
  expect(body.data.resolutions).toEqual([
    {
      memberId: 'lead',
      receipt: expect.objectContaining({
        agentId: 'reviewer',
        engine: { kind: 'connection', connectionId: 'codex' },
        provider: 'codex',
        workspace: expect.objectContaining({ projectSlug: 'project' }),
      }),
    },
  ]);
  expect(Object.keys(body.data.resolutions[0].receipt).sort()).toEqual(
    [
      'agentId',
      'engine',
      'environmentId',
      'modelLaunchPlan',
      'provider',
      'resolvedAt',
      'schemaVersion',
      'workspace',
    ].sort(),
  );
  expect(JSON.stringify(body)).not.toMatch(
    /SECRET_|preparationDefinitions|requestOptions|credentialProfile/,
  );
  for (const spy of f.tripwires) expect(spy).not.toHaveBeenCalled();
  expect(f.readIntegration).toHaveBeenCalledTimes(1);
});

test.each([
  [
    'project-setting',
    'project',
    'shared',
    'authored',
    'configured',
    'Project settings',
  ],
  [
    'directory',
    'directory',
    'shared',
    'authored',
    'configured',
    'Group workspace draft',
  ],
  [
    'inherited',
    'project',
    'worktree',
    'default',
    'configured',
    'Station workspace settings',
  ],
  [
    'builtin-shared',
    'project',
    'shared',
    'default',
    'configured',
    'Station workspace settings',
  ],
  [
    'unobserved-project',
    'project',
    'shared',
    'unknown',
    'unknown',
    'Project settings',
  ],
] as const)(
  'isolation provenance follows the actual resolved %s binding without probing',
  async (mode, kind, isolationMode, origin, state, owner) => {
    const f = await fixture({ observeProject: mode !== 'unobserved-project' });
    if (mode === 'inherited' || mode === 'builtin-shared') {
      const revision = f.storage.projectRevision('project');
      const { defaultWorkspaceIsolation: _removed, ...project } =
        revision.value;
      await revision.replace(project);
    }
    if (mode === 'builtin-shared') {
      const config = await f.loader.loadAppConfig();
      await f.loader.saveAppConfig({
        ...config,
        defaultWorkspaceIsolation: undefined,
      });
    }
    const input =
      mode !== 'directory'
        ? f.input
        : {
            ...f.input,
            bindings: {},
            groupBindings: {
              lead: {
                target: {
                  agent: 'reviewer',
                  expectedEngine: { kind: 'connection', connectionId: 'codex' },
                  workspace: { kind: 'directory' as const, cwd: f.root },
                },
                needs: [],
              },
            },
          };
    const response = await f.request(input);
    expect(response.status).toBe(200);
    const { data } = (await response.json()) as { data: EnsembleInspection };
    expect(data.resolutions[0].receipt.workspace).toMatchObject(
      kind === 'directory'
        ? { kind: 'directory', cwd: f.root }
        : { kind: 'project', workspaceIsolation: { mode: isolationMode } },
    );
    expect(data.facts).toContainEqual(
      expect.objectContaining({
        id: 'isolation:lead',
        origin,
        state,
        value: expect.stringContaining(isolationMode),
        owner: expect.objectContaining({
          label: owner,
          receipt: 'resolution:lead',
        }),
      }),
    );
    expect(
      data.facts.find((fact) => fact.id === 'isolation:lead')?.value,
    ).toContain('unverified');
    expect(JSON.stringify(data)).not.toMatch(/SECRET_/);
    for (const spy of f.tripwires) expect(spy).not.toHaveBeenCalled();
  },
);

test('unbound members retain all categories as missing or unavailable, not empty successful inventories', async () => {
  const f = await fixture();
  const response = await f.request({ path: f.path, bindings: {} });
  const body = (await response.json()) as { data: EnsembleInspection };
  expect(response.status).toBe(200);
  expect(body.data.facts).toContainEqual(
    expect.objectContaining({ id: 'workspace:lead', state: 'missing' }),
  );
  for (const category of [
    'routing/triggers',
    'memory',
    'schedules/webhooks',
    'output destinations',
  ])
    expect(body.data.facts).toContainEqual(
      expect.objectContaining({ category, state: 'unavailable' }),
    );
  expect(f.readIntegration).not.toHaveBeenCalled();
});

test('workspace and isolation owner links resolve to the selected Project editor', async () => {
  // Keep the browser's JSX type graph out of the server type lane.
  const {
    resolveViewFromPath,
  }: { resolveViewFromPath: (path: string) => unknown } = await import(
    new URL('../../../../src-ui/src/app-shell/routing.ts', import.meta.url).href
  );
  const f = await fixture();
  const response = await f.request(f.input);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: EnsembleInspection };
  for (const id of ['workspace:lead', 'isolation:lead']) {
    const href = body.data.facts.find((fact) => fact.id === id)?.owner.href;
    expect(href).toBeDefined();
    expect(resolveViewFromPath(href ?? '')).toEqual({
      type: 'project-edit',
      slug: f.input.bindings.lead.projectSlug,
    });
  }
});

test('malformed JSON is an invalid request before preset reads or owner enumeration', async () => {
  const f = await fixture();
  const load = vi.spyOn(presets, 'loadEnsemblePreset');
  const response = await f.request('{');
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    success: false,
    code: 'ensemble_inspection_invalid',
  });
  expect(load).not.toHaveBeenCalled();
  expect(f.readIntegration).not.toHaveBeenCalled();
});

test('raw operator and unauthenticated callers cannot cause a preset read or owner enumeration', async () => {
  const f = await fixture();
  const load = vi.spyOn(presets, 'loadEnsemblePreset');
  expect((await f.request(f.input, f.raw)).status).toBe(403);
  expect((await f.request(f.input, 'invalid')).status).toBe(401);
  expect(load).not.toHaveBeenCalled();
  expect(f.readIntegration).not.toHaveBeenCalled();
});

test.each(['source', 'agent', 'principal', 'environment'] as const)(
  'the HTTP response refuses changed %s custody after resolution',
  async (change) => {
    const f = await fixture();
    f.setOnIntegration(() => {
      if (change === 'source') writeFileSync(f.path, `${f.bytes}\n`);
      if (change === 'agent')
        writeFileSync(join(f.root, 'home/agents/reviewer/agent.json'), '{}');
      if (change === 'principal') f.revoke();
      if (change === 'environment') f.setEnvironment('different-station');
    });
    const response = await f.request(f.input);
    expect(response.status).toBe(change === 'principal' ? 403 : 409);
    expect(await response.text()).not.toContain('SECRET_');
  },
);

test('stale bytes, extra members, malformed selections and oversized bodies are refused safely', async () => {
  const f = await fixture();
  expect(
    (
      await f.request({
        ...f.input,
        expectedPresetHash: `sha256:${'0'.repeat(64)}`,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await f.request({
        ...f.input,
        bindings: { extra: f.input.bindings.lead },
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await f.request({
        ...f.input,
        bindings: { lead: { ...f.input.bindings.lead, model: 'substitute' } },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await f.request({
        path: 'x'.repeat(ENSEMBLE_INSPECTION_LIMITS.requestBytes),
        bindings: {},
      })
    ).status,
  ).toBe(413);
  expect(f.readIntegration).not.toHaveBeenCalled();
});

test('a missing exact receiver never silently substitutes another engine', async () => {
  const f = await fixture();
  const response = await f.request({
    ...f.input,
    bindings: { lead: { agent: 'missing', projectSlug: 'project' } },
  });
  const body = (await response.json()) as { data: EnsembleInspection };
  expect(body.data.resolutions).toEqual([]);
  expect(body.data.facts).toContainEqual(
    expect.objectContaining({ id: 'binding:lead', state: 'unavailable' }),
  );
  expect(body.data.facts).toContainEqual(
    expect.objectContaining({ id: 'tools:lead', state: 'unavailable' }),
  );
  for (const spy of f.tripwires) expect(spy).not.toHaveBeenCalled();
});

test('inspection projects declared prerequisite identities from the exact group draft without computing readiness', async () => {
  const f = await fixture();
  const presetJson = JSON.stringify({
    ...f.preset,
    members: [
      ...f.preset.members,
      { ...f.preset.members[0], id: 'peer', codename: 'Peer' },
    ],
  });
  const target = {
    agent: 'reviewer',
    expectedEngine: { kind: 'connection', connectionId: 'codex' },
    workspace: { kind: 'directory', cwd: f.root },
  };
  const response = await f.request(
    {
      presetJson,
      expectedPresetHash: `sha256:${createHash('sha256').update(presetJson).digest('hex')}`,
      bindings: {},
      groupBindings: {
        lead: { target, needs: [] },
        peer: { target, needs: ['lead'] },
      },
    },
    f.browser,
  );
  expect(response.status).toBe(200);
  const { data } = (await response.json()) as { data: EnsembleInspection };
  expect(data.facts).toContainEqual(
    expect.objectContaining({
      id: 'needs:peer',
      memberId: 'peer',
      needs: ['lead'],
      value: 'lead → peer',
      origin: 'authored',
      state: 'configured',
      owner: {
        label: 'Group dependency draft',
        receipt: expect.stringMatching(/^draft:sha256:[0-9a-f]{64}$/),
      },
    }),
  );
  expect(data.facts).toContainEqual(
    expect.objectContaining({ id: 'needs:lead', needs: [] }),
  );
  for (const spy of f.tripwires) expect(spy).not.toHaveBeenCalled();
});

test('a host browser inspects exact uploaded group bindings without gaining host-path access or execution', async () => {
  const f = await fixture();
  const load = vi.spyOn(presets, 'loadEnsemblePreset');
  const presetJson = ' '.repeat(20_000) + f.bytes;
  const input = {
    presetJson,
    expectedPresetHash: `sha256:${createHash('sha256').update(presetJson).digest('hex')}`,
    bindings: {},
    groupBindings: {
      lead: {
        target: {
          agent: 'reviewer',
          expectedEngine: { kind: 'connection', connectionId: 'codex' },
          workspace: { kind: 'directory', cwd: f.root },
        },
        needs: [],
      },
    },
  };
  const response = await f.request(input, f.browser);
  expect(response.status).toBe(200);
  const { data } = (await response.json()) as { data: EnsembleInspection };
  expect(data.source.sha256).toBe(input.expectedPresetHash);
  expect(data.resolutions[0].receipt.workspace).toEqual({
    kind: 'directory',
    cwd: f.root,
  });
  expect(data.facts).toContainEqual(
    expect.objectContaining({
      id: 'needs:lead',
      origin: 'authored',
      state: 'configured',
    }),
  );
  expect(data.facts).toContainEqual(
    expect.objectContaining({ id: 'tool:lead:external', state: 'unknown' }),
  );
  const readsBeforeInvalid = f.readIntegration.mock.calls.length;
  const missingDependency = await f.request(
    {
      ...input,
      groupBindings: {
        lead: { ...input.groupBindings.lead, needs: ['absent-member'] },
      },
    },
    f.browser,
  );
  expect(missingDependency.status).toBe(422);
  expect(await missingDependency.json()).toMatchObject({
    success: false,
    code: 'ensemble_inspection_invalid',
  });
  expect(f.readIntegration).toHaveBeenCalledTimes(readsBeforeInvalid);
  expect(JSON.stringify(data)).not.toMatch(
    /SECRET_|preparationDefinitions|requestOptions|credentialProfile/,
  );
  expect(load).not.toHaveBeenCalled();
  expect((await f.request(f.input, f.browser)).status).toBe(403);
  expect(load).not.toHaveBeenCalled();
  const mismatch = structuredClone(input);
  mismatch.groupBindings.lead.target.expectedEngine.connectionId = 'claude';
  const refused = await f.request(mismatch, f.browser);
  expect(refused.status).toBe(200);
  const unavailable = (await refused.json()) as { data: EnsembleInspection };
  expect(unavailable.data.resolutions).toEqual([]);
  expect(unavailable.data.facts).toContainEqual(
    expect.objectContaining({ id: 'binding:lead', state: 'unavailable' }),
  );
  for (const spy of f.tripwires) expect(spy).not.toHaveBeenCalled();
});

test('uploaded inspection rejects injected models, ambiguous sources and changed source hashes before resolving owners', async () => {
  const f = await fixture();
  const input = {
    presetJson: f.bytes,
    expectedPresetHash: f.input.expectedPresetHash,
    bindings: {},
    groupBindings: {
      lead: {
        target: {
          agent: 'reviewer',
          expectedEngine: { kind: 'connection', connectionId: 'codex' },
          workspace: { kind: 'directory', cwd: f.root },
        },
        needs: [],
      },
    },
  };
  expect((await f.request({ ...input, path: f.path }, f.browser)).status).toBe(
    400,
  );
  expect(
    (
      await f.request(
        { ...input, expectedPresetHash: `sha256:${'0'.repeat(64)}` },
        f.browser,
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await f.request(
        {
          ...input,
          groupBindings: {
            lead: {
              ...input.groupBindings.lead,
              target: {
                ...input.groupBindings.lead.target,
                model: { override: 'injected' },
              },
            },
          },
        },
        f.browser,
      )
    ).status,
  ).toBe(400);
  expect(f.readIntegration).not.toHaveBeenCalled();
  for (const spy of f.tripwires) expect(spy).not.toHaveBeenCalled();
});

test.each(['missing', 'disabled'] as const)(
  'the inspector discloses a %s configured tool without claiming an empty or usable capability inventory',
  async (state) => {
    const f = await fixture();
    f.readIntegration.mockReturnValue(
      state === 'missing'
        ? undefined
        : { id: 'external', kind: 'mcp', transport: 'stdio', enabled: false },
    );
    const response = await f.request(f.input);
    expect(response.status).toBe(200);
    const { data } = (await response.json()) as { data: EnsembleInspection };
    expect(data.facts).toContainEqual(
      expect.objectContaining({
        id: 'tool:lead:external',
        state: state === 'missing' ? 'missing' : 'unavailable',
      }),
    );
    for (const spy of f.tripwires) expect(spy).not.toHaveBeenCalled();
  },
);

test('uploaded inspection cannot publish resolved facts after its browser grant is revoked', async () => {
  const f = await fixture();
  f.setOnIntegration(f.revokeBrowser);
  const response = await f.request(
    {
      presetJson: f.bytes,
      expectedPresetHash: f.input.expectedPresetHash,
      bindings: {},
      groupBindings: {
        lead: {
          target: {
            agent: 'reviewer',
            expectedEngine: { kind: 'connection', connectionId: 'codex' },
            workspace: { kind: 'directory', cwd: f.root },
          },
          needs: [],
        },
      },
    },
    f.browser,
  );
  expect(response.status).toBe(403);
  expect(await response.text()).not.toMatch(/SECRET_|resolution|facts/);
});

test('Project tool and knowledge configuration appears with owner provenance without exposing content or storage paths', async () => {
  const f = await fixture();
  const revision = f.storage.projectRevision('project');
  await revision.replace({
    ...revision.value,
    toolDefaults: { mcpServers: ['project-tool'], knowledge: true },
    knowledgeNamespaces: [
      { id: 'rules', label: 'SECRET_OVERRIDE', behavior: 'rag' },
      {
        id: 'research',
        label: 'Research',
        behavior: 'rag',
        storageDir: 'SECRET_STORAGE_PATH',
      },
    ],
  });
  await f.storage.saveKnowledgeStoreRoot({
    id: 'root:project-project',
    scope: { kind: 'project', projectSlug: 'project' },
    adapterId: 'kit-default-store',
    storeRoot: 'SECRET_ROOT_PATH',
    displayName: 'Project store',
    createdAt: '2026-10-22T00:00:00Z',
  });
  const list = vi
    .spyOn(f.storage, 'listKnowledgeStoreRoots')
    .mockImplementation(() => {
      throw new Error('Ordinary root list forbidden');
    });
  const observe = vi.spyOn(f.storage, 'observeKnowledgeStoreRoots');
  const response = await f.request(f.input);
  expect(response.status).toBe(200);
  const { data } = (await response.json()) as { data: EnsembleInspection };
  expect(data.facts).toContainEqual(
    expect.objectContaining({
      id: 'tool:lead:project-tool',
      owner: expect.objectContaining({ href: '/projects/project/edit' }),
    }),
  );
  expect(data.facts).toContainEqual(
    expect.objectContaining({
      id: 'tool:lead:station-knowledge',
      origin: 'default',
    }),
  );
  expect(data.facts).toContainEqual(
    expect.objectContaining({
      category: 'memory',
      label: 'Rules & Steering',
      origin: 'default',
      value: expect.stringContaining('inject'),
    }),
  );
  expect(data.facts).toContainEqual(
    expect.objectContaining({
      category: 'memory',
      label: 'Research',
      origin: 'authored',
    }),
  );
  expect(data.facts).toContainEqual(
    expect.objectContaining({
      id: 'knowledge-roots:lead',
      state: 'configured',
      value: expect.stringContaining('1 registered'),
    }),
  );
  expect(JSON.stringify(data)).not.toMatch(/SECRET_|storeRoot|storageDir/);
  expect(list).not.toHaveBeenCalled();
  expect(observe).toHaveBeenCalledTimes(2);
  const directoryResponse = await f.request(
    {
      presetJson: f.bytes,
      expectedPresetHash: f.input.expectedPresetHash,
      bindings: {},
      groupBindings: {
        lead: {
          target: {
            agent: 'reviewer',
            expectedEngine: { kind: 'connection', connectionId: 'codex' },
            workspace: { kind: 'directory', cwd: f.root },
          },
          needs: [],
        },
      },
    },
    f.browser,
  );
  expect(directoryResponse.status).toBe(200);
  const directory = (await directoryResponse.json()) as {
    data: EnsembleInspection;
  };
  expect(directory.data.facts).not.toContainEqual(
    expect.objectContaining({ id: 'tool:lead:project-tool' }),
  );
  expect(directory.data.facts).not.toContainEqual(
    expect.objectContaining({ id: 'knowledge-roots:lead' }),
  );
  for (const spy of f.tripwires) expect(spy).not.toHaveBeenCalled();
});

test('an unavailable knowledge registry is disclosed without adding a default tool or inventing empty successful storage', async () => {
  const f = await fixture();
  vi.spyOn(f.storage, 'observeKnowledgeStoreRoots').mockImplementation(() => {
    throw new Error('SECRET_REGISTRY_FAILURE');
  });
  const response = await f.request(f.input);
  expect(response.status).toBe(200);
  const { data } = (await response.json()) as { data: EnsembleInspection };
  expect(data.facts).toContainEqual(
    expect.objectContaining({
      id: 'knowledge-roots:lead',
      state: 'unavailable',
    }),
  );
  expect(data.facts).not.toContainEqual(
    expect.objectContaining({ id: 'tool:lead:station-knowledge' }),
  );
  expect(JSON.stringify(data)).not.toContain('SECRET_');
});

test('knowledge registry changes after Project inspection refuse the whole response as stale', async () => {
  const f = await fixture();
  const root = {
    id: 'root:project-project',
    scope: { kind: 'project' as const, projectSlug: 'project' },
    adapterId: 'kit-default-store',
    storeRoot: 'SECRET_STORE',
    displayName: 'Before',
    createdAt: '2026-10-22T00:00:00Z',
  };
  await f.storage.saveKnowledgeStoreRoot(root);
  f.setOnIntegration(() => {
    writeFileSync(
      join(f.root, 'home/config/knowledge-store-roots.json'),
      JSON.stringify([{ ...root, displayName: 'After' }]),
    );
  });
  const response = await f.request(f.input);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    code: 'ensemble_inspection_stale',
  });
});

test('a full roster batches Project configuration and bounds every namespace, root and tool detail projection', async () => {
  const f = await fixture();
  const revision = f.storage.projectRevision('project');
  await revision.replace({
    ...revision.value,
    toolDefaults: {
      mcpServers: Array.from({ length: 12 }, (_, i) => `project-tool-${i}`),
    },
    knowledgeNamespaces: Array.from({ length: 8 }, (_, i) => ({
      id: `namespace-${i}`,
      label: `Namespace ${i}`,
      behavior: 'rag' as const,
    })),
  });
  for (let i = 0; i < 6; i++)
    await f.storage.saveKnowledgeStoreRoot({
      id: `root:project-project:${i}`,
      scope: { kind: 'project', projectSlug: 'project' },
      adapterId: 'kit-default-store',
      storeRoot: `SECRET_STORE_${i}`,
      displayName: `Store ${i}`,
      createdAt: '2026-10-22T00:00:00Z',
    });
  const preset = {
    ...f.preset,
    stationmaster: 'member0',
    members: Array.from({ length: 16 }, (_, i) => ({
      ...f.preset.members[0],
      id: `member${i}`,
      codename: `Member${i}`,
    })),
  };
  const presetJson = JSON.stringify(preset);
  const observe = vi.spyOn(f.storage, 'observeKnowledgeStoreRoots');
  const response = await f.request(
    {
      presetJson,
      expectedPresetHash: `sha256:${createHash('sha256').update(presetJson).digest('hex')}`,
      bindings: Object.fromEntries(
        preset.members.map((member) => [member.id, f.input.bindings.lead]),
      ),
    },
    f.browser,
  );
  expect(response.status).toBe(200);
  const { data } = (await response.json()) as { data: EnsembleInspection };
  expect(data.resolutions).toHaveLength(16);
  expect(
    data.facts.filter((fact) => fact.id.startsWith('namespace:')),
  ).toHaveLength(64);
  expect(
    data.facts.filter((fact) => fact.id.startsWith('knowledge-root:')),
  ).toHaveLength(64);
  expect(data.facts.filter((fact) => fact.id.startsWith('tool:'))).toHaveLength(
    128,
  );
  expect(data.facts.length).toBeLessThanOrEqual(512);
  expect(f.readProject).toHaveBeenCalledTimes(1);
  expect(observe).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(data)).not.toMatch(/SECRET_/);
});

test('group inspection resolves an exact receiver Project ID without imposing Agent identity syntax', async () => {
  const f = await fixture();
  const projectSlug = `7-${'p'.repeat(70)}`;
  await f.storage.createProject({
    ...f.storage.getProject('project'),
    id: 'selected-project',
    slug: projectSlug,
    name: 'Selected Project',
  });
  const response = await f.request(
    {
      presetJson: f.bytes,
      expectedPresetHash: f.input.expectedPresetHash,
      bindings: {},
      groupBindings: {
        lead: {
          target: {
            agent: 'reviewer',
            expectedEngine: { kind: 'connection', connectionId: 'codex' },
            workspace: { kind: 'project', projectSlug },
          },
          needs: [],
        },
      },
    },
    f.browser,
  );
  expect(response.status).toBe(200);
  const { data } = (await response.json()) as { data: EnsembleInspection };
  expect(data.resolutions[0].receipt.workspace).toMatchObject({
    kind: 'project',
    projectSlug,
    cwd: f.root,
  });
  expect(f.readProject).toHaveBeenCalledWith(projectSlug);
  expect(data.facts).toContainEqual(
    expect.objectContaining({
      id: 'knowledge-namespaces:lead',
      state: 'configured',
    }),
  );
});

test('ordinary standalone inspection declares no recorded-group reader and refuses explicit group binding without one', async () => {
  const f = await fixture();
  const input = {
    presetJson: f.bytes,
    expectedPresetHash: f.input.expectedPresetHash,
    bindings: {},
  };
  const ordinary = await f.request(input, f.browser);
  expect(ordinary.status).toBe(200);
  expect(
    ((await ordinary.json()) as { data: EnsembleInspection }).data
      .groupInspection,
  ).toEqual({
    state: 'unavailable',
    detail: 'Recorded group inspection is unavailable on this host.',
  });
  const bound = await f.request({ ...input, groupId: 'group-1' }, f.browser);
  expect(bound.status).toBe(422);
  expect(await bound.text()).not.toContain('SECRET_ROLE');
  for (const spy of f.tripwires) expect(spy).not.toHaveBeenCalled();
});

test.each(['preset', 'knowledge'] as const)(
  'bound inspection refuses %s changes during its final awaited group read',
  async (changed) => {
    let reads = 0;
    const f = await fixture({
      readGroup: async () => {
        if (++reads === 2) {
          if (changed === 'preset')
            await writeFile(
              f.path,
              f.bytes.replace('SECRET_ROLE', 'CHANGED_ROLE'),
            );
          else
            await f.storage.saveKnowledgeStoreRoot({
              id: 'root:late',
              scope: { kind: 'project', projectSlug: 'project' },
              adapterId: 'kit-default-store',
              storeRoot: 'UNREAD_STORE',
              displayName: 'Late root',
              createdAt: '2026-11-05T00:00:00Z',
            });
        }
        return group;
      },
    });
    const group: CliSessionGroupView = {
      version: 'station.cli-session-group/v1',
      groupId: 'recorded',
      revision: 1,
      supervision: 'not-running',
      cancelled: false,
      deadlineAt: Date.now() + 60000,
      maxConcurrent: 1,
      maxDispatches: 1,
      dispatchCount: 0,
      guarantees: {
        authority: 'station-session',
        portableFlowLineage: 'unbound',
        dollarCap: 'unavailable',
        tokenCap: 'unavailable',
        physicalAttemptCap: 'unavailable',
        deadline: 'stop-admission-and-request-interruption',
      },
      flow: null,
      acceptance: 'unassessed',
      preset: {
        presetId: f.preset.id,
        name: f.preset.name,
        sha256: f.input.expectedPresetHash,
        stationmaster: f.preset.stationmaster,
        members: f.preset.members.map((m) => ({
          seatId: m.id,
          codename: m.codename,
          color: m.color,
          role: m.role,
        })),
      },
      members: [{ seatId: 'lead', needs: [], state: 'pending' }],
    };
    const response = await f.request({
      path: f.path,
      expectedPresetHash: f.input.expectedPresetHash,
      bindings: {},
      groupId: group.groupId,
    });
    expect(reads).toBe(2);
    expect(response.status, await response.clone().text()).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'ensemble_inspection_stale',
    });
    for (const spy of f.tripwires) expect(spy).not.toHaveBeenCalled();
  },
);
