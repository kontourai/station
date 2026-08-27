import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test, vi } from 'vitest';
import { EventBus } from '../event-bus.js';

describe('EventBus', () => {
  test('subscribe receives emitted events', () => {
    const bus = new EventBus();
    const fn = vi.fn();
    bus.subscribe(fn);
    bus.emit(SERVER_EVENTS.CONFIG_CHANGED, { key: 'val' });
    expect(fn).toHaveBeenCalledWith({
      event: SERVER_EVENTS.CONFIG_CHANGED,
      data: { key: 'val' },
    });
  });

  test('unsubscribe stops delivery', () => {
    const bus = new EventBus();
    const fn = vi.fn();
    const unsub = bus.subscribe(fn);
    unsub();
    bus.emit(SERVER_EVENTS.CONFIG_CHANGED);
    expect(fn).not.toHaveBeenCalled();
  });

  test('multiple listeners all receive events', () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe(a);
    bus.subscribe(b);
    bus.emit(SERVER_EVENTS.CORE_UPDATED);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  test('emit without data sends undefined data', () => {
    const bus = new EventBus();
    const fn = vi.fn();
    bus.subscribe(fn);
    bus.emit(SERVER_EVENTS.CORE_UPDATED);
    expect(fn).toHaveBeenCalledWith({
      event: SERVER_EVENTS.CORE_UPDATED,
      data: undefined,
    });
  });

  /**
   * station#1284 (HIGH 3). This test used to assert the opposite — that a
   * throwing listener is REMOVED — and it pinned a defect: every subscriber
   * on this bus is a boot-wired infrastructure singleton (SSE fan-out,
   * console bridge, web push, the approval inbox) that never monitors its
   * own removal and never re-subscribes. One transient throw inside the
   * approval inbox meant no approval notification would ever be created or
   * cleared again for the life of the process.
   *
   * Isolating the OTHER listeners from a throw is the legitimate goal, and
   * `try/catch` alone achieves all of it; deletion added only the
   * amplification. The invariant is now: a listener that throws on the
   * first emission still receives the second.
   */
  test('a throwing listener keeps its subscription and still receives later events', () => {
    const bus = new EventBus();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    bus.subscribe(bad);
    bus.subscribe(good);

    bus.emit(SERVER_EVENTS.CONFIG_CHANGED);
    // The throw is isolated: the other listener still got its event.
    expect(good).toHaveBeenCalledTimes(1);
    expect(bad).toHaveBeenCalledTimes(1);

    bus.emit(SERVER_EVENTS.CONFIG_CHANGED);
    expect(bad).toHaveBeenCalledTimes(2);
    expect(good).toHaveBeenCalledTimes(2);

    // Observable rather than silent: a persistently-throwing listener is
    // diagnosable, which a deleted one is not.
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  /**
   * THE WARNING IS BOUNDED (round-3 review, MEDIUM 4; measured by
   * independent verification at 50 emits → 50 warns, 1:1 and unbounded).
   *
   * Keeping the subscription is right, and the noise axis was not
   * considered when it was decided. This bus carries `content.text-delta` —
   * one emit per streamed token — so a listener that throws every time
   * produced one `console.warn` per token per stream, forever, drowning the
   * log it was supposed to inform. Delivery must be unaffected; only the
   * warning rate is capped.
   */
  test('a persistently-throwing listener is warned about once, not once per emitted event', () => {
    const bus = new EventBus();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = vi.fn(() => {
      throw new Error('poisoned listener');
    });
    const good = vi.fn();
    bus.subscribe(bad);
    bus.subscribe(good);

    for (let index = 0; index < 50; index += 1) {
      bus.emit(SERVER_EVENTS.CONFIG_CHANGED, { index });
    }

    // Delivery is untouched in both directions: the throwing listener keeps
    // receiving events, and the healthy one is unaffected by it.
    expect(bad).toHaveBeenCalledTimes(50);
    expect(good).toHaveBeenCalledTimes(50);
    // The whole point: 50 identical failures inside one interval are ONE
    // warning, not fifty.
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  /**
   * The throttle is per listener, so a second broken subsystem is never
   * silenced by the first — the failure mode a single global rate limit
   * would introduce while fixing the volume.
   */
  test('each throwing listener gets its own warning', () => {
    const bus = new EventBus();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bus.subscribe(() => {
      throw new Error('first subsystem');
    });
    bus.subscribe(() => {
      throw new Error('second subsystem');
    });

    for (let index = 0; index < 10; index += 1) {
      bus.emit(SERVER_EVENTS.CONFIG_CHANGED, { index });
    }

    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
