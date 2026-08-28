/**
 * @vitest-environment jsdom
 *
 * archive#3354 — the highlight worker pool: result resolution, the wedge
 * timeout that recycles a hung worker, and the two properties the pool's
 * docstring claims and the first cut did not have — a wedge takes down only
 * its own request (no cascade through co-scheduled work), and the deadline
 * measures a worker's service time rather than time spent queued.
 */
import { describe, expect, test, vi } from 'vitest';
import type { HighlightWorkerLike } from '../highlight/highlight-client';
import {
  HighlightWorkerPool,
  withWorkerErrorFallback,
} from '../highlight/highlight-client';

interface FakeWorker extends HighlightWorkerLike {
// Test fake dispatches bare payload objects as MessageEvents.
  messages: unknown[];
  terminated: boolean;
  respond(id: number, html: string): void;
  fail(id: number, error: string): void;
}

/**
* @param options.auto  workers answer every post in a microtask, EXCEPT the
*                      creation indexes listed in `wedged`, which never
*                      answer at all. Without it every worker is manual and
*                      the test drives `respond`/`fail` itself.
 */
function fakeWorkerFactory(
  options: { auto?: boolean; wedged?: number[] } = {},
) {
  const workers: FakeWorker[] = [];
  const factory = () => {
    const creationIndex = workers.length;
    const wedged = options.wedged?.includes(creationIndex) ?? false;
    const worker: FakeWorker = {
      messages: [],
      terminated: false,
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      postMessage(msg: unknown) {
        this.messages.push(msg);
        if (!options.auto || wedged) return;
        const { id } = msg as { id: number };
        queueMicrotask(() => {
          if (this.terminated) return;
          this.respond(id, `<pre>${id}</pre>`);
        });
      },
      terminate() {
        this.terminated = true;
      },
      respond(id: number, html: string) {
        this.onmessage?.({ data: { id, html } } as MessageEvent);
      },
      fail(id: number, error: string) {
        this.onmessage?.({ data: { id, error } } as MessageEvent);
      },
    };
    workers.push(worker);
    return worker;
  };
  return { factory, workers };
}

const REQ_ID = (m: unknown) => (m as { id: number }).id;

describe('HighlightWorkerPool (station#3354)', () => {
  test('resolves highlight results from a worker', async () => {
    const { factory, workers } = fakeWorkerFactory();
    const pool = new HighlightWorkerPool(factory, 1000, 1);
    const promise = pool.highlight('const a = 1;', 'ts');
    const req = workers[0].messages[0];
    workers[0].respond(REQ_ID(req), '<pre>hl</pre>');
    await expect(promise).resolves.toBe('<pre>hl</pre>');
    pool.dispose();
  });

  test('the module default is a single worker', () => {
    const { factory, workers } = fakeWorkerFactory();
    const pool = new HighlightWorkerPool(factory);
    expect(workers.length).toBe(1);
    pool.dispose();
  });

  test('a wedged worker times out, is recycled, and the request rejects', async () => {
    vi.useFakeTimers();
    try {
      const { factory, workers } = fakeWorkerFactory();
      const pool = new HighlightWorkerPool(factory, 50, 2);
      const promise = pool.highlight('code', 'ts');
      const rejected = expect(promise).rejects.toThrow('wedged');
      await vi.advanceTimersByTimeAsync(60);
      await rejected;
// The hung worker was terminated and replaced…
      expect(workers[0].terminated).toBe(true);
      expect(workers.length).toBe(3); // 2 initial + 1 replacement
// …and the fresh worker still serves new requests.
      const next = pool.highlight('more', 'ts');
      const fresh = workers.find((w) => !w.terminated && w.messages.length);
      fresh?.respond(REQ_ID(fresh.messages[0]), '<pre>ok</pre>');
      await expect(next).resolves.toBe('<pre>ok</pre>');
      pool.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test('a worker error message rejects without recycling', async () => {
    const { factory, workers } = fakeWorkerFactory();
    const pool = new HighlightWorkerPool(factory, 1000, 2);
    const promise = pool.highlight('code', 'ts');
    const rejected = expect(promise).rejects.toThrow('boom');
    workers[0].fail(REQ_ID(workers[0].messages[0]), 'boom');
    await rejected;
    expect(workers[0].terminated).toBe(false);
    expect(workers.length).toBe(2);
    pool.dispose();
  });

  test('late responses from a recycled worker are ignored', async () => {
    vi.useFakeTimers();
    try {
      const { factory, workers } = fakeWorkerFactory();
      const pool = new HighlightWorkerPool(factory, 50, 2);
      const timedOut = expect(pool.highlight('code', 'ts')).rejects.toThrow(
        'wedged',
      );
      await vi.advanceTimersByTimeAsync(60);
      await timedOut;
// The wedged worker finally answers after it was terminated — its
// onmessage is detached, so this must be a no-op (no unhandled
// rejection, no crash).
      const staleId = REQ_ID(workers[0].messages[0]);
      expect(workers[0].onmessage).toBeNull();
      workers[0].onmessage?.({
        data: { id: staleId, html: '<pre>late</pre>' },
      } as MessageEvent);
      pool.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a wedge does not cascade (station#3354 review HIGH-1)', () => {
  test('healthy co-scheduled requests survive a wedged worker', async () => {
// The review's repro: pool of 2, six requests, only worker 0 wedged.
// The first cut terminated THREE workers and rejected three requests —
// two of them healthy work that had merely been round-robined onto the
// dead slot, each firing its own timeout and destroying the freshly
// spawned replacement in turn.
    vi.useFakeTimers();
    try {
      const { factory, workers } = fakeWorkerFactory({
        auto: true,
        wedged: [0],
      });
      const pool = new HighlightWorkerPool(factory, 50, 2);
      const outcomes = ['A', 'B', 'C', 'D', 'E', 'F'].map((code) =>
        pool.highlight(code, 'ts').then(
          () => 'RESOLVED',
          () => 'REJECTED',
        ),
      );
      await vi.advanceTimersByTimeAsync(60);
      expect(await Promise.all(outcomes)).toEqual([
        'REJECTED',
        'RESOLVED',
        'RESOLVED',
        'RESOLVED',
        'RESOLVED',
        'RESOLVED',
      ]);
      expect(workers.filter((w) => w.terminated).length).toBe(1);
      expect(workers.length).toBe(3); // 2 initial + 1 replacement
      pool.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test('a request queued behind a wedge is served by the replacement', async () => {
// One worker, two requests. A wedges; B must not be left bound to the
// terminated worker (where its own timeout would recycle the slot again
// and orphan whatever the replacement had just been handed).
    vi.useFakeTimers();
    try {
      const { factory, workers } = fakeWorkerFactory({
        auto: true,
        wedged: [0],
      });
      const pool = new HighlightWorkerPool(factory, 50, 1);
      const a = pool.highlight('A', 'ts').then(
        () => 'RESOLVED',
        (err: Error) => `REJECTED:${err.message}`,
      );
      const b = pool.highlight('B', 'ts').then(
        () => 'RESOLVED',
        () => 'REJECTED',
      );
      await vi.advanceTimersByTimeAsync(60);

      expect(workers.length).toBe(2); // 1 initial + 1 replacement
      expect(workers[0].terminated).toBe(true);
// The replacement actually received the queued request. Asserted
// BEFORE awaiting `b`, so a slot that never re-pumps its queue fails
// here by name instead of hanging the test out to its timeout.
      expect(workers[1].messages.length).toBe(1);
      expect(await a).toMatch(/^REJECTED:highlight worker wedged/);
      expect(await b).toBe('RESOLVED');
// …and no orphaned timer comes back to kill it.
      await vi.advanceTimersByTimeAsync(500);
      expect(workers[1].terminated).toBe(false);
      expect(workers.length).toBe(2);
      pool.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test('the deadline measures service time, not queue wait', async () => {
// Two blocks, one worker, a 50ms budget. The first takes 40ms; the
// second must get its own 50ms from the moment it reaches the worker,
// not the 10ms left over from when the caller asked for it. Arming the
// timer at request time gave every block mounted in one commit a single
// shared deadline.
    vi.useFakeTimers();
    try {
      const { factory, workers } = fakeWorkerFactory();
      const pool = new HighlightWorkerPool(factory, 50, 1);
      const first = pool.highlight('A', 'ts');
      const second = pool.highlight('B', 'ts');
// Only A is with the worker; B is still queued and holds no timer.
      expect(workers[0].messages.length).toBe(1);

      await vi.advanceTimersByTimeAsync(40);
      workers[0].respond(REQ_ID(workers[0].messages[0]), '<pre>a</pre>');
      await expect(first).resolves.toBe('<pre>a</pre>');

// B has only just been dispatched: 40ms more is still inside ITS budget.
      await vi.advanceTimersByTimeAsync(40);
      expect(workers[0].terminated).toBe(false);
      workers[0].respond(REQ_ID(workers[0].messages[1]), '<pre>b</pre>');
      await expect(second).resolves.toBe('<pre>b</pre>');
      pool.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('withWorkerErrorFallback (station#3354 review MEDIUM-3)', () => {
  test('a worker that dies asynchronously falls back to the main thread', async () => {
// A CSP `worker-src` refusal or a failed chunk fetch constructs fine and
// then emits `error`, answering nothing. Without this the request waited
// out a full timeout, rendered plain, and — because the client promise is
// memoised — every later block did the same, forever.
    const { factory, workers } = fakeWorkerFactory();
    const fallback = vi.fn(async (code: string) => `<main>${code}</main>`);
    const highlight = withWorkerErrorFallback(factory, fallback, 1000, 1);

    const inFlight = highlight('A', 'ts');
    workers[0].onerror?.(
      new ErrorEvent('error', { message: 'script load failed' }),
    );
    await expect(inFlight).resolves.toBe('<main>A</main>');

// Later requests skip the pool entirely: no timeout, no doomed respawn.
    await expect(highlight('B', 'ts')).resolves.toBe('<main>B</main>');
    expect(fallback).toHaveBeenCalledTimes(2);
    expect(workers.length).toBe(1);
    expect(workers[0].terminated).toBe(true);
  });

  test('every request QUEUED behind the failing worker also reaches the fallback', async () => {
// The shape production actually takes: POOL_SIZE is 1, so a page with
// three streaming code blocks has one request at the worker and two in
// the queue. The worker then emits `error` (CSP `worker-src`, an offline
// chunk fetch) and `onWorkerError` disposes the pool. If `dispose` did
// not drain the queue, blocks 2 and 3 would never settle at all —
// `pump` early-returns on `disposed` and nothing re-pumps — so they
// would render plain <pre> forever, leak their promises, and never reach
// the main-thread fallback this wrapper exists to route them to.
    const { factory, workers } = fakeWorkerFactory();
    const fallback = vi.fn(async (code: string) => `<main>${code}</main>`);
    const highlight = withWorkerErrorFallback(factory, fallback, 10_000, 1);

    const settled: string[] = [];
    const outcomes = ['A', 'B', 'C'].map((code) =>
      highlight(code, 'ts').then(
        (html) => {
          settled.push(html);
          return html;
        },
        (err: Error) => {
          settled.push(`REJECTED:${err.message}`);
          return `REJECTED:${err.message}`;
        },
      ),
    );
// A is with the worker; B and C are QUEUED — without a queue this test
// would prove nothing beyond the single-request case above.
    expect(workers[0].messages.length).toBe(1);

    workers[0].onerror?.(
      new ErrorEvent('error', { message: 'script load failed' }),
    );
// One macrotask turn drains every microtask on these paths (the fallback
// is a resolved async function), so an unsettled request fails the count
// assertion by name rather than hanging the test out to its timeout.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled.length).toBe(3);

    expect(await Promise.all(outcomes)).toEqual([
      '<main>A</main>',
      '<main>B</main>',
      '<main>C</main>',
    ]);
    expect(fallback).toHaveBeenCalledTimes(3);
    expect(workers.length).toBe(1);
  });

  test('a messageerror degrades the same way', async () => {
    const { factory, workers } = fakeWorkerFactory();
    const fallback = vi.fn(async (code: string) => `<main>${code}</main>`);
    const highlight = withWorkerErrorFallback(factory, fallback, 1000, 1);
    const inFlight = highlight('A', 'ts');
    workers[0].onmessageerror?.(new MessageEvent('messageerror'));
    await expect(inFlight).resolves.toBe('<main>A</main>');
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  test('an ordinary wedge does NOT degrade to the main thread', async () => {
// A wedge is one slow request, not a broken runtime: the caller renders
// a plain <pre> and the pool keeps serving. Falling back here would put
// Shiki back on the main thread — the defect this PR exists to remove.
    vi.useFakeTimers();
    try {
      const { factory } = fakeWorkerFactory({ auto: true, wedged: [0] });
      const fallback = vi.fn(async () => '<main/>');
      const highlight = withWorkerErrorFallback(factory, fallback, 50, 1);
      const rejected = expect(highlight('A', 'ts')).rejects.toThrow('wedged');
      await vi.advanceTimersByTimeAsync(60);
      await rejected;
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
