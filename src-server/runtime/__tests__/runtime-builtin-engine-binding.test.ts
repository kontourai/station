import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  engineConnectionId,
  engineId,
  engineRuntimeId,
} from '@kontourai/station-contracts/agent-identity';
import type { AppConfig } from '@kontourai/station-contracts/config';
import { describe, expect, it, vi } from 'vitest';
import { ConfigLoader } from '../../domain/config-loader.js';
import { connectionIdForPersistedSelection } from '../../providers/adapter-identity.js';
import { StationRuntime } from '../bootstrap/station-runtime.js';

describe('StationRuntime built-in engine identity migration', () => {
  it('joins a legacy runtime selector to its public connection identity', () => {
    expect(
      connectionIdForPersistedSelection('codex-runtime', [
        {
          id: engineConnectionId('codex'),
          runtimeId: engineRuntimeId('codex-runtime'),
        },
      ]),
    ).toBe(engineConnectionId('codex'));
  });

  it('gives a current public identity precedence over colliding legacy runtime text', () => {
    expect(
      connectionIdForPersistedSelection('shared', [
        {
          id: engineConnectionId('other'),
          runtimeId: engineRuntimeId('shared'),
        },
        {
          id: engineConnectionId('shared'),
          runtimeId: engineRuntimeId('shared-runtime'),
        },
      ]),
    ).toBe(engineConnectionId('shared'));
  });

  it('does not overwrite a newer operator choice during legacy migration', async () => {
    const current = {
      defaultModel: '',
      invokeModel: '',
      structureModel: '',
      builtinAgentEngineConnectionId: engineConnectionId('claude'),
    };
    const runtime = Object.create(StationRuntime.prototype) as {
      connectionService: {
        listEngineConnectionMigrationCandidates: () => Promise<unknown[]>;
      };
      configLoader: {
        loadAppConfig: () => Promise<AppConfig>;
        mutateAppConfig: (
          mutate: (config: Readonly<AppConfig>) => Partial<AppConfig>,
        ) => Promise<AppConfig>;
      };
      migrateBuiltinEngineConnectionSelection: () => Promise<AppConfig>;
    };
    runtime.connectionService = {
      listEngineConnectionMigrationCandidates: async () => [
        {
          engineConnectionId: engineConnectionId('codex'),
          runtimeId: engineRuntimeId('codex-runtime'),
        },
      ],
    };
    runtime.configLoader = {
      loadAppConfig: async () =>
        ({
          ...current,
          builtinAgentEngineConnectionId: 'codex-runtime',
        }) as unknown as AppConfig,
      mutateAppConfig: async (mutate) => {
        expect(mutate(current)).toEqual({});
        return current;
      },
    };

    await expect(
      runtime.migrateBuiltinEngineConnectionSelection(),
    ).resolves.toEqual(current);
  });

  it('preserves and durably migrates an existing explicit selection before the real reload revision fence', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-engine-id-migration-'));
    mkdirSync(join(home, 'config'), { recursive: true });
    writeFileSync(
      join(home, 'config', 'app.json'),
      JSON.stringify({
        defaultModel: '',
        invokeModel: '',
        structureModel: '',
        builtinAgentEngineConnectionId: 'codex-runtime',
      }),
    );
    const configLoader = new ConfigLoader({ projectHomeDir: home });
    const observed: { binding: { connectionId: string } | null } = {
      binding: null,
    };
    const runtime = Object.create(StationRuntime.prototype) as {
      listEngineConnections: () => Promise<unknown[]>;
      connectionService: {
        listEngineConnectionMigrationCandidates: () => Promise<unknown[]>;
      };
      providerService: {
        listProviderConnections: () => unknown[];
        getLaunchabilityRevision: () => number;
      };
      configLoader: ConfigLoader;
      resolveBuiltinEngineBinding: (
        config: AppConfig,
      ) => Promise<{ connectionId: string } | null>;
      reloadDefaultAgentFromConfig: (config: AppConfig) => Promise<void>;
      reloadDefaultAgent: () => Promise<void>;
      rebuildGlobalToolRegistry: () => void;
      [key: string]: unknown;
    };

    runtime.listEngineConnections = async () => [
      {
        id: engineConnectionId('codex'),
        runtimeId: engineRuntimeId('codex-runtime'),
        type: 'codex-runtime',
        name: 'Codex',
        enabled: true,
        status: 'ready',
        engineId: engineId('codex'),
        capabilities: ['agent-runtime'],
      },
    ];
    runtime.connectionService = {
      listEngineConnectionMigrationCandidates: async () => [
        {
          engineConnectionId: engineConnectionId('codex'),
          runtimeId: engineRuntimeId('codex-runtime'),
        },
      ],
    };
    runtime.providerService = {
      listProviderConnections: () => [],
      getLaunchabilityRevision: () => 0,
    };
    runtime.configLoader = configLoader;
    runtime.agentConfigurationMutationQueue = Promise.resolve();
    runtime.agentConfigurationMutationsClosed = false;
    runtime.agentConfigurationRevision = 0;
    runtime.agentConfigurationPersistenceRevision = 0;
    runtime.loadedProviderLaunchabilityRevision = null;
    runtime.loadedAppConfigLaunchabilityRevision = null;
    runtime.globalToolRegistry = new Map();
    runtime.agentTools = new Map();
    runtime.rebuildGlobalToolRegistry = vi.fn();
    const resolve = (
      StationRuntime.prototype as unknown as {
        resolveBuiltinEngineBinding: (
          this: typeof runtime,
          config: AppConfig,
        ) => Promise<{ connectionId: string } | null>;
      }
    ).resolveBuiltinEngineBinding;
    runtime.reloadDefaultAgentFromConfig = async (config) => {
      observed.binding = await resolve.call(runtime, config);
    };

    try {
      await runtime.reloadDefaultAgent();
      expect(observed.binding?.connectionId).toBe(engineConnectionId('codex'));
      expect(
        JSON.parse(readFileSync(join(home, 'config', 'app.json'), 'utf8'))
          .builtinAgentEngineConnectionId,
      ).toBe('codex');
    } finally {
      await configLoader.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
