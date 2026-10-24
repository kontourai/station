import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { KernelCommand, KernelResult } from '../commands.js';
import { openSqliteKernelStorage } from '../sqlite.js';
import {
  createFakeProcessTable,
  createSqliteKernelLocation,
} from '../testing/index.js';

const intent = {
  invocationId: 'invocation',
  inputDigest: 'input',
  intentDigest: 'envelope',
  bodyRef: 'host:retained-body',
  dedupKey: 'key',
} as const;
for (const via of ['execute', 'executeSync'] as const) {
  for (const type of [
    'turnBoundary.cancelPrepared',
    'turnBoundary.recordDefinitiveRefusal',
  ] as const) {
    const refusal = type === 'turnBoundary.recordDefinitiveRefusal';
    describe(`${via} ${type}`, () => {
      async function fixture() {
        const location = createSqliteKernelLocation();
        const db = new DatabaseSync(location.path);
        const storage = openSqliteKernelStorage({ database: db });
        const processes = createFakeProcessTable();
        const owner = processes.spawn();
        const dedupOwner = processes.spawn();
        const context = { liveness: processes.liveness };
        const run = async <C extends KernelCommand>(
          command: C,
        ): Promise<KernelResult<C>> =>
          via === 'executeSync'
            ? storage.executeSync(command, context)
            : storage.execute(command, context);
        db.exec(
          "CREATE TABLE host_intent_body (ref TEXT PRIMARY KEY, bytes TEXT); INSERT INTO host_intent_body VALUES ('host:retained-body','exact retained bytes')",
        );
        expect(
          await run({
            type: 'turnDedup.claim',
            key: 'key',
            owner: dedupOwner,
            tracking: 'tracked',
            now: 1,
          }),
        ).toEqual({ kind: 'claimed', reclaimed: false });
        expect(
          await run({
            type: 'turnBoundary.create',
            boundaryId: 'boundary',
            threadId: 'thread',
            purpose: 'turn',
            state: 'reserved',
            owner,
            now: '1',
          }),
        ).toEqual({ kind: 'applied' });
        expect(
          await run({
            type: 'turnBoundary.prepare',
            boundaryId: 'boundary',
            ownerId: owner.id,
            dedupOwnerId: dedupOwner.id,
            intent,
            now: '2',
          }),
        ).toEqual({ kind: 'applied' });
        if (refusal)
          expect(
            await run({
              type: 'turnBoundary.beginInvocation',
              boundaryId: 'boundary',
              ownerId: owner.id,
              dedupOwnerId: dedupOwner.id,
              intent,
              now: '3',
            }),
          ).toEqual({ kind: 'applied' });
        const command = {
          type,
          boundaryId: 'boundary',
          intent,
          settlementId: 'settlement',
          now: '4',
          boundary: { owner, createdAt: '1', updatedAt: refusal ? '3' : '2' },
          dedup: { owner: dedupOwner, createdAt: 1, updatedAt: '2' },
        } as const;
        const snapshot = () => ({
          boundary: db.prepare('SELECT * FROM monument_turn_boundaries').get(),
          dedup: db.prepare('SELECT * FROM monument_turn_dedup').get(),
          body: db.prepare('SELECT * FROM host_intent_body').get(),
        });
        return {
          location,
          db,
          storage,
          processes,
          owner,
          dedupOwner,
          context,
          run,
          command,
          snapshot,
          async close() {
            await storage.close();
            db.close();
            await location.dispose();
          },
        };
      }
      it('rolls back both settlement writes after the first write and preserves the host body through reopen', async () => {
        const f = await fixture();
        try {
          const before = f.snapshot();
          f.db.exec(`CREATE TRIGGER fail_settlement BEFORE UPDATE ON monument_turn_boundaries
            WHEN NEW.state = 'settled' BEGIN
            SELECT CASE WHEN json_extract((SELECT owner_json FROM monument_turn_dedup WHERE dedup_key = 'key'), '$.settlement.id') IS NOT 'settlement'
              THEN RAISE(ABORT, 'dedup settlement write not reached') END;
            SELECT RAISE(ABORT, 'failure after dedup settlement write'); END;`);
          await expect(f.run(f.command)).rejects.toThrow(
            'failure after dedup settlement write',
          );
          expect(f.snapshot()).toEqual(before);
          f.db.exec('DROP TRIGGER fail_settlement');
          expect(await f.run(f.command)).toEqual({ kind: 'applied' });
          await f.storage.close();
          const reopened = openSqliteKernelStorage({ path: f.location.path });
          try {
            expect(await reopened.execute(f.command, f.context)).toEqual({
              kind: 'applied',
            });
            expect(
              await reopened.execute(
                { type: 'turnBoundary.hasPossibleEffect', threadId: 'thread' },
                f.context,
              ),
            ).toEqual({ kind: 'available', active: false });
            expect(
              await reopened.execute({ type: 'turnBoundary.list' }, f.context),
            ).toMatchObject({
              kind: 'records',
              records: [
                {
                  state: 'settled',
                  intent,
                  settlement: {
                    id: 'settlement',
                    disposition: refusal ? 'definitively-refused' : 'cancelled',
                  },
                },
              ],
            });
          } finally {
            await reopened.close();
          }
          expect(f.db.prepare('SELECT * FROM host_intent_body').get()).toEqual({
            ref: 'host:retained-body',
            bytes: 'exact retained bytes',
          });
        } finally {
          await f.close();
        }
      });
      for (const corruption of [
        'unknown',
        'untracked',
        'opposite-stage',
        'resolved',
        'tombstone',
        'wrong-link',
        'partial-link',
        'missing',
      ] as const) {
        it(`refuses ${corruption} linked evidence without changing the boundary or body`, async () => {
          const f = await fixture();
          try {
            if (
              corruption === 'unknown' ||
              corruption === 'untracked' ||
              corruption === 'opposite-stage'
            )
              f.db
                .prepare(
                  "UPDATE monument_turn_dedup SET owner_json = json_set(owner_json, '$.invocation', ?)",
                )
                .run(
                  corruption === 'opposite-stage'
                    ? refusal
                      ? 'pending'
                      : 'begun'
                    : corruption === 'unknown'
                      ? 'future-tag'
                      : 'untracked',
                );
            if (corruption === 'resolved')
              f.db.exec("UPDATE monument_turn_dedup SET value='provider-turn'");
            if (corruption === 'tombstone')
              f.db.exec(
                "INSERT INTO monument_turn_dedup_expired VALUES ('key', 3)",
              );
            if (corruption === 'wrong-link')
              f.db.exec(
                "UPDATE monument_turn_dedup SET owner_json=json_set(owner_json,'$.preparedInvocationId','other')",
              );
            if (corruption === 'partial-link')
              f.db.exec(
                "UPDATE monument_turn_dedup SET owner_json=json_remove(owner_json,'$.preparedUpdatedAt')",
              );
            if (corruption === 'missing')
              f.db.exec('DELETE FROM monument_turn_dedup');
            const before = f.snapshot();
            if (corruption === 'partial-link')
              await expect(f.run(f.command)).rejects.toThrow(
                'Incomplete prepared invocation metadata',
              );
            else expect(await f.run(f.command)).toEqual({ kind: 'refused' });
            expect(f.snapshot()).toEqual(before);
          } finally {
            await f.close();
          }
        });
      }
    });
  }
}

it('requires an explicitly configured settlement column on bound hosts and keeps the legacy control usable', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(
    `CREATE TABLE host_boundary (boundary_id TEXT PRIMARY KEY,thread_id TEXT,state TEXT,purpose TEXT,provider_turn_id TEXT,owner_json TEXT,created_at TEXT,updated_at TEXT);`,
  );
  const storage = openSqliteKernelStorage({
    database: db,
    tables: {
      turnBoundary: {
        table: 'host_boundary',
        ownerEncoding: 'json',
        terminalFacts: 'kernel',
      },
      turnDedup: 'unused',
      requestKeys: 'unused',
      inbox: 'unused',
      steerReceipts: 'unused',
    },
  });
  const owner = {
    id: 'legacy-owner',
    pid: 1,
    identityKind: 'unverified',
  } as const;
  const context = { liveness: () => 'unknown' as const };
  try {
    expect(
      storage.executeSync(
        {
          type: 'turnBoundary.create',
          boundaryId: 'legacy',
          threadId: 'thread',
          state: 'prepared',
          purpose: 'turn',
          owner,
          now: '1',
        },
        context,
      ),
    ).toEqual({ kind: 'applied' });
    const { dedupKey: _, ...keyless } = intent;
    expect(() =>
      storage.executeSync(
        {
          type: 'turnBoundary.cancelPrepared',
          boundaryId: 'legacy',
          intent: keyless,
          settlementId: 's',
          now: '2',
          boundary: { owner, createdAt: '1', updatedAt: '1' },
        },
        context,
      ),
    ).toThrow('settlementColumn');
    expect(
      storage.executeSync(
        {
          type: 'turnBoundary.remove',
          boundaryId: 'legacy',
          ownerId: owner.id,
          from: ['prepared'],
        },
        context,
      ),
    ).toEqual({ kind: 'applied' });
  } finally {
    await storage.close();
    db.close();
  }
});
