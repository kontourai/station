import { PLUGIN_FOREGROUND_WORK_SCHEMA_VERSION } from '@kontourai/station-contracts/plugin-foreground-work';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { describe, expect, test } from 'vitest';
import {
  PluginForegroundRunStorageUnavailableError,
  RunService,
} from '../run-service.js';

const authority = sessionReadAuthorityFromRequest(
  'account-a',
  undefined,
  undefined,
);
const run = {
  schemaVersion: PLUGIN_FOREGROUND_WORK_SCHEMA_VERSION,
  runId: 'plugin:run-a',
  pluginId: 'build-tools',
  installationGeneration: 2,
  kind: 'index-project',
  state: 'indeterminate' as const,
  effectDepth: 'possible-effect' as const,
  startedAt: '2026-09-03T00:00:00.000Z',
  updatedAt: '2026-09-03T00:00:02.000Z',
  completedAt: '2026-09-03T00:00:02.000Z',
  failureSummary: 'Plugin work may have continued before Station stopped.',
};

function createService(
  pluginForegroundRuns: ConstructorParameters<typeof RunService>[4],
) {
  return new RunService(
    {
      listAgentRuns: async () => [],
      readAgentRun: async () => null,
    } as unknown as ConstructorParameters<typeof RunService>[0],
    {
      listRunSummaries: async () => [],
      readRunSummary: async () => null,
    } as unknown as ConstructorParameters<typeof RunService>[1],
    {
      list: () => ({ kind: 'available', runs: [] }),
      read: () => ({ kind: 'available', run: null }),
    },
    {
      list: () => ({ kind: 'available', runs: [] }),
      read: () => ({ kind: 'available', run: null }),
    },
    pluginForegroundRuns,
  );
}

describe('RunService plugin foreground projection', () => {
  test('reads and filters the canonical plugin run without projecting private identities', async () => {
    const service = createService({
      list: async () => ({ kind: 'available', runs: [run] }),
      read: async (runId) => ({
        kind: 'available',
        run: runId === run.runId ? run : null,
      }),
    });

    await expect(
      service.listRuns(authority, { source: 'plugin' }),
    ).resolves.toEqual([
      expect.objectContaining({
        runId: run.runId,
        source: 'plugin',
        providerId: 'plugin:build-tools',
        sourceId: 'index-project',
        status: 'failed',
        failureKind: 'unknown',
        retryEligible: false,
        metadata: expect.objectContaining({
          pluginForegroundState: 'indeterminate',
          effectDepth: 'possible-effect',
        }),
      }),
    ]);
    const observed = await service.readRun(run.runId, authority);
    expect(observed).toMatchObject({ source: 'plugin', status: 'failed' });
    expect(JSON.stringify(observed)).not.toContain('installationKey');
    expect(JSON.stringify(observed)).not.toContain('idempotency');
  });

  test('fails closed when the canonical plugin run reader is unavailable', async () => {
    const service = createService({
      list: async () => ({ kind: 'unavailable' }),
      read: async () => ({ kind: 'unavailable' }),
    });
    await expect(
      service.listRuns(authority, { source: 'plugin' }),
    ).rejects.toBeInstanceOf(PluginForegroundRunStorageUnavailableError);
    await expect(service.readRun(run.runId, authority)).rejects.toBeInstanceOf(
      PluginForegroundRunStorageUnavailableError,
    );
  });
});
