import { type ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, vi } from 'vitest';
import {
  executeOwnedProcess,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from '../../../../scripts/lib/owned-process.mjs';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { awaitSessionRecoveryCompleted } from '../../../__test-utils__/session-runtime-barriers.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

const makeTempDir = trackTempDirs();
const moduleUrl = (path: string) =>
  JSON.stringify(new URL(path, import.meta.url).href);
const ownerSource = `
import { EventStore } from ${moduleUrl('../event-store.ts')};
import { OrchestrationService } from ${moduleUrl('../orchestration-service.ts')};
import { EventBus } from ${moduleUrl('../event-bus.ts')};
import { GateTestAdapter, createGateTestRegistry } from ${moduleUrl('../../../__test-utils__/orchestration-gate-test-harness.ts')};
const store = new EventStore(process.argv[1]);
const adapter = new GateTestAdapter();
let stops = 0;
adapter.stopSession = async () => { stops++; };
adapter.hasSession = async () => stops === 0;
const service = new OrchestrationService({ adapterRegistry: createGateTestRegistry(adapter),
  eventStore: store, eventBus: new EventBus(), logger: { debug() {}, warn() {} } });
service.initialize();
await service.whenSessionRecoveryCompleted();
service.seedSessionRecord({ threadId: 'child', provider: 'claude', status: 'running' });
const admission = store.sessionTurnBoundaryAuthority().claim('child', '2026-01-01T00:00:00.000Z');
if (admission.kind !== 'owner') throw new Error('No child admission');
admission.claim.beginInvocation('2026-01-01T00:00:00.000Z');
admission.claim.accepted('child-turn', '2026-01-01T00:00:00.000Z');
process.on('message', async () => {
  try {
    await service.sweepIdleSessions();
    process.send({ stops, pending: store.pendingCascadeStops().length });
  } catch (error) { process.send({ error: String(error) }); }
});
process.send({ ready: true });
`;

function message(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error('Cascade owner did not answer')),
      15000,
    );
    const finish = (error?: Error, value?: unknown) => {
      clearTimeout(timer);
      child.off('message', received);
      child.off('error', failed);
      child.off('exit', exited);
      if (error) reject(error);
      else resolve(value);
    };
    const received = (value: unknown) => finish(undefined, value);
    const failed = (error: Error) => finish(error);
    const exited = () => finish(new Error('Cascade owner exited early'));
    child.once('message', received);
    child.once('error', failed);
    child.once('exit', exited);
  });
}

test('a live peer retains the intent and its actual owner delivers through existing reconciliation', {
  timeout: 30000,
}, async () => {
  const path = join(makeTempDir('cascade-peer-'), 'events.sqlite');
  const execution = executeOwnedProcess(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', ownerSource, path],
    spawn,
    'Cascade Session owner',
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true },
  );
  let stderr = '';
  execution.child.stderr?.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-8000);
  });
  let store: EventStore | undefined;
  let service: OrchestrationService | undefined;
  try {
    expect(await message(execution.child), stderr).toEqual({ ready: true });
    store = new EventStore(path);
    store.appendEvent({
      eventId: 'terminal',
      threadId: 'parent',
      sessionId: 'parent',
      provider: 'claude',
      method: 'session.exited',
      reason: 'stopped',
      createdAt: '2026-01-01T00:00:01.000Z',
    });
    store.recordCascadeStopIntent('parent', 'child', 'terminal');
    const adapter = new GateTestAdapter();
    const stop = vi.spyOn(adapter, 'stopSession');
    service = new OrchestrationService({
      adapterRegistry: createGateTestRegistry(adapter),
      eventStore: store,
      eventBus: new EventBus(),
      logger: { debug() {}, warn() {} },
    });
    service.initialize();
    await awaitSessionRecoveryCompleted(service);
    await service.sweepIdleSessions();
    expect(stop).not.toHaveBeenCalled();
    expect(store.pendingCascadeStops()).toHaveLength(1);
    const db = new DatabaseSync(path);
    try {
      expect(
        db
          .prepare('SELECT custody FROM orchestration_cascade_stop_custody')
          .get(),
      ).toEqual({ custody: 'peer' });
    } finally {
      db.close();
    }
    const delivered = message(execution.child);
    execution.child.send('reconcile');
    expect(await delivered).toEqual({ stops: 1, pending: 0 });
    expect(store.pendingCascadeStops()).toEqual([]);
  } finally {
    await service?.shutdown();
    store?.close();
    await terminateSuiteExecution(execution, {
      processLabel: 'Cascade Session owner',
      waitForSuiteSettlement,
      terminationGraceMs: 1000,
      terminationForceMs: 1000,
    });
  }
});
