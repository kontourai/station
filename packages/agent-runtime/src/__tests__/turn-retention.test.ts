import { constants, DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { turnFixture } from './turn-fixture.js';
import {
  retentionBacklog,
  seedRetentionBacklog,
} from './turn-retention-fixture.js';

it('batched retention setup writes the same agent rows as individually committed commands', async () => {
  const ordinary = await turnFixture();
  const batched = await turnFixture();
  const commits = (f: Awaited<ReturnType<typeof turnFixture>>) => {
    let count = 0;
    f.database.setAuthorizer((action, operation) => {
      if (action === constants.SQLITE_TRANSACTION && operation === 'COMMIT')
        count++;
      return constants.SQLITE_OK;
    });
    return () => count;
  };
  const ordinaryCommits = commits(ordinary);
  const batchedCommits = commits(batched);
  try {
    await seedRetentionBacklog(ordinary, 3, 2, false);
    await seedRetentionBacklog(batched, 3, 2);
    const snapshot = (f: Awaited<ReturnType<typeof turnFixture>>) => {
      const rows: Record<string, string[]> = {};
      for (const { name } of f.database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB 'agent_steps_*' ORDER BY name",
        )
        .all()) {
        const table = String(name);
        rows[table] = f.database
          .prepare(`SELECT * FROM ${table}`)
          .all()
          .map((row) => {
            // Affinity values are opaque generated UUIDs; their conversation identity is stable.
            const record =
              table === 'agent_steps_affinity'
                ? {
                    ...row,
                    provider_session_id: `${row.scope}:${row.conversation}`,
                  }
                : row;
            return JSON.stringify(record);
          })
          .sort();
      }
      return rows;
    };
    expect(snapshot(batched)).toEqual(snapshot(ordinary));
    expect(batchedCommits()).toBeLessThan(ordinaryCommits());
  } finally {
    await batched.close();
    await ordinary.close();
  }
});

it('retention bounds open and settle while draining 10 terminal turns with 80 effects each', async () => {
  await retentionBacklog(10, 80);
});

it('settlement leaves WAL checkpoint work for idle maintenance without delaying durable visibility', async () => {
  const f = await turnFixture();
  try {
    f.database.exec(
      'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint=1',
    );
    await f.lease.run(async () => {});
    expect(
      f.database.prepare('PRAGMA wal_autocheckpoint').get()?.wal_autocheckpoint,
    ).toBe(1);
    const wal = f.database.prepare('PRAGMA wal_checkpoint(NOOP)').get();
    expect(Number(wal?.log)).toBeGreaterThan(0);
    expect(wal?.checkpointed).toBe(0);
    const reader = new DatabaseSync(f.database.location()!, { readOnly: true });
    try {
      expect(
        reader.prepare('SELECT state FROM agent_steps_terminal').get()?.state,
      ).toBe('completed');
      expect(
        reader.prepare('PRAGMA integrity_check').get()?.integrity_check,
      ).toBe('ok');
    } finally {
      reader.close();
    }
    await setImmediate();
    const idle = f.database.prepare('PRAGMA wal_checkpoint(NOOP)').get();
    expect(idle?.checkpointed).toBe(idle?.log);
    expect(f.database.prepare('PRAGMA synchronous').get()?.synchronous).toBe(2);
  } finally {
    await f.close();
  }
});

it('a failed settlement commit rolls back terminal state and restores the host checkpoint policy', async () => {
  const f = await turnFixture();
  const execute = f.database.exec.bind(f.database);
  try {
    execute('PRAGMA wal_autocheckpoint=17');
    const failure = vi.spyOn(f.database, 'exec').mockImplementation((sql) => {
      if (
        sql === 'COMMIT' &&
        f.database.prepare('SELECT 1 FROM agent_steps_terminal').get()
      )
        throw new Error('injected settle commit failure');
      execute(sql);
    });
    try {
      await expect(f.lease.run(async () => {})).rejects.toThrow(
        'injected settle commit failure',
      );
    } finally {
      failure.mockRestore();
    }
    expect(f.database.isTransaction).toBe(false);
    expect(
      f.database.prepare('SELECT count(*) AS n FROM agent_steps_terminal').get()
        ?.n,
    ).toBe(0);
    expect(
      f.database.prepare('PRAGMA wal_autocheckpoint').get()?.wal_autocheckpoint,
    ).toBe(17);
    const recovered = await f.recover();
    await recovered.run(async () => {});
    expect(
      f.database.prepare('SELECT state FROM agent_steps_terminal').get()?.state,
    ).toBe('completed');
  } finally {
    await f.close();
  }
});
