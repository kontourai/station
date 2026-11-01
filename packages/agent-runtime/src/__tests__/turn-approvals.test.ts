import { afterEach, expect, it } from 'vitest';
import { gate, turnFixture } from './turn-fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const tool = {
  id: 'tool:delete',
  replay: 'unsafe' as const,
  input: { path: 'example.txt' },
};
it('pending approval survives a crash with its original deadline and resolves once before tool execution', async () => {
  const f = await turnFixture();
  cleanup.push(() => f.close());
  const firstAsked = gate();
  const firstAnswer = gate<boolean>();
  const old = f.lease.approval(tool, 100, async (pending) => {
    expect(pending.deadline).toBe(1_100);
    firstAsked.resolve();
    return firstAnswer.promise;
  });
  const oldFailure = old.then(
    () => undefined,
    (error) => error,
  );
  cleanup.push(async () => {
    firstAnswer.resolve(true);
    expect((await oldFailure)?.message).toContain('STALE');
  });
  await firstAsked.promise;
  f.advance(40);
  const restored = await f.recover();
  let effects = 0;
  await expect(restored.tool(tool, async () => ++effects)).rejects.toThrow(
    'BUSY',
  );
  expect(effects).toBe(0);
  const asked = gate();
  const answer = gate<boolean>();
  let resumedAsks = 0;
  let resumedPending: unknown;
  const approved = restored.approval(tool, 1_000, async (pending) => {
    resumedAsks++;
    resumedPending = pending;
    asked.resolve();
    return answer.promise;
  });
  await asked.promise;
  expect(resumedPending).toEqual({
    id: 'approval:tool:delete',
    deadline: 1_100,
    remainingMs: 60,
  });
  const duplicate = restored.approval(tool, 1_000, async () => {
    throw Error('Duplicate approval wait');
  });
  expect(resumedAsks).toBe(1);
  expect(effects).toBe(0);
  answer.resolve(true);
  expect(await approved).toBe(true);
  expect(await duplicate).toBe(true);
  expect(await restored.tool(tool, async () => ++effects)).toBe(1);
  expect(await restored.tool(tool, async () => ++effects)).toBe(1);
  expect(effects).toBe(1);
  await expect(
    restored.approvalCommand({
      type: 'approvalResolve',
      id: 'approval:tool:delete',
      expectedRevision: '0',
      decision: 'approved',
    }),
  ).rejects.toThrow('STALE');
  const row = JSON.parse(
    String(
      f.database.prepare('SELECT record FROM agent_steps_approvals').get()
        ?.record,
    ),
  );
  expect(row).toMatchObject({
    state: 'approved',
    revision: '1',
    deadline: 1_100,
  });
  firstAnswer.resolve(true);
  await oldFailure;
});

it('an approval deadline is absolute across restart and expiration never grants permission', async () => {
  const f = await turnFixture();
  cleanup.push(() => f.close());
  const asked = gate();
  const answer = gate<boolean>();
  const old = f.lease.approval(tool, 100, async () => {
    asked.resolve();
    return answer.promise;
  });
  const oldFailure = old.then(
    () => undefined,
    (error) => error,
  );
  cleanup.push(async () => {
    answer.resolve(true);
    expect((await oldFailure)?.message).toContain('STALE');
  });
  await asked.promise;
  f.advance(101);
  const restored = await f.recover();
  let asks = 0;
  expect(
    await restored.approval(tool, 10_000, async () => {
      asks++;
      return true;
    }),
  ).toBe(false);
  expect(asks).toBe(0);
  let effects = 0;
  await expect(restored.tool(tool, async () => ++effects)).rejects.toThrow(
    'BUSY',
  );
  expect(effects).toBe(0);
});

it('a failed approval-resolution commit remains pending and is asked again after restart', async () => {
  const f = await turnFixture();
  cleanup.push(() => f.close());
  const asked = gate();
  const answer = gate<boolean>();
  const pending = f.lease.approval(tool, 100, async () => {
    asked.resolve();
    return answer.promise;
  });
  const failure = expect(pending).rejects.toThrow(
    'approval-resolution-rollback',
  );
  await asked.promise;
  f.crash.failNextCommit(new Error('approval-resolution-rollback'));
  answer.resolve(true);
  await failure;
  expect(
    JSON.parse(
      String(
        f.database.prepare('SELECT record FROM agent_steps_approvals').get()
          ?.record,
      ),
    ),
  ).toMatchObject({ state: 'pending', revision: '0' });
  const restored = await f.recover();
  let asks = 0;
  expect(
    await restored.approval(tool, 1_000, async () => {
      asks++;
      return false;
    }),
  ).toBe(false);
  expect(asks).toBe(1);
});

it('an approved but unentered tool cannot start after its original approval deadline', async () => {
  const f = await turnFixture();
  cleanup.push(() => f.close());
  expect(await f.lease.approval(tool, 100, async () => true)).toBe(true);
  f.advance(101);
  const restored = await f.recover();
  expect(
    await restored.approval(tool, 1_000, async () => {
      throw Error('Deadline must not renew');
    }),
  ).toBe(false);
  let effects = 0;
  await expect(restored.tool(tool, async () => ++effects)).rejects.toThrow(
    'BUSY',
  );
  expect(effects).toBe(0);
});
