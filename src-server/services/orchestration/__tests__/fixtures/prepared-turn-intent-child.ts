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

const [
  databasePath,
  phase,
  threadId,
  clientTurnId,
  input,
  ambientContext,
  cwd,
] = process.argv.slice(2);
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
      metadata: { ...value.metadata, nativeResumeBindingKey: 'b'.repeat(64) },
    });
    return {
      ...(await super.startSession(value)),
      ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
      resumeCursor: { sessionId: 'prepared-native-session' },
    };
  }

  override async hasSession(id?: string) {
    return id !== undefined && this.sessions.has(id);
  }
  preparedTurnBinding(id: string) {
    return this.sessions.has(id)
      ? {
          bindingKey: 'b'.repeat(64),
          nativeIdentity: { sessionId: 'prepared-native-session' },
        }
      : undefined;
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
  {
    type: 'startSession',
    input: {
      threadId,
      provider: 'claude',
      ...(cwd === undefined ? {} : { cwd }),
      metadata: { userId: 'prepared-owner' },
    },
  },
  { userId: 'prepared-owner' },
);
const ownerDeadline = Date.now() + 20_000;
while (!store.readSessionByThread(threadId)) {
  if (Date.now() >= ownerDeadline)
    throw new Error('Session start was not persisted.');
  await new Promise((resolve) => setTimeout(resolve, 10));
}

if (phase === 'prepared' || phase === 'begun') {
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql: string) {
    exec.call(this, sql);
    if (sql.trim().toUpperCase() !== 'COMMIT') return;
    const row = this.prepare(
      `SELECT boundary_id, state FROM orchestration_turn_boundaries
       WHERE thread_id = ? AND boundary_id LIKE 'turn-boundary:%'`,
    ).get(threadId);
    if (row?.state !== (phase === 'prepared' ? 'prepared' : 'invoking')) return;
    // Stop the actual owner immediately after its durable preparation commit.
    // SIGKILL from the parent bypasses every service finally/release path.
    report(phase, { boundaryId: row.boundary_id });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  };
}
if (phase === 'prepare-abort') {
  const db = new DatabaseSync(databasePath);
  db.exec(`CREATE TRIGGER abort_prepared_body BEFORE INSERT ON orchestration_prepared_turns
    BEGIN SELECT RAISE(ABORT, 'fixture prepare body abort'); END`);
  db.close();
}

void service
  .dispatch({
    type: 'sendTurn',
    input: {
      threadId,
      ...([
        'sparse-array',
        'array-subclass',
        'non-enumerable',
        'dense-array',
      ].includes(phase)
        ? {}
        : { clientTurnId }),
      input,
      ambientContext,
      ...{ invocationId: 'untrusted-caller-invocation' },
      ...(phase === 'sparse-array'
        ? {
            metadata: {
              preparedStrictArray: Object.assign(Array(1), {
                extra: 'must not disappear',
              }),
            },
          }
        : {}),
      ...(phase === 'array-subclass'
        ? {
            metadata: {
              preparedStrictArray: new (class extends Array<string> {})(
                'must not reinterpret',
              ),
            },
          }
        : {}),
      ...(phase === 'non-enumerable'
        ? {
            metadata: {
              preparedStrictObject: Object.defineProperty({}, 'hidden', {
                value: 'must not disappear',
              }),
            },
          }
        : {}),
      ...(phase === 'dense-array'
        ? {
            metadata: {
              preparedStrictArray: ['keep', { nested: [1, null, true] }],
            },
          }
        : {}),
    },
  })
  .catch((error: unknown) => {
    report('failed', { message: String(error) });
    process.exitCode = 1;
  });
setInterval(() => undefined, 1000);
