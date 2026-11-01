import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { auditSqliteAgentJournal } from '../index.js';
import { nextOwner } from './fixture.js';
import { turnFixture } from './turn-fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
it('a damaged active header cannot hide a live conversation from new admission', async () => {
  const f = await turnFixture();
  cleanup.push(() => f.close());
  f.database.exec('UPDATE agent_steps_turns SET active=0');
  await expect(
    f.runtime.start({
      key: { ...f.key, invocationId: 'racing' },
      input: 'new',
      implementation: 'station-agent/1',
    }),
  ).rejects.toThrow('JOURNAL_DAMAGED');
  f.database.exec('UPDATE agent_steps_turns SET active=1');
  await f.lease.assertCurrent();
});
it('a liveness callback cannot replace ownership facts inside a takeover transaction', async () => {
  const f = await turnFixture();
  cleanup.push(() => f.close());
  const read = await f.crash.storage.execute(
    { type: 'read', key: f.key },
    { liveness: f.liveness },
  );
  if (read.kind !== 'owned') throw Error('real ownership prerequisite');
  const before = f.database
    .prepare('SELECT record,active FROM agent_steps_turns')
    .get();
  await expect(
    f.crash.storage.execute(
      {
        type: 'claim',
        key: f.key,
        expected: read.turn.fence,
        owner: nextOwner,
      },
      {
        liveness: () => {
          f.database.exec('UPDATE agent_steps_turns SET active=0');
          return 'dead';
        },
      },
    ),
  ).rejects.toThrow('LIVENESS_CHANGED_STATE');
  expect(
    f.database.prepare('SELECT record,active FROM agent_steps_turns').get(),
  ).toEqual(before);
});
it('settled damage stays outside an ongoing selected read and is diagnosed by the read-only complete audit', async () => {
  const f = await turnFixture();
  cleanup.push(() => f.close());
  await f.lease.run(async () => {});
  const next = await f.runtime.start({
    key: { ...f.key, invocationId: 'next' },
    input: 'new',
    implementation: 'station-agent/1',
  });
  const previous = f.database
    .prepare('SELECT id,record FROM agent_steps_turns WHERE active=0')
    .get();
  if (
    !previous ||
    typeof previous.id !== 'string' ||
    typeof previous.record !== 'string'
  )
    throw Error('real settled record prerequisite');
  f.database
    .prepare("UPDATE agent_steps_turns SET record='{}' WHERE id=?")
    .run(previous.id);
  await next.assertCurrent();
  const changes = f.database.prepare('SELECT total_changes() AS n').get()?.n;
  expect(() => auditSqliteAgentJournal({ database: f.database })).toThrow(
    z.ZodError,
  );
  expect(f.database.prepare('SELECT total_changes() AS n').get()?.n).toBe(
    changes,
  );
  f.database
    .prepare('UPDATE agent_steps_turns SET record=? WHERE id=?')
    .run(previous.record, previous.id);
  expect(auditSqliteAgentJournal({ database: f.database })).toEqual({
    turns: 2,
    effects: 0,
    approvals: 0,
  });
});
