import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { afterEach, expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  type ProviderSendTurnInput,
  SendTurnRefusedError,
} from '../../../providers/adapter-shape.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { SessionExecutionCoordinator } from '../session-execution-coordinator.js';
import { resolveWorkspaceIdentity } from '../workspace-identity.js';

const THREAD = 'prepared-turn-owner';
const KEY = 'prepared-turn-key';
const INPUT = '  keep these bytes\n';
const AMBIENT = 'pinned context\n';
const makeTempDir = trackTempDirs();
const children: ChildProcess[] = [];
const services: OrchestrationService[] = [];
const stores: EventStore[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  for (const service of services.splice(0)) await service.shutdown();
  for (const store of stores.splice(0)) store.close();
});

class LiveResumeAdapter extends GateTestAdapter {
  result: 'accepted' | 'refused' | 'unknown' = 'accepted';
  bindingKey = 'b'.repeat(64);
  preparedTurnBinding() {
    return {
      bindingKey: this.bindingKey,
      nativeIdentity: { sessionId: 'prepared-native-session' },
    };
  }
  readonly sent: ProviderSendTurnInput[] = [];
  override async hasSession() {
    return true;
  }
  override async listSessions() {
    return [
      {
        provider: 'claude' as const,
        threadId: THREAD,
        status: 'ready' as const,
        resumeCursor: { sessionId: 'prepared-native-session' },
        createdAt: '2026-10-16T00:00:00Z',
        updatedAt: '2026-10-16T00:00:00Z',
      },
    ];
  }
  override async sendTurn(input: ProviderSendTurnInput) {
    this.sent.push(input);
    if (this.result === 'refused')
      throw new SendTurnRefusedError(
        'No provider-visible effect.',
        'provider_error',
      );
    if (this.result === 'unknown')
      throw new Error('Connection dropped after begin.');
    return { threadId: input.threadId, turnId: 'resumed-original' };
  }
}

async function killedOwner(
  databasePath: string,
  phase:
    | 'prepared'
    | 'invoked'
    | 'begun'
    | 'prepare-abort'
    | 'sparse-array'
    | 'array-subclass'
    | 'non-enumerable'
    | 'dense-array',
  cwd?: string,
) {
  const expected =
    phase === 'sparse-array' ||
    phase === 'array-subclass' ||
    phase === 'non-enumerable' ||
    phase === 'prepare-abort'
      ? 'failed'
      : phase === 'dense-array'
        ? 'invoked'
        : phase;
  const home = join(dirname(databasePath), 'fixture-home');
  mkdirSync(home, { recursive: true });
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      resolve(
        'src-server/services/orchestration/__tests__/fixtures/prepared-turn-intent-child.ts',
      ),
      databasePath,
      phase,
      THREAD,
      KEY,
      INPUT,
      AMBIENT,
      ...(cwd === undefined ? [] : [cwd]),
    ],
    {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, 'config'),
        XDG_CACHE_HOME: join(home, 'cache'),
        STATION_HOME: join(home, 'station'),
      },
    },
  );
  children.push(child);
  let output = '';
  let errors = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    errors += chunk.toString();
  });
  await new Promise<void>((resolveStep, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error(`Owner did not reach ${phase}: ${output} ${errors}`)),
      60_000,
    );
    const failed = (code: number | null) => {
      clearTimeout(timer);
      reject(new Error(`Owner exited ${code}: ${output} ${errors}`));
    };
    child.once('exit', failed);
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (expected !== 'failed' && output.includes('"step":"failed"')) {
        clearTimeout(timer);
        child.removeListener('exit', failed);
        reject(new Error(`Owner dispatch failed: ${output} ${errors}`));
        return;
      }
      if (expected === 'failed' && output.includes('"step":"invoked"')) {
        clearTimeout(timer);
        child.removeListener('exit', failed);
        reject(new Error(`Invalid input reached the adapter: ${output}`));
        return;
      }
      if (!output.includes(`"step":"${expected}"`)) return;
      clearTimeout(timer);
      child.removeListener('exit', failed);
      resolveStep();
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  expect(child.signalCode).toBe('SIGKILL');
  return output;
}

function storedIntent(databasePath: string) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orchestration_prepared_turns'",
        )
        .get(),
      'a real dispatch must retain its input before the engine can receive it',
    ).toBeDefined();
    const row = db
      .prepare(
        'SELECT invocation_id, client_turn_id, input_digest, envelope_json FROM orchestration_prepared_turns WHERE thread_id = ?',
      )
      .get(THREAD);
    expect(row).toBeDefined();
    if (!row || typeof row.envelope_json !== 'string')
      throw new Error('Missing prepared input body.');
    return { row, envelope: JSON.parse(row.envelope_json) };
  } finally {
    db.close();
  }
}

test('a killed prepared owner leaves the exact final input retrievable without invoking', async () => {
  const path = join(makeTempDir('prepared-intent-crash-'), 'events.sqlite');
  const observed = await killedOwner(path, 'prepared');
  expect(observed).not.toContain('"step":"invoked"');
  const { row, envelope } = storedIntent(path);
  expect(row.client_turn_id).toBe(KEY);
  expect(row.input_digest).toMatch(/^[a-f0-9]{64}$/);
  expect(envelope.input).toMatchObject({
    text: 'pinned context\n\n  keep these bytes\n',
    displayInput: INPUT,
    ambientContext: AMBIENT,
  });
}, 90_000);

test.each([
  'sparse-array',
  'array-subclass',
  'non-enumerable',
  'prepare-abort',
] as const)(
  'dispatch refuses %s before adapter entry and leaves no partial preparation',
  async (phase) => {
    const path = join(
      makeTempDir('prepared-invalid-options-'),
      'events.sqlite',
    );
    const observed = await killedOwner(path, phase);
    expect(observed).toContain('"step":"failed"');
    expect(observed).toContain('Prepared turn input');
    expect(observed).not.toContain('"step":"invoked"');
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(
        db
          .prepare('SELECT COUNT(*) AS count FROM orchestration_prepared_turns')
          .get()?.count,
      ).toBe(0);
      expect(
        db
          .prepare('SELECT COUNT(*) AS count FROM orchestration_turn_dedup')
          .get()?.count,
      ).toBe(0);
      expect(
        db
          .prepare(
            'SELECT COUNT(*) AS count FROM orchestration_turn_boundaries',
          )
          .get()?.count,
      ).toBe(0);
    } finally {
      db.close();
    }
  },
  90_000,
);

test('dispatch retains dense JSON-array options without changing their values', async () => {
  const path = join(makeTempDir('prepared-dense-options-'), 'events.sqlite');
  await killedOwner(path, 'dense-array');
  expect(
    storedIntent(path).envelope.input.metadata.preparedStrictArray,
  ).toEqual(['keep', { nested: [1, null, true] }]);
}, 90_000);

test.each(['begun', 'invoked'] as const)(
  'a killed %s owner retains its input and a normal retry invokes nothing',
  async (phase) => {
    const path = join(makeTempDir('invoking-intent-crash-'), 'events.sqlite');
    const observed = await killedOwner(path, phase);
    expect(observed.match(/"step":"invoked"/g) ?? []).toHaveLength(
      phase === 'invoked' ? 1 : 0,
    );
    class CountingAdapter extends GateTestAdapter {
      sent: ProviderSendTurnInput[] = [];
      override async sendTurn(input: ProviderSendTurnInput) {
        this.sent.push(input);
        return { threadId: input.threadId, turnId: 'unexpected-retry' };
      }
    }
    const store = new EventStore(path);
    stores.push(store);
    const adapter = new CountingAdapter();
    const service = new OrchestrationService({
      adapterRegistry: createGateTestRegistry(adapter),
      eventBus: new EventBus(),
      eventStore: store,
      logger: { debug() {}, warn() {} },
    });
    services.push(service);
    service.initialize();
    await expect(
      service.dispatch({
        type: 'sendTurn',
        input: {
          threadId: THREAD,
          clientTurnId: KEY,
          input: INPUT,
          ambientContext: AMBIENT,
        },
      }),
    ).rejects.toMatchObject({ outcome: 'indeterminate' });
    expect(adapter.sent).toHaveLength(0);
    const { row, envelope } = storedIntent(path);
    expect(envelope.input.text).toBe('pinned context\n\n  keep these bytes\n');
    expect(envelope.input).not.toHaveProperty('invocationId');
    if (phase === 'invoked') {
      const invoked = observed
        .split('\n')
        .find((line) => line.includes('"step":"invoked"'));
      if (!invoked) throw new Error('Expected the actual adapter entry.');
      expect(JSON.parse(invoked)).toMatchObject({
        input: { invocationId: row.invocation_id },
      });
      expect(row.invocation_id).not.toBe('untrusted-caller-invocation');
    }
  },
  90_000,
);

test('a non-persistent send cannot forward a caller-provided invocation identity', async () => {
  const adapter = new LiveResumeAdapter();
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus: new EventBus(),
    logger: { debug() {}, warn() {} },
  });
  services.push(service);
  await service.dispatch({
    type: 'startSession',
    input: { threadId: THREAD, provider: 'claude' },
  });
  const spoofed = {
    threadId: THREAD,
    input: INPUT,
    invocationId: 'untrusted-caller-invocation',
  };
  await service.dispatch({ type: 'sendTurn', input: spoofed });
  expect(adapter.sent).toHaveLength(1);
  expect(adapter.sent[0]?.invocationId).toMatch(/^[a-f0-9-]{36}$/);
  expect(adapter.sent[0]?.invocationId).not.toBe(spoofed.invocationId);
});

test.each(['accepted', 'refused', 'unknown', 'ack-lost'] as const)(
  'explicit prepared resume retains original bytes for an %s adapter result',
  async (outcome) => {
    const path = join(makeTempDir('prepared-intent-resume-'), 'events.sqlite');
    await killedOwner(path, 'prepared');
    const { row, envelope } = storedIntent(path);
    expect(envelope.resumeGuard).toMatchObject({
      binding: {
        nativeBindingKey: 'b'.repeat(64),
        resumeCursor: { sessionId: 'prepared-native-session' },
      },
      requiresFreshCompanions: false,
    });
    const predecessor = new DatabaseSync(path);
    try {
      predecessor.exec(
        'ALTER TABLE orchestration_turn_boundaries DROP COLUMN prepared_settlement',
      );
      expect(
        predecessor
          .prepare(
            'SELECT invocation_id FROM orchestration_turn_boundaries WHERE thread_id = ?',
          )
          .get(THREAD)?.invocation_id,
      ).toBe(row.invocation_id);
    } finally {
      predecessor.close();
    }
    const store = new EventStore(path);
    expect(store.findSessionOwnerUserId(THREAD)).toBe('prepared-owner');
    stores.push(store);
    const adapter = new LiveResumeAdapter();
    adapter.result = outcome === 'ack-lost' ? 'accepted' : outcome;
    const service = new OrchestrationService({
      adapterRegistry: createGateTestRegistry(adapter),
      eventBus: new EventBus(),
      eventStore: store,
      logger: { debug() {}, warn() {} },
    });
    services.push(service);
    service.initialize();
    const owner = sessionReadAuthorityFromRequest(
      'prepared-owner',
      undefined,
      undefined,
    );
    const stranger = sessionReadAuthorityFromRequest(
      'prepared-stranger',
      undefined,
      undefined,
    );
    const invocationId = String(row.invocation_id);
    expect(invocationId).toMatch(/^[a-f0-9-]{36}$/);
    expect(
      await service.readPreparedTurnIntent(THREAD, invocationId, stranger),
    ).toBeNull();
    await expect(
      service.resumePreparedTurnIntent(THREAD, invocationId, stranger),
    ).rejects.toThrow('unavailable');
    expect(adapter.sent).toHaveLength(0);
    expect(
      await service.readPreparedTurnIntent(THREAD, invocationId, owner),
    ).toMatchObject({
      state: 'prepared',
      inputDigest: row.input_digest,
      input: { text: 'pinned context\n\n  keep these bytes\n' },
    });
    let ackLost = false;
    const originalExec = DatabaseSync.prototype.exec;
    const lost = vi
      .spyOn(DatabaseSync.prototype, 'exec')
      .mockImplementation(function (this: DatabaseSync, sql: string) {
        const result = originalExec.call(this, sql);
        if (
          outcome === 'ack-lost' &&
          !ackLost &&
          adapter.sent.length === 1 &&
          sql === 'COMMIT' &&
          this.prepare(
            "SELECT 1 FROM orchestration_turn_boundaries WHERE thread_id = ? AND state = 'accepted'",
          ).get(THREAD)
        ) {
          ackLost = true;
          throw new Error(
            'resume acceptance committed before acknowledgement loss',
          );
        }
        return result;
      });
    const resumed = service.resumePreparedTurnIntent(
      THREAD,
      invocationId,
      owner,
    );
    if (outcome === 'accepted')
      await expect(resumed).resolves.toMatchObject({
        turnId: 'resumed-original',
      });
    else if (outcome === 'refused')
      await expect(resumed).rejects.toThrow('No provider-visible effect.');
    else
      await expect(resumed).rejects.toMatchObject({ outcome: 'indeterminate' });
    lost.mockRestore();
    expect(ackLost).toBe(outcome === 'ack-lost');
    expect(storedIntent(path).row.envelope_json).toBe(row.envelope_json);
    expect(
      await service.readPreparedTurnIntent(THREAD, invocationId, owner),
    ).toMatchObject({
      state:
        outcome === 'accepted' || outcome === 'ack-lost'
          ? 'accepted'
          : outcome === 'refused'
            ? 'settled'
            : 'indeterminate',
    });
    if (outcome === 'refused') {
      const auditDb = new DatabaseSync(path, { readOnly: true });
      try {
        const boundary = auditDb
          .prepare(
            'SELECT prepared_settlement FROM orchestration_turn_boundaries WHERE invocation_id = ?',
          )
          .get(invocationId);
        const dedup = auditDb
          .prepare('SELECT owner_json FROM orchestration_turn_dedup')
          .get();
        const audit = JSON.parse(String(boundary?.prepared_settlement));
        expect(audit.disposition).toBe('definitively-refused');
        expect(JSON.parse(String(dedup?.owner_json)).settlement).toEqual(audit);
        expect(
          store.sessionTurnBoundaryAuthority().hasPossibleEffect(THREAD),
        ).toEqual({ kind: 'available', active: false });
      } finally {
        auditDb.close();
      }
    }
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]).toMatchObject({
      invocationId,
      threadId: THREAD,
      clientTurnId: KEY,
      input: 'pinned context\n\n  keep these bytes\n',
      displayInput: INPUT,
      ambientContext: AMBIENT,
    });
    await expect(
      service.resumePreparedTurnIntent(THREAD, invocationId, owner),
    ).rejects.toThrow('unavailable');
    expect(adapter.sent).toHaveLength(1);
  },
  90_000,
);

test('resume refuses posture tightened after validation while its real coordinator is waiting', async () => {
  const path = join(
    makeTempDir('prepared-posture-revocation-'),
    'events.sqlite',
  );
  await killedOwner(path, 'prepared');
  const { row } = storedIntent(path);
  const store = new EventStore(path);
  stores.push(store);
  const adapter = new LiveResumeAdapter();
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus: new EventBus(),
    eventStore: store,
    logger: { debug() {}, warn() {} },
  });
  services.push(service);
  const owner = sessionReadAuthorityFromRequest(
    'prepared-owner',
    undefined,
    undefined,
  );
  await service.readSession(THREAD, owner);
  let entered!: () => void;
  const atBarrier = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = vi.spyOn(
    SessionExecutionCoordinator.prototype,
    'runPreparedTurnStart',
  );
  spy.mockImplementation(async function <T>(
    this: SessionExecutionCoordinator,
    threadId: string,
    operation: () => Promise<T>,
    workspaceKey?: string,
  ): Promise<T> {
    entered();
    await hold;
    spy.mockRestore();
    return this.runPreparedTurnStart(threadId, operation, workspaceKey);
  });
  const before = new DatabaseSync(path, { readOnly: true });
  const owners = () =>
    before
      .prepare(
        'SELECT owner_id, updated_at, state FROM orchestration_turn_boundaries WHERE thread_id = ?',
      )
      .get(THREAD);
  const originalOwner = owners();
  const pending = service.resumePreparedTurnIntent(
    THREAD,
    String(row.invocation_id),
    owner,
  );
  try {
    await atBarrier;
    await service.dispatch({
      type: 'setApprovalMode',
      threadId: THREAD,
      approvalMode: 'ask',
      basedOnSequence: null,
    });
  } finally {
    release();
  }
  try {
    await expect(pending).rejects.toThrow('unavailable');
    expect(adapter.sent).toHaveLength(0);
    expect(owners()).toEqual(originalOwner);
  } finally {
    before.close();
  }
}, 90_000);

test.each([
  { cut: 'ownership transfer', transaction: 1 },
  { cut: 'invocation begin', transaction: 2 },
])(
  'resume refuses a peer policy commit immediately before $cut',
  async ({ transaction }) => {
    const path = join(makeTempDir('prepared-peer-policy-'), 'events.sqlite');
    await killedOwner(path, 'prepared');
    const { row } = storedIntent(path);
    const store = new EventStore(path);
    const peer = new EventStore(path);
    stores.push(store, peer);
    const adapter = new LiveResumeAdapter();
    const service = new OrchestrationService({
      adapterRegistry: createGateTestRegistry(adapter),
      eventBus: new EventBus(),
      eventStore: store,
      logger: { debug() {}, warn() {} },
    });
    services.push(service);
    const owner = sessionReadAuthorityFromRequest(
      'prepared-owner',
      undefined,
      undefined,
    );
    await service.readSession(THREAD, owner);
    const db = new DatabaseSync(path, { readOnly: true });
    const boundary = () =>
      db
        .prepare(
          'SELECT owner_id, updated_at, state FROM orchestration_turn_boundaries WHERE thread_id = ?',
        )
        .get(THREAD);
    const before = boundary();
    expect(before?.state).toBe('prepared');
    let writes = 0;
    let injected = false;
    const originalExec = DatabaseSync.prototype.exec;
    const exec = vi.spyOn(DatabaseSync.prototype, 'exec');
    exec.mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql.trim().toUpperCase() === 'BEGIN IMMEDIATE' && !injected) {
        writes += 1;
        if (writes === transaction) {
          injected = true;
          // Commit through a separate real store before the resume writer acquires its lock.
          peer.appendEvent({
            eventId: 'peer-prepared-policy-revocation',
            method: 'session.approval-mode-set',
            provider: 'claude',
            threadId: THREAD,
            sessionId: THREAD,
            createdAt: new Date().toISOString(),
            approvalMode: 'ask',
          });
        }
      }
      return originalExec.call(this, sql);
    });
    try {
      await expect(
        service.resumePreparedTurnIntent(
          THREAD,
          String(row.invocation_id),
          owner,
        ),
      ).rejects.toThrow('unavailable');
      expect(injected).toBe(true);
      expect(writes).toBe(transaction);
      expect(store.latestApprovalModeDecision([THREAD])).toMatchObject({
        approvalMode: 'ask',
      });
      expect(adapter.sent).toHaveLength(0);
      expect(boundary()?.state).toBe('prepared');
      if (transaction === 1) expect(boundary()).toEqual(before);
      else expect(boundary()?.owner_id).not.toBe(before?.owner_id);
      const dedup = db
        .prepare('SELECT owner_json, value FROM orchestration_turn_dedup')
        .get();
      expect(dedup?.value).toBeNull();
      expect(JSON.parse(String(dedup?.owner_json))).toMatchObject({
        invocation: 'pending',
      });
    } finally {
      exec.mockRestore();
      db.close();
    }
  },
  90_000,
);

test('resume refuses a different live engine binding even when its native cursor is reused', async () => {
  const path = join(
    makeTempDir('prepared-live-binding-change-'),
    'events.sqlite',
  );
  await killedOwner(path, 'prepared');
  const { row } = storedIntent(path);
  const store = new EventStore(path);
  stores.push(store);
  const adapter = new LiveResumeAdapter();
  adapter.bindingKey = 'c'.repeat(64);
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus: new EventBus(),
    eventStore: store,
    logger: { debug() {}, warn() {} },
  });
  services.push(service);
  const owner = sessionReadAuthorityFromRequest(
    'prepared-owner',
    undefined,
    undefined,
  );
  await service.readSession(THREAD, owner);
  const db = new DatabaseSync(path, { readOnly: true });
  const boundary = () =>
    db
      .prepare(
        'SELECT owner_id, updated_at, state FROM orchestration_turn_boundaries WHERE thread_id = ?',
      )
      .get(THREAD);
  const before = boundary();
  try {
    await expect(
      service.resumePreparedTurnIntent(
        THREAD,
        String(row.invocation_id),
        owner,
      ),
    ).rejects.toThrow('unavailable');
    expect(adapter.sent).toHaveLength(0);
    expect(boundary()).toEqual(before);
  } finally {
    db.close();
  }
}, 90_000);

test.each(['accepted', 'early-terminal'] as const)(
  'real caller retains %s acceptance across post-COMMIT throws with one adapter entry',
  async (outcome) => {
    const path = join(makeTempDir('invocation-ack-loss-'), 'events.sqlite');
    const store = new EventStore(path);
    stores.push(store);
    let calls = 0;
    let acceptanceReady = false;
    let terminalId = '';
    class CountingAdapter extends LiveResumeAdapter {
      override async sendTurn(input: ProviderSendTurnInput) {
        calls += 1;
        this.sent.push(input);
        this.events.push({
          method: 'turn.started',
          eventId: 'start-' + calls,
          provider: 'claude',
          threadId: THREAD,
          turnId: 'N',
          invocationId: input.invocationId,
          createdAt: '2030-01-01T00:00:00Z',
          prompt: 'B',
        });
        if (outcome === 'early-terminal') {
          terminalId = 'early-' + calls;
          this.events.push({
            method: 'runtime.error',
            eventId: terminalId,
            provider: 'claude',
            threadId: THREAD,
            invocationId: input.invocationId,
            createdAt: '1900-01-01T00:00:00Z',
            severity: 'error',
            message: 'request-owned before native acknowledgement',
          });
          await vi.waitFor(() =>
            expect(store.hasEventId(terminalId)).toBe(true),
          );
          await vi.waitFor(() =>
            expect(
              store['db']
                .prepare(
                  'SELECT * FROM orchestration_turn_boundaries WHERE thread_id = ?',
                )
                .all(THREAD),
            ).toHaveLength(0),
          );
        }
        acceptanceReady = true;
        return { threadId: THREAD, turnId: 'N' };
      }
    }
    const adapter = new CountingAdapter();
    const service = new OrchestrationService({
      adapterRegistry: createGateTestRegistry(adapter),
      eventBus: new EventBus(),
      eventStore: store,
      logger: { debug() {}, warn() {} },
    });
    services.push(service);
    service.initialize();
    const exec = DatabaseSync.prototype.exec;
    let injected = false;
    const spy = vi
      .spyOn(DatabaseSync.prototype, 'exec')
      .mockImplementation(function (this: DatabaseSync, sql: string) {
        const result = exec.call(this, sql);
        if (!injected && acceptanceReady && sql === 'COMMIT') {
          const accepted = this.prepare(
            "SELECT state FROM orchestration_turn_boundaries WHERE thread_id = ? AND state = 'accepted'",
          ).get(THREAD);
          const witness = this.prepare(
            'SELECT terminal_retirement FROM orchestration_prepared_turns WHERE thread_id = ?',
          ).get(THREAD);
          if (
            accepted ||
            (outcome === 'early-terminal' &&
              calls === 1 &&
              witness?.terminal_retirement)
          ) {
            injected = true;
            throw new Error('committed acceptance acknowledgement lost');
          }
        }
        return result;
      });
    const input = {
      threadId: THREAD,
      clientTurnId: 'ack-key',
      input: 'original bytes',
    };
    try {
      await expect(
        service.dispatch({ type: 'sendTurn', input }),
      ).rejects.toMatchObject({ outcome: 'indeterminate' });
      expect(injected).toBe(true);
      expect(calls).toBe(1);
      spy.mockRestore();
      if (outcome === 'accepted') {
        adapter.events.push({
          method: 'turn.completed',
          eventId: 'late-exact-ack',
          provider: 'claude',
          threadId: THREAD,
          turnId: 'N',
          invocationId: adapter.sent[0]?.invocationId,
          createdAt: '1900-01-01T00:00:00Z',
        });
        await vi.waitFor(() =>
          expect(store.hasEventId('late-exact-ack')).toBe(true),
        );
      }
      await vi.waitFor(() =>
        expect(
          store.sessionTurnBoundaryAuthority().hasPossibleEffect(THREAD),
        ).toEqual({ kind: 'available', active: false }),
      );
      await expect(
        service.dispatch({ type: 'sendTurn', input }),
      ).rejects.toMatchObject({ outcome: 'indeterminate' });
      expect(calls).toBe(1);
      const retained = store.readPreparedTurnIntent(
        THREAD,
        adapter.sent[0]!.invocationId!,
      );
      expect(retained?.capture.adapterInput.input).toBe('original bytes');
    } finally {
      spy.mockRestore();
    }
  },
  90_000,
);

test.each(['fresh', 'resume'] as const)(
  'acknowledged %s refusal releases only its local invocation and workspace; failed settlement retains it',
  async (mode) => {
    for (const settlement of [
      'applied',
      'abort',
      'ack-lost',
      'other-active',
    ] as const) {
      const cwd = makeTempDir(`refusal-${mode}-${settlement}-`);
      const path = join(cwd, 'events.sqlite');
      if (mode === 'resume') await killedOwner(path, 'prepared', cwd);
      const store = new EventStore(path);
      stores.push(store);
      class RefusingAdapter extends LiveResumeAdapter {
        override async sendTurn(input: ProviderSendTurnInput) {
          if (settlement === 'other-active') {
            this.events.push({
              method: 'turn.started',
              eventId: 'independent-provider-start',
              provider: 'claude',
              threadId: input.threadId,
              turnId: 'provider:independent',
              prompt: 'independent engine work',
              metadata: { trigger: 'provider' },
              createdAt: new Date().toISOString(),
            });
            await vi.waitFor(() =>
              expect(
                store
                  .listEvents(input.threadId)
                  .some((row) => row.id === 'independent-provider-start'),
              ).toBe(true),
            );
          }
          return super.sendTurn(input);
        }
        override async listSessions() {
          return (await super.listSessions()).map((row) => ({ ...row, cwd }));
        }
        override async startSession(
          input: Parameters<GateTestAdapter['startSession']>[0],
        ) {
          this.events.push({
            method: 'session.started',
            eventId: 'refusal-session',
            provider: 'claude',
            threadId: input.threadId,
            sessionId: input.threadId,
            createdAt: new Date().toISOString(),
            metadata: {
              ...input.metadata,
              nativeResumeBindingKey: 'b'.repeat(64),
            },
          });
          return {
            ...(await super.startSession(input)),
            cwd,
            resumeCursor: { sessionId: 'prepared-native-session' },
          };
        }
      }
      const adapter = new RefusingAdapter();
      adapter.result = 'refused';
      const service = new OrchestrationService({
        adapterRegistry: createGateTestRegistry(adapter),
        eventBus: new EventBus(),
        eventStore: store,
        logger: { debug() {}, warn() {} },
      });
      services.push(service);
      service.initialize();
      const owner = sessionReadAuthorityFromRequest(
        'prepared-owner',
        undefined,
        undefined,
      );
      if (mode === 'fresh') {
        await service.dispatch(
          {
            type: 'startSession',
            input: {
              threadId: THREAD,
              provider: 'claude',
              cwd,
              metadata: { userId: 'prepared-owner' },
            },
          },
          { userId: 'prepared-owner' },
        );
        await vi.waitFor(() =>
          expect(store.findSessionOwnerUserId(THREAD)).toBe('prepared-owner'),
        );
      }
      const identity = await resolveWorkspaceIdentity(cwd, 'local');
      if (identity.kind === 'remote')
        throw new Error('local workspace prerequisite');
      const originalExec = DatabaseSync.prototype.exec;
      let thrown = false;
      const spy = vi
        .spyOn(DatabaseSync.prototype, 'exec')
        .mockImplementation(function (this: DatabaseSync, sql: string) {
          const result = originalExec.call(this, sql);
          if (
            settlement === 'ack-lost' &&
            !thrown &&
            sql === 'COMMIT' &&
            this.prepare(
              "SELECT 1 FROM orchestration_turn_boundaries WHERE state='settled'",
            ).get()
          ) {
            thrown = true;
            throw new Error('settlement COMMIT acknowledgement lost');
          }
          return result;
        });
      if (settlement === 'abort')
        store['db'].exec(
          "CREATE TRIGGER refuse_settlement BEFORE UPDATE ON orchestration_turn_boundaries WHEN NEW.state='settled' BEGIN SELECT RAISE(ABORT,'settlement unavailable'); END",
        );
      try {
        const invocationId =
          mode === 'resume'
            ? String(storedIntent(path).row.invocation_id)
            : undefined;
        const dispatch =
          mode === 'resume'
            ? service.resumePreparedTurnIntent(THREAD, invocationId!, owner)
            : service.dispatch(
                {
                  type: 'sendTurn',
                  input: {
                    threadId: THREAD,
                    clientTurnId: KEY,
                    input: INPUT,
                    ambientContext: AMBIENT,
                  },
                },
                { userId: 'prepared-owner' },
              );
        if (settlement === 'applied' || settlement === 'other-active')
          await expect(dispatch).rejects.toThrow('No provider-visible effect.');
        else
          await expect(dispatch).rejects.toMatchObject({
            outcome: 'indeterminate',
          });
        expect(adapter.sent).toHaveLength(1);
        const audit = store['db']
          .prepare(
            'SELECT state FROM orchestration_turn_boundaries WHERE thread_id=? AND invocation_id IS NOT NULL',
          )
          .get(THREAD) as { state: string };
        expect(audit.state).toBe(
          settlement === 'abort' ? 'invoking' : 'settled',
        );
        if (settlement === 'applied') {
          expect(service.hasActiveTurn(THREAD)).toBe(false);
          await expect(
            service.runWorkspaceRestore(identity.key, async () => 'restored'),
          ).resolves.toBe('restored');
          await expect(
            service.dispatch(
              {
                type: 'sendTurn',
                input: {
                  threadId: THREAD,
                  clientTurnId: KEY,
                  input: INPUT,
                  ambientContext: AMBIENT,
                },
              },
              { userId: 'prepared-owner' },
            ),
          ).rejects.toMatchObject({ code: 'client_turn_settled' });
          expect(adapter.sent).toHaveLength(1);
        } else {
          expect(service.hasActiveTurn(THREAD)).toBe(true);
          await expect(
            service.runWorkspaceRestore(identity.key, async () => 'unsafe'),
          ).rejects.toThrow('workspace_has_active_turn');
        }
      } finally {
        spy.mockRestore();
      }
    }
  },
  90_000,
);
