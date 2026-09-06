import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createStationHomeBackup,
  restoreStationHomeBackup,
  STATION_HOME_RECOVERY_RECORD,
} from '@kontourai/station-shared/station-home-archive';
import { ensureStationHomeSchemaSync } from '@kontourai/station-shared/station-home-schema';
/**
 * Delta2 review H2 — the PRODUCTION wiring of the managed-chat binding.
 *
 * The resolver itself was already correct in isolation; the defect was where
 * it read its app config. `createRuntimeSystemRouteDeps` closed over
 * `context.appConfig`, the object captured when routes were constructed, while
 * a configuration reload replaces the runtime's own `this.appConfig` and
 * rebuilds the default agent from it. So after a live default-provider change
 * the agent executed through the new connection and `GET /status` kept
 * answering for the old one — a disagreement no unit test of the resolver
 * could see, because both sides of it were correct.
 */

import { describe, expect, test } from 'vitest';
import { createRuntimeSystemRouteDeps } from '../runtime-route-support.js';
import type { ConfigureRuntimeRoutesContext } from '../runtime-routes.js';

const connections = [
  {
    id: 'anthropic-1',
    type: 'anthropic',
    name: 'Anthropic',
    enabled: true,
    capabilities: ['llm'],
    config: { defaultModel: 'claude' },
  },
  {
    id: 'ollama-local',
    type: 'ollama',
    name: 'Ollama',
    enabled: true,
    capabilities: ['llm'],
    config: { defaultModel: 'qwen3' },
  },
];

function contextWithConfig(initial: { defaultLLMProvider?: string }) {
  // The runtime REPLACES its app-config field on reload; the snapshot passed
  // as `appConfig` is deliberately left at the boot value here, exactly as it
  // is in production, so a dep that reads it fails this test.
  const snapshot = { ...initial };
  let live = { ...initial };
  const context = {
    appConfig: snapshot,
    getLiveAppConfig: () => live,
    agentMetadataMap: new Map<string, { execution?: unknown }>(),
    activeAgents: new Map(),
    providerService: { listProviderConnections: () => connections },
    connectionService: {
      checkGatedModelConnectionIds: () => new Map(),
      listEngineConnectionStates: async () => [],
    },
    acpBridge: { getStatus: () => ({ connections: [] }) },
    configLoader: { getProjectHomeDir: () => '/tmp/station-test-home' },
    checkOllamaAvailability: async () => false,
    eventBus: { emit: () => undefined },
    skillService: {},
    port: 4321,
    host: '127.0.0.1',
  } as unknown as ConfigureRuntimeRoutesContext;
  return {
    context,
    reload: (next: { defaultLLMProvider?: string }) => {
      live = { ...next };
    },
    snapshot,
  };
}

describe('system route deps read the live app config', () => {
  test('the managed-chat binding follows a default-provider change made after routes were built', () => {
    const { context, reload, snapshot } = contextWithConfig({
      defaultLLMProvider: 'anthropic-1',
    });
    const deps = createRuntimeSystemRouteDeps(context);

    expect(deps.resolveManagedChatBinding()).toEqual({
      kind: 'resolved',
      connectionId: 'anthropic-1',
    });

    reload({ defaultLLMProvider: 'ollama-local' });

    expect(deps.resolveManagedChatBinding()).toEqual({
      kind: 'resolved',
      connectionId: 'ollama-local',
    });
    // The construction-time snapshot is untouched: this passes because the
    // dep stopped reading it, not because the fixture mutated it.
    expect(snapshot.defaultLLMProvider).toBe('anthropic-1');
  });

  test('clearing the default with several enabled connections reads as ambiguous, not resolved', () => {
    const { context, reload } = contextWithConfig({
      defaultLLMProvider: 'anthropic-1',
    });
    const deps = createRuntimeSystemRouteDeps(context);

    reload({});

    expect(deps.resolveManagedChatBinding()).toEqual({ kind: 'ambiguous' });
  });

  test('deleting the declared default reads as invalid, naming what was declared', () => {
    const { context, reload } = contextWithConfig({
      defaultLLMProvider: 'anthropic-1',
    });
    const deps = createRuntimeSystemRouteDeps(context);

    reload({ defaultLLMProvider: 'deleted-1' });

    expect(deps.resolveManagedChatBinding()).toEqual({
      kind: 'invalid',
      declaredConnectionId: 'deleted-1',
    });
  });

  test('getAppConfig is live too, so status cannot report the boot-time default model', () => {
    const { context, reload } = contextWithConfig({
      defaultLLMProvider: 'anthropic-1',
    });
    const deps = createRuntimeSystemRouteDeps(context);

    reload({ defaultLLMProvider: 'anthropic-1', defaultModel: 'qwen3' } as {
      defaultLLMProvider?: string;
    });

    expect(
      (deps.getAppConfig() as { defaultModel?: string }).defaultModel,
    ).toBe('qwen3');
  });
});

test('runtime status reads restored-home provenance and never exposes backup paths or digests', () => {
  const root = mkdtempSync(join(tmpdir(), 'station-recovery-status-'));
  try {
    const source = join(root, 'source');
    ensureStationHomeSchemaSync(source);
    const backup = createStationHomeBackup({
      homeDir: source,
      outputDir: join(root, 'backup'),
      now: () => '2026-09-05T00:00:00.000Z',
    });
    const restored = restoreStationHomeBackup({
      homeDir: join(root, 'target'),
      backupDir: backup.backupDir,
      confirm: true,
    });
    const { context } = contextWithConfig({});
    context.configLoader.getProjectHomeDir = () => restored.homeDir;
    const deps = createRuntimeSystemRouteDeps(context);
    expect(deps.getHomeRecovery()).toEqual({
      kind: 'recovered-from-copy',
      recoveryId: restored.recovery.recoveryId,
      snapshotCreatedAt: '2026-09-05T00:00:00.000Z',
      authorityTransferred: false,
    });
    expect(JSON.stringify(deps.getHomeRecovery())).not.toContain(root);
    writeFileSync(join(restored.homeDir, STATION_HOME_RECOVERY_RECORD), '{}');
    expect(deps.getHomeRecovery()).toEqual({ kind: 'unavailable' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
