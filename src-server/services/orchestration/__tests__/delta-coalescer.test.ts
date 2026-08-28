import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test, vi } from 'vitest';
import { DeltaCoalescer } from '../delta-coalescer.js';

/**
 * archive#3350. The invariant these tests exist for is ORDER: a buffered delta
 * must never surface after an event that happened later, or a tool call, an
 * approval or a turn boundary lands in the wrong place in the transcript.
 *
 * The second standing property is that the FIRST delta of a run of text is
 * never held, so nothing here changes time-to-first-token.
 */

function delta(
  threadId: string,
  text: string,
  extra: Record<string, unknown> = {},
): CanonicalRuntimeEvent {
  return {
    method: 'content.text-delta',
    threadId,
    turnId: 'turn-1',
    itemId: 'item-1',
    delta: text,
    ...extra,
  } as unknown as CanonicalRuntimeEvent;
}

function other(threadId: string, method: string): CanonicalRuntimeEvent {
  return {
    method,
    threadId,
    turnId: 'turn-1',
  } as unknown as CanonicalRuntimeEvent;
}

function texts(events: CanonicalRuntimeEvent[]): string[] {
  return events.map((e) => (e as unknown as { delta: string }).delta);
}

/** A coalescer whose window never fires on its own, so tests drive the flushes. */
function manual() {
  const emitted: CanonicalRuntimeEvent[] = [];
  const coalescer = new DeltaCoalescer((event) => emitted.push(event), {
    windowMs: 1_000_000,
    setTimer: () => 'timer',
    clearTimer: () => {},
    logger: { warn: vi.fn() },
  });
  return { coalescer, emitted };
}

describe('DeltaCoalescer', () => {
  test('merges consecutive deltas after the first into one event carrying the joined text', () => {
    const { coalescer, emitted } = manual();

    // The first delta paints immediately; batching starts with the second.
    expect(coalescer.offer(delta('t1', 'Hel'))).toBe(true);
    expect(texts(emitted)).toEqual(['Hel']);
    expect(coalescer.offer(delta('t1', 'lo '))).toBe(true);
    expect(coalescer.offer(delta('t1', 'world'))).toBe(true);
    expect(emitted).toHaveLength(1);

    coalescer.flushAll();

    expect(texts(emitted)).toEqual(['Hel', 'lo world']);
  });

  test('the first delta of a run of text is published without waiting for the window', () => {
    const emitted: CanonicalRuntimeEvent[] = [];
    let scheduled = 0;
    const coalescer = new DeltaCoalescer((e) => emitted.push(e), {
      windowMs: 60,
      setTimer: () => {
        scheduled += 1;
        return 'timer';
      },
      clearTimer: () => {},
      logger: { warn: vi.fn() },
    });

    coalescer.offer(delta('t1', 'first'));

    // Not merely "emitted eventually": nothing was even scheduled, so
    // time-to-first-token is exactly what it was before this coalescer.
    expect(texts(emitted)).toEqual(['first']);
    expect(scheduled).toBe(0);
    expect(coalescer.pendingThreadCount()).toBe(0);

    coalescer.offer(delta('t1', '-second'));
    expect(scheduled).toBe(1);
    expect(texts(emitted)).toEqual(['first']);
    expect(coalescer.pendingThreadCount()).toBe(1);
  });

  test('a non-delta event flushes the buffer BEFORE it, preserving order', () => {
    const { coalescer, emitted } = manual();

    coalescer.offer(delta('t1', 'be'));
    coalescer.offer(delta('t1', 'fore'));
    expect(texts(emitted)).toEqual(['be']);
    // A tool call arriving mid-stream must not jump ahead of the text that
    // preceded it, which is the whole reason this is not a naive timer.
    expect(coalescer.offer(other('t1', 'tool.started'))).toBe(false);

    expect(texts(emitted)).toEqual(['be', 'fore']);
  });

  test('a turn boundary flushes rather than swallowing trailing text', () => {
    const { coalescer, emitted } = manual();

    coalescer.offer(delta('t1', 'the last '));
    coalescer.offer(delta('t1', 'words'));
    expect(coalescer.offer(other('t1', 'turn.completed'))).toBe(false);

    expect(texts(emitted)).toEqual(['the last ', 'words']);
  });

  test('threads never merge into one another', () => {
    const { coalescer, emitted } = manual();

    coalescer.offer(delta('t1', 'alpha'));
    coalescer.offer(delta('t2', 'beta'));
    coalescer.offer(delta('t1', '-one'));
    coalescer.offer(delta('t2', '-two'));
    coalescer.flushAll();

    const byThread: Record<string, string> = {};
    for (const event of emitted) {
      byThread[event.threadId] =
        (byThread[event.threadId] ?? '') +
        (event as unknown as { delta: string }).delta;
    }
    expect(byThread).toEqual({ t1: 'alpha-one', t2: 'beta-two' });
  });

  test('a new turn does not concatenate onto the previous turn’s text', () => {
    const { coalescer, emitted } = manual();

    coalescer.offer(delta('t1', 'first turn'));
    coalescer.offer(delta('t1', ' more'));
    coalescer.offer(delta('t1', 'second turn', { turnId: 'turn-2' }));
    coalescer.flushAll();

    expect(texts(emitted)).toEqual(['first turn', ' more', 'second turn']);
  });

  test('reasoning and text deltas are separate streams', () => {
    const { coalescer, emitted } = manual();

    coalescer.offer(delta('t1', 'answer'));
    coalescer.offer(
      delta('t1', 'thinking', { method: 'content.reasoning-delta' }),
    );
    coalescer.flushAll();

    expect(emitted).toHaveLength(2);
    expect(emitted.map((e) => e.method)).toEqual([
      'content.text-delta',
      'content.reasoning-delta',
    ]);
  });

  test('deltas from different items never merge, so a merged itemId is never a lie', () => {
    const { coalescer, emitted } = manual();

    coalescer.offer(delta('t1', 'a1', { itemId: 'item-a' }));
    coalescer.offer(delta('t1', 'a2', { itemId: 'item-a' }));
    // `itemId` is a required field of both delta types and adapters populate
    // it meaningfully, so a merged event must never stamp one item's id onto
    // text that spans several.
    coalescer.offer(delta('t1', 'b1', { itemId: 'item-b' }));
    coalescer.offer(delta('t1', 'b2', { itemId: 'item-b' }));
    coalescer.flushAll();

    expect(
      emitted.map((e) => [
        (e as unknown as { itemId: string }).itemId,
        (e as unknown as { delta: string }).delta,
      ]),
    ).toEqual([
      ['item-a', 'a1'],
      ['item-a', 'a2'],
      ['item-b', 'b1'],
      ['item-b', 'b2'],
    ]);
  });

  test('a burst flushes on the size cap instead of building one huge event', () => {
    const emitted: CanonicalRuntimeEvent[] = [];
    const coalescer = new DeltaCoalescer((e) => emitted.push(e), {
      windowMs: 1_000_000,
      maxChars: 10,
      setTimer: () => 'timer',
      clearTimer: () => {},
      logger: { warn: vi.fn() },
    });

    coalescer.offer(delta('t1', 'paint'));
    coalescer.offer(delta('t1', '12345'));
    expect(texts(emitted)).toEqual(['paint']);
    coalescer.offer(delta('t1', '67890'));

    // Reaching the cap emits without waiting for the window, bounding the
    // SIZE of a single event.
    expect(texts(emitted)).toEqual(['paint', '1234567890']);
  });

  test('the window fires on its own when no other event arrives', () => {
    const emitted: CanonicalRuntimeEvent[] = [];
    let fire: (() => void) | undefined;
    const coalescer = new DeltaCoalescer((e) => emitted.push(e), {
      windowMs: 60,
      setTimer: (fn) => {
        fire = fn;
        return 'timer';
      },
      clearTimer: () => {},
      logger: { warn: vi.fn() },
    });

    coalescer.offer(delta('t1', 'paint'));
    coalescer.offer(delta('t1', 'alone'));
    expect(texts(emitted)).toEqual(['paint']);
    fire?.();

    // A final delta with nothing after it must still reach the client.
    expect(texts(emitted)).toEqual(['paint', 'alone']);
  });

  test('an event with no string delta is passed through untouched', () => {
    const { coalescer, emitted } = manual();

    // Defensive: a malformed delta must not be swallowed into a buffer that
    // has no text to flush.
    expect(
      coalescer.offer({
        method: 'content.text-delta',
        threadId: 't1',
      } as unknown as CanonicalRuntimeEvent),
    ).toBe(false);
    expect(emitted).toHaveLength(0);
    expect(coalescer.pendingThreadCount()).toBe(0);
  });

  test('an absent itemId is one stream, and does not merge with a named one', () => {
    const { coalescer, emitted } = manual();
    const nameless = (text: string) =>
      ({
        method: 'content.text-delta',
        threadId: 't1',
        turnId: 'turn-1',
        delta: text,
      }) as unknown as CanonicalRuntimeEvent;

    // `itemId` is required by the contract, but `streamKeyOf` reads it
    // defensively (`itemId ?? ''`) and every other fixture here hardcodes one,
    // so this is the only test that exercises the absent case at all.
    coalescer.offer(nameless('a'));
    coalescer.offer(nameless('b'));
    coalescer.offer(nameless('c'));
    // A named item is a DIFFERENT stream: merging it in would stamp its id
    // onto text that predates it.
    coalescer.offer(delta('t1', 'named', { itemId: 'item-z' }));
    coalescer.flushAll();

    expect(texts(emitted)).toEqual(['a', 'bc', 'named']);
  });

  test('a delivery that throws on the SYNCHRONOUS offer path propagates, so the stream can recover', () => {
    const emitted: CanonicalRuntimeEvent[] = [];
    const warn = vi.fn();
    let failNext = false;
    const coalescer = new DeltaCoalescer(
      (event) => {
        if (failNext) throw new Error('SQLITE_BUSY: database is locked');
        emitted.push(event);
      },
      {
        windowMs: 1_000_000,
        setTimer: () => 'timer',
        clearTimer: () => {},
        logger: { warn },
      },
    );

    // archive#3304: `consumeAdapterEvents` sits directly above this call. Its
    // catch classifies a SQLITE_BUSY as store contention — counting
    // `orchestrationStoreContentionObserved`, publishing a `runtime.error`
    // naming the locked store, and restarting the stream. Deltas are the bulk
    // of a turn and so the likeliest event to hit BUSY first, so swallowing
    // them here would make that whole mechanism unreachable in practice: no
    // inline user error, no metric, no restart, just a server-log line.
    failNext = true;
    expect(() => coalescer.offer(delta('t1', 'first paint'))).toThrow(
      'SQLITE_BUSY',
    );
    expect(warn).not.toHaveBeenCalled();

    // The FLUSH that a later delta triggers is on the same synchronous path.
    failNext = false;
    coalescer.offer(delta('t2', 'paint'));
    coalescer.offer(delta('t2', '-held'));
    failNext = true;
    expect(() => coalescer.offer(other('t2', 'tool.started'))).toThrow(
      'SQLITE_BUSY',
    );
    expect(warn).not.toHaveBeenCalled();

    // Nothing stale is left behind either way: the buffer is dropped before
    // the delivery is attempted.
    expect(coalescer.pendingThreadCount()).toBe(0);
    expect(texts(emitted)).toEqual(['paint']);
  });

  test('a delivery that throws on the timer path does not propagate, and the coalescer stays usable', () => {
    const emitted: CanonicalRuntimeEvent[] = [];
    let fire: (() => void) | undefined;
    let failNext = false;
    const warn = vi.fn();
    const coalescer = new DeltaCoalescer(
      (event) => {
        if (failNext) throw new Error('SQLITE_BUSY: database is locked');
        emitted.push(event);
      },
      {
        windowMs: 60,
        setTimer: (fn) => {
          fire = fn;
          return 'timer';
        },
        clearTimer: () => {},
        logger: { warn },
      },
    );

    coalescer.offer(delta('t1', 'paint'));
    coalescer.offer(delta('t1', 'doomed'));
    failNext = true;
    // Unlike the synchronous case above, the timer callback has NO caller
    // frame to catch for it: an escaping throw here reaches
    // `uncaughtException` and takes the server down for one undeliverable
    // delta. The lost text is disclosed by the warning, not by an inline
    // error — that asymmetry is deliberate and is the whole reason the two
    // paths differ.
    expect(() => fire?.()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      'Content delta could not be published',
      expect.objectContaining({
        threadId: 't1',
        error: 'SQLITE_BUSY: database is locked',
      }),
    );

    failNext = false;
    coalescer.offer(delta('t1', 'after'));
    coalescer.offer(delta('t1', '-more'));
    coalescer.flushAll();

    // Still usable: the failed thread holds nothing stale, and later text
    // publishes normally.
    expect(texts(emitted)).toEqual(['paint', 'after-more']);
    expect(coalescer.pendingThreadCount()).toBe(0);
  });

  test('a throwing delivery during flushAll does not abandon the other threads', () => {
    const emitted: CanonicalRuntimeEvent[] = [];
    let flushing = false;
    const coalescer = new DeltaCoalescer(
      (event) => {
        // Only the flush fails. Shutdown has no caller frame, so one thread's
        // failed final delivery must not cost every other thread its text.
        if (flushing && event.threadId === 't1') throw new Error('nope');
        emitted.push(event);
      },
      {
        windowMs: 1_000_000,
        setTimer: () => 'timer',
        clearTimer: () => {},
        logger: { warn: vi.fn() },
      },
    );

    coalescer.offer(delta('t1', 'a'));
    coalescer.offer(delta('t1', 'b'));
    coalescer.offer(delta('t2', 'c'));
    coalescer.offer(delta('t2', 'd'));
    flushing = true;
    coalescer.flushAll();

    expect(texts(emitted)).toEqual(['a', 'c', 'd']);
    expect(coalescer.pendingThreadCount()).toBe(0);
  });

  test('flushAll converges on text a flush re-entrantly buffers, rather than sweeping a snapshot once', () => {
    const emitted: CanonicalRuntimeEvent[] = [];
    let reentered = false;
    let flushing = false;
    const coalescer: DeltaCoalescer = new DeltaCoalescer(
      (event) => {
        emitted.push(event);
        if (flushing && !reentered) {
          reentered = true;
          // A synchronous bus listener publishing onto a thread the sweep's
          // snapshot never held. Two offers: the first paints, the second
          // buffers — and that buffer is what a single-pass sweep abandons.
          coalescer.offer(delta('t2', 'late'));
          coalescer.offer(delta('t2', '-text'));
        }
      },
      {
        windowMs: 1_000_000,
        setTimer: () => 'timer',
        clearTimer: () => {},
        logger: { warn: vi.fn() },
      },
    );

    coalescer.offer(delta('t1', 'x'));
    coalescer.offer(delta('t1', 'y'));
    flushing = true;
    coalescer.flushAll();

    // On shutdown a buffer left behind here is lost text — the exact thing
    // flushAll exists to prevent.
    expect(texts(emitted)).toEqual(['x', 'y', 'late', '-text']);
    expect(coalescer.pendingThreadCount()).toBe(0);
  });

  test('a re-entrant producer that never settles is bounded and reported, not spun on forever', () => {
    const emitted: CanonicalRuntimeEvent[] = [];
    const warn = vi.fn();
    let paints = 0;
    const coalescer: DeltaCoalescer = new DeltaCoalescer(
      (event) => {
        emitted.push(event);
        // Every delivery buffers another delta for the same thread, forever.
        paints += 1;
        coalescer.offer(delta('t1', `re-${paints}`));
      },
      {
        windowMs: 1_000_000,
        setTimer: () => 'timer',
        clearTimer: () => {},
        logger: { warn },
      },
    );

    coalescer.offer(delta('t1', 'seed'));
    coalescer.offer(delta('t1', 'buffered'));
    coalescer.flushAll();

    expect(warn).toHaveBeenCalledWith(
      'Delta coalescing flush did not converge; buffered content deltas remain unpublished',
      expect.objectContaining({ passes: 32 }),
    );
    // One delivery per pass (32) plus the seed paint is what the bound alone
    // produces. The 34th is the final best-effort emit of the buffer the
    // bound would otherwise have RETAINED — and on the shutdown path this
    // method exists for, a retained buffer is exactly the lost text it is
    // supposed to prevent.
    expect(emitted).toHaveLength(34);
  });

  test('a logger that throws does not escape the delivery it is reporting on', () => {
    let fire: (() => void) | undefined;
    let failNext = false;
    const coalescer = new DeltaCoalescer(
      () => {
        if (failNext) throw new Error('SQLITE_BUSY: database is locked');
      },
      {
        windowMs: 60,
        setTimer: (fn) => {
          fire = fn;
          return 'timer';
        },
        clearTimer: () => {},
        // A pino destination torn down during shutdown is precisely when a
        // warn throws — and it is called from INSIDE `deliver`'s catch, so it
        // escapes as the exact `uncaughtException` that catch exists to
        // prevent.
        logger: {
          warn: () => {
            throw new Error('write after end');
          },
        },
      },
    );

    coalescer.offer(delta('t1', 'paint'));
    coalescer.offer(delta('t1', 'doomed'));
    failNext = true;

    expect(() => fire?.()).not.toThrow();
    expect(coalescer.pendingThreadCount()).toBe(0);
  });

  describe('a buffer is never left without its first-paint marker', () => {
    /**
     * The three places that drop a thread's marker do it AFTER a flush, and a
     * flush fans out synchronously. If that fan-out re-buffers a delta for the
     * same thread, dropping the marker leaves the thread holding text with no
     * marker — and the NEXT delta then takes the first-paint branch and
     * publishes immediately, ahead of the text already buffered. Order, not
     * counts, is what these pin: every assertion below reads the published
     * text as one stream.
     */
    test('forgetThread keeps the marker of a thread whose own flush re-buffered', () => {
      const emitted: CanonicalRuntimeEvent[] = [];
      let forgetting = false;
      let reentered = false;
      const coalescer: DeltaCoalescer = new DeltaCoalescer(
        (event) => {
          emitted.push(event);
          if (forgetting && !reentered) {
            reentered = true;
            // A synchronous listener publishing more of the SAME run of text
            // while the flush that is retiring the thread is still on the
            // stack.
            coalescer.offer(delta('t1', '-earlier'));
          }
        },
        {
          windowMs: 1_000_000,
          setTimer: () => 'timer',
          clearTimer: () => {},
          logger: { warn: vi.fn() },
        },
      );

      coalescer.offer(delta('t1', 'paint'));
      coalescer.offer(delta('t1', '-held'));
      forgetting = true;
      coalescer.forgetThread('t1');
      forgetting = false;

      // The re-buffered text is still held, so the marker that keeps the next
      // delta from overtaking it must still be held too.
      expect(coalescer.pendingThreadCount()).toBe(1);
      expect(coalescer.trackedThreadCount()).toBe(1);

      coalescer.offer(delta('t1', '-later'));
      coalescer.flushAll();

      expect(texts(emitted).join('')).toBe('paint-held-earlier-later');
    });

    test('the non-coalescable path keeps the marker of a thread its flush re-buffered', () => {
      const emitted: CanonicalRuntimeEvent[] = [];
      let interrupting = false;
      let reentered = false;
      const coalescer: DeltaCoalescer = new DeltaCoalescer(
        (event) => {
          emitted.push(event);
          if (interrupting && !reentered) {
            reentered = true;
            coalescer.offer(delta('t1', '-earlier'));
          }
        },
        {
          windowMs: 1_000_000,
          setTimer: () => 'timer',
          clearTimer: () => {},
          logger: { warn: vi.fn() },
        },
      );

      coalescer.offer(delta('t1', 'paint'));
      coalescer.offer(delta('t1', '-held'));
      interrupting = true;
      // The tool call flushes the buffer before it; the flush's fan-out then
      // buffers more text for the same thread.
      expect(coalescer.offer(other('t1', 'tool.started'))).toBe(false);
      interrupting = false;

      coalescer.offer(delta('t1', '-later'));
      coalescer.flushAll();

      expect(texts(emitted).join('')).toBe('paint-held-earlier-later');
    });

    test('the flushAll bound never returns with a buffered thread whose marker was cleared', () => {
      const emitted: CanonicalRuntimeEvent[] = [];
      let refilling = false;
      const coalescer: DeltaCoalescer = new DeltaCoalescer(
        (event) => {
          emitted.push(event);
          // A producer that re-buffers on every delivery, so the sweep gives
          // up with `t1` still holding text. That is the ONLY way out of
          // `flushAll` with a non-empty buffer.
          if (refilling) coalescer.offer(delta('t1', 'R'));
        },
        {
          windowMs: 1_000_000,
          setTimer: () => 'timer',
          clearTimer: () => {},
          logger: { warn: vi.fn() },
        },
      );

      coalescer.offer(delta('t1', 'paint'));
      coalescer.offer(delta('t1', '-held'));
      refilling = true;
      coalescer.flushAll();
      refilling = false;

      expect(coalescer.pendingThreadCount()).toBe(1);
      expect(coalescer.trackedThreadCount()).toBe(1);

      coalescer.offer(delta('t1', '-later'));
      coalescer.flushAll();

      // Everything the producer emitted before `-later` must be published
      // before it, so the last text on the wire is the last text produced.
      expect(texts(emitted).join('').endsWith('-later')).toBe(true);
    });

    test('a thread with nothing buffered still loses its marker', () => {
      const { coalescer } = manual();

      // The guard is "still holding text", not "was ever seen": an ordinary
      // retired thread must not keep an entry, which is what the marker sweep
      // exists to prevent.
      coalescer.offer(delta('t1', 'paint'));
      coalescer.offer(delta('t2', 'paint'));
      expect(coalescer.trackedThreadCount()).toBe(2);

      coalescer.forgetThread('t1');
      expect(coalescer.trackedThreadCount()).toBe(1);

      coalescer.offer(other('t2', 'tool.started'));
      expect(coalescer.trackedThreadCount()).toBe(0);
    });
  });

  test('a logger that throws on the non-convergence warning does not escape flushAll', () => {
    const coalescer: DeltaCoalescer = new DeltaCoalescer(
      () => {
        coalescer.offer(delta('t1', 'again'));
      },
      {
        windowMs: 1_000_000,
        setTimer: () => 'timer',
        clearTimer: () => {},
        // Same torn-down-pino case the delivery warning already guards for.
        // `shutdown` calls `flushAll` inside a catch that warns through this
        // same logger and rethrows, so an escape here escapes `shutdown()`.
        logger: {
          warn: () => {
            throw new Error('write after end');
          },
        },
      },
    );

    coalescer.offer(delta('t1', 'seed'));

    expect(() => coalescer.flushAll()).not.toThrow();
  });

  test('the non-convergence warning counts what remains AFTER its final pass', () => {
    const emitted: CanonicalRuntimeEvent[] = [];
    const warn = vi.fn();
    // Mirrors FLUSH_ALL_MAX_PASSES. `t1` never settles; `t2` refills once per
    // NORMAL pass and then declines to refill during the final best-effort
    // pass, so it is buffered when the bound is hit and settled by the time
    // the warning is written. With a single never-settling thread the count
    // reads 1 under either reading and cannot tell them apart.
    const normalPasses = 32;
    let sweeping = false;
    let t2FlushesDuringSweep = 0;
    const coalescer: DeltaCoalescer = new DeltaCoalescer(
      (event) => {
        emitted.push(event);
        if (event.threadId === 't1') {
          coalescer.offer(delta('t1', 'r'));
          return;
        }
        if (!sweeping) {
          coalescer.offer(delta('t2', 'r'));
          return;
        }
        t2FlushesDuringSweep += 1;
        if (t2FlushesDuringSweep <= normalPasses)
          coalescer.offer(delta('t2', 'r'));
      },
      {
        windowMs: 1_000_000,
        setTimer: () => 'timer',
        clearTimer: () => {},
        logger: { warn },
      },
    );

    coalescer.offer(delta('t1', 'seed-1'));
    coalescer.offer(delta('t2', 'seed-2'));
    sweeping = true;
    coalescer.flushAll();

    expect(warn).toHaveBeenCalledWith(
      'Delta coalescing flush did not converge; buffered content deltas remain unpublished',
      expect.objectContaining({ passes: 32, pendingThreads: 1 }),
    );
    expect(coalescer.pendingThreadCount()).toBe(1);
    expect(emitted.length).toBeGreaterThan(normalPasses);
  });

  describe('per-thread state does not outlive its thread', () => {
    test('forgetThread publishes what was buffered and then drops the marker', () => {
      const { coalescer, emitted } = manual();

      coalescer.offer(delta('t1', 'kept'));
      coalescer.offer(delta('t1', '-and-kept'));
      expect(coalescer.trackedThreadCount()).toBe(1);

      coalescer.forgetThread('t1');

      // Flushes first, so this can never be the thing that silently deletes
      // text the model produced.
      expect(texts(emitted)).toEqual(['kept', '-and-kept']);
      expect(coalescer.pendingThreadCount()).toBe(0);
      expect(coalescer.trackedThreadCount()).toBe(0);
    });

    test('a thread that dies after one delta does not leak a marker forever', () => {
      const { coalescer } = manual();

      // `offer` only drops the marker when a NON-coalescable event arrives.
      // A stream that dies mid-turn never sends one, so every such thread
      // used to leave an entry behind for the life of the process — and
      // `pending`, which self-cleans on every flush, hid that.
      for (let index = 0; index < 1_000; index += 1)
        coalescer.offer(delta(`dead-${index}`, 'one delta'));
      expect(coalescer.trackedThreadCount()).toBe(1_000);
      expect(coalescer.pendingThreadCount()).toBe(0);

      coalescer.flushAll();

      expect(coalescer.trackedThreadCount()).toBe(0);
    });
  });
});
