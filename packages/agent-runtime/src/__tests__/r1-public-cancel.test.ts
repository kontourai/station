import { afterEach, expect, it } from 'vitest';
import { nativeOptions, runtimeFixture } from './r1-fixture.js';

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
