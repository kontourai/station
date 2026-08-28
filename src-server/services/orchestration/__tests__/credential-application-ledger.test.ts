import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { EventStore } from '../event-store.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
  ) => {
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): {
      all(...args: unknown[]): unknown[];
      get(...args: unknown[]): unknown;
    };
  };
};

async function constructCredentialStore(databasePath: string): Promise<void> {
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
    // Every constructor must complete. This briefly tolerated a loser exiting
    // with STATION_EVENT_STORE_INTEGRITY_UNAVAILABLE (archive#3145), because
    // a peer's DDL invalidated its cached schema mid-integrity-check and the
    // startup gate declined to assert integrity it could not check. That
    // whole failure mode is gone: archive#3219 removed the per-boot integrity
    // check entirely, so there is no startup check left to contend on and a
    // loser is not an expected outcome here. Do not re-add tolerance — it
    // would make this test, whose entire point is contention, unable to
    // notice a concurrent constructor regressing.
    throw new Error(
      `Credential store constructor exited ${String(code)}: ${stderr}`,
    );
  }
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return existsSync(path);
}

function spawnCredentialMigration(
  databasePath: string,
  markerPrefix: string,
  releasePath: string,
  mode: 'production' | 'legacy',
): { child: ReturnType<typeof spawn>; stderr: () => string } {
  const migrationPath = new URL(
    '../../../domain/migrations/003-orchestration-events.ts',
    import.meta.url,
  ).pathname;
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `import { existsSync, writeFileSync } from 'node:fs';
       import { DatabaseSync } from 'node:sqlite';
       import { ensureCredentialApplicationCommitPendingIndex } from ${JSON.stringify(migrationPath)};
       const [databasePath, markerPrefix, releasePath, mode] = process.argv.slice(1);
       const waitForRelease = () => {
         while (!existsSync(releasePath)) {
           Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
         }
       };
       const db = new DatabaseSync(databasePath, { timeout: 5_000 });
       writeFileSync(markerPrefix + '.before', 'before');
       if (mode === 'production') {
         ensureCredentialApplicationCommitPendingIndex(db, {
           afterIndexDrop: () => {
             writeFileSync(markerPrefix + '.dropped', 'dropped');
             waitForRelease();
           },
         });
       } else {
         db.exec('DROP INDEX IF EXISTS idx_credential_profile_applications_one_live_per_connection');
         writeFileSync(markerPrefix + '.dropped', 'dropped');
         waitForRelease();
         db.exec(\`CREATE UNIQUE INDEX idx_credential_profile_applications_one_live_per_connection
           ON credential_profile_applications(connection_id)
           WHERE acknowledged_at IS NULL
             AND state IN ('reserved', 'staged', 'indeterminate', 'commit-pending')\`);
       }
       db.close();`,
      databasePath,
      markerPrefix,
      releasePath,
      mode,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
  );
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  return { child, stderr: () => stderr };
}

async function childExit(
  spawned: ReturnType<typeof spawnCredentialMigration>,
): Promise<number | null> {
  const [code] = await once(spawned.child, 'exit');
  return code as number | null;
}

function downgradeCredentialFence(
  databasePath: string,
): InstanceType<typeof DatabaseSync> {
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    DROP INDEX idx_credential_profile_applications_one_live_per_connection;
    CREATE UNIQUE INDEX idx_credential_profile_applications_one_live_per_connection
      ON credential_profile_applications(connection_id)
      WHERE acknowledged_at IS NULL
        AND state IN ('reserved', 'staged', 'indeterminate');
    DROP TABLE credential_profile_connection_locks;
    CREATE TABLE credential_profile_connection_locks (
      connection_id TEXT PRIMARY KEY,
      owner_token TEXT NOT NULL,
      owner_pid INTEGER NOT NULL,
      owner_birth TEXT,
      owner_identity_kind TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);
  return legacy;
}

describe('CredentialApplicationFactory', () => {
  const directories: string[] = [];
  afterEach(() =>
    directories
      .splice(0)
      .forEach((directory) =>
        rmSync(directory, { recursive: true, force: true }),
      ),
  );

  function fixture() {
    const directory = mkdtempSync(
      join(tmpdir(), 'credential-application-ledger-'),
    );
    directories.push(directory);
    return new EventStore(join(directory, 'orchestration.sqlite'));
  }

  test('atomically reserves one opaque application and latches legal transitions', () => {
    const store = fixture();
    const first = store.createCredentialApplicationFactory().start({
      recoveryFingerprint: 'recovery-a',
      connectionId: 'codex-runtime',
      candidateProfileRef: 'candidate',
      now: '2026-08-13T00:00:00.000Z',
    });
    const second = store.createCredentialApplicationFactory().start({
      recoveryFingerprint: 'recovery-a',
      connectionId: 'codex-runtime',
      candidateProfileRef: 'other',
      now: '2026-08-13T00:00:00.000Z',
    });
    expect(first.kind).toBe('owner');
    expect(second).toEqual({ kind: 'unavailable' });
    if (first.kind !== 'owner') throw new Error('expected owner');
    expect(first.claim.staged('2026-08-13T00:00:01.000Z')).toEqual({
      kind: 'applied',
    });
    expect(first.claim.settle('adopted', '2026-08-13T00:00:02.000Z')).toEqual({
      kind: 'applied',
    });
    expect(
      first.claim.settle('rolled-back', '2026-08-13T00:00:03.000Z'),
    ).toEqual({ kind: 'stale' });
    expect(first.claim.acknowledge('2026-08-13T00:00:04.000Z')).toEqual({
      kind: 'applied',
    });
    expect(first.claim.acknowledge('2026-08-13T00:00:05.000Z')).toEqual({
      kind: 'applied',
    });
    store.close();
  });

  test('two independent SQLite connections admit one live application per connection', () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'credential-application-ledger-'),
    );
    directories.push(directory);
    const path = join(directory, 'orchestration.sqlite');
    const firstStore = new EventStore(path);
    const secondStore = new EventStore(path);
    const first = firstStore.createCredentialApplicationFactory().start({
      recoveryFingerprint: 'recovery-first',
      connectionId: 'codex-runtime',
      candidateProfileRef: 'candidate-a',
      now: '2026-08-13T00:00:00.000Z',
    });
    const second = secondStore.createCredentialApplicationFactory().start({
      recoveryFingerprint: 'recovery-second',
      connectionId: 'codex-runtime',
      candidateProfileRef: 'candidate-b',
      now: '2026-08-13T00:00:01.000Z',
    });
    expect(first.kind).toBe('owner');
    expect(second).toEqual({ kind: 'unavailable' });
    firstStore.close();
    secondStore.close();
  });

  test('concurrent constructors atomically upgrade the live-application fence [process]', async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'credential-application-ledger-migration-'),
    );
    directories.push(directory);
    const path = join(directory, 'orchestration.sqlite');
    new EventStore(path).close();

    downgradeCredentialFence(path).close();

    // All six, not "at least one": the fence assertions below are made over
    // however many constructors actually ran the upgrade, so a tolerated
    // loser would silently shrink the population they are proved against.
    await Promise.all(
      Array.from({ length: 6 }, () => constructCredentialStore(path)),
    );

    const upgraded = new DatabaseSync(path);
    const index = upgraded
      .prepare(
        `SELECT sql FROM sqlite_master
         WHERE type = 'index'
           AND name = 'idx_credential_profile_applications_one_live_per_connection'`,
      )
      .get() as { sql?: string } | undefined;
    const lockColumns = upgraded
      .prepare('PRAGMA table_info(credential_profile_connection_locks)')
      .all() as Array<{ name?: string }>;
    upgraded.close();
    expect(index?.sql).toContain("'commit-pending'");
    expect(lockColumns.map((column) => column.name)).not.toContain(
      'expires_at',
    );

    const firstStore = new EventStore(path);
    const secondStore = new EventStore(path);
    const first = firstStore.createCredentialApplicationFactory().start({
      recoveryFingerprint: 'migration-first',
      connectionId: 'codex-runtime',
      candidateProfileRef: 'candidate-a',
      now: '2026-08-13T00:00:00.000Z',
    });
    expect(first.kind).toBe('owner');
    if (first.kind !== 'owner') throw new Error('expected owner');
    expect(first.claim.staged('2026-08-13T00:00:01.000Z')).toEqual({
      kind: 'applied',
    });
    expect(
      first.claim.settle('commit-pending', '2026-08-13T00:00:02.000Z'),
    ).toEqual({ kind: 'applied' });
    expect(
      secondStore.createCredentialApplicationFactory().start({
        recoveryFingerprint: 'migration-second',
        connectionId: 'codex-runtime',
        candidateProfileRef: 'candidate-b',
        now: '2026-08-13T00:00:03.000Z',
      }),
    ).toEqual({ kind: 'unavailable' });
    firstStore.close();
    secondStore.close();
  }, 20_000);

  test('serializes the exact drop-create window that races without the transaction [process]', async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'credential-application-ledger-ddl-window-'),
    );
    directories.push(directory);
    const productionPath = join(directory, 'production.sqlite');
    new EventStore(productionPath).close();
    downgradeCredentialFence(productionPath).close();

    const productionRelease = join(directory, 'production.release');
    const first = spawnCredentialMigration(
      productionPath,
      join(directory, 'production-first'),
      productionRelease,
      'production',
    );
    expect(await waitForFile(join(directory, 'production-first.dropped'))).toBe(
      true,
    );
    const second = spawnCredentialMigration(
      productionPath,
      join(directory, 'production-second'),
      productionRelease,
      'production',
    );
    expect(await waitForFile(join(directory, 'production-second.before'))).toBe(
      true,
    );
    expect(
      await waitForFile(join(directory, 'production-second.dropped'), 200),
    ).toBe(false);
    writeFileSync(productionRelease, 'release');
    expect(await childExit(first), first.stderr()).toBe(0);
    expect(await childExit(second), second.stderr()).toBe(0);
    expect(existsSync(join(directory, 'production-second.dropped'))).toBe(true);

    const legacyPath = join(directory, 'legacy.sqlite');
    new EventStore(legacyPath).close();
    downgradeCredentialFence(legacyPath).close();
    const legacyRelease = join(directory, 'legacy.release');
    const legacyFirst = spawnCredentialMigration(
      legacyPath,
      join(directory, 'legacy-first'),
      legacyRelease,
      'legacy',
    );
    const legacySecond = spawnCredentialMigration(
      legacyPath,
      join(directory, 'legacy-second'),
      legacyRelease,
      'legacy',
    );
    expect(await waitForFile(join(directory, 'legacy-first.dropped'))).toBe(
      true,
    );
    expect(await waitForFile(join(directory, 'legacy-second.dropped'))).toBe(
      true,
    );
    writeFileSync(legacyRelease, 'release');
    const legacyCodes = await Promise.all([
      childExit(legacyFirst),
      childExit(legacySecond),
    ]);
    expect(legacyCodes.filter((code) => code === 0)).toHaveLength(1);
    expect(legacyCodes.filter((code) => code !== 0)).toHaveLength(1);
  }, 20_000);

  test('rolls back the whole legacy upgrade when conflicting live evidence prevents the new fence', () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'credential-application-ledger-migration-conflict-'),
    );
    directories.push(directory);
    const path = join(directory, 'orchestration.sqlite');
    new EventStore(path).close();

    const legacy = downgradeCredentialFence(path);
    legacy.exec(`
      INSERT INTO credential_profile_applications (
        attempt_id, recovery_fingerprint, connection_id,
        candidate_profile_ref, state, created_at, updated_at
      ) VALUES
        ('attempt-a', 'recovery-a', 'codex-runtime', 'candidate-a',
         'commit-pending', '2026-08-13T00:00:00.000Z', '2026-08-13T00:00:00.000Z'),
        ('attempt-b', 'recovery-b', 'codex-runtime', 'candidate-b',
         'commit-pending', '2026-08-13T00:00:01.000Z', '2026-08-13T00:00:01.000Z');
    `);
    legacy.close();

    expect(() => new EventStore(path)).toThrow(/UNIQUE constraint failed/);

    const preserved = new DatabaseSync(path);
    const index = preserved
      .prepare(
        `SELECT sql FROM sqlite_master
         WHERE type = 'index'
           AND name = 'idx_credential_profile_applications_one_live_per_connection'`,
      )
      .get() as { sql?: string } | undefined;
    const lockColumns = preserved
      .prepare('PRAGMA table_info(credential_profile_connection_locks)')
      .all() as Array<{ name?: string }>;
    preserved.close();
    expect(index?.sql).not.toContain("'commit-pending'");
    expect(lockColumns.map((column) => column.name)).toContain('expires_at');
  });

  test('fences cross-process config mutation by connection and releases only its owner', async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'credential-application-ledger-lock-'),
    );
    directories.push(directory);
    const path = join(directory, 'orchestration.sqlite');
    const firstStore = new EventStore(path);
    const secondStore = new EventStore(path);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = firstStore
      .createCredentialApplicationFactory()
      .mutate('codex-runtime', async () => {
        await held;
        return 'first';
      });
    await Promise.resolve();
    await expect(
      secondStore
        .createCredentialApplicationFactory()
        .mutate('codex-runtime', async () => 'second'),
    ).resolves.toEqual({ kind: 'unavailable' });
    release();
    await expect(first).resolves.toEqual({ kind: 'applied', value: 'first' });
    await expect(
      secondStore
        .createCredentialApplicationFactory()
        .mutate('codex-runtime', async () => 'second'),
    ).resolves.toEqual({ kind: 'applied', value: 'second' });
    firstStore.close();
    secondStore.close();
  });

  test('process fence [process]: live child cannot be stolen, dead child is reclaimed once', async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'credential-application-ledger-process-lock-'),
    );
    directories.push(directory);
    const path = join(directory, 'orchestration.sqlite');
    // Initialize the schema before the child starts so its only observable
    // action is acquiring the real production mutation fence.
    new EventStore(path).close();
    const eventStorePath = new URL('../event-store.ts', import.meta.url)
      .pathname;
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `import { EventStore } from ${JSON.stringify(eventStorePath)};
         const store = new EventStore(process.argv[1]);
         const result = await store.createCredentialApplicationFactory().mutate(process.argv[2], async () => {
           process.stdout.write('locked\\n');
           await new Promise(() => { setInterval(() => {}, 1_000); });
         });
         if (result.kind !== 'applied') process.exitCode = 2;`,
        path,
        'codex-runtime',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    await once(child.stdout!, 'data');

    const live = new EventStore(path);
    await expect(
      live
        .createCredentialApplicationFactory()
        .mutate('codex-runtime', async () => 'must-not-run'),
    ).resolves.toEqual({ kind: 'unavailable' });
    live.close();

    child.kill('SIGKILL');
    await once(child, 'exit');
    const reclaimed = new EventStore(path);
    await expect(
      reclaimed
        .createCredentialApplicationFactory()
        .mutate('codex-runtime', async () => 'reclaimed'),
    ).resolves.toEqual({ kind: 'applied', value: 'reclaimed' });
    // The stale child row was removed by the sole successor. A second caller
    // cannot reclaim a live successor based on the killed child's identity.
    const successor = reclaimed
      .createCredentialApplicationFactory()
      .mutate('codex-runtime', async () => 'second');
    await expect(successor).resolves.toEqual({
      kind: 'applied',
      value: 'second',
    });
    reclaimed.close();
  }, 20_000);

  test('PID birth mismatch reclaims only the old token, while unavailable identity fails closed', async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'credential-application-ledger-identity-lock-'),
    );
    directories.push(directory);
    const path = join(directory, 'orchestration.sqlite');
    const oldStore = new EventStore(path, undefined, {
      exact: () => ({ pid: 41, start: 'birth-old' }),
      probe: () => ({ state: 'unavailable' }),
    });
    let releaseOld!: () => void;
    const oldHeld = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const old = oldStore
      .createCredentialApplicationFactory()
      .mutate('codex-runtime', async () => {
        await oldHeld;
        return 'old';
      });
    await Promise.resolve();

    const unavailable = new EventStore(path, undefined, {
      exact: () => ({ pid: 42, start: 'birth-unavailable' }),
      probe: () => ({ state: 'unavailable' }),
    });
    await expect(
      unavailable
        .createCredentialApplicationFactory()
        .mutate('codex-runtime', async () => 'must-not-run'),
    ).resolves.toEqual({ kind: 'unavailable' });
    unavailable.close();

    const successorStore = new EventStore(path, undefined, {
      exact: () => ({ pid: 43, start: 'birth-successor' }),
      probe: () => ({
        state: 'exact' as const,
        identity: { pid: 41, start: 'birth-reused' },
      }),
    });
    let releaseSuccessor!: () => void;
    const successorHeld = new Promise<void>((resolve) => {
      releaseSuccessor = resolve;
    });
    const successor = successorStore
      .createCredentialApplicationFactory()
      .mutate('codex-runtime', async () => {
        await successorHeld;
        return 'successor';
      });
    await Promise.resolve();
    releaseOld();
    await expect(old).resolves.toEqual({ kind: 'unavailable' });

    const contender = new EventStore(path, undefined, {
      exact: () => ({ pid: 44, start: 'birth-contender' }),
      probe: () => ({
        state: 'exact' as const,
        identity: { pid: 43, start: 'birth-successor' },
      }),
    });
    await expect(
      contender
        .createCredentialApplicationFactory()
        .mutate('codex-runtime', async () => 'must-not-run'),
    ).resolves.toEqual({ kind: 'unavailable' });
    contender.close();
    releaseSuccessor();
    await expect(successor).resolves.toEqual({
      kind: 'applied',
      value: 'successor',
    });
    oldStore.close();
    successorStore.close();
  });

  test('reopens commit-pending idempotently and keeps its connection exclusively reserved', () => {
    const store = fixture();
    const protocol = store.createCredentialApplicationFactory();
    const first = protocol.start({
      recoveryFingerprint: 'recovery-pending',
      connectionId: 'codex-runtime',
      candidateProfileRef: 'candidate-a',
      now: '2026-08-13T00:00:00.000Z',
    });
    expect(first.kind).toBe('owner');
    if (first.kind !== 'owner') throw new Error('expected owner');
    expect(first.claim.staged('2026-08-13T00:00:01.000Z')).toEqual({
      kind: 'applied',
    });
    expect(
      first.claim.settle('commit-pending', '2026-08-13T00:00:02.000Z'),
    ).toEqual({ kind: 'applied' });

    expect(
      first.claim.settle('commit-pending', '2026-08-13T00:00:03.000Z'),
    ).toEqual({ kind: 'applied' });
    expect(
      protocol.start({
        recoveryFingerprint: 'recovery-competing',
        connectionId: 'codex-runtime',
        candidateProfileRef: 'candidate-b',
        now: '2026-08-13T00:00:04.000Z',
      }),
    ).toEqual({ kind: 'unavailable' });
    expect(first.claim.settle('adopted', '2026-08-13T00:00:05.000Z')).toEqual({
      kind: 'applied',
    });
    store.close();
  });

  test('keeps opaque application authority out of the public recovery contract', () => {
    const contract = readFileSync(
      new URL(
        '../../../../packages/contracts/src/connection-recovery.ts',
        import.meta.url,
      ),
      'utf8',
    );
    expect(contract).not.toContain('CredentialProfilePendingApplication');
    expect(contract).not.toContain('CredentialProfileApplicationReceipt');
    const protocol = readFileSync(
      new URL('../credential-application-ledger.ts', import.meta.url),
      'utf8',
    );
    expect(protocol).not.toContain(
      'export interface CredentialApplicationLedger',
    );
    const publicInterface = protocol.slice(
      protocol.indexOf('export interface CredentialApplicationFactory'),
      protocol.indexOf('interface Coordinator'),
    );
    expect(publicInterface).not.toContain('attemptId');
    expect(publicInterface).not.toContain('begin(');
    expect(publicInterface).not.toContain('resume(');
    expect(publicInterface).not.toContain('recover(');
    expect(publicInterface).not.toContain('reserve(input:');
    expect(publicInterface).not.toContain('open(input:');
  });
});
