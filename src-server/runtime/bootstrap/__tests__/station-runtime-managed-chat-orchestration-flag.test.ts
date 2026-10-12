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
// Captures the context StationRuntime hands its routes, so the case reads the
// flag through the getter production routes consume.
const configureRuntimeRoutes = vi.hoisted(() => vi.fn((_context: any) => ({})));

vi.mock('../../routes/runtime-routes.js', () => ({ configureRuntimeRoutes }));

vi.mock('../../agents/runtime-agent-lifecycle.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../agents/runtime-agent-lifecycle.js')
  >('../../agents/runtime-agent-lifecycle.js');
  return { ...actual, reloadRuntimeAgents };
});

import { StationRuntime } from '../station-runtime.js';

function createRuntime(): any {
  const runtime = Object.create(StationRuntime.prototype) as any;
  // The loader verifies the selected package generation through the store's
  // admission journal on every reload; a harness with no store would fail
  // closed, so it carries a journal that observes an empty selection.
  runtime.orchestrationEventStore = {
    createPackageMcpAdmissionJournal: () => ({
      selectedInstallations: () => ({ state: 'observed', installations: [] }),
    }),
  };
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
  // Route configuration builds the operator-passkey service (#3319), which
  // reads the home but opens its store only on first use.
  runtime.configLoader = {
    getLaunchabilityRevision: vi.fn(() => 6),
    getProjectHomeDir: () => '/station-home-never-opened',
  };
  runtime.consentChannel = { trustedOrigin: null };
  runtime.logger = { error: vi.fn(), info: vi.fn() };
  runtime.eventBus = { emit: vi.fn() };
  runtime.reloadDefaultAgentFromConfig = vi.fn();
  // Already built, so route configuration does not compose search.
  runtime.runtimeSearch = { stop: vi.fn() };
  return runtime;
}

/** Configures routes once, as boot does, and returns the routes' flag getter. */
function routeFlagGetter(runtime: any): () => boolean {
  runtime.configureRoutes({});
  const context = configureRuntimeRoutes.mock.calls.at(-1)?.[0];
  return context.getManagedChatOrchestrationEnabled;
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

  test('a config reload (reloadAgentsFromDisk) loses appConfig.managedChatOrchestration, but the route-context flag is unaffected', async () => {
    process.env.STATION_FEATURES = 'managed-chat-orchestration';
    const runtime = createRuntime();
    // The boot-time snapshot (runtime-initialize.ts) sets this — simulates a
    // freshly-booted runtime before any config mutation.
    runtime.appConfig = { managedChatOrchestration: true };
    const managedChatOrchestrationEnabled = routeFlagGetter(runtime);
    expect(managedChatOrchestrationEnabled()).toBe(true);

    // A fresh disk load never carries the non-persisted field — exactly what
    // `reloadRuntimeAgents`/`configLoader.loadAppConfig()` return in
    // production.
    reloadRuntimeAgents.mockResolvedValue({ defaultModel: 'current-model' });

    await runtime.reloadAgentsFromDisk();

    // Confirms the trap is real: the reassigned appConfig no longer carries
    // the flag.
    expect(runtime.appConfig.managedChatOrchestration).not.toBe(true);
    // The fix: the getter the routes hold never depended on `appConfig`.
    expect(managedChatOrchestrationEnabled()).toBe(true);
  });

  test('the route-context flag follows STATION_FEATURES, not the appConfig snapshot', async () => {
    process.env.STATION_FEATURES = 'strands-runtime';
    const runtime = createRuntime();
    // A stale snapshot claiming the flag must not turn it on.
    runtime.appConfig = { managedChatOrchestration: true };
    reloadRuntimeAgents.mockResolvedValue({ defaultModel: 'current-model' });
    const managedChatOrchestrationEnabled = routeFlagGetter(runtime);

    expect(managedChatOrchestrationEnabled()).toBe(false);
    await runtime.reloadAgentsFromDisk();
    expect(managedChatOrchestrationEnabled()).toBe(false);
  });
});
