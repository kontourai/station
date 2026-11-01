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
let effects = 0;
adapter.stopSession = async () => { stops++; effects = 1; };
adapter.hasSession = async () => effects === 0;
const service = new OrchestrationService({ adapterRegistry: createGateTestRegistry(adapter),
  eventStore: store, eventBus: new EventBus(), logger: { debug() {}, warn() {} } });
service.initialize();
await service.whenSessionRecoveryCompleted();
service.seedSessionRecord({ threadId: 'child', provider: 'claude', status: 'running' });
store.appendEvent({ eventId: 'child-started', threadId: 'child', sessionId: 'child', provider: 'claude',
  method: 'session.started', createdAt: '2026-01-01T00:00:00.000Z', metadata: {
    delegation: { parentSessionId: 'parent', parentConversationId: 'parent' }, stationDelegationProvenance: 'caller-derived' } });
const admission = store.sessionTurnBoundaryAuthority().claim('child', '2026-01-01T00:00:00.000Z');
if (admission.kind !== 'owner') throw new Error('No child admission');
admission.claim.beginInvocation('2026-01-01T00:00:00.000Z');
admission.claim.accepted('child-turn', '2026-01-01T00:00:00.000Z');
process.on('message', async () => {
  try {
    await service.sweepIdleSessions();
    process.send({ stops, effects, pending: store.pendingCascadeStops().length });
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

test.each([
  'normal',
  'requester-crash-before-delivery',
  'reopen-after-delivery-before-ack',
] as const)(
  'a live peer retains the intent and its actual owner reconciles: %s',
  {
    timeout: 30000,
  },
  async (mode) => {
    const path = join(makeTempDir('cascade-peer-'), 'events.sqlite');
    const seed = new EventStore(path);
    seed.appendEvent({
      eventId: 'parent-started',
      threadId: 'parent',
      sessionId: 'parent',
      provider: 'claude',
      method: 'session.started',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    seed.close();
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
      const terminal = {
        eventId: 'terminal',
        threadId: 'parent',
        sessionId: 'parent',
        provider: 'claude',
        method: 'session.exited' as const,
        reason: 'stopped',
        createdAt: '2026-01-01T00:00:01.000Z',
      };
      if (mode === 'requester-crash-before-delivery') {
        const crashSource = `import { EventStore } from ${moduleUrl('../event-store.ts')};
        const store = new EventStore(process.argv[1]); store.appendEvent(${JSON.stringify(terminal)}); process.exit(86);`;
        const writer = executeOwnedProcess(
          process.execPath,
          ['--import', 'tsx', '--input-type=module', '-e', crashSource, path],
          spawn,
          'Cascade crash writer',
          { stdio: 'ignore', windowsHide: true },
        );
        try {
          expect(await waitForSuiteSettlement(writer, 15000)).toBe(true);
          expect((await writer.completion).status).toBe(86);
        } finally {
          await terminateSuiteExecution(writer, {
            processLabel: 'Cascade crash writer',
            waitForSuiteSettlement,
            terminationGraceMs: 1000,
            terminationForceMs: 1000,
          });
        }
      }
      store = new EventStore(path);
      if (mode !== 'requester-crash-before-delivery')
        store.appendEvent(terminal);
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
      if (mode === 'reopen-after-delivery-before-ack') {
        const fault = new DatabaseSync(path);
        fault.exec(
          "CREATE TRIGGER fail_stop_ack BEFORE UPDATE OF state ON orchestration_cascade_stop_intents WHEN NEW.state = 'completed' BEGIN SELECT RAISE(ABORT, 'injected completion crash'); END",
        );
        fault.close();
      }
      execution.child.send('reconcile');
      expect(await delivered).toEqual({
        stops: 1,
        effects: 1,
        pending: mode === 'reopen-after-delivery-before-ack' ? 1 : 0,
      });
      if (mode === 'reopen-after-delivery-before-ack') {
        await service.shutdown();
        store.close();
        store = new EventStore(path);
        const fault = new DatabaseSync(path);
        fault.exec('DROP TRIGGER fail_stop_ack');
        fault.close();
        service = new OrchestrationService({
          adapterRegistry: createGateTestRegistry(adapter),
          eventStore: store,
          eventBus: new EventBus(),
          logger: { debug() {}, warn() {} },
        });
        service.initialize();
        await awaitSessionRecoveryCompleted(service);
        const redelivered = message(execution.child);
        execution.child.send('reconcile');
        expect(await redelivered).toEqual({ stops: 2, effects: 1, pending: 0 });
      }
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
  },
);
