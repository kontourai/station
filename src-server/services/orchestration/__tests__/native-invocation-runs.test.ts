import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  EventStore,
  NativeInvocationStartupUnavailableError,
} from '../event-store.js';
import { RunService } from '../run-service.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
  ) => {
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): { all(...args: unknown[]): unknown[] };
  };
};

const stores: EventStore[] = [];

function createStore(): EventStore {
  const store = new EventStore(
    join(
      mkdtempSync(join(tmpdir(), 'native-invocation-runs-')),
      'events.sqlite',
    ),
  );
  stores.push(store);
  return store;
}

async function spawnNativeInvocationOwner(
  databasePath: string,
): Promise<ChildProcess> {
  const eventStorePath = new URL('../event-store.ts', import.meta.url).pathname;
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `import { EventStore } from ${JSON.stringify(eventStorePath)};
       const store = new EventStore(process.argv[1]);
       const begun = store.nativeInvocationStarter().begin({ kind: 'global-invoke', now: '2026-08-14T00:00:00.000Z' });
       if (begun.kind !== 'owner') process.exit(2);
       if (begun.claim.beginInvocation('2026-08-14T00:00:01.000Z').kind !== 'applied') process.exit(3);
       process.stdout.write(JSON.stringify({ runId: begun.runId }) + '\\n');
       setInterval(() => {}, 1_000);`,
      databasePath,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  await once(child.stdout!, 'data');
  return child;
}

async function constructNativeInvocationStore(
  databasePath: string,
): Promise<'constructed'> {
  const eventStorePath = new URL('../event-store.ts', import.meta.url).pathname;
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `import { EventStore } from ${JSON.stringify(eventStorePath)};
       const store = new EventStore(process.argv[1]);
       store.close();`,
      databasePath,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
  );
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const [code] = await once(child, 'exit');
  if (code !== 0) {
    // This used to tolerate a loser exiting with
    // STATION_EVENT_STORE_INTEGRITY_UNAVAILABLE (archive#3145): the
    // constructor's PRAGMA integrity check could lose a concurrent-DDL race
    // and decline to assert integrity it could not check. archive#3219
    // removed the per-boot check entirely, so that error no longer exists
    // and every concurrent constructor is expected to complete; any non-zero
    // exit is a real failure.
    throw new Error(
      `Native invocation store constructor exited ${String(code)}: ${stderr}`,
    );
  }
  return 'constructed';
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
  if (child.exitCode === null) await once(child, 'exit');
}

afterEach(() => {
  while (stores.length) stores.pop()?.close();
});

describe('native invocation runs', () => {
  test('requires the native projection dependency instead of retaining the optional bypass', () => {
    const source = readFileSync(
      new URL('../run-service.ts', import.meta.url),
      'utf8',
    );

    expect(source).toContain(
      'private readonly nativeInvocationRuns: NativeInvocationRunReader',
    );
    expect(source).not.toContain('nativeInvocationRuns?:');
    expect(Object.getOwnPropertyNames(EventStore.prototype)).not.toContain(
      'createNativeInvocationRuns',
    );
  });

  test('publishes separate starter and reader capabilities without a public reconcile operation', () => {
    const store = createStore();
    expect(Object.keys(store.nativeInvocationStarter())).toEqual(['begin']);
    expect(Object.keys(store.nativeInvocationRunReader())).toEqual([
      'list',
      'read',
    ]);
  });

  test('records the provider boundary and projects the terminal run', () => {
    const store = createStore();
    const runs = store.nativeInvocationStarter();
    const reader = store.nativeInvocationRunReader();
    const claim = runs.begin({
      kind: 'agent-invoke',
      sourceId: 'station',
      now: '2026-08-14T00:00:00.000Z',
    });
    expect(claim.kind).toBe('owner');
    if (claim.kind !== 'owner') throw new Error('expected owner');

    expect(reader.read(claim.runId)).toMatchObject({
      kind: 'available',
      run: { status: 'starting', source: 'invoke', retryEligible: false },
    });
    expect(claim.claim.beginInvocation('2026-08-14T00:00:01.000Z')).toEqual({
      kind: 'applied',
    });
    expect(claim.claim.completed('2026-08-14T00:00:02.000Z')).toEqual({
      kind: 'applied',
    });
    expect(claim.claim.completed('2026-08-14T00:01:00.000Z')).toEqual({
      kind: 'applied',
    });
    expect(reader.read(claim.runId)).toMatchObject({
      kind: 'available',
      run: {
        runId: claim.runId,
        source: 'invoke',
        sourceId: 'station',
        status: 'completed',
        retryEligible: false,
        metadata: {
          nativeInvocationKind: 'agent-invoke',
          nativeInvocationState: 'completed',
        },
      },
    });
  });

  test('reconciles an owner released after the provider boundary as indeterminate without replay', () => {
    const directory = mkdtempSync(join(tmpdir(), 'native-invocation-restart-'));
    const path = join(directory, 'events.sqlite');
    const first = new EventStore(path);
    const claim = first.nativeInvocationStarter().begin({
      kind: 'global-invoke',
      now: '2026-08-14T00:00:00.000Z',
    });
    expect(claim.kind).toBe('owner');
    if (claim.kind !== 'owner') throw new Error('expected owner');
    expect(claim.claim.beginInvocation('2026-08-14T00:00:01.000Z')).toEqual({
      kind: 'applied',
    });
    first.close();

    const reopened = new EventStore(path);
    stores.push(reopened);
    const reader = reopened.nativeInvocationRunReader();
    expect(reader.read(claim.runId)).toMatchObject({
      kind: 'available',
      run: {
        status: 'failed',
        retryEligible: false,
        failureKind: 'unknown',
        metadata: { nativeInvocationState: 'indeterminate' },
      },
    });
  });

  test('a live foreign process fences reconciliation, while an unavailable probe fails closed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'native-invocation-live-'));
    const path = join(directory, 'events.sqlite');
    const initial = new EventStore(path);
    initial.close();
    const child = await spawnNativeInvocationOwner(path);
    try {
      const live = new EventStore(path);
      expect(live.nativeInvocationRunReader().list()).toMatchObject({
        kind: 'available',
        runs: [expect.objectContaining({ status: 'running' })],
      });
      live.close();

      const unavailable = new EventStore(path, undefined, {
        exact: () => ({ pid: process.pid, start: 'observer' }),
        probe: () => ({ state: 'unavailable' as const }),
      });
      expect(unavailable.nativeInvocationRunReader().list()).toMatchObject({
        kind: 'available',
        runs: [expect.objectContaining({ status: 'running' })],
      });
      unavailable.close();
    } finally {
      await stopChild(child);
    }
  });

  test('a real crashed owner reconciles once, and a reused PID birth is not trusted', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'native-invocation-crash-'));
    const path = join(directory, 'events.sqlite');
    const initial = new EventStore(path);
    initial.close();
    const child = await spawnNativeInvocationOwner(path);
    try {
      const mismatchedBirth = new EventStore(path, undefined, {
        exact: () => ({ pid: process.pid, start: 'observer' }),
        probe: (pid) => ({
          state: 'exact' as const,
          identity: { pid, start: 'different-process-birth' },
        }),
      });
      expect(mismatchedBirth.nativeInvocationRunReader().list()).toMatchObject({
        kind: 'available',
        runs: [
          expect.objectContaining({
            status: 'failed',
            failureKind: 'unknown',
            metadata: expect.objectContaining({
              nativeInvocationState: 'indeterminate',
            }),
          }),
        ],
      });
      mismatchedBirth.close();
    } finally {
      await stopChild(child);
    }

    const secondDirectory = mkdtempSync(
      join(tmpdir(), 'native-invocation-kill-'),
    );
    const secondPath = join(secondDirectory, 'events.sqlite');
    const secondInitial = new EventStore(secondPath);
    secondInitial.close();
    const killed = await spawnNativeInvocationOwner(secondPath);
    await stopChild(killed);
    const reconciled = new EventStore(secondPath);
    stores.push(reconciled);
    expect(reconciled.nativeInvocationRunReader().list()).toMatchObject({
      kind: 'available',
      runs: [
        expect.objectContaining({
          status: 'failed',
          failureKind: 'unknown',
          metadata: expect.objectContaining({
            nativeInvocationState: 'indeterminate',
          }),
        }),
      ],
    });
  });

  test('blocks startup through repeated transient reconciliation failures instead of publishing unavailable adapters', () => {
    let attempts = 0;
    const path = join(
      mkdtempSync(join(tmpdir(), 'native-invocation-startup-retry-')),
      'events.sqlite',
    );
    const recovered = new EventStore(
      path,
      undefined,
      undefined,
      undefined,
      undefined,
      () => {
        attempts += 1;
        if (attempts <= 3) throw new Error('transient native startup lock');
      },
    );
    stores.push(recovered);
    expect(attempts).toBe(4);
    expect(
      recovered.nativeInvocationStarter().begin({
        kind: 'agent-invoke',
        now: '2026-08-14T00:00:00.000Z',
      }),
    ).toMatchObject({ kind: 'owner' });

    const failedPath = join(
      mkdtempSync(join(tmpdir(), 'native-invocation-startup-fail-')),
      'events.sqlite',
    );
    expect(
      () =>
        new EventStore(
          failedPath,
          undefined,
          undefined,
          undefined,
          undefined,
          () => {
            throw new Error('persistent native startup lock');
          },
        ),
    ).toThrow(NativeInvocationStartupUnavailableError);
    // The typed startup failure closes its SQLite handle; a later runtime can
    // retry construction instead of inheriting a half-published route graph.
    const afterFailure = new EventStore(failedPath);
    stores.push(afterFailure);
    expect(afterFailure.nativeInvocationRunReader().list()).toEqual({
      kind: 'available',
      runs: [],
    });
  });

  test('upgrades a legacy database before adding the terminal retention index under concurrent constructors', async () => {
    const path = join(
      mkdtempSync(join(tmpdir(), 'native-invocation-legacy-sequence-')),
      'events.sqlite',
    );
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE native_invocation_runs (
      run_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      source_id TEXT,
      state TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      owner_pid INTEGER NOT NULL,
      owner_birth TEXT,
      owner_identity_kind TEXT NOT NULL,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      failure_message TEXT
    )`);
    legacy.close();

    const outcomes = await Promise.all([
      constructNativeInvocationStore(path),
      constructNativeInvocationStore(path),
    ]);
    // At least one must have completed, or the migration assertions below
    // would be proving nothing.
    expect(outcomes).toContain('constructed');
    const upgraded = new DatabaseSync(path);
    const columns = upgraded
      .prepare('PRAGMA table_info(native_invocation_runs)')
      .all() as Array<{ name: string }>;
    const indexes = upgraded
      .prepare('PRAGMA index_list(native_invocation_runs)')
      .all() as Array<{ name: string }>;
    upgraded.close();
    expect(columns.map((column) => column.name)).toContain('terminal_sequence');
    expect(indexes.map((index) => index.name)).toContain(
      'idx_native_invocation_runs_terminal_sequence',
    );
  });

  test('retains every active run and only the newest 1,000 durable terminals across restart', () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'native-invocation-terminal-retention-'),
    );
    const path = join(directory, 'events.sqlite');
    const store = new EventStore(path);
    const starter = store.nativeInvocationStarter();
    const base = Date.parse('2026-08-14T00:00:00.000Z');
    const terminal = Array.from({ length: 1001 }, (_, index) => {
      // The final provider completion sees a clock that moved backwards. It
      // must still be retained because SQLite assigns terminal order at the
      // durable transition, rather than trusting completedAt wall-clock time.
      const terminalBase =
        index === 1_000 ? base : base + 4_000_000 + index * 3_000;
      const begun = starter.begin({
        kind: 'global-invoke',
        sourceId: `terminal-${index}`,
        now: new Date(terminalBase).toISOString(),
      });
      if (begun.kind !== 'owner') throw new Error('expected terminal owner');
      expect(
        begun.claim.beginInvocation(
          new Date(terminalBase + 1_000).toISOString(),
        ),
      ).toEqual({ kind: 'applied' });
      expect(
        begun.claim.completed(new Date(terminalBase + 2_000).toISOString()),
      ).toEqual({ kind: 'applied' });
      return begun.runId;
    });
    const active = Array.from({ length: 3 }, (_, index) => {
      const begun = starter.begin({
        kind: 'agent-invoke',
        sourceId: `active-${index}`,
        now: new Date(base + 4_000_000 + index).toISOString(),
      });
      if (begun.kind !== 'owner') throw new Error('expected active owner');
      return begun.runId;
    });
    const reader = store.nativeInvocationRunReader();
    const listed = reader.list();
    expect(listed).toMatchObject({ kind: 'available' });
    if (listed.kind !== 'available') throw new Error('expected available runs');

    const terminalRuns = listed.runs.filter(
      (run) => run.status === 'completed',
    );
    expect(terminalRuns).toHaveLength(1_000);
    expect(new Set(terminalRuns.map((run) => run.runId))).toEqual(
      new Set(terminal.slice(1)),
    );
    expect(reader.read(terminal[0])).toEqual({
      kind: 'available',
      run: null,
    });
    expect(reader.read(terminal[1])).toMatchObject({
      kind: 'available',
      run: { runId: terminal[1], status: 'completed' },
    });
    expect(reader.read(terminal[1_000])).toMatchObject({
      kind: 'available',
      run: { runId: terminal[1_000], status: 'completed' },
    });

    const listedActive = listed.runs.filter((run) =>
      run.sourceId?.startsWith('active-'),
    );
    expect(listedActive).toHaveLength(active.length);
    expect(new Set(listedActive.map((run) => run.runId))).toEqual(
      new Set(active),
    );
    expect(new Set(listed.runs.map((run) => run.runId)).size).toBe(
      listed.runs.length,
    );
    expect(
      listed.runs.map((run) => `${run.startedAt}\u0000${run.runId}`),
    ).toEqual(
      [...listed.runs]
        .map((run) => `${run.startedAt}\u0000${run.runId}`)
        .sort(),
    );

    store.close();
    const reopened = new EventStore(path);
    stores.push(reopened);
    expect(reopened.nativeInvocationRunReader().read(terminal[0])).toEqual({
      kind: 'available',
      run: null,
    });
    expect(
      reopened.nativeInvocationRunReader().read(terminal[1_000]),
    ).toMatchObject({
      kind: 'available',
      run: { runId: terminal[1_000], status: 'completed' },
    });
  }, 20_000);

  test('reconciles a released pre-invocation claim as definitely not invoked', () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'native-invocation-preflight-'),
    );
    const path = join(directory, 'events.sqlite');
    const first = new EventStore(path);
    const claim = first.nativeInvocationStarter().begin({
      kind: 'agent-invoke-stream',
      now: '2026-08-14T00:00:00.000Z',
    });
    expect(claim.kind).toBe('owner');
    if (claim.kind !== 'owner') throw new Error('expected owner');
    first.close();

    const reopened = new EventStore(path);
    stores.push(reopened);
    expect(
      reopened.nativeInvocationRunReader().read(claim.runId),
    ).toMatchObject({
      kind: 'available',
      run: {
        status: 'failed',
        retryEligible: false,
        failureKind: 'agent_error',
        metadata: { nativeInvocationState: 'failed' },
      },
    });
  });

  test('recognizes the exact terminal fact after SQLite writes then throws', () => {
    let transitions = 0;
    const store = new EventStore(
      join(
        mkdtempSync(join(tmpdir(), 'native-invocation-readback-')),
        'events.sqlite',
      ),
      undefined,
      undefined,
      undefined,
      () => {
        transitions += 1;
        if (transitions === 2) throw new Error('after commit');
      },
    );
    stores.push(store);
    const runs = store.nativeInvocationStarter();
    const claim = runs.begin({
      kind: 'agent-invoke',
      now: '2026-08-14T00:00:00.000Z',
    });
    expect(claim.kind).toBe('owner');
    if (claim.kind !== 'owner') throw new Error('expected owner');
    expect(claim.claim.beginInvocation('2026-08-14T00:00:01.000Z')).toEqual({
      kind: 'applied',
    });
    expect(claim.claim.completed('2026-08-14T00:00:02.000Z')).toEqual({
      kind: 'applied',
    });
  });

  test('projects the same canonical id through RunService without creating an orchestration session', async () => {
    const store = createStore();
    const runs = store.nativeInvocationStarter();
    const claim = runs.begin({
      kind: 'global-invoke',
      sourceId: 'global',
      now: '2026-08-14T00:00:00.000Z',
    });
    expect(claim.kind).toBe('owner');
    if (claim.kind !== 'owner') throw new Error('expected owner');
    claim.claim.beginInvocation('2026-08-14T00:00:01.000Z');

    const service = new RunService(
      { listAgentRuns: async () => [], readAgentRun: async () => null } as any,
      {
        listRunSummaries: async () => [],
        readRunSummary: async () => null,
      } as any,
      store.nativeInvocationRunReader(),
      {
        list: () => ({ kind: 'available', runs: [] }),
        read: () => ({ kind: 'available', run: null }),
      },
    );
    const authority = { mode: 'personal', userId: 'brian' } as any;
    await expect(
      service.listRuns(authority, { source: 'invoke' }),
    ).resolves.toEqual([
      expect.objectContaining({ runId: claim.runId, status: 'running' }),
    ]);
    await expect(service.readRun(claim.runId, authority)).resolves.toEqual(
      expect.objectContaining({ runId: claim.runId, source: 'invoke' }),
    );
  });
});
