import { randomUUID } from 'node:crypto';
import { existsSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { fileMutationLockOrphanTemporaries } from '../../../telemetry/metrics.js';
import {
  getActiveRuntimeProjectSlug,
  prepareRuntimeStartup,
  seedRuntimeDefaultProviderConnection,
  sweepRuntimeOrphanedMutationTemporaries,
} from '../runtime-startup.js';

const makeTempDir = trackTempDirs();

/**
 * #4995: a live home held zero-byte `notifications.json.mutation.<uuid>.tmp`
 * files 13 days old. Startup reclaims them through the lock module's sweep.
 */
describe('sweepRuntimeOrphanedMutationTemporaries (#4995)', () => {
  test('removes an old orphan from the real home, counts it, and logs once', async () => {
    const home = makeTempDir('station-startup-sweep-');
    const orphan = join(
      home,
      `notifications.json.mutation.${randomUUID()}.tmp`,
    );
    writeFileSync(orphan, '');
    const old = new Date(Date.now() - 13 * 24 * 60 * 60_000);
    utimesSync(orphan, old, old);
    const fresh = join(home, `jobs.json.mutation.${randomUUID()}.tmp`);
    writeFileSync(fresh, '');
    const add = vi.spyOn(fileMutationLockOrphanTemporaries, 'add');
    const logger = { info: vi.fn(), warn: vi.fn() };
    try {
      await sweepRuntimeOrphanedMutationTemporaries(home, logger);

      expect(existsSync(orphan)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
      expect(add.mock.calls).toEqual([[1, { outcome: 'removed' }]]);
      expect(logger.info).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith(
        'Swept orphaned mutation lock temporaries',
        { removed: 1, retainedLive: 0, failed: 0, truncated: false },
      );

      // Nothing left to find: silent, and nothing counted.
      add.mockClear();
      logger.info.mockClear();
      await sweepRuntimeOrphanedMutationTemporaries(home, logger);
      expect(add).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
    } finally {
      add.mockRestore();
    }
  });

  test('a sweep that throws is reported, never a startup failure', async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    await sweepRuntimeOrphanedMutationTemporaries(
      '/nowhere',
      logger,
      async () => {
        throw new Error('EIO');
      },
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'Orphaned mutation lock temporary sweep failed',
      { error: 'EIO' },
    );
  });
});

describe('getActiveRuntimeProjectSlug', () => {
  test('returns the first configured project slug', () => {
    expect(
      getActiveRuntimeProjectSlug({
        listProjects: () => [{ slug: 'project-a' }, { slug: 'project-b' }],
      } as any),
    ).toBe('project-a');
  });
});

describe('seedRuntimeDefaultProviderConnection', () => {
  test('still seeds bedrock when only non-llm providers exist and ollama is up (ollama is detect-only)', async () => {
    const storageAdapter = {
      listProviderConnections: vi.fn(() => [
        {
          id: 'lancedb-builtin',
          type: 'lancedb',
          enabled: true,
          capabilities: ['vectordb'],
        },
      ]),
      saveProviderConnection: vi.fn(),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

    await seedRuntimeDefaultProviderConnection({
      storageAdapter: storageAdapter as any,
      appConfig: {},
      logger,
      checkOllamaAvailability: async () => true,
      checkBedrockCredentials: async () => true,
    });

    // Ollama is never auto-written; Bedrock remains the only auto-seed path.
    expect(storageAdapter.saveProviderConnection).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ollama' }),
    );
    expect(storageAdapter.saveProviderConnection).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'bedrock' }),
    );
  });

  test('does not auto-seed ollama when reachable; falls through to bedrock when credentials exist', async () => {
    const storageAdapter = {
      listProviderConnections: vi.fn(() => []),
      saveProviderConnection: vi.fn(),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

    await seedRuntimeDefaultProviderConnection({
      storageAdapter: storageAdapter as any,
      appConfig: {},
      logger,
      checkOllamaAvailability: async () => true,
      checkBedrockCredentials: async () => true,
    });

    expect(storageAdapter.saveProviderConnection).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ollama' }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Ollama is reachable'),
      expect.objectContaining({ baseUrl: 'http://localhost:11434' }),
    );
    expect(storageAdapter.saveProviderConnection).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'bedrock' }),
    );
  });

  test('does not reseed when an enabled llm provider already exists', async () => {
    const storageAdapter = {
      listProviderConnections: vi.fn(() => [
        {
          id: 'ollama-local',
          type: 'ollama',
          enabled: true,
          capabilities: ['llm', 'embedding'],
        },
      ]),
      saveProviderConnection: vi.fn(),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

    await seedRuntimeDefaultProviderConnection({
      storageAdapter: storageAdapter as any,
      appConfig: {},
      logger,
      checkOllamaAvailability: async () => true,
      checkBedrockCredentials: async () => true,
    });

    expect(storageAdapter.saveProviderConnection).not.toHaveBeenCalled();
  });

  test('falls back to bedrock when ollama is unavailable and credentials are available', async () => {
    const storageAdapter = {
      listProviderConnections: vi.fn(() => []),
      saveProviderConnection: vi.fn(),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

    await seedRuntimeDefaultProviderConnection({
      storageAdapter: storageAdapter as any,
      appConfig: { region: 'us-west-2' },
      logger,
      checkOllamaAvailability: async () => false,
      checkBedrockCredentials: async () => true,
    });

    expect(storageAdapter.saveProviderConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'bedrock',
        config: { region: 'us-west-2' },
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      'Seeded default Bedrock provider connection',
    );
  });

  test('seeds bedrock without a region override when region is unset', async () => {
    const storageAdapter = {
      listProviderConnections: vi.fn(() => []),
      saveProviderConnection: vi.fn(),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

    await seedRuntimeDefaultProviderConnection({
      storageAdapter: storageAdapter as any,
      appConfig: {},
      logger,
      checkOllamaAvailability: async () => false,
      checkBedrockCredentials: async () => true,
    });

    expect(storageAdapter.saveProviderConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'bedrock',
        config: {},
      }),
    );
  });
});

describe('prepareRuntimeStartup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('discovers skills, optionally registers the default skill registry, and returns usage aggregation', async () => {
    const timers: NodeJS.Timeout[] = [];
    const storageAdapter = {
      listProjects: vi.fn(() => [{ slug: 'project-a' }]),
      listProviderConnections: vi.fn(() => [{ id: 'existing' }]),
      saveProviderConnection: vi.fn(),
    };
    const configLoader = {
      loadPluginOverrides: vi.fn(async () => ({})),
    };
    const skillService = {
      discoverSkills: vi.fn(async () => {}),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const provider = { id: 'default-skill-provider' };
    const registerSkillRegistryProvider = vi.fn();
    const runStartupMigrations = vi.fn(async () => {});
    const sweepOrphanedMutationTemporaries = vi.fn(async () => ({
      removed: 0,
      retainedLive: 0,
      failed: 0,
      truncated: false,
    }));
    const fullRescan = vi.fn(async () => {});
    const usageAggregator = { fullRescan } as any;

    const result = await prepareRuntimeStartup({
      projectHomeDir: '/tmp/project',
      appConfig: { region: 'us-west-2' },
      storageAdapter: storageAdapter as any,
      configLoader,
      skillService,
      logger,
      timers,
      createUsageAggregator: () => usageAggregator,
      runStartupMigrations,
      sweepOrphanedMutationTemporaries,
      createDefaultSkillRegistryProvider: async () => provider,
      registerSkillRegistryProvider,
    });

    expect(skillService.discoverSkills).toHaveBeenCalledWith(
      '/tmp/project',
      'project-a',
    );
    expect(registerSkillRegistryProvider).toHaveBeenCalledWith(provider);
    expect(runStartupMigrations).toHaveBeenCalledWith('/tmp/project');
    expect(sweepOrphanedMutationTemporaries).toHaveBeenCalledWith(
      '/tmp/project',
    );
    expect(result).toBe(usageAggregator);
    expect(timers).toHaveLength(1);
    // An immediate rescan, then one every 30 minutes.
    expect(fullRescan).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 - 1);
    expect(fullRescan).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fullRescan).toHaveBeenCalledTimes(2);
  });

  test.each([
    {
      name: 'app config disables default skill registries',
      appConfig: { disableDefaultSkillRegistries: true },
      overrides: {},
    },
    {
      name: 'the aws-internal plugin override disables them',
      appConfig: {},
      overrides: {
        'aws-internal': { settings: { disableDefaultSkillRegistries: true } },
      },
    },
  ])(
    'skips the default skill registry when $name',
    async ({ appConfig, overrides }) => {
      const createDefaultSkillRegistryProvider = vi.fn(async () => ({
        id: 'default-skill-provider',
      }));
      const registerSkillRegistryProvider = vi.fn();

      await prepareRuntimeStartup({
        projectHomeDir: '/tmp/project',
        appConfig,
        storageAdapter: {
          listProjects: vi.fn(() => []),
          listProviderConnections: vi.fn(() => [
            { id: 'existing', capabilities: ['llm'] },
          ]),
          saveProviderConnection: vi.fn(),
        } as any,
        configLoader: { loadPluginOverrides: vi.fn(async () => overrides) },
        skillService: { discoverSkills: vi.fn(async () => {}) },
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        timers: [],
        createUsageAggregator: () =>
          ({ fullRescan: vi.fn(async () => {}) }) as any,
        createDefaultSkillRegistryProvider,
        registerSkillRegistryProvider,
      });

      expect(createDefaultSkillRegistryProvider).not.toHaveBeenCalled();
      expect(registerSkillRegistryProvider).not.toHaveBeenCalled();
    },
  );

  test('seeds an llm provider after migrations add only vectordb providers', async () => {
    const timers: NodeJS.Timeout[] = [];
    const providerConnections: Array<{
      id: string;
      type: string;
      enabled: boolean;
      capabilities: string[];
    }> = [];
    const storageAdapter = {
      listProjects: vi.fn(() => [{ slug: 'project-a' }]),
      listProviderConnections: vi.fn(() => providerConnections),
      saveProviderConnection: vi.fn((connection) => {
        providerConnections.push(connection);
      }),
    };
    const configLoader = {
      loadPluginOverrides: vi.fn(async () => ({})),
    };
    const skillService = {
      discoverSkills: vi.fn(async () => {}),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const runStartupMigrations = vi.fn(async () => {
      providerConnections.push({
        id: 'lancedb-builtin',
        type: 'lancedb',
        enabled: true,
        capabilities: ['vectordb'],
      });
    });

    await prepareRuntimeStartup({
      projectHomeDir: '/tmp/project',
      appConfig: {},
      storageAdapter: storageAdapter as any,
      configLoader,
      skillService,
      logger,
      timers,
      runStartupMigrations,
      checkOllamaAvailability: async () => true,
      createUsageAggregator: () =>
        ({ fullRescan: vi.fn(async () => {}) }) as any,
    });

    // Ollama detect-only: with ollama reachable but no auto-seed, and no
    // bedrock check wired here, nothing is written after migrations.
    expect(storageAdapter.saveProviderConnection).not.toHaveBeenCalled();
  });
});
