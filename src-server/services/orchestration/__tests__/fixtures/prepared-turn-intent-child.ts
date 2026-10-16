import { writeSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../../__test-utils__/orchestration-gate-test-harness.js';
import type { ProviderSendTurnInput } from '../../../../providers/adapter-shape.js';
import { EventBus } from '../../event-bus.js';
import { EventStore } from '../../event-store.js';
import { OrchestrationService } from '../../orchestration-service.js';

const [databasePath, phase, threadId, clientTurnId, input, ambientContext] =
  process.argv.slice(2);
if (!databasePath || !threadId || !clientTurnId || !input)
  throw new Error('Missing prepared-intent child input.');

const report = (step: string, extra: object = {}) =>
  writeSync(1, `${JSON.stringify({ step, ...extra })}\n`);

class InterruptedAdapter extends GateTestAdapter {
  private readonly sessions = new Set<string>();

  override async startSession(
    value: Parameters<GateTestAdapter['startSession']>[0],
  ) {
    this.sessions.add(value.threadId);
    this.events.push({
      method: 'session.started',
      eventId: `started:${value.threadId}`,
      provider: this.provider,
      threadId: value.threadId,
      sessionId: value.threadId,
      createdAt: new Date().toISOString(),
      metadata: value.metadata,
    });
    return super.startSession(value);
  }

  override async hasSession(id?: string) {
    return id !== undefined && this.sessions.has(id);
  }

  override sendTurn(
    value: ProviderSendTurnInput,
  ): ReturnType<GateTestAdapter['sendTurn']> {
    report('invoked', { input: value });
    return new Promise(() => {});
  }
}

const store = new EventStore(databasePath);
const service = new OrchestrationService({
  adapterRegistry: createGateTestRegistry(new InterruptedAdapter()),
  eventBus: new EventBus(),
  eventStore: store,
  logger: { debug() {}, warn() {} },
});
service.initialize();
await service.dispatch(
  { type: 'startSession', input: { threadId, provider: 'claude' } },
  { userId: 'prepared-owner' },
);
const ownerDeadline = Date.now() + 20_000;
while (!store.readSessionByThread(threadId)) {
  if (Date.now() >= ownerDeadline)
    throw new Error('Session start was not persisted.');
  await new Promise((resolve) => setTimeout(resolve, 10));
}

if (phase === 'prepared') {
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql: string) {
    exec.call(this, sql);
    if (sql.trim().toUpperCase() !== 'COMMIT') return;
    const row = this.prepare(
      `SELECT boundary_id, state FROM orchestration_turn_boundaries
       WHERE thread_id = ? AND boundary_id LIKE 'turn-boundary:%'`,
    ).get(threadId);
    if (row?.state !== 'prepared') return;
    // Stop the actual owner immediately after its durable preparation commit.
    // SIGKILL from the parent bypasses every service finally/release path.
    report('prepared', { boundaryId: row.boundary_id });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  };
}

void service
  .dispatch({
    type: 'sendTurn',
    input: { threadId, clientTurnId, input, ambientContext },
  })
  .catch((error: unknown) => {
    report('failed', { message: String(error) });
    process.exitCode = 1;
  });
setInterval(() => undefined, 1000);
