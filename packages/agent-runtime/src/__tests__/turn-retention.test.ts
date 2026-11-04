import { constants } from 'node:sqlite';
import { expect, it } from 'vitest';
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
