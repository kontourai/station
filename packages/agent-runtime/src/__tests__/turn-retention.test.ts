import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { constants } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { turnFixture } from './turn-fixture.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it('retention bounds open and settle while draining 60 terminal turns with 80 effects each', async () => {
  const f = await turnFixture();
  cleanup.push(() => f.close());
  await f.lease.run(async () => {});
  for (let turn = 0; turn < 60; turn++) {
    const lease = await f.runtime.start({
      key: {
        ...f.key,
        conversationId: `backlog-${turn}`,
        invocationId: `old-${turn}`,
      },
      input: `turn-${turn}`,
      implementation: 'station-agent/1',
    });
    for (let effect = 0; effect < 80; effect++) {
      const text = Array.from({ length: 10 }, (_, i) =>
        createHash('sha256')
          .update(`${turn}:${effect}:${i}`)
          .digest('base64url'),
      ).join('');
      await lease.tool(
        { id: `effect-${effect}`, input: text, replay: 'unsafe' },
        async () => `${text} result`,
      );
    }
    if (turn % 3 === 1)
      await expect(
        lease.run(async () => {
          throw new Error('terminal failure');
        }),
      ).rejects.toThrow('terminal failure');
    else {
      if (turn % 3 === 2) {
        await lease.cancel();
        await expect(lease.run(async () => {})).rejects.toThrow(
          'DURABLE_AGENT_CANCELLED',
        );
      } else await lease.run(async () => {});
    }
  }
  expect(
    Number(
      f.database.prepare('SELECT count(*) AS n FROM agent_steps_effects').get()
        ?.n,
    ),
  ).toBe(4800);
  expect(() =>
    f.database.exec('UPDATE agent_steps_body_counts SET n=0'),
  ).toThrow('DURABLE_AGENT_REFERENCE_WRITE_REFUSED');
  const guardPayloadReads = new Set<string>();
  f.database.setAuthorizer((action, table, column, _database, source) => {
    if (
      action === constants.SQLITE_READ &&
      table === 'agent_steps_effects' &&
      column === 'record' &&
      source?.endsWith('_no_delete')
    )
      guardPayloadReads.add(source);
    return constants.SQLITE_OK;
  });
  f.advance(8 * 24 * 60 * 60 * 1000);
  const opens: number[] = [];
  const settles: number[] = [];
  let drained = false;
  for (let pass = 0; pass < 1200; pass++) {
    let started = performance.now();
    const lease = await f.runtime.start({
      key: {
        ...f.key,
        conversationId: `maintenance-${pass}`,
        invocationId: `fresh-${pass}`,
      },
      input: 'maintenance',
      implementation: 'station-agent/1',
    });
    opens.push(performance.now() - started);
    started = performance.now();
    await lease.run(async () => {});
    settles.push(performance.now() - started);
    const remaining = Number(
      f.database
        .prepare(
          "SELECT count(*) AS n FROM agent_steps_effects WHERE turn_id IN (SELECT id FROM agent_steps_turns WHERE json_extract(record,'$.retired')=1)",
        )
        .get()?.n,
    );
    const pending = Number(
      f.database
        .prepare('SELECT count(*) AS n FROM agent_steps_retained_cleanup')
        .get()?.n,
    );
    const dead = Number(
      f.database
        .prepare('SELECT count(*) AS n FROM agent_steps_body_counts WHERE n=0')
        .get()?.n,
    );
    if (
      !remaining &&
      !pending &&
      !dead &&
      Number(
        f.database
          .prepare(
            'SELECT (SELECT count(*) FROM agent_steps_bodies)+(SELECT count(*) FROM agent_steps_body_nodes)+(SELECT count(*) FROM agent_steps_body_chunks) AS n',
          )
          .get()?.n,
      ) === 0 &&
      Number(
        f.database
          .prepare('SELECT count(*) AS n FROM agent_steps_retained')
          .get()?.n,
      ) === 61
    ) {
      drained = true;
      break;
    }
  }
  if (process.env.STATION_AGENT_RUNTIME_RETENTION_REPORT)
    writeFileSync(
      process.env.STATION_AGENT_RUNTIME_RETENTION_REPORT,
      JSON.stringify({
        effectRows: 4800,
        passes: opens.length,
        maxOpenMs: Math.max(...opens),
        maxSettleMs: Math.max(...settles),
      }),
    );
  console.info(
    'retention backlog timings',
    JSON.stringify({
      effectRows: 4800,
      passes: opens.length,
      maxOpenMs: Math.max(...opens),
      maxSettleMs: Math.max(...settles),
    }),
  );
  expect(drained).toBe(true);
  expect([...guardPayloadReads]).toEqual([]);
  expect(opens.length).toBeLessThanOrEqual(400);
  expect(Math.max(...opens)).toBeLessThan(50);
  expect(Math.max(...settles)).toBeLessThan(50);
  expect(
    f.database
      .prepare(
        'SELECT state,count(*) AS n FROM agent_steps_terminal s JOIN agent_steps_retained r ON r.turn_id=s.turn_id GROUP BY state ORDER BY state',
      )
      .all(),
  ).toEqual([
    { state: 'blocked', n: 20 },
    { state: 'cancelled', n: 20 },
    { state: 'completed', n: 21 },
  ]);
  expect(
    await f.runtime.recover({
      ...f.key,
      conversationId: 'backlog-1',
      invocationId: 'old-1',
    }),
  ).toBe('retry');
}, 300_000);
