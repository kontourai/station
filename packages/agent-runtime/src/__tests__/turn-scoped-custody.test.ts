import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  auditSqliteAgentJournal,
  createAgentRuntime,
  openSqliteAgentJournal,
} from '../index.js';
import { agentWire } from '../internal.js';
import { nextOwner, owner } from './fixture.js';
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

for (const change of ['format', 'state'] as const) {
  it(`participant ${change === 'format' ? 'JSON formatting preserves the logical receipt' : 'state changes cannot replace the expected effect receipt'}`, async () => {
    const f = await turnFixture();
    cleanup.push(() => f.close());
    const journal = openSqliteAgentJournal({
      database: f.database,
      participants: [
        {
          name: 'effect-receipt-control',
          commit({ command }, database) {
            if (command.type !== 'effectPlan') return;
            const row = database
              .prepare('SELECT record FROM agent_steps_effects WHERE id=?')
              .get(command.intent.id);
            const effect = JSON.parse(String(row?.record));
            if (change === 'state') effect.state = 'indeterminate';
            database
              .prepare('UPDATE agent_steps_effects SET record=? WHERE id=?')
              .run(JSON.stringify(effect, null, 2), command.intent.id);
          },
        },
      ],
    });
    cleanup.push(() => journal.close());
    const runtime = createAgentRuntime({
      journal,
      owner,
      liveness: f.liveness,
      implementation: 'callback/1',
    });
    const lease = await runtime.start({
      key: { ...f.key, conversationId: 'callback' },
      input: 'input',
      implementation: 'callback/1',
    });
    let calls = 0;
    const result = lease.tool(
      { id: 'tool:callback', input: agentWire('input'), replay: 'unsafe' },
      async () => ++calls,
    );
    if (change === 'state') {
      await expect(result).rejects.toThrow('PARTICIPANT_CHANGED_STATE');
      expect(calls).toBe(0);
    } else {
      expect(await result).toBe(1);
      expect(calls).toBe(1);
    }
  });
}
