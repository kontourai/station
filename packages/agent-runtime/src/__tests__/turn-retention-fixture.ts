import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { constants } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import { expect, vi } from 'vitest';
import {
  auditSqliteAgentJournal,
  createAgentRuntime,
  openSqliteAgentJournal,
} from '../index.js';
import { owner } from './fixture.js';
import { turnFixture } from './turn-fixture.js';

type TurnFixture = Awaited<ReturnType<typeof turnFixture>>;

/** Seed through the production writer, committing its normal row writes as one fixture transaction. */
export async function seedRetentionBacklog(
  f: TurnFixture,
  turns: number,
  effects: number,
  batched = true,
) {
  await f.lease.run(async () => {});
  const epoch = Number(
    f.database
      .prepare('SELECT settled_at FROM agent_steps_terminal LIMIT 1')
      .get()?.settled_at,
  );
  const journal = batched
    ? openSqliteAgentJournal({ database: f.database })
    : undefined;
  const runtime = journal
    ? createAgentRuntime({
        journal,
        owner,
        liveness: f.liveness,
        implementation: 'station-agent/1',
        now: () => epoch,
      })
    : f.runtime;
  const execute = f.database.exec.bind(f.database);
  if (batched) execute('BEGIN IMMEDIATE');
  // Only setup barriers are batched. Real statements, validation and reference triggers still run.
  const barriers = batched
    ? vi.spyOn(f.database, 'exec').mockImplementation((sql) => {
        if (/^(BEGIN(?: IMMEDIATE)?|COMMIT)$/.test(sql)) return;
        execute(sql);
      })
    : undefined;
  try {
    for (let turn = 0; turn < turns; turn++) {
      const lease = await runtime.start({
        key: {
          ...f.key,
          conversationId: `backlog-${turn}`,
          invocationId: `old-${turn}`,
        },
        input: `turn-${turn}`,
        implementation: 'station-agent/1',
      });
      for (let effect = 0; effect < effects; effect++) {
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
    barriers?.mockRestore();
    if (batched) execute('COMMIT');
  } catch (error) {
    barriers?.mockRestore();
    if (f.database.isTransaction) execute('ROLLBACK');
    throw error;
  } finally {
    barriers?.mockRestore();
    await journal?.close();
  }
  await f.crash.reopen();
  expect(auditSqliteAgentJournal({ database: f.database })).toEqual({
    turns: turns + 1,
    effects: turns * effects,
    approvals: 0,
  });
}

export async function retentionBacklog(turns: number, effects: number) {
  const seedStarted = performance.now();
  const f = await turnFixture();
  try {
    await seedRetentionBacklog(f, turns, effects);
    const seedMs = performance.now() - seedStarted;
    expect(
      Number(
        f.database
          .prepare('SELECT count(*) AS n FROM agent_steps_effects')
          .get()?.n,
      ),
    ).toBe(turns * effects);
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
    const drainStarted = performance.now();
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
      if (pass === 0) {
        await setImmediate();
        expect(
          f.database
            .prepare('SELECT count(*) AS n FROM agent_steps_retained')
            .get()?.n,
        ).toBe(0);
        expect(
          f.database
            .prepare('SELECT count(*) AS n FROM agent_steps_effects')
            .get()?.n,
        ).toBe(turns * effects);
      }
      started = performance.now();
      await lease.run(async () => {});
      settles.push(performance.now() - started);
      for (let idle = 0; idle < 4; idle++) await setImmediate();
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
          .prepare(
            'SELECT count(*) AS n FROM agent_steps_body_counts WHERE n=0',
          )
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
        ) ===
          turns + 1
      ) {
        drained = true;
        break;
      }
    }
    const metrics = {
      turns,
      effectRows: turns * effects,
      seedMs,
      drainMs: performance.now() - drainStarted,
      passes: opens.length,
      maxOpenMs: Math.max(...opens),
      maxSettleMs: Math.max(...settles),
    };
    if (process.env.STATION_AGENT_RUNTIME_RETENTION_REPORT)
      writeFileSync(
        process.env.STATION_AGENT_RUNTIME_RETENTION_REPORT,
        JSON.stringify(metrics),
      );
    console.info('retention backlog timings', JSON.stringify(metrics));
    expect(metrics.drainMs).toBeLessThan(30_000);
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
      { state: 'blocked', n: Math.floor((turns + 1) / 3) },
      { state: 'cancelled', n: Math.floor(turns / 3) },
      { state: 'completed', n: Math.ceil(turns / 3) + 1 },
    ]);
    expect(
      await f.runtime.recover({
        ...f.key,
        conversationId: 'backlog-1',
        invocationId: 'old-1',
      }),
    ).toBe('retry');
  } finally {
    await f.close();
  }
}
