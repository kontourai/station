import { describe, expect, test } from 'vitest';
import { FocusPresence, focusSurfaceId } from '../focus-presence.js';

const TAB_A = '11111111-1111-4111-8111-111111111111';
const TAB_B = '22222222-2222-4222-8222-222222222222';
const phone = { kind: 'device', deviceId: 'phone' } as const;

function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('FocusPresence', () => {
  test('derives device and local surface ids from the reporter kind', () => {
    expect(focusSurfaceId(phone)).toBe('device:phone');
    expect(focusSurfaceId({ kind: 'local', clientSessionId: TAB_A })).toBe(
      `local:${TAB_A}`,
    );
  });

  test('a report lapses at the 120 s lease and the surface reads as absent', () => {
    const time = clock();
    const presence = new FocusPresence({ now: time.now });
    expect(presence.report(phone, TAB_A, 'focused')).toEqual({
      accepted: true,
      surfaceId: 'device:phone',
    });
    time.advance(119_999);
    expect(presence.snapshot(['device:phone']).get('device:phone')).toEqual({
      surfaceId: 'device:phone',
      state: 'focused',
      reportedAt: 1_000_000,
    });
    expect(presence.isAnyFocused(['device:phone'])).toBe(true);

    time.advance(1);
    expect(presence.snapshot().size).toBe(0);
    expect(presence.isAnyFocused(['device:phone'])).toBe(false);
  });

  test('a heartbeat renews the lease', () => {
    const time = clock();
    const presence = new FocusPresence({ now: time.now });
    presence.report(phone, TAB_A, 'focused');
    time.advance(60_000);
    presence.report(phone, TAB_A, 'focused');
    time.advance(100_000);
    expect(presence.isAnyFocused(['device:phone'])).toBe(true);
  });

  test('one focused document makes its device focused whatever its other tabs report', () => {
    const time = clock();
    const presence = new FocusPresence({ now: time.now });
    presence.report(phone, TAB_A, 'focused');
    time.advance(1_000);
    presence.report(phone, TAB_B, 'hidden');
    expect(presence.snapshot().get('device:phone')?.state).toBe('focused');

    // Once the focused tab's own report lapses, the surviving tab decides.
    time.advance(119_500);
    expect(presence.snapshot().get('device:phone')).toMatchObject({
      state: 'hidden',
      reportedAt: 1_001_000,
    });
  });

  test('a newer report from the same document replaces its earlier state', () => {
    const presence = new FocusPresence({ now: clock().now });
    presence.report(phone, TAB_A, 'focused');
    presence.report(phone, TAB_A, 'hidden');
    expect(presence.snapshot().get('device:phone')?.state).toBe('hidden');
    expect(presence.isAnyFocused(['device:phone'])).toBe(false);
  });

  test('snapshot restricts to the requested surfaces', () => {
    const presence = new FocusPresence({ now: clock().now });
    presence.report(phone, TAB_A, 'focused');
    presence.report(
      { kind: 'local', clientSessionId: TAB_B },
      TAB_B,
      'visible',
    );
    expect([...presence.snapshot([`local:${TAB_B}`]).keys()]).toEqual([
      `local:${TAB_B}`,
    ]);
    expect(presence.isAnyFocused([`local:${TAB_B}`, 'device:laptop'])).toBe(
      false,
    );
  });

  test('capacity is bounded: a new surface evicts the least recently reported one', () => {
    const time = clock();
    const presence = new FocusPresence({ now: time.now, capacity: 2 });
    presence.report({ kind: 'device', deviceId: 'a' }, TAB_A, 'focused');
    time.advance(10);
    presence.report({ kind: 'device', deviceId: 'b' }, TAB_A, 'focused');
    time.advance(10);
    // `a` reports again, so `b` is now the oldest.
    presence.report({ kind: 'device', deviceId: 'a' }, TAB_A, 'focused');
    time.advance(10);
    presence.report({ kind: 'device', deviceId: 'c' }, TAB_A, 'focused');
    expect([...presence.snapshot().keys()].sort()).toEqual([
      'device:a',
      'device:c',
    ]);
  });

  test('sessions per surface are bounded, evicting the oldest report', () => {
    const presence = new FocusPresence({
      now: clock().now,
      sessionsPerSurface: 1,
    });
    presence.report(phone, TAB_A, 'focused');
    presence.report(phone, TAB_B, 'hidden');
    expect(presence.snapshot().get('device:phone')?.state).toBe('hidden');
  });

  test('reports past the per-surface rate are refused without changing state', () => {
    const time = clock();
    const presence = new FocusPresence({
      now: time.now,
      reportsPerWindow: 2,
      reportWindowMs: 60_000,
    });
    presence.report(phone, TAB_A, 'focused');
    time.advance(1_000);
    presence.report(phone, TAB_A, 'focused');
    time.advance(1_000);
    expect(presence.report(phone, TAB_A, 'hidden')).toEqual({
      accepted: false,
      retryAfterMs: 58_000,
    });
    expect(presence.snapshot().get('device:phone')?.state).toBe('focused');
    time.advance(58_000);
    expect(presence.report(phone, TAB_A, 'hidden').accepted).toBe(true);
  });
});
