import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

const reloadRuntimeAgents = vi.hoisted(() => vi.fn());

vi.mock('../../agents/runtime-agent-lifecycle.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../agents/runtime-agent-lifecycle.js')
  >('../../agents/runtime-agent-lifecycle.js');
  return { ...actual, reloadRuntimeAgents };
});

import { UsageTelemetryService } from '../../../services/usage-telemetry-service.js';
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
  runtime.providerService = {
    getLaunchabilityRevision: vi.fn(() => 4),
  };
  runtime.configLoader = {
    getLaunchabilityRevision: vi.fn(() => 6),
  };
  runtime.logger = { error: vi.fn(), info: vi.fn() };
  runtime.eventBus = { emit: vi.fn() };
  runtime.appConfig = {};
  runtime.reloadDefaultAgentFromConfig = vi.fn();
  return runtime;
}

afterEach(() => {
  reloadRuntimeAgents.mockReset();
});

describe('StationRuntime configuration generation reload', () => {
  test('rebuilds the default agent and global tools before publishing source revisions', async () => {
    const runtime = createRuntime();
    const customTool = { name: 'custom-tool', execute: vi.fn() };
    const defaultTool = { name: 'default-tool', execute: vi.fn() };
    const order: string[] = [];
    reloadRuntimeAgents.mockImplementation(async () => {
      order.push('custom');
      runtime.agentTools.set('worker', [customTool]);
      return { defaultModel: 'current-model' };
    });
    runtime.reloadDefaultAgentFromConfig.mockImplementation(
      async (appConfig: unknown) => {
        order.push('default');
        expect(appConfig).toEqual({ defaultModel: 'current-model' });
        runtime.agentTools.set('default', [defaultTool]);
      },
    );

    await runtime.reloadAgentsFromDisk();

    expect(order).toEqual(['custom', 'default']);
    expect(runtime.globalToolRegistry).toEqual(
      new Map([
        ['default-tool', defaultTool],
        ['custom-tool', customTool],
      ]),
    );
    expect(runtime.loadedProviderLaunchabilityRevision).toBe(4);
    expect(runtime.loadedAppConfigLaunchabilityRevision).toBe(6);
  });
  test('PRIVACY TOGGLE DEFECT: the existing config reload seam stops and discards live telemetry', async () => {
    const runtime = createRuntime();
    const home = await mkdtemp(join(tmpdir(), 'station-telemetry-runtime-'));
    const fetch = vi.fn();
    const telemetry = new UsageTelemetryService({
      homeDir: home,
      appConfig: {} as any,
      version: '1.2.3',
      logger: { warn: vi.fn() },
      env: { STATION_TELEMETRY_ENDPOINT: 'https://ingest.test' },
      fetch,
      setInterval: vi.fn() as any,
      clearInterval: vi.fn() as any,
    });
    await telemetry.stationStarted();
    runtime.usageTelemetry = telemetry;
    reloadRuntimeAgents.mockResolvedValue({ telemetryEnabled: false });
    try {
      await runtime.reloadAgentsFromDisk();
      await telemetry.shutdown();
      expect(
        telemetry.bufferedCount,
        'config reload saved telemetryEnabled=false but left consented events buffered',
      ).toBe(0);
      expect(
        fetch,
        'config reload saved telemetryEnabled=false but live telemetry still sent',
      ).not.toHaveBeenCalled();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('does not mark a generation current when a source changes during default rebuild', async () => {
    const runtime = createRuntime();
    let providerRevision = 4;
    runtime.providerService.getLaunchabilityRevision.mockImplementation(
      () => providerRevision,
    );
    reloadRuntimeAgents.mockResolvedValue({ defaultModel: 'current-model' });
    runtime.reloadDefaultAgentFromConfig.mockImplementation(async () => {
      providerRevision += 1;
    });

    await expect(runtime.reloadAgentsFromDisk()).rejects.toThrow(
      'Runtime configuration changed while agents were being reloaded.',
    );

    expect(runtime.loadedProviderLaunchabilityRevision).toBeNull();
    expect(runtime.loadedAppConfigLaunchabilityRevision).toBeNull();
  });
});
