import { afterEach, expect, it } from 'vitest';
import { deferred, nativeOptions, runtimeFixture } from './r1-fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});
it('R1.3 public cancel settles an already pending downstream read before acknowledging cancelled', async () => {
  let prefix!: ReadableStreamDefaultController<
    import('@ai-sdk/provider').LanguageModelV3StreamPart
  >;
  const f = await runtimeFixture({
    stream(c) {
      prefix = c;
    },
  });
  cleanup.push(() => f.close());
  const response = await f.control.run(() =>
    Promise.resolve(f.guarded.doStream(nativeOptions)),
  );
  const reader = response.stream.getReader();
  let settled = false;
  const pending = reader.read().then(
    () => {
      settled = true;
      return 'eof';
    },
    () => {
      settled = true;
      return 'cancelled';
    },
  );
  await f.control.cancel();
  expect(f.upstreamCancelled).toBe(true);
  expect(settled).toBe(true);
  expect(await pending).toBe('cancelled');
  expect(
    await f.storage.execute({ type: 'read', key: f.entry.key }, f.context),
  ).toMatchObject({ snapshot: { state: 'cancelled' } });
  void prefix;
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
