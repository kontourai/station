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

for (const batched of [false, true])
  it(`late ${batched ? 'batched' : 'single'} publication waits for an in-flight settlement receipt instead of using its old fence`, async () => {
    const f = await setup();
    let entered!: () => void;
    let release!: () => void;
    const committed = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const acknowledged = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = f.crash.storage.execute.bind(f.crash.storage);
    f.crash.storage.execute = async (command, context) => {
      const answer = await execute(command, context);
      if (command.type === 'settle') {
        entered();
        await acknowledged;
      }
      return answer;
    };
    const ending = f.lease.run(async () => {});
    cleanup.push(async () => {
      release();
      await ending.catch(() => {});
    });
    await committed;
    const projected = (
      batched
        ? f.lease
            .frameBatch([
              { id: 'late-frame', wire: 'data: {"type":"finish"}\n\n' },
            ])
            .then((frames) => frames[0]!)
        : f.lease.frame('late-frame', 'data: {"type":"finish"}\n\n')
    ).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    release();
    await ending;
    expect(await projected).toMatchObject({
      value: { id: 'late-frame', wire: 'data: {"type":"finish"}\n\n' },
    });
  });

it('a frame batch rolls back as one prefix and restored frame IDs keep their receipts', async () => {
  const f = await setup();
  const frames = [
    { id: 'a', wire: 'data: {"text":"a"}\n\n' },
    { id: 'b', wire: 'data: {"text":"b"}\n\n' },
  ];
  f.crash.failNextCommit(new Error('frame-batch-rollback'));
  await expect(f.lease.frameBatch(frames)).rejects.toThrow(
    'frame-batch-rollback',
  );
  expect((await f.lease.frame('probe', 'data: {}\n\n')).position).toBe(0);
  const receipt = await f.lease.frameBatch(frames);
  expect(receipt.map((frame) => frame.position)).toEqual([1, 2]);
  expect(receipt.map((frame) => frame.wire)).toEqual(
    frames.map((frame) => frame.wire),
  );
  await f.crash.reopen();
  expect(await f.lease.frame('b', frames[1]!.wire)).toEqual(receipt[1]);
});
