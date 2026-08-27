import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  ActionOperationService,
  FileActionOperationStore,
} from '../../services/operations/action-operation-service.js';
import { StationRuntime } from '../bootstrap/station-runtime.js';

describe('StationRuntime fleet action-operation composition', () => {
  test('routes and fleet observer share the runtime-owned durable service', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'station-fleet-runtime-'));
    const operations = new ActionOperationService(
      new FileActionOperationStore(directory),
    );
    const runtime = Object.create(StationRuntime.prototype) as {
      stationEnvironmentId: string;
      actionOperations: ActionOperationService;
      configLoader: { getProjectHomeDir(): string };
      fleetConsumerProbesPreview: { select(input: unknown): undefined };
      fleetRouting(): {
        observer?: {
          begin(input: {
            accountId: string;
            sessionId: string;
            turnId: string;
            correlationId: string;
            planDigest: string;
          }): Promise<void>;
        };
      };
    };
    runtime.stationEnvironmentId = 'environment-a';
    runtime.actionOperations = operations;
    runtime.configLoader = { getProjectHomeDir: () => directory };
    runtime.fleetConsumerProbesPreview = { select: () => undefined };

    const routing = runtime.fleetRouting();
    expect(routing.observer).toBeDefined();
    await routing.observer!.begin({
      accountId: 'account-a',
      sessionId: 'session-a',
      turnId: 'turn-a',
      correlationId: 'correlation-a',
      planDigest: 'plan-a',
    });

    expect(
      (
        await operations.list({
          accountId: 'account-a',
          canReadSession: (sessionId) => sessionId === 'session-a',
        })
      ).items,
    ).toHaveLength(1);
  });
});
