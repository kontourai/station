import { mkdtempDisposableSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openAtomicCrashPointStore } from '@kontourai/monument/testing';
import { afterEach, expect, it } from 'vitest';
import {
  type AgentJournalContext,
  type AgentJournalProtocol,
  createAgentRuntime,
  openSqliteAgentJournal,
} from '../index.js';
import { key, nextOwner, owner } from './fixture.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup() {
  const dir = mkdtempDisposableSync(join(tmpdir(), 'agent-owner-'));
  cleanup.push(() => dir.remove());
  const database = new DatabaseSync(join(dir.path, 'agent.sqlite'));
  database.exec(
    'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;',
  );
  cleanup.push(() => database.close());
  const crash = await openAtomicCrashPointStore<
    AgentJournalProtocol,
    AgentJournalContext,
    DatabaseSync
  >({
    async open(options) {
      return openSqliteAgentJournal({
        database,
        participants: options?.participants,
      });
    },
    async dispose() {},
  });
  cleanup.push(() => crash.dispose());
  let dead = false;
  const liveness = (candidate: { id: string }) =>
    candidate.id === owner.id && dead ? ('dead' as const) : ('live' as const);
  const first = createAgentRuntime({
    journal: crash.storage,
    owner,
    liveness,
    implementation: 'station-agent/1',
  });
  const lease = await first.start({
    key,
    implementation: 'station-agent/1',
    input: '{"input":"hello"}',
  });
  let ownerSequence = 0;
  const successor = () =>
    createAgentRuntime({
      journal: crash.storage,
      owner: { ...nextOwner, id: `successor-${++ownerSequence}` },
      liveness,
      implementation: 'station-agent/1',
    });
  return {
    crash,
    lease,
    successor,
    kill: () => {
      dead = true;
    },
    liveness,
  };
}

it('a dead owner is fenced before recovery effects; live and unknown owners cannot be taken over', async () => {
  const f = await setup();
  expect(await f.successor().recover(key)).toBe('retry');
  const unknown = createAgentRuntime({
    journal: f.crash.storage,
    owner: nextOwner,
    liveness: () => 'unknown',
    implementation: 'station-agent/1',
  });
  expect(await unknown.recover(key)).toBe('retry');
  f.kill();
  await f.crash.reopen();
  const recovered = await f.successor().recover(key);
  if (typeof recovered === 'string') throw Error('real takeover prerequisite');
  await expect(f.lease.assertCurrent()).rejects.toThrow('STALE_OWNER');
  let effects = 0;
  await recovered.run(async () => {
    await recovered.assertCurrent();
    effects++;
  });
  await expect(
    recovered.run(async () => {
      effects++;
    }),
  ).rejects.toThrow('DUPLICATE_CONSUMER');
  expect(effects).toBe(1);
});

it('two recovering owners race at the real journal and exactly one may execute', async () => {
  const f = await setup();
  f.kill();
  const held = f.crash.holdNextCommit();
  const losing = f.successor().recover(key);
  await held.entered;
  const winning = await f.successor().recover(key);
  held.release();
  expect(await losing).toBe('retry');
  if (typeof winning === 'string') throw Error('winning takeover prerequisite');
  let effects = 0;
  await winning.run(async () => {
    effects++;
  });
  expect(effects).toBe(1);
});

it('claim rollback grants no recovery authority and keeps the original committed owner', async () => {
  const f = await setup();
  f.kill();
  f.crash.failNextCommit(new Error('claim-rollback'));
  await expect(f.successor().recover(key)).rejects.toThrow('claim-rollback');
  const read = await f.crash.storage.execute(
    { type: 'read', key },
    { liveness: f.liveness },
  );
  expect(read.kind === 'owned' ? read.turn.fence.owner : read).toEqual(owner);
});
