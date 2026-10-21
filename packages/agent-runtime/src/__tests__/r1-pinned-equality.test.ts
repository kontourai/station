import { afterEach, expect, it } from 'vitest';
import { runtimeFixture } from './r1-fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});
it('retained native pin equality independently refuses changed stored request after authoritative entry restore', async () => {
  const { createModelRuntime } = await import('../index.js');
  const { requestBytes } = await import('../ai-sdk.js');
  const { createDurableVoltConsumer } = await import('../voltagent.js');
  const { operation, owner, nextOwner } = await import('./fixture.js');
  const f = await runtimeFixture();
  cleanup.push(() => f.close());
  const request = await f.bodies.put(
    'runtime-ai-sdk-v3-request/1',
    requestBytes({
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'INCOMPATIBLE-PIN' }] },
      ],
    }),
  );
  const pin = {
    requestId: 'retained-pin',
    ordinal: 0,
    entryDigest: f.entry.entry.body.digest,
    previousResponseDigest: null,
    request,
  };
  const pinned = await f.storage.execute(
    operation({ type: 'pin', key: f.entry.key, expected: f.entry.fence, pin }),
    f.context,
  );
  if (pinned.kind === 'refused') throw Error('actual stored pin prerequisite');
  const runtime = createModelRuntime({
    storage: f.storage,
    bodies: f.bodies,
    admission: f.host,
    liveness: (o) => (o.id === owner.id ? 'dead' : 'live'),
  });
  const entry = await runtime.restore({
    key: f.entry.key,
    observed: pinned.fence,
    owner: nextOwner,
    admission: f.admission,
  });
  const consumer = createDurableVoltConsumer({
    runtime,
    entry,
    model: f.model,
  });
  await consumer.control
    .run(async () => {
      const r = await consumer.raw.streamText([
        {
          id: 'user',
          role: 'user',
          parts: [{ type: 'text', text: 'COMPOSED-A' }],
        },
      ]);
      for await (const _ of r.fullStream) {
      }
    })
    .catch(() => {});
  expect(f.calls).toHaveLength(0);
});
