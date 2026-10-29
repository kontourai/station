import { afterEach, expect, it, vi } from 'vitest';
import {
  commandDigest,
  DEFAULT_MODEL_POLICY,
  drainModelOutbox,
} from '../index.js';
import { openSqliteRuntimeProjection } from '../sqlite.js';
import { key, operation } from './fixture.js';
import { completedGeneration } from './r2-fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
  vi.useRealTimers();
});
for (const kind of ['memory', 'sqlite'] as const)
  for (const projection of ['unacked', 'lagging', 'drained'] as const)
    it(`R2.2 ${kind} exact saved replay and open expire with ${projection} projection and stale prefinish fence`, async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const epoch = Date.UTC(2026, 0, 1);
      vi.setSystemTime(epoch);
      const f = await completedGeneration(kind);
      cleanup.push(() => f.close());
      const sink = openSqliteRuntimeProjection({
        database: f.database,
        bodies: f.bodies,
        host: f.host,
        policy: DEFAULT_MODEL_POLICY,
      });
      cleanup.push(() => sink.close());
      // Memory has its own journal; use the actual same-database sink only for SQLite.
      const rows = await f.storage.execute(
        { type: 'listOutbox', key, limit: 10 },
        f.context,
      );
      if (rows.kind !== 'listed' || rows.entries.length !== 1)
        throw Error('actual completed outbox prerequisite');
      if (projection === 'lagging') {
        const { hash } = await import('../encoding.js');
        for (const entry of rows.entries)
          await f.storage.execute(
            operation({
              type: 'acknowledge',
              key,
              projectionId: entry.id,
              projectionDigest: hash(entry),
            }),
            f.context,
          );
      } else if (projection === 'drained') {
        if (kind === 'sqlite')
          await drainModelOutbox(f.storage, sink, key, f.context);
        else {
          const { hash } = await import('../encoding.js');
          for (const entry of rows.entries)
            await f.storage.execute(
              operation({
                type: 'acknowledge',
                key,
                projectionId: entry.id,
                projectionDigest: hash(entry),
              }),
              f.context,
            );
        }
      }
      const finish = await f.storage.execute(
        operation({
          type: 'finish',
          key,
          expected: f.fence,
          status: 'completed',
        }),
        f.context,
      );
      if (finish.kind === 'refused')
        throw Error('real settlement prerequisite');
      vi.setSystemTime(epoch + 7 * 86400000 - 1);
      expect(await f.storage.execute(f.replay, f.context)).toEqual(f.replayed);
      expect(await f.storage.execute(f.savedOpen, f.context)).toMatchObject({
        kind: 'existing',
      });
      vi.setSystemTime(epoch + 7 * 86400000);
      const changed = { ...f.replay, requestId: 'conflicting' };
      expect(
        await f.storage.execute(
          { ...changed, digest: commandDigest(changed) },
          f.context,
        ),
      ).toEqual({ kind: 'refused', reason: 'conflict' });
      expect.soft(await f.storage.execute(f.replay, f.context)).toEqual({
        kind: 'refused',
        reason: 'expired',
      });
      expect.soft(await f.storage.execute(f.savedOpen, f.context)).toEqual({
        kind: 'refused',
        reason: 'expired',
      });
      if (kind === 'sqlite' && projection !== 'drained') {
        expect(
          f.database
            .prepare('SELECT count(*) AS n FROM agent_runtime_runs')
            .get()?.n,
        ).toBe(1);
        expect(await f.bodies.read(f.tape)).toBeInstanceOf(Uint8Array);
        if (projection === 'unacked')
          await drainModelOutbox(f.storage, sink, key, f.context);
        else for (const entry of rows.entries) await sink.apply(entry);
        expect(await sink.readAudit(key)).toHaveLength(1);
      }
    });
