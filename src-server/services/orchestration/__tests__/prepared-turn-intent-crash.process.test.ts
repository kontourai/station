import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { afterEach, expect, test } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { ProviderSendTurnInput } from '../../../providers/adapter-shape.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

const THREAD = 'prepared-turn-owner';
const KEY = 'prepared-turn-key';
const INPUT = '  keep these bytes\n';
const AMBIENT = 'pinned context\n';
const makeTempDir = trackTempDirs();
const children: ChildProcess[] = [];
const services: OrchestrationService[] = [];
const stores: EventStore[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  for (const service of services.splice(0)) await service.shutdown();
  for (const store of stores.splice(0)) store.close();
});

async function killedOwner(
  databasePath: string,
  phase:
    | 'prepared'
    | 'invoked'
    | 'sparse-array'
    | 'array-subclass'
    | 'dense-array',
) {
  const expected =
    phase === 'sparse-array' || phase === 'array-subclass'
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

test.each(['sparse-array', 'array-subclass'] as const)(
  'dispatch refuses %s JSON options before adapter entry',
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

test('a killed invoking owner retains its input and a normal retry invokes nothing', async () => {
  const path = join(makeTempDir('invoking-intent-crash-'), 'events.sqlite');
  const observed = await killedOwner(path, 'invoked');
  expect(observed.match(/"step":"invoked"/g)).toHaveLength(1);
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
  const { envelope } = storedIntent(path);
  expect(envelope.input.text).toBe('pinned context\n\n  keep these bytes\n');
}, 90_000);

test('explicit prepared resume reauthorizes the retained input and sends its original bytes exactly once', async () => {
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
  class ResumeAdapter extends GateTestAdapter {
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
      return { threadId: input.threadId, turnId: 'resumed-original' };
    }
  }
  const store = new EventStore(path);
  expect(store.findSessionOwnerUserId(THREAD)).toBe('prepared-owner');
  stores.push(store);
  const adapter = new ResumeAdapter();
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
  await expect(
    service.resumePreparedTurnIntent(THREAD, invocationId, owner),
  ).resolves.toMatchObject({
    turnId: 'resumed-original',
  });
  expect(adapter.sent).toHaveLength(1);
  expect(adapter.sent[0]).toMatchObject({
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
}, 90_000);
