import { MCPLocalConnectionCustody } from '@kontourai/station-shared/mcp';
import { describe, expect, test, vi } from 'vitest';
import { createMCPToolProvenanceGeneration } from '../../../services/orchestration/mcp-tool-provenance.js';
import { createRuntimeInitializationDeps } from '../runtime-initialize-deps.js';

describe('createRuntimeInitializationDeps', () => {
  test('forwards runtime state and delegates initialization hooks', async () => {
    const createVoltAgentInstance = vi
      .fn()
      .mockImplementation(async (slug: string) => ({ slug }));
    const configureRoutes = vi.fn();
    const reloadAgents = vi.fn(async () => {});
    const onACPConnectionsReady = vi.fn(async () => {});
    const replaceTemplateVariables = vi.fn(
      (text: string, agentName?: string) => `${text}:${agentName ?? ''}`,
    );
    const checkBedrockCredentials = vi.fn(async () => true);
    const createDefaultSkillRegistryProvider = vi.fn(async () => ({
      id: 'provider',
    }));
    const runStartupMigrations = vi.fn(async () => {});
    const startHealthChecks = vi.fn();
    const onCoreConfigReady = vi.fn();
    const onRouteServicesReady = vi.fn();
    const onVoltAgentCreated = vi.fn();
    const mcpToolProvenanceGeneration = createMCPToolProvenanceGeneration();

    const deps = createRuntimeInitializationDeps({
      port: 4123,
      logger: { info: vi.fn(), debug: vi.fn() } as any,
      eventBus: { emit: vi.fn() } as any,
      approvalRegistry: { has: vi.fn(), resolve: vi.fn() } as any,
      environmentSecurityService: {
        verifyCredential: vi.fn(() => true),
        resolveGrantedScope: vi.fn(
          () =>
            'orchestration:read orchestration:operate terminal:operate access:manage',
        ),
      },
      timers: [],
      configLoader: {
        loadAppConfig: vi.fn().mockResolvedValue({ region: 'us-west-2' }),
        loadPluginOverrides: vi.fn(async () => ({})),
        loadACPConfig: vi.fn(async () => ({})),
        getProjectHomeDir: () => '/tmp/project',
        loadIntegration: vi.fn(async () => ({}) as any),
        loadAgent: vi.fn(async () => ({}) as any),
        // Agent records read for boot-time engine adoption.
        listAgents: vi.fn(async () => []),
        mutateAgent: vi.fn(async () => null),
        // archive#3063: boot-time built-in integration materialization.
        saveIntegration: vi.fn(async () => {}),
        hasIntegration: vi.fn(async () => true),
      },
      storageAdapter: { kind: 'storage' } as any,
      skillService: {
        discoverSkills: vi.fn(async () => {}),
        getSkill: vi.fn(async () => ({}) as any),
      } as any,
      feedbackService: { kind: 'feedback' } as any,
      voiceService: { kind: 'voice' } as any,
      acpBridge: { kind: 'acp' } as any,
      onACPConnectionsReady,
      orchestrationEventStore: { kind: 'events' } as any,
      usageAggregator: { kind: 'usage' } as any,
      activeAgents: new Map([['default', { id: 'agent' } as any]]),
      agentMetadataMap: new Map([['default', { slug: 'default' }]]),
      memoryAdapters: new Map([['default', { kind: 'memory' }]]),
      agentTools: new Map([['default', [{ name: 'tool' }]]]),
      agentSpecs: new Map([['default', { slug: 'default' } as any]]),
      mcpCustody: new MCPLocalConnectionCustody(),
      mcpConfigs: new Map([['server', { kind: 'mcp' }]]),
      mcpConnectionStatus: new Map([['server', { connected: true }]]),
      integrationMetadata: new Map([['server', { type: 'mcp' }]]),
      toolNameMapping: new Map([
        [
          'tool',
          { original: 'tool', normalized: 'tool', server: null, tool: 'tool' },
        ],
      ]),
      toolNameReverseMapping: new Map([['tool', 'tool']]),
      mcpToolProvenanceGeneration,
      eventLog: { persist: vi.fn(async () => {}) } as any,
      bedrockAdapter: { kind: 'bedrock' } as any,
      claudeAdapter: { kind: 'claude' } as any,
      codexAdapter: { kind: 'codex' } as any,
      museAdapter: { kind: 'muse' } as any,
      ollamaAdapter: { kind: 'ollama' } as any,
      createVoltAgentInstance,
      configureRoutes,
      reloadAgents,
      replaceTemplateVariables,
      checkBedrockCredentials,
      createDefaultSkillRegistryProvider,
      runStartupMigrations,
      startHealthChecks,
      onCoreConfigReady,
      onRouteServicesReady,
      onVoltAgentCreated,
    });

    expect(deps.port).toBe(4123);
    // archive#1078 review HIGH: this manual copy layer silently dropped the
    // settle callback (shipping the whole fix inert) — pin identity
    // forwarding so the next added hook can't vanish the same way.
    expect(deps.activeAgents).toBeInstanceOf(Map);
    expect(deps.approvalRegistry).toBeDefined();
    expect(deps.createVoltAgentInstance).toBe(createVoltAgentInstance);
    expect(deps.configureRoutes).toBe(configureRoutes);
    expect(deps.reloadAgents).toBe(reloadAgents);
    expect(deps.onACPConnectionsReady).toBe(onACPConnectionsReady);
    expect(deps.replaceTemplateVariables).toBe(replaceTemplateVariables);
    expect(deps.startHealthChecks).toBe(startHealthChecks);
    expect(deps.onCoreConfigReady).toBe(onCoreConfigReady);
    expect(deps.onRouteServicesReady).toBe(onRouteServicesReady);
    expect(deps.onVoltAgentCreated).toBe(onVoltAgentCreated);
    expect(deps.mcpToolProvenanceGeneration).toBe(mcpToolProvenanceGeneration);

    await expect(deps.checkBedrockCredentials()).resolves.toBe(true);
    await expect(deps.createDefaultSkillRegistryProvider()).resolves.toEqual({
      id: 'provider',
    });
    await deps.runStartupMigrations('/tmp/project');

    expect(checkBedrockCredentials).toHaveBeenCalledTimes(1);
    expect(createDefaultSkillRegistryProvider).toHaveBeenCalledTimes(1);
    expect(runStartupMigrations).toHaveBeenCalledWith('/tmp/project');
  });
});
