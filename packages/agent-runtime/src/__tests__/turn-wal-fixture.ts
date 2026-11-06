import { createHash } from 'node:crypto';
import { copyFileSync, statSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout } from 'node:timers/promises';
import { expect } from 'vitest';
import { turnFixture } from './turn-fixture.js';
import { timeAgentTransactions } from './turn-timing-fixture.js';

export async function activeTurnWalBacklog() {
  const f = await turnFixture();
  const timing = timeAgentTransactions(f.database);
  const path = f.database.location()!;
  const opens: { rawMs: number; workMs: number; commitMs: number }[] = [];
  const samples: { turn: number; walBytes: number }[] = [];
  let maxWalBytes = 0;
  const loadStart = loadavg();
  try {
    for (let turn = 0; turn < 300; turn++) {
      const opened = await timing.measure(() =>
        f.runtime.start({
          key: {
            ...f.key,
            conversationId: `wal-${turn}`,
            invocationId: `wal-${turn}`,
          },
          input: 'WAL bound',
          implementation: 'station-agent/1',
        }),
      );
      const lease = opened.result;
      opens.push({
        rawMs: opened.rawMs,
        workMs: opened.workMs,
        commitMs: opened.commitMs,
      });
      for (let effect = 0; effect < 20; effect++) {
        const text = Array.from({ length: 10 }, (_, index) =>
          createHash('sha256')
            .update(`${turn}:${effect}:${index}`)
            .digest('base64url'),
        ).join('');
        await lease.tool(
          { id: `effect-${effect}`, input: text, replay: 'unsafe' },
          async () => `${text} result`,
        );
        maxWalBytes = Math.max(maxWalBytes, statSync(`${path}-wal`).size);
      }
      await lease.run(async () => {});
      if ((turn + 1) % 50 === 0)
        samples.push({
          turn: turn + 1,
          walBytes: statSync(`${path}-wal`).size,
        });
    }
    // Keep the first turn active throughout; retention cannot create checkpoint opportunities.
    await f.lease.assertCurrent();
    const crashPath = join(path, '..', 'crash.sqlite');
    copyFileSync(path, crashPath);
    copyFileSync(`${path}-wal`, `${crashPath}-wal`);
    const cold = new DatabaseSync(crashPath);
    let firstQueryMs: number;
    try {
      const started = performance.now();
      expect(
        cold.prepare('SELECT count(*) AS n FROM agent_steps_turns').get()?.n,
      ).toBe(301);
      firstQueryMs = performance.now() - started;
    } finally {
      cold.close();
    }
    const metrics = {
      scenario: 'active-300x20',
      opens,
      samples,
      maxWalBytes,
      firstQueryMs,
      loadStart,
      loadEnd: loadavg(),
    };
    if (process.env.STATION_AGENT_RUNTIME_WAL_REPORT)
      writeFileSync(
        process.env.STATION_AGENT_RUNTIME_WAL_REPORT,
        JSON.stringify(metrics),
      );
    console.info('active-turn WAL', JSON.stringify(metrics));
    expect(maxWalBytes).toBeLessThan(8 * 1024 * 1024);
    expect(Math.max(...opens.map((row) => row.workMs))).toBeLessThan(50);
  } finally {
    timing.restore();
    await f.close();
  }
}

export async function checkpointEventLoop() {
  const f = await turnFixture();
  const path = f.database.location()!;
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  try {
    f.database.exec(
      'PRAGMA wal_autocheckpoint=0; CREATE TABLE checkpoint_padding(bytes BLOB)',
    );
    f.database
      .prepare('INSERT INTO checkpoint_padding VALUES(?)')
      .run(Buffer.alloc(6 * 1024 * 1024, 42));
    const beforeBytes = statSync(`${path}-wal`).size;
    histogram.enable();
    await setTimeout(5);
    const started = performance.now();
    // A read needs no durable commit; its wait isolates checkpoint responsiveness.
    await f.lease.assertCurrent();
    const readMs = performance.now() - started;
    await setTimeout(5);
    histogram.disable();
    const wal = f.database.prepare('PRAGMA wal_checkpoint(NOOP)').get();
    const metrics = {
      scenario: 'checkpoint-read',
      wal,
      beforeBytes,
      afterBytes: statSync(`${path}-wal`).size,
      readMs,
      eventLoopMaxMs: histogram.max / 1e6,
    };
    if (process.env.STATION_AGENT_RUNTIME_CHECKPOINT_REPORT)
      writeFileSync(
        process.env.STATION_AGENT_RUNTIME_CHECKPOINT_REPORT,
        JSON.stringify(metrics),
      );
    console.info('checkpoint responsiveness', JSON.stringify(metrics));
    expect(wal?.checkpointed).toBe(wal?.log);
    expect(metrics.afterBytes).toBeLessThan(8 * 1024 * 1024);
    expect(metrics.eventLoopMaxMs).toBeLessThan(50);
  } finally {
    histogram.disable();
    await f.close();
  }
}
