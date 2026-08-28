import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ORCHESTRATION_EVENT_STORE_MIGRATION } from '../../../domain/migrations/003-orchestration-events.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import {
  ChatTurnDedupStore,
  getChatTurnDedupStore,
  resetChatTurnDedupStoresForTest,
} from '../chat-turn-dedup.js';

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
      run(...args: unknown[]): unknown;
    };
  };
};
const CHILD_TIMEOUT_MS = 10_000;

type ChildClaimInput = {
  filePath: string;
  key: string;
  executionsPath: string;
  readyPath?: string;
  releasePath?: string;
};

function claimFromRealProcess(
  input: ChildClaimInput,
): Promise<{ claimed: boolean }> {
  const moduleUrl = pathToFileURL(
    resolve(process.cwd(), 'src-server/routes/chat/chat-turn-dedup.ts'),
  ).href;
  const program = `
    import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
    const input = JSON.parse(process.env.STATION_TURN_DEDUP_CHILD_INPUT);
    const { ChatTurnDedupStore } = await import(${JSON.stringify(moduleUrl)});
    const store = new ChatTurnDedupStore(input.filePath);
    const claim = store.claim(input.key);
    if (claim.claimed) appendFileSync(input.executionsPath, process.pid + '\\n');
    if (input.readyPath) writeFileSync(input.readyPath, 'ready');
    while (input.releasePath && !existsSync(input.releasePath)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    process.stdout.write(JSON.stringify({ claimed: claim.claimed }));
  `;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', program],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          STATION_TURN_DEDUP_CHILD_INPUT: JSON.stringify(input),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('turn ownership child timed out'));
    }, CHILD_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`turn ownership child exited ${code}: ${stderr}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout) as { claimed: boolean });
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + CHILD_TIMEOUT_MS;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${path}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

function seedTurnRows(
  filePath: string,
  rows: Array<{
    key: string;
    value: string | null;
    createdAt: number;
    owner?: object;
  }>,
): void {
  const database = new DatabaseSync(filePath);
  try {
    database.exec(ORCHESTRATION_EVENT_STORE_MIGRATION);
    const insert = database.prepare(`INSERT INTO orchestration_turn_dedup
      (dedup_key, value, created_at, owner_json) VALUES (?, ?, ?, ?)`);
    for (const row of rows) {
      insert.run(
        `chat:${row.key.length}:${row.key}`,
        row.value,
        row.createdAt,
        row.owner ? JSON.stringify(row.owner) : null,
      );
    }
  } finally {
    database.close();
  }
}

describe('ChatTurnDedupStore (station#1224 offline slice 2)', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chat-turn-dedup-'));
    filePath = join(dir, 'chat-turn-dedup.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('a fresh clientTurnId claims successfully', () => {
    const store = new ChatTurnDedupStore(filePath);
    expect(store.claim('turn-a')).toEqual({ claimed: true });
  });

  test('a resolved claim is a dedup hit carrying the original conversationId', () => {
    const store = new ChatTurnDedupStore(filePath);
    store.claim('turn-a');
    store.resolve('turn-a', 'conversation-1');

    expect(store.claim('turn-a')).toEqual({
      claimed: false,
      conversationId: 'conversation-1',
    });
  });

  test('an unresolved (in-flight) claim reports claimed:false with conversationId null', () => {
    const store = new ChatTurnDedupStore(filePath);
    store.claim('turn-a');

    expect(store.claim('turn-a')).toEqual({
      claimed: false,
      conversationId: null,
    });
  });

  test('releasing an unresolved claim lets a retry genuinely re-claim it', () => {
    const store = new ChatTurnDedupStore(filePath);
    store.claim('turn-a');
    store.release('turn-a');

    expect(store.claim('turn-a')).toEqual({ claimed: true });
  });

  test('survives being reconstructed from the same file (restart-safety)', () => {
    const store = new ChatTurnDedupStore(filePath);
    store.claim('turn-a');
    store.resolve('turn-a', 'conversation-1');

    const reloaded = new ChatTurnDedupStore(filePath);
    expect(reloaded.claim('turn-a')).toEqual({
      claimed: false,
      conversationId: 'conversation-1',
    });
  });

  test('awaitResolution resolves once another caller resolves the claim', async () => {
    const store = new ChatTurnDedupStore(filePath);
    store.claim('turn-a');

    const waiter = store.awaitResolution('turn-a', 2000, 10);
    setTimeout(() => store.resolve('turn-a', 'conversation-late'), 30);

    await expect(waiter).resolves.toBe('conversation-late');
  });

  test('station#1224 CRITICAL fix: an in-flight claim stays held indefinitely within the same process — repeated attempts never reclaim it', () => {
    const store = new ChatTurnDedupStore(filePath);
    store.claim('turn-a');

    // A long-running turn easily runs well past the OLD 10-minute stale
    // window while still legitimately executing. Repeated in-process
    // attempts must never see `claimed: true` again.
    for (let i = 0; i < 5; i += 1) {
      expect(store.claim('turn-a')).toEqual({
        claimed: false,
        conversationId: null,
      });
    }
  });

  test('a second store construction preserves a live owner claim', () => {
    const firstProcess = new ChatTurnDedupStore(filePath);
    firstProcess.claim('turn-a');
    // Still unresolved when this "process" ends (it crashed) — a second
    // claim attempt from the SAME (still-running) instance must NOT
    // reclaim it.
    expect(firstProcess.claim('turn-a')).toEqual({
      claimed: false,
      conversationId: null,
    });

    // A second Station may share this home; construction cannot steal.
    const restartedProcess = new ChatTurnDedupStore(filePath);
    expect(restartedProcess.claim('turn-a')).toEqual({
      claimed: false,
      conversationId: null,
    });
  });

  test(
    'OWNERSHIP VIOLATION: two real processes execute one turn exactly once and a second process construction preserves the live claim',
    async () => {
      const executionsPath = join(dir, 'executions.log');
      const firstReadyPath = join(dir, 'first-ready');
      const releasePath = join(dir, 'release-first');
      const first = claimFromRealProcess({
        filePath,
        key: 'turn-shared',
        executionsPath,
        readyPath: firstReadyPath,
        releasePath,
      });
      await waitFor(firstReadyPath);

      const second = await claimFromRealProcess({
        filePath,
        key: 'turn-shared',
        executionsPath,
      });
      expect(second).toEqual({ claimed: false });
      expect(
        readFileSync(executionsPath, 'utf8').trim().split('\n'),
      ).toHaveLength(1);

      writeFileSync(releasePath, 'release');
      expect(await first).toEqual({ claimed: true });
      expect(
        readFileSync(executionsPath, 'utf8').trim().split('\n'),
      ).toHaveLength(1);
    },
    CHILD_TIMEOUT_MS + 1_000,
  );

  test(
    'distinct turns execute concurrently in real processes',
    async () => {
      const executionsPath = join(dir, 'executions.log');
      const firstReadyPath = join(dir, 'first-ready');
      const secondReadyPath = join(dir, 'second-ready');
      const releasePath = join(dir, 'release-both');
      const first = claimFromRealProcess({
        filePath,
        key: 'turn-one',
        executionsPath,
        readyPath: firstReadyPath,
        releasePath,
      });
      await waitFor(firstReadyPath);
      const second = claimFromRealProcess({
        filePath,
        key: 'turn-two',
        executionsPath,
        readyPath: secondReadyPath,
        releasePath,
      });
      await waitFor(secondReadyPath);
      expect(
        readFileSync(executionsPath, 'utf8').trim().split('\n'),
      ).toHaveLength(2);
      writeFileSync(releasePath, 'release');
      await expect(Promise.all([first, second])).resolves.toEqual([
        { claimed: true },
        { claimed: true },
      ]);
    },
    CHILD_TIMEOUT_MS + 1_000,
  );

  test('reclaims a genuinely abandoned claim with a dead PID', () => {
    seedTurnRows(filePath, [
      {
        key: 'turn-abandoned',
        value: null,
        createdAt: 0,
        owner: {
          pid: 999_999_999,
          birth: 'dead-process-birth',
          token: 'abandoned-owner',
          identityKind: 'exact',
        },
      },
    ]);

    expect(new ChatTurnDedupStore(filePath).claim('turn-abandoned')).toEqual({
      claimed: true,
    });
  });

  test('capacity evicts an oldest resolved claim but never unresolved claims', async () => {
    // Eviction is a property of "more rows than the cap", not of the number
    // 2000. Inserting 2000 real SQLite rows made this test exceed its 5s
    // budget under host load and fail intermittently — a test that reds at
    // random trains people to rerun rather than read.
    const CHAT_TURN_DEDUP_MAX_ENTRIES = 6;
    const ownerStore = new ChatTurnDedupStore(
      filePath,
      CHAT_TURN_DEDUP_MAX_ENTRIES,
    );
    expect(ownerStore.claim('old-live')).toEqual({ claimed: true });
    const database = new DatabaseSync(filePath);
    let liveOwner: object;
    try {
      const row = database
        .prepare(
          'SELECT owner_json AS ownerJson FROM orchestration_turn_dedup WHERE dedup_key = ?',
        )
        .get('chat:8:old-live') as { ownerJson: string };
      liveOwner = JSON.parse(row.ownerJson) as object;
      database
        .prepare(
          'UPDATE orchestration_turn_dedup SET created_at = ? WHERE dedup_key = ?',
        )
        .run(0, 'chat:8:old-live');
    } finally {
      database.close();
    }
    const deadOwner = {
      pid: 999_999_999,
      birth: 'dead-process-birth',
      token: 'dead-owner',
      identityKind: 'exact',
    };
    seedTurnRows(filePath, [
      { key: 'old-dead', value: null, createdAt: 1, owner: deadOwner },
      { key: 'old-resolved', value: 'conversation-old', createdAt: 2 },
      ...Array.from(
        { length: CHAT_TURN_DEDUP_MAX_ENTRIES - 3 },
        (_, index) => ({
          key: `live-${index}`,
          value: null,
          createdAt: index + 3,
          owner: liveOwner,
        }),
      ),
    ]);

    // The overflow claim MUST run against the same reduced cap. With the
    // default 2000 the row count never exceeds it, `prune()` returns on a
    // negative overflow, and nothing is evicted -- `old-dead` would then
    // succeed through ordinary dead-owner reclamation in `claim()` and the
    // test would assert a true thing for the wrong reason.
    const store = new ChatTurnDedupStore(filePath, CHAT_TURN_DEDUP_MAX_ENTRIES);
    expect(store.claim('new-turn')).toEqual({ claimed: true });

    // Prove eviction happened, before any claim can mask it by reclaiming.
    const after = new DatabaseSync(filePath);
    try {
      const keys = (
        after
          .prepare('SELECT dedup_key FROM orchestration_turn_dedup')
          .all() as Array<{ dedup_key: string }>
      ).map((row) => row.dedup_key);
      expect(keys).not.toContain('chat:12:old-resolved');
      expect(keys).toContain('chat:8:old-live');
      expect(keys).toContain('chat:8:old-dead');
    } finally {
      after.close();
    }

    expect(store.claim('old-live')).toEqual({
      claimed: false,
      conversationId: null,
    });
    // Retention does not disable ordinary claim-time recovery of a genuinely
    // dead owner; the SQL inspection above proves pruning did not evict it.
    expect(store.claim('old-dead')).toEqual({ claimed: true });
  });

  test('fails loudly and preserves malformed claim-owner bytes', () => {
    const database = new DatabaseSync(filePath);
    try {
      database.exec(ORCHESTRATION_EVENT_STORE_MIGRATION);
      database
        .prepare(`INSERT INTO orchestration_turn_dedup
          (dedup_key, value, created_at, owner_json) VALUES (?, ?, ?, ?)`)
        .run('chat:6:turn-a', null, 0, '{"pid":"not-a-pid"}');
    } finally {
      database.close();
    }

    expect(() => new ChatTurnDedupStore(filePath).claim('turn-a')).toThrow(
      'Invalid orchestration turn claim owner_json',
    );
    expect(() => new ChatTurnDedupStore(filePath).claim('turn-a')).toThrow(
      'Invalid orchestration turn claim owner_json',
    );
    const ownerAfterFailure = new DatabaseSync(filePath);
    try {
      expect(
        ownerAfterFailure
          .prepare(
            'SELECT owner_json AS ownerJson FROM orchestration_turn_dedup WHERE dedup_key = ?',
          )
          .get('chat:6:turn-a'),
      ).toEqual({ ownerJson: '{"pid":"not-a-pid"}' });
    } finally {
      ownerAfterFailure.close();
    }
  });

  test('a process restart never clears an already-RESOLVED claim', () => {
    const firstProcess = new ChatTurnDedupStore(filePath);
    firstProcess.claim('turn-a');
    firstProcess.resolve('turn-a', 'conversation-1');

    const restartedProcess = new ChatTurnDedupStore(filePath);
    expect(restartedProcess.claim('turn-a')).toEqual({
      claimed: false,
      conversationId: 'conversation-1',
    });
  });

  test('upgrades a legacy handoff receipt before ChatTurnDedup composes its EventStore', () => {
    const database = new DatabaseSync(filePath);
    try {
      database.exec(ORCHESTRATION_EVENT_STORE_MIGRATION);
      database.exec(`
        CREATE TABLE orchestration_conversation_handoffs (
          conversation_id TEXT NOT NULL,
          predecessor_session_id TEXT NOT NULL PRIMARY KEY,
          session_id TEXT NOT NULL UNIQUE,
          idempotency_key TEXT NOT NULL,
          target_agent_id TEXT NOT NULL,
          target_environment_id TEXT NOT NULL,
          target_connection_id TEXT,
          target_model_id TEXT,
          created_at TEXT NOT NULL,
          UNIQUE (conversation_id, idempotency_key)
        );
      `);
      database
        .prepare(
          `INSERT INTO orchestration_conversation_handoffs
            (conversation_id, predecessor_session_id, session_id, idempotency_key,
             target_agent_id, target_environment_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'legacy-conversation',
          'legacy-conversation',
          'legacy-conversation:session:codex',
          'legacy-handoff',
          'codex',
          'environment-current',
          '2026-08-24T00:00:00.000Z',
        );
    } finally {
      database.close();
    }

    const eventStore = new EventStore(filePath);
    try {
      expect(
        eventStore.conversationHandoffByKey(
          'legacy-conversation',
          'legacy-handoff',
        ),
      ).toMatchObject({ messageDigest: 'legacy-unavailable' });
      expect(new ChatTurnDedupStore(eventStore).claim('legacy-turn')).toEqual({
        claimed: true,
      });
    } finally {
      eventStore.close();
    }
  });

  // Writes CHAT_TURN_DEDUP_MAX_ENTRIES+1 claim/resolve pairs through the
  // real store — priced explicitly so full-corpus contention cannot red it
  // at the default budget (archive#2654).
  test('bounds a full persisted file with one representative persistence transition', {
    timeout: 30_000,
  }, async () => {
    const { CHAT_TURN_DEDUP_MAX_ENTRIES } = await import(
      '../chat-turn-dedup.js'
    );
    const store = new ChatTurnDedupStore(filePath);
    for (let index = 0; index <= CHAT_TURN_DEDUP_MAX_ENTRIES; index += 1) {
      store.claim(`turn-${index}`);
      store.resolve(`turn-${index}`, `conversation-${index}`);
    }

    // The oldest entries were evicted; the most recent ones remain claimable
    // (i.e. still recognized — re-claiming them reports claimed:false since
    // they're still present).
    expect(store.claim(`turn-${CHAT_TURN_DEDUP_MAX_ENTRIES}`)).toEqual({
      claimed: false,
      conversationId: `conversation-${CHAT_TURN_DEDUP_MAX_ENTRIES}`,
    });
    expect(store.claim('turn-0')).toEqual({ claimed: true });
  });
});

describe('getChatTurnDedupStore', () => {
  afterEach(() => {
    resetChatTurnDedupStoresForTest();
  });

  test('returns the SAME instance for the same projectHomeDir', () => {
    const store1 = getChatTurnDedupStore('/tmp/station-test-home-a');
    const store2 = getChatTurnDedupStore('/tmp/station-test-home-a');
    expect(store1).toBe(store2);
  });

  test('returns DIFFERENT instances for different projectHomeDirs', () => {
    const store1 = getChatTurnDedupStore('/tmp/station-test-home-b');
    const store2 = getChatTurnDedupStore('/tmp/station-test-home-c');
    expect(store1).not.toBe(store2);
  });
});
