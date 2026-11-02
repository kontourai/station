import { describe, expect, test } from 'vitest';
import { createLiveSurfaceStreamAdmission } from '../liveSurfaceStreamAdmission';

const A = 'http://127.0.0.1:4100/api/live-surfaces/a/frames';
const B = 'http://127.0.0.1:4100/api/live-surfaces/b/frames';
const OTHER_ORIGIN = 'http://127.0.0.1:4200/api/live-surfaces/a/frames';

async function settle() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('frame-stream admission per origin (#2760)', () => {
  test('admits up to the cap, queues the rest in order, and wakes them on release', async () => {
    const admission = createLiveSurfaceStreamAdmission(2);
    const signal = new AbortController().signal;
    const first = await admission.admit(A, signal);
    const second = await admission.admit(B, signal);
    const order: string[] = [];
    let queued = 0;
    const third = admission
      .admit(A, signal, () => (queued += 1))
      .then((release) => {
        order.push('third');
        return release;
      });
    const fourth = admission
      .admit(B, signal, () => (queued += 1))
      .then((release) => {
        order.push('fourth');
        return release;
      });
    await settle();
    expect(queued).toBe(2);
    expect(order).toEqual([]);
    first!();
    first!(); // a second release is a no-op, not a second slot
    await settle();
    expect(order).toEqual(['third']);
    second!();
    await settle();
    expect(order).toEqual(['third', 'fourth']);
    (await third)!();
    (await fourth)!();
  });

  test('another origin has its own slots', async () => {
    const admission = createLiveSurfaceStreamAdmission(1);
    const signal = new AbortController().signal;
    await admission.admit(A, signal);
    expect(await admission.admit(OTHER_ORIGIN, signal)).toEqual(
      expect.any(Function),
    );
  });

  test('an aborted waiter leaves the queue and never takes a slot', async () => {
    const admission = createLiveSurfaceStreamAdmission(1);
    const held = await admission.admit(A, new AbortController().signal);
    const gone = new AbortController();
    const abandoned = admission.admit(B, gone.signal);
    const next = admission.admit(B, new AbortController().signal);
    gone.abort();
    expect(await abandoned).toBeNull();
    held!();
    expect(await next).toEqual(expect.any(Function));
  });
});
