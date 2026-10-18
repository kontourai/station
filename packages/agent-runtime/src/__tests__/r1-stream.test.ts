import { afterEach, expect, it } from 'vitest';
import { deferred, nativeOptions, runtimeFixture } from './r1-fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

for (const change of ['revoke', 'writer', 'cancel'] as const)
  it(`R1.4 final body read ${change} refuses provider after a real begin grant`, async () => {
    const entered = deferred();
    const release = deferred();
    let begun = false;
    let held = false;
    const f = await runtimeFixture({
      storage(s) {
        return {
          async execute(c, ctx) {
            const answer = await s.execute(c, ctx);
            if (c.type === 'begin' && answer.kind === 'execute') begun = true;
            return answer;
          },
          close: () => s.close(),
        };
      },
      bodies(b) {
        return {
          put: b.put,
          async read(ref) {
            if (begun && !held && ref.codec === 'runtime-ai-sdk-v3-request/1') {
              held = true;
              entered.resolve();
              await release.promise;
            }
            return b.read(ref);
          },
        };
      },
    });
    cleanup.push(() => f.close());
    const operation = f.control
      .run(() => Promise.resolve(f.guarded.doStream(nativeOptions)))
      .then(
        () => 'dispatched',
        () => 'refused',
      );
    await entered.promise;
    let cancellation: Promise<void> | undefined;
    if (change === 'revoke') f.revoke();
    else if (change === 'writer') f.changeWriter();
    else cancellation = f.control.cancel();
    release.resolve();
    expect(await operation).toBe('refused');
    expect(f.calls).toHaveLength(0);
    if (cancellation) await cancellation;
  });
it('R1.3 cancel wins before EOF and quiesces the consumer without completed evidence', async () => {
  const f = await runtimeFixture({
    stream(c) {
      c.enqueue({ type: 'stream-start', warnings: [] });
    },
  });
  cleanup.push(() => f.close());
  const observed: string[] = [];
  const waiting = deferred();
  const consumed = f.control
    .run(async () => {
      const { stream } = await f.guarded.doStream(nativeOptions);
      const reader = stream.getReader();
      const first = await reader.read();
      observed.push(first.value!.type);
      waiting.resolve();
      return reader.read();
    })
    .then(
      () => 'completed',
      () => 'cancelled',
    );
  await waiting.promise;
  await f.control.cancel();
  expect(await consumed).toBe('cancelled');
  expect(observed).toEqual(['stream-start']);
  expect(
    await f.storage.execute(
      { type: 'listOutbox', key: f.entry.key, limit: 10 },
      f.context,
    ),
  ).toMatchObject({ entries: [{ kind: 'partial' }, { kind: 'aborted' }] });
});
it('R1.3 committed complete wins the race but public cancel withholds held finish and settles native callbacks', async () => {
  const committed = deferred();
  const release = deferred();
  const f = await runtimeFixture({
    storage(s) {
      return {
        async execute(c, ctx) {
          const result = await s.execute(c, ctx);
          if (c.type === 'complete' && result.kind !== 'refused') {
            committed.resolve();
            await release.promise;
          }
          return result;
        },
        close: () => s.close(),
      };
    },
  });
  cleanup.push(() => f.close());
  const observed: string[] = [];
  const consumed = f.control
    .run(async () => {
      const { stream } = await f.guarded.doStream(nativeOptions);
      const reader = stream.getReader();
      while (true) {
        const item = await reader.read();
        if (item.done) return 'eof';
        observed.push(item.value.type);
      }
    })
    .then(
      () => 'completed',
      () => 'cancelled',
    );
  await committed.promise;
  const cancelled = f.control.cancel();
  release.resolve();
  await cancelled;
  expect(await consumed).toBe('cancelled');
  expect(observed).not.toContain('finish');
  expect(
    await f.storage.execute({ type: 'read', key: f.entry.key }, f.context),
  ).toMatchObject({ snapshot: { state: 'cancelled' } });
  expect(
    await f.storage.execute(
      { type: 'listOutbox', key: f.entry.key, limit: 10 },
      f.context,
    ),
  ).toMatchObject({
    entries: expect.arrayContaining([
      expect.objectContaining({ kind: 'completed' }),
    ]),
  });
});
