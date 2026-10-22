import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentMetadata } from '@kontourai/station-contracts/agent';
import { engineConnectionId } from '@kontourai/station-contracts/agent-identity';
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

async function fixture() {
  vi.stubEnv('STATION_HOSTED_TENANT_REGISTRY_FILE', undefined);
  const root = await realpath(temp('ensemble-inspection-'));
  const home = join(root, 'home');
  await mkdir(home);
  const loader = new ConfigLoader({ projectHomeDir: home });
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
  const service = new EnsembleInspectionService({
    security,
    inventory,
    readIntegration,
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
    createEnsembleInspectionRoutes(service, resolvePrincipal),
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
      origin: 'unknown',
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
