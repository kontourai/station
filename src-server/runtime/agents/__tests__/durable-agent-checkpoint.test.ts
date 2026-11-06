import { existsSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout } from 'node:timers/promises';
import { agentWire } from '@kontourai/agent-runtime/internal';
import { beforeEach, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { resetFixtureSqliteSynchronousForTest } from '../../../utils/sqlite-fixture-durability.js';
import { durableAgentCheckpoint } from '../durable-agent-checkpoint.js';
import { stationAgentRuntimeOwner } from '../durable-agent-owner.js';

const temp = trackTempDirs();
beforeEach(() => resetFixtureSqliteSynchronousForTest());

it('the production owner checkpoints active-turn WAL through a responsive worker', async () => {
  const home = temp('durable-checkpoint-owner-');
  const owner = stationAgentRuntimeOwner(home);
  owner.configure({
    preview: { select: (branches) => branches.enabled() },
    failed: (error) => {
      throw error;
    },
  });
  owner.registerAgent('assistant', 'definition/1', async () => {
    throw new Error('No model invocation expected');
  });
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  try {
    const lease = await owner.runtime.start({
      key: {
        scopeId: 'station',
        conversationId: 'conversation',
        invocationId: 'turn',
      },
      implementation: 'station-agent/1',
      input: agentWire({
        version: 1,
        slug: 'assistant',
        definition: 'definition/1',
        input: 'go',
        options: { conversationId: 'conversation', userId: 'owner' },
      }),
    });
    const path = join(home, 'data', 'agent-runtime', 'steps.sqlite');
    const writer = new DatabaseSync(path);
    try {
      writer.exec(
        'PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0; CREATE TABLE checkpoint_padding(bytes BLOB); INSERT INTO checkpoint_padding VALUES(zeroblob(6291456))',
      );
    } finally {
      writer.close();
    }
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(4 * 1024 * 1024);
    let maxSyncReadMs = 0;
    let readFailures = 0;
    const reads = setInterval(() => {
      const started = performance.now();
      try {
        owner.read('conversation', 'turn');
      } catch {
        readFailures++;
      } finally {
        maxSyncReadMs = Math.max(maxSyncReadMs, performance.now() - started);
      }
    }, 2);
    histogram.enable();
    await setTimeout(5);
    const started = performance.now();
    let busyWhilePolling = false;
    try {
      await lease.assertCurrent();
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          error.message === 'DURABLE_AGENT_CHECKPOINT_BUSY'
        )
      )
        throw error;
      busyWhilePolling = true;
    } finally {
      clearInterval(reads);
    }
    if (busyWhilePolling) await lease.assertCurrent();
    const checkpointReadMs = performance.now() - started;
    await setTimeout(5);
    histogram.disable();
    const metrics = {
      checkpointReadMs,
      busyWhilePolling,
      maxSyncReadMs,
      readFailures,
      eventLoopMaxMs: histogram.max / 1e6,
      walBytes: statSync(`${path}-wal`).size,
    };
    if (process.env.STATION_AGENT_RUNTIME_HOST_CHECKPOINT_REPORT)
      writeFileSync(
        process.env.STATION_AGENT_RUNTIME_HOST_CHECKPOINT_REPORT,
        JSON.stringify(metrics),
      );
    console.info('Station checkpoint worker', JSON.stringify(metrics));
    expect(statSync(`${path}-wal`).size).toBe(0);
    expect(histogram.max / 1e6).toBeLessThan(50);
    expect(maxSyncReadMs).toBeLessThan(50);
    expect(readFailures).toBe(0);
    await lease.run(async () => {});
    expect(owner.read('conversation', 'turn')?.turn.state).toBe('completed');
  } finally {
    histogram.disable();
    await owner.pause();
  }
});

it('closing an in-flight checkpoint reaps the worker and retains committed data', async () => {
  const path = join(temp('durable-checkpoint-close-'), 'journal.sqlite');
  const db = new DatabaseSync(path);
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0; CREATE TABLE payload(bytes BLOB); INSERT INTO payload VALUES(zeroblob(6291456))',
  );
  const checkpoint = durableAgentCheckpoint(db);
  try {
    const pending = expect(checkpoint.run()).rejects.toThrow(
      'DURABLE_AGENT_CHECKPOINT_CLOSED',
    );
    await Promise.all([checkpoint.close(), checkpoint.close()]);
    await pending;
    await expect(checkpoint.run()).rejects.toThrow(
      'DURABLE_AGENT_CHECKPOINT_CLOSED',
    );
    expect(db.prepare('SELECT count(*) AS n FROM payload').get()?.n).toBe(1);
    expect(db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe(
      'ok',
    );
  } finally {
    await checkpoint.close();
    db.close();
  }
});

it('a failed final checkpoint closes SQLite and releases the owner without losing committed data', async () => {
  const home = temp('durable-checkpoint-close-failure-');
  const path = join(home, 'data', 'agent-runtime', 'steps.sqlite');
  const owner = stationAgentRuntimeOwner(home);
  owner.configure({
    preview: { select: (branches) => branches.enabled() },
    failed: (error) => {
      throw error;
    },
  });
  owner.registerAgent('assistant', 'definition/1', async () => {
    throw new Error('No model invocation expected');
  });
  await owner.runtime.start({
    key: {
      scopeId: 'station',
      conversationId: 'conversation',
      invocationId: 'turn',
    },
    implementation: 'station-agent/1',
    input: agentWire({
      version: 1,
      slug: 'assistant',
      definition: 'definition/1',
      input: 'go',
      options: { conversationId: 'conversation', userId: 'owner' },
    }),
  });
  const close = vi.spyOn(DatabaseSync.prototype, 'close');
  try {
    const closing = owner.pause();
    queueMicrotask(() => renameSync(path, `${path}.held`));
    await expect(closing).rejects.toThrow('ENOENT');
    renameSync(`${path}.held`, path);
    expect(close).toHaveBeenCalledOnce();
    expect(close.mock.contexts[0]).toHaveProperty('isOpen', false);
    await expect(owner.pause()).rejects.toThrow('ENOENT');
    const replacement = stationAgentRuntimeOwner(home);
    try {
      expect(replacement).not.toBe(owner);
      expect(replacement.read('conversation', 'turn')?.turn.state).toBe(
        'running',
      );
      await expect(
        replacement.runtime.recover(
          {
            scopeId: 'station',
            conversationId: 'conversation',
            invocationId: 'turn',
          },
          () => true,
        ),
      ).resolves.toMatchObject({ key: { invocationId: 'turn' } });
      await expect(owner.pause()).rejects.toThrow('ENOENT');
      expect(stationAgentRuntimeOwner(home)).toBe(replacement);
    } finally {
      await replacement.pause();
    }
  } finally {
    if (existsSync(`${path}.held`)) renameSync(`${path}.held`, path);
    close.mockRestore();
    await owner.pause().catch(() => {});
  }
});
