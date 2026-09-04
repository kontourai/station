import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KIT_OBSERVABILITY_CONFORMANCE_VECTORS } from '@kontourai/flow-agents/kit-observability-conformance';
import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import {
  loadIntegrationConfig,
  saveIntegrationConfig,
} from '../../../domain/config-loader-storage.js';
import { PluginContentLockCycleError } from '../../../services/plugins/plugin-content-integrity.js';
import { PluginConsentRefusedError } from '../../../services/plugins/plugin-install-consent.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  registryOps: { add: vi.fn() },
}));

vi.mock('../../../providers/registries/registry.js', () => {
  const integrationProvider = {
    listAvailable: vi.fn().mockResolvedValue([]),
    listInstalled: vi.fn().mockResolvedValue([]),
    install: vi.fn().mockResolvedValue({ success: true }),
    uninstall: vi.fn().mockResolvedValue({ success: true }),
    getToolDef: vi.fn().mockResolvedValue(null),
    sync: vi.fn().mockResolvedValue(undefined),
  };
  const skillProvider = {
    listAvailable: vi
      .fn()
      .mockResolvedValue([
        { id: 's1', name: 'Skill 1', description: 'A skill' },
      ]),
    getContent: vi.fn().mockResolvedValue('# Skill content'),
  };
  const agentProvider = {
    listAvailable: vi.fn().mockResolvedValue([]),
    listInstalled: vi.fn().mockResolvedValue([]),
    install: vi.fn().mockResolvedValue({ success: true }),
    uninstall: vi.fn().mockResolvedValue({ success: true }),
  };
  return {
    getSkillRegistryProviders: vi
      .fn()
      .mockReturnValue([{ provider: skillProvider, source: 'test' }]),
    getAgentRegistryProvider: vi.fn().mockReturnValue(agentProvider),
    getIntegrationRegistryProvider: vi
      .fn()
      .mockReturnValue(integrationProvider),
    __integrationProvider: integrationProvider,
    __agentProvider: agentProvider,
  };
});

vi.mock('../plugin-install-shared.js', () => ({
  installPluginFromSource: vi.fn().mockResolvedValue({
    success: true,
    plugin: {
      name: 'p1',
      displayName: 'Plugin 1',
      version: '1.0.0',
      hasBundle: true,
      agents: [],
    },
    tools: [],
    dependencies: [],
    permissions: { autoGranted: [], pendingConsent: [] },
  }),
  readRegistryPluginAvailability: vi.fn().mockResolvedValue([
    {
      id: 'p1',
      displayName: 'Plugin 1',
      version: '1.0.0',
      source: 'test',
      installed: true,
    },
  ]),
  resolvePluginRegistryInstall: vi.fn().mockResolvedValue({
    source: '/tmp/registry/plugin-one',
    registryKey: 'test-registry',
  }),
  uninstallInstalledPlugin: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('../../../services/agents/skill-service.js', () => ({
  SkillService: vi.fn(),
}));

const { createRegistryRoutes } = await import('../registry.js');
const { DistributionProfileService } = await import(
  '../../../services/plugins/distribution-profile-service.js'
);
const { StationKitObservabilityHost } = await import(
  '../../../services/kits/kit-observability-host.js'
);
const { StationKitObservabilityRegistry } = await import(
  '../../../services/kits/kit-observability-registry.js'
);
// __integrationProvider / __agentProvider are mock-only exports (see vi.mock
// factory above); they do not exist on the real module, so the type checker
// sees them via `any`.
const { __integrationProvider, __agentProvider } = (await import(
  '../../../providers/registries/registry.js'
)) as any;
const {
  installPluginFromSource,
  readRegistryPluginAvailability,
  resolvePluginRegistryInstall,
  uninstallInstalledPlugin,
} = await import('../plugin-install-shared.js');

function setup(
  layoutCatalog?: InstanceType<typeof DistributionProfileService>,
  kitObservabilityRegistry?: InstanceType<
    typeof StationKitObservabilityRegistry
  >,
  approveKitOperatorAction?: (candidate: any) => boolean | Promise<boolean>,
  applyConfigurationMutation?: (...args: any[]) => Promise<any>,
) {
  const configLoader = {
    getProjectHomeDir: vi.fn().mockReturnValue('/tmp'),
    loadIntegration: vi.fn().mockRejectedValue(new Error('not found')),
    saveIntegration: vi.fn(),
    deleteIntegration: vi.fn().mockResolvedValue(undefined),
  };
  const refreshACPModes = vi.fn().mockResolvedValue(undefined);
  const reloadSkills = vi.fn().mockResolvedValue(undefined);
  const skillService = {
    installSkill: vi.fn().mockResolvedValue({ success: true }),
    removeSkill: vi.fn().mockResolvedValue({ success: true }),
  };
  const app = createRegistryRoutes(
    configLoader as any,
    refreshACPModes,
    reloadSkills,
    skillService as any,
    {
      kitObservabilityRegistry,
      approveKitOperatorAction,
      applyConfigurationMutation,
      layoutCatalog,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    },
  );
  return { app, configLoader, refreshACPModes, reloadSkills, skillService };
}

describe('Registry Routes', () => {
  test('POST /integrations/install saves the tool definition when one is provided', async () => {
    const { app, configLoader } = setup();
    __integrationProvider.getToolDef.mockResolvedValueOnce({
      id: 'filesystem',
      kind: 'mcp',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    });

    const body = await json(
      await app.request('/integrations/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'filesystem' }),
      }),
    );

    expect(body.success).toBe(true);
    expect(configLoader.saveIntegration).toHaveBeenCalledWith(
      'filesystem',
      expect.objectContaining({
        command: 'npx',
        enabled: false,
      }),
    );
  });

  test('registry manifest refs are stripped for an unbound integration', async () => {
    const { app, configLoader } = setup();
    __integrationProvider.getToolDef.mockResolvedValueOnce({
      id: 'filesystem',
      kind: 'mcp',
      command: 'provider-command',
      secretEnvRefs: { TOKEN: 'poisoned-token', OTHER: 'poisoned-other' },
    });

    await app.request('/integrations/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'filesystem' }),
    });

    expect(configLoader.saveIntegration).toHaveBeenCalledWith(
      'filesystem',
      expect.objectContaining({
        command: 'provider-command',
      }),
    );
    expect(configLoader.saveIntegration.mock.calls[0]?.[1]).not.toHaveProperty(
      'secretEnvRefs',
    );
  });

  test('registry install refuses to overwrite a bound integration execution identity', async () => {
    const { app, configLoader } = setup();
    configLoader.loadIntegration.mockResolvedValue({
      id: 'filesystem',
      kind: 'mcp',
      command: 'previous-command',
      secretEnvRefs: { TOKEN: 'operator-token' },
    });
    __integrationProvider.getToolDef.mockResolvedValueOnce({
      id: 'filesystem',
      kind: 'mcp',
      command: 'provider-command',
      secretEnvRefs: { TOKEN: 'poisoned-token' },
    });

    const response = await app.request('/integrations/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'filesystem' }),
    });
    expect(response.status).toBe(409);
    expect(configLoader.saveIntegration).not.toHaveBeenCalled();
  });

  test('registry install persists and reloads a new integration disabled', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-registry-disabled-'));
    try {
      const { app, configLoader } = setup();
      configLoader.saveIntegration.mockImplementation((id, def) =>
        saveIntegrationConfig(home, id, def),
      );
      __integrationProvider.getToolDef.mockResolvedValueOnce({
        id: 'filesystem',
        kind: 'mcp',
        command: 'npx',
      });

      await app.request('/integrations/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'filesystem' }),
      });

      const path = join(home, 'integrations', 'filesystem', 'integration.json');
      expect(readFileSync(path, 'utf8')).toContain('"enabled": false');
      expect((await loadIntegrationConfig(home, 'filesystem')).enabled).toBe(
        false,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('DELETE /integrations/:id removes the saved integration config after uninstall', async () => {
    const { app, configLoader } = setup();

    const body = await json(
      await app.request('/integrations/filesystem', { method: 'DELETE' }),
    );

    expect(body.success).toBe(true);
    expect(configLoader.deleteIntegration).toHaveBeenCalledWith('filesystem');
  });

  test('GET /integrations reports the provider source and invents none when absent', async () => {
    const { app } = setup();
    __integrationProvider.listAvailable.mockResolvedValueOnce([
      { id: 'filesystem', displayName: 'Filesystem', source: '/tmp/registry' },
      { id: 'sourceless', displayName: 'Sourceless' },
    ]);

    const body = await json(await app.request('/integrations'));

    expect(body.success).toBe(true);
    expect(body.data[0].source).toBe('/tmp/registry');
    expect(body.data[1].source).toBeUndefined();
  });

  test('GET /integrations strips bracket qualifiers in linear time for malformed local display names (station#2384)', async () => {
    const { app } = setup();
    const displayName = '['.repeat(50_000);
    __integrationProvider.listAvailable.mockResolvedValueOnce([
      { id: 'filesystem', displayName },
    ]);

    const startedAt = performance.now();
    const body = await json(await app.request('/integrations'));
    expect(body.data[0].displayName).toBe(displayName);
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  test('GET /plugins returns { success, data } array with installed state', async () => {
    const { app } = setup();
    const body = await json(await app.request('/plugins'));
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data[0]).toMatchObject({
      id: 'p1',
      installed: true,
      source: 'test',
    });
    expect(readRegistryPluginAvailability).toHaveBeenCalledWith('/tmp');
  });

  test('GET /layouts returns an honest local built-in lifecycle catalog', async () => {
    const { app } = setup();
    const body = await json(await app.request('/layouts'));
    expect(body.success).toBe(true);
    expect(
      body.data.find((layout: any) => layout.id === 'builtin:coding'),
    ).toMatchObject({ lifecycle: { state: 'installed' }, enabled: true });
    expect(
      body.data.find((layout: any) => layout.id === 'builtin:tasks'),
    ).toMatchObject({ lifecycle: { state: 'installed' }, enabled: true });
  });

  test('layout lifecycle actions persist a built-in disable without executing a plugin', async () => {
    const projectHome = mkdtempSync(join(tmpdir(), 'station-registry-layout-'));
    try {
      const catalog = new DistributionProfileService(projectHome);
      const { app } = setup(catalog);
      const response = await app.request('/layouts/builtin:coding/disable', {
        method: 'POST',
      });
      const body = await json(response);
      expect(response.status).toBe(200);
      expect(body.data).toMatchObject({
        lifecycle: { state: 'disabled' },
        enabled: false,
      });
      expect(catalog.resolveForApply.bind(catalog, 'builtin:coding')).toThrow(
        'not installed and enabled',
      );
    } finally {
      rmSync(projectHome, { recursive: true, force: true });
    }
  });

  test('Kit discovery and lifecycle routes project existing read-only layout primitives', async () => {
    const registry = new StationKitObservabilityRegistry(
      new StationKitObservabilityHost({
        supported_contract_versions: ['1.0'],
        capabilities: ['standard_views', 'resource.open'],
      }),
    );
    const contribution = structuredClone(
      KIT_OBSERVABILITY_CONFORMANCE_VECTORS[0].contribution,
    );
    registry.install({
      contribution: { status: 'supported', contribution, diagnostics: [] },
    });
    const { app } = setup(undefined, registry);

    const listed = await json(await app.request('/kits'));
    expect(listed.data).toEqual([
      expect.objectContaining({
        contributionRef: contribution.metadata.name,
        lifecycle: 'installed',
      }),
    ]);
    const layout = await json(
      await app.request(`/kits/${contribution.metadata.name}/layout`),
    );
    expect(layout.data.component).toBeUndefined();
    expect(layout.data.standardViews).toEqual([
      expect.objectContaining({ readOnly: true }),
    ]);
    expect(
      await app.request(`/kits/${contribution.metadata.name}/disable`, {
        method: 'POST',
      }),
    ).toHaveProperty('status', 200);
    const listedAfterDisable = await json(await app.request('/kits'));
    expect(listedAfterDisable.data[0].lifecycle).toBe('disabled');
    const rejected = await app.request(
      `/kits/${contribution.metadata.name}/actions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent: 'open_resource', approved: false }),
      },
    );
    expect(rejected.status).toBe(403);
  });

  test('rechecks the declared Kit action after an asynchronous approval', async () => {
    const registry = new StationKitObservabilityRegistry(
      new StationKitObservabilityHost({
        supported_contract_versions: ['1.0'],
        capabilities: ['standard_views', 'resource.open'],
      }),
    );
    const contribution = structuredClone(
      KIT_OBSERVABILITY_CONFORMANCE_VECTORS[0].contribution,
    );
    registry.install({
      contribution: { status: 'supported', contribution, diagnostics: [] },
    });
    let approve!: (approved: boolean) => void;
    const approval = new Promise<boolean>((resolve) => {
      approve = resolve;
    });
    let approvalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      approvalStarted = resolve;
    });
    const { app } = setup(undefined, registry, () => {
      approvalStarted();
      return approval;
    });
    const request = app.request(`/kits/${contribution.metadata.name}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: 'open_resource' }),
    });
    await started;
    const revised = structuredClone(contribution);
    revised.spec.package_ref = 'npm:@example/revised@2.0.0';
    registry.update(contribution.metadata.name, {
      contribution: {
        status: 'supported',
        contribution: revised,
        diagnostics: [],
      },
    });
    approve(true);

    expect(await request).toHaveProperty('status', 409);
  });

  test('POST /plugins/install resolves the source and passes the registry id into the install pipeline', async () => {
    const { app } = setup();
    const body = await json(
      await app.request('/plugins/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'p1' }),
      }),
    );
    expect(body.success).toBe(true);
    expect(resolvePluginRegistryInstall).toHaveBeenCalledWith('p1');
    expect(installPluginFromSource).toHaveBeenCalledWith(
      '/tmp/registry/plugin-one',
      [],
      expect.objectContaining({
        agentsDir: '/tmp/agents',
        pluginsDir: '/tmp/plugins',
        projectHomeDir: '/tmp',
      }),
      {
        registryId: 'p1',
        registryKey: 'test-registry',
        // archive#4288: this route installs on one click with no preview and
        // no prompt, so it declares that it holds no operator decision rather
        // than passing one nobody made. The installer refuses exactly what
        // this route could not have disclosed.
        consent: {
          kind: 'no-operator-decision',
          caller: 'the plugin registry',
        },
      },
    );
  });

  test('POST /plugins/install preserves an installer failure instead of reporting a false success', async () => {
    const { app } = setup();
    vi.mocked(installPluginFromSource).mockResolvedValueOnce({
      success: false,
      message: 'Plugin source was not installed',
    } as never);

    const response = await app.request('/plugins/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'p1' }),
    });
    const body = await json(response);

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      success: false,
      message: 'Plugin source was not installed',
    });
  });

  /**
   * archive#4309 follow-up, defect 1. The second route that can observe a
   * refused plugin content lock. It answers the same 409, from the same
   * derivation, as the direct install route — two routes describing one
   * refusal differently is how a reader learns to trust neither.
   */
  test('POST /plugins/install answers 409 when a plugin content lock is refused', async () => {
    const { app } = setup();
    vi.mocked(installPluginFromSource).mockRejectedValueOnce(
      new Error("Plugin dependency 'shared-lib' failed to install", {
        cause: new PluginContentLockCycleError([
          '/tmp/plugins/app',
          '/tmp/plugins/shared-lib',
          '/tmp/plugins/app',
        ]),
      }),
    );

    const response = await app.request('/plugins/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'p1' }),
    });
    const body = await json(response);

    expect(response.status).toBe(409);
    expect(body.success).toBe(false);
    expect(body.message).toContain('app');
    expect(body.message).toContain('shared-lib');
    expect(body.lockCycle).toEqual(['app', 'shared-lib']);
  });

  test('DELETE /plugins/:id removes the installed plugin through the shared lifecycle path', async () => {
    const { app } = setup();
    const body = await json(
      await app.request('/plugins/p1', { method: 'DELETE' }),
    );
    expect(body.success).toBe(true);
    expect(uninstallInstalledPlugin).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        agentsDir: '/tmp/agents',
        pluginsDir: '/tmp/plugins',
        projectHomeDir: '/tmp',
      }),
    );
  });

  /**
   * #765 D1. A JSON-manifest registry serves its plugin catalog through the
   * agent-registry face too, and this route used to answer a plugin id with
   * the provider's raw tree copy: no buildPlugin, no consent gate, no
   * `plugins:installed` event. The tree landed without `dist/bundle.js`, so
   * every layout component the plugin declared rendered as "Unsupported
   * layout tab" forever while the install reported success. Any id the
   * plugin registry resolves must take the one complete install pipeline.
   */
  test('POST /agents/install routes a registry plugin id through the consent-gated plugin pipeline, never the raw provider copy', async () => {
    const { app } = setup();
    vi.mocked(installPluginFromSource).mockClear();
    __agentProvider.install.mockClear();

    const body = await json(
      await app.request('/agents/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'p1' }),
      }),
    );

    expect(body.success).toBe(true);
    expect(__agentProvider.install).not.toHaveBeenCalled();
    expect(installPluginFromSource).toHaveBeenCalledWith(
      '/tmp/registry/plugin-one',
      [],
      expect.objectContaining({ pluginsDir: '/tmp/plugins' }),
      {
        registryId: 'p1',
        registryKey: 'test-registry',
        // No decision travelled with this request, and the route says so
        // rather than passing one nobody made — the installer then refuses a
        // plugin contributing code, instead of half-installing it.
        consent: {
          kind: 'no-operator-decision',
          caller: 'the plugin registry',
        },
      },
    );
  });

  test('POST /agents/install falls back to the agent provider for an id the plugin registry does not resolve', async () => {
    const { app } = setup();
    vi.mocked(resolvePluginRegistryInstall).mockResolvedValueOnce(null);
    vi.mocked(installPluginFromSource).mockClear();
    __agentProvider.install.mockClear();

    const body = await json(
      await app.request('/agents/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'plain-agent' }),
      }),
    );

    expect(body.success).toBe(true);
    expect(__agentProvider.install).toHaveBeenCalledWith('plain-agent');
    expect(installPluginFromSource).not.toHaveBeenCalled();
  });

  test('registry plugin installs forward the operator decision from the preview (both catalog faces)', async () => {
    const applyConfigurationMutation = vi.fn(
      async (operation, _options?: unknown) =>
        operation(vi.fn(), { status: 'applied' }),
    );
    const { app } = setup(
      undefined,
      undefined,
      undefined,
      applyConfigurationMutation,
    );
    const consent = {
      permissions: ['navigation.dock'],
      contentDigest: 'sha256:abc',
      dependencies: [],
    };

    for (const route of ['/agents/install', '/plugins/install']) {
      vi.mocked(installPluginFromSource).mockClear();
      const body = await json(
        await app.request(route, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'p1', consent, skip: ['layout:demo'] }),
        }),
      );
      expect(body.success).toBe(true);
      expect(installPluginFromSource).toHaveBeenCalledWith(
        '/tmp/registry/plugin-one',
        ['layout:demo'],
        expect.anything(),
        {
          registryId: 'p1',
          registryKey: 'test-registry',
          consent: { kind: 'operator-decision', ...consent },
        },
      );
    }
    expect(
      applyConfigurationMutation.mock.calls.map((call) => call[1]),
    ).toEqual([{ rediscoverSkills: true }, { rediscoverSkills: true }]);
  });

  test('a consent refusal answers 400 with the refusal sentence, on both catalog faces', async () => {
    const { app } = setup();
    for (const route of ['/agents/install', '/plugins/install']) {
      vi.mocked(installPluginFromSource).mockRejectedValueOnce(
        new PluginConsentRefusedError({
          pluginName: 'getting-started-starter',
          reason: 'undisclosed-contributions',
          message:
            "Plugin 'getting-started-starter' contributes entrypoint, layout — install it from a preview.",
        }),
      );
      const response = await app.request(route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'p1' }),
      });
      const body = await json(response);
      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.message).toContain('getting-started-starter');
      expect(body.consent.reason).toBe('undisclosed-contributions');
    }
  });

  test('DELETE /agents/:id removes a registry plugin through the shared uninstall, not the raw provider delete', async () => {
    const { app } = setup();
    vi.mocked(uninstallInstalledPlugin).mockClear();
    __agentProvider.uninstall.mockClear();

    const body = await json(
      await app.request('/agents/p1', { method: 'DELETE' }),
    );

    expect(body.success).toBe(true);
    expect(__agentProvider.uninstall).not.toHaveBeenCalled();
    expect(uninstallInstalledPlugin).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ pluginsDir: '/tmp/plugins' }),
    );
  });

  test('DELETE /agents/:id falls back to the agent provider for a non-plugin id', async () => {
    const { app } = setup();
    vi.mocked(resolvePluginRegistryInstall).mockResolvedValueOnce(null);
    vi.mocked(uninstallInstalledPlugin).mockClear();
    __agentProvider.uninstall.mockClear();

    const body = await json(
      await app.request('/agents/plain-agent', { method: 'DELETE' }),
    );

    expect(body.success).toBe(true);
    expect(__agentProvider.uninstall).toHaveBeenCalledWith('plain-agent');
    expect(uninstallInstalledPlugin).not.toHaveBeenCalled();
  });

  test('GET /skills returns { success, data } array with id/name', async () => {
    const { app } = setup();
    const body = await json(await app.request('/skills'));
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data[0]).toHaveProperty('id');
    expect(body.data[0]).toHaveProperty('name');
  });

  test('POST /skills/install returns { success }', async () => {
    const { app } = setup();
    const body = await json(
      await app.request('/skills/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 's1' }),
      }),
    );
    expect(body.success).toBe(true);
  });

  test('DELETE /skills/:id returns { success }', async () => {
    const { app } = setup();
    const body = await json(
      await app.request('/skills/s1', { method: 'DELETE' }),
    );
    expect(body.success).toBe(true);
  });

  test('POST /skills/:id/update returns { success }', async () => {
    const { app } = setup();
    const body = await json(
      await app.request('/skills/s1/update', { method: 'POST' }),
    );
    expect(body.success).toBe(true);
  });

  test('GET /skills/:id/content returns { success, data: string }', async () => {
    const { app } = setup();
    const body = await json(await app.request('/skills/s1/content'));
    expect(body.success).toBe(true);
    expect(typeof body.data).toBe('string');
  });
});
