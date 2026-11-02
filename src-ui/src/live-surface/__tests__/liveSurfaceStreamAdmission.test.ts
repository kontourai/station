import { describe, expect, test } from 'vitest';
import { createLiveSurfaceStreamAdmission } from '../liveSurfaceStreamAdmission';

const A = 'http://127.0.0.1:4100/api/live-surfaces/a/frames';
const B = 'http://127.0.0.1:4100/api/live-surfaces/b/frames';
const OTHER_ORIGIN = 'http://127.0.0.1:4200/api/live-surfaces/a/frames';

async function settle() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('frame-stream admission per origin, per page without Web Locks (#2760)', () => {
  test('admits up to the cap, queues the rest in order, and wakes them on release', async () => {
    const admission = createLiveSurfaceStreamAdmission(2, null);
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
    const admission = createLiveSurfaceStreamAdmission(1, null);
    const signal = new AbortController().signal;
    await admission.admit(A, signal);
    expect(await admission.admit(OTHER_ORIGIN, signal)).toEqual(
      expect.any(Function),
    );
  });

  test('an aborted waiter leaves the queue and never takes a slot', async () => {
    const admission = createLiveSurfaceStreamAdmission(1, null);
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

describe('frame-stream admission across tabs with Web Locks (#2760)', () => {
  // Node's navigator.locks is a real Web Locks implementation; two admission
  // instances over it stand in for two tabs of one browser profile. Each test
  // uses its own origin, so lock names never collide between tests.
  const locks = globalThis.navigator.locks;
  let port = 5100;
  const frames = () =>
    `http://127.0.0.1:${(port += 1)}/api/live-surfaces/a/frames`;

  test("two tabs share one origin's two slots, and a release admits the waiting tab", async () => {
    const url = frames();
    const tabA = createLiveSurfaceStreamAdmission(2, locks);
    const tabB = createLiveSurfaceStreamAdmission(2, locks);
    const signal = new AbortController().signal;
    const first = await tabA.admit(url, signal);
    const second = await tabB.admit(url, signal);
    expect(first).toEqual(expect.any(Function));
    expect(second).toEqual(expect.any(Function));
    let queued = 0;
    let third: (() => void) | null = null;
    const waiting = tabA
      .admit(url, signal, () => (queued += 1))
      .then((release) => {
        third = release;
      });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(queued).toBe(1);
    expect(third).toBeNull();
    second!();
    await waiting;
    expect(third).toEqual(expect.any(Function));
    first!();
    third!();
  });

  test('a tab that stops waiting withdraws from every slot and holds none', async () => {
    const url = frames();
    const tab = createLiveSurfaceStreamAdmission(1, locks);
    const other = createLiveSurfaceStreamAdmission(1, locks);
    const held = await tab.admit(url, new AbortController().signal);
    const gone = new AbortController();
    const abandoned = other.admit(url, gone.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    gone.abort();
    expect(await abandoned).toBeNull();
    held!();
    const next = await other.admit(url, new AbortController().signal);
    expect(next).toEqual(expect.any(Function));
    next!();
  });

  test('another origin has its own slots across tabs too', async () => {
    const tabA = createLiveSurfaceStreamAdmission(1, locks);
    const tabB = createLiveSurfaceStreamAdmission(1, locks);
    const signal = new AbortController().signal;
    const a = await tabA.admit(frames(), signal);
    const b = await tabB.admit(frames(), signal);
    expect([a, b]).toEqual([expect.any(Function), expect.any(Function)]);
    a!();
    b!();
  });
});
