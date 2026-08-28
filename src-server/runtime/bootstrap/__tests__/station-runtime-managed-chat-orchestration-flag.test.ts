/**
 * archive#980 fix (HIGH, independent review): `getManagedChatOrchestrationEnabled`
 * must survive a config reload. `this.appConfig` is wholesale reassigned from a
 * fresh disk load (which never carries the non-persisted
 * `managedChatOrchestration` field) on every `reloadAgentsFromDisk()`/
 * `reloadDefaultAgent()` call — which `applyAgentConfigurationMutation` runs on
 * every agent/connection/app-config save. Reading
 * `this.appConfig.managedChatOrchestration` (the pre-fix implementation) would
 * silently revert the flag to `false` for the rest of the process after the
 * first unrelated config mutation.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';

const reloadRuntimeAgents = vi.hoisted(() => vi.fn());

vi.mock('../../agents/runtime-agent-lifecycle.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../agents/runtime-agent-lifecycle.js')
  >('../../agents/runtime-agent-lifecycle.js');
  return { ...actual, reloadRuntimeAgents };
});

import { isManagedChatOrchestrationFeatureEnabled } from '../station-features.js';
import { StationRuntime } from '../station-runtime.js';

function createRuntime(): any {
  const runtime = Object.create(StationRuntime.prototype) as any;
  runtime.activeAgents = new Map();
  runtime.agentFixedTokens = new Map();
  runtime.agentHooksMap = new Map();
  runtime.agentMetadataMap = new Map();
  runtime.agentSpecs = new Map();
  runtime.agentTools = new Map();
  runtime.globalToolRegistry = new Map();
  runtime.integrationMetadata = new Map();
  runtime.mcpConfigs = new Map();
  runtime.mcpConnectionStatus = new Map();
  runtime.memoryAdapters = new Map();
  runtime.retiredMcpConfigs = new Set();
  runtime.toolNameMapping = new Map();
  runtime.toolNameReverseMapping = new Map();
  runtime.loadedProviderLaunchabilityRevision = 0;
  runtime.loadedAppConfigLaunchabilityRevision = 0;
  runtime.providerService = { getLaunchabilityRevision: vi.fn(() => 4) };
  runtime.configLoader = { getLaunchabilityRevision: vi.fn(() => 6) };
  runtime.logger = { error: vi.fn(), info: vi.fn() };
  runtime.eventBus = { emit: vi.fn() };
  runtime.reloadDefaultAgentFromConfig = vi.fn();
  return runtime;
}

describe('StationRuntime managed-chat-orchestration flag durability (station#980 fix)', () => {
  const originalStationFeatures = process.env.STATION_FEATURES;

  afterEach(() => {
    reloadRuntimeAgents.mockReset();
    if (originalStationFeatures === undefined) {
      delete process.env.STATION_FEATURES;
    } else {
      process.env.STATION_FEATURES = originalStationFeatures;
    }
  });

  test('a config reload (reloadAgentsFromDisk) loses appConfig.managedChatOrchestration, but the live feature check is unaffected', async () => {
    process.env.STATION_FEATURES = 'managed-chat-orchestration';
    const runtime = createRuntime();
    // The boot-time snapshot (runtime-initialize.ts) sets this — simulates a
    // freshly-booted runtime before any config mutation.
    runtime.appConfig = { managedChatOrchestration: true };

    expect(isManagedChatOrchestrationFeatureEnabled()).toBe(true);

    // A fresh disk load never carries the non-persisted field — exactly what
    // `reloadRuntimeAgents`/`configLoader.loadAppConfig()` return in
    // production.
    reloadRuntimeAgents.mockResolvedValue({ defaultModel: 'current-model' });

    await runtime.reloadAgentsFromDisk();

    // Confirms the trap is real: the reassigned appConfig no longer carries
    // the flag.
    expect(runtime.appConfig.managedChatOrchestration).not.toBe(true);
    // The fix: the live getter never depended on `appConfig`, so it is
    // unaffected by the reassignment above.
    expect(isManagedChatOrchestrationFeatureEnabled()).toBe(true);
  });

  test('the feature check reports false when STATION_FEATURES does not include the flag, before or after a reload', async () => {
    process.env.STATION_FEATURES = 'strands-runtime';
    const runtime = createRuntime();
    runtime.appConfig = { managedChatOrchestration: false };
    reloadRuntimeAgents.mockResolvedValue({ defaultModel: 'current-model' });

    expect(isManagedChatOrchestrationFeatureEnabled()).toBe(false);
    await runtime.reloadAgentsFromDisk();
    expect(isManagedChatOrchestrationFeatureEnabled()).toBe(false);
  });
});
