import { PLUGIN_FOREGROUND_WORK_SCHEMA_VERSION } from '@kontourai/station-contracts/plugin-foreground-work';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { describe, expect, test } from 'vitest';
import type { PluginForegroundRunRecord } from '../../plugins/plugin-foreground-runs.js';
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
// The full stored row, private owner and idempotency facts included. The
// reader's public type admits it (a record extends the run), so only the
// `/runs` projection stands between these fields and the wire.
const storedRecord: PluginForegroundRunRecord = {
  ...run,
  installationKey: 'host-installation-key-secret',
  accountId: 'account-a',
  idempotencyDigest: 'idempotency-digest-secret',
  inputDigest: 'input-digest-secret',
  executionOwnerId: 'execution-owner-secret',
  executionOwnerPid: 4242,
  executionOwnerIdentityKind: 'unverified',
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
      list: async () => ({ kind: 'available', runs: [storedRecord] }),
      read: async (runId) => ({
        kind: 'available',
        run: runId === run.runId ? storedRecord : null,
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
    const listed = await service.listRuns(authority, { source: 'plugin' });
    const observed = await service.readRun(run.runId, authority);
    expect(observed).toMatchObject({ source: 'plugin', status: 'failed' });
    for (const projected of [
      JSON.stringify(listed),
      JSON.stringify(observed),
    ]) {
      for (const secret of [
        'host-installation-key-secret',
        'idempotency-digest-secret',
        'input-digest-secret',
        'execution-owner-secret',
        'installationKey',
        'idempotency',
      ]) {
        expect(projected).not.toContain(secret);
      }
    }
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
