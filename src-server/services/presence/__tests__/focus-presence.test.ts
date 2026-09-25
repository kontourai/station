import { describe, expect, test } from 'vitest';
import { FocusPresence, focusSurfaceId } from '../focus-presence.js';

const TAB_A = '11111111-1111-4111-8111-111111111111';
const TAB_B = '22222222-2222-4222-8222-222222222222';
const phone = {
  kind: 'device',
  deviceId: 'phone',
  principalId: 'human:alice',
} as const;
const local = (clientSessionId: string, principalId = 'operator') =>
  ({ kind: 'local', clientSessionId, principalId }) as const;
const device = (deviceId: string, principalId = 'human:alice') =>
  ({ kind: 'device', deviceId, principalId }) as const;

let lastSeq = 0;
/** Reports with a fresh, strictly increasing seq, as a real client does. */
function send(
  presence: FocusPresence,
  reporter: Parameters<FocusPresence['report']>[0],
  clientSessionId: string,
  state: Parameters<FocusPresence['report']>[2],
) {
  lastSeq += 1;
  return presence.report(reporter, clientSessionId, state, lastSeq);
}

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
    expect(focusSurfaceId(local(TAB_A))).toBe(`local:${TAB_A}`);
  });

  test('a report lapses at the 120 s lease and the surface reads as absent', () => {
    const time = clock();
    const presence = new FocusPresence({ now: time.now });
    expect(send(presence, phone, TAB_A, 'focused')).toEqual({
      accepted: true,
      surfaceId: 'device:phone',
      applied: true,
    });
    time.advance(119_999);
    expect(presence.snapshot(['device:phone']).get('device:phone')).toEqual({
      surfaceId: 'device:phone',
      principalId: 'human:alice',
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
    send(presence, phone, TAB_A, 'focused');
    time.advance(60_000);
    send(presence, phone, TAB_A, 'focused');
    time.advance(100_000);
    expect(presence.isAnyFocused(['device:phone'])).toBe(true);
  });

  test('one focused document makes its device focused whatever its other tabs report', () => {
    const time = clock();
    const presence = new FocusPresence({ now: time.now });
    send(presence, phone, TAB_A, 'focused');
    time.advance(1_000);
    send(presence, phone, TAB_B, 'hidden');
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
    send(presence, phone, TAB_A, 'focused');
    send(presence, phone, TAB_A, 'hidden');
    expect(presence.snapshot().get('device:phone')?.state).toBe('hidden');
    expect(presence.isAnyFocused(['device:phone'])).toBe(false);
  });

  test('snapshot restricts to the requested surfaces', () => {
    const presence = new FocusPresence({ now: clock().now });
    send(presence, phone, TAB_A, 'focused');
    send(presence, local(TAB_B), TAB_B, 'visible');
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
    send(presence, device('a'), TAB_A, 'focused');
    time.advance(10);
    send(presence, device('b'), TAB_A, 'focused');
    time.advance(10);
    // `a` reports again, so `b` is now the oldest.
    send(presence, device('a'), TAB_A, 'focused');
    time.advance(10);
    send(presence, device('c'), TAB_A, 'focused');
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
    send(presence, phone, TAB_A, 'focused');
    send(presence, phone, TAB_B, 'hidden');
    expect(presence.snapshot().get('device:phone')?.state).toBe('hidden');
  });

  test('a report that lowers or keeps a document state is taken even past the rate', () => {
    const time = clock();
    const presence = new FocusPresence({ now: time.now });
    for (let index = 0; index < 30; index += 1) {
      expect(send(presence, phone, TAB_A, 'focused').accepted).toBe(true);
    }
    // Raising is refused: a new document, or hidden -> focused.
    expect(send(presence, phone, TAB_B, 'focused').accepted).toBe(false);
    expect(send(presence, phone, TAB_A, 'hidden')).toEqual({
      accepted: true,
      surfaceId: 'device:phone',
      applied: true,
    });
    expect(presence.snapshot().get('device:phone')?.state).toBe('hidden');
    expect(presence.isAnyFocused(['device:phone'])).toBe(false);
    expect(send(presence, phone, TAB_A, 'hidden').accepted).toBe(true);
    expect(send(presence, phone, TAB_A, 'focused').accepted).toBe(false);
  });

  test('snapshotForPrincipals returns only the named people and carries the principal', () => {
    const presence = new FocusPresence({ now: clock().now });
    send(presence, device('alice-phone', 'human:alice'), TAB_A, 'focused');
    send(presence, device('bob-phone', 'human:bob'), TAB_A, 'focused');
    send(presence, local(TAB_B), TAB_B, 'visible');
    const alice = presence.snapshotForPrincipals(['human:alice']);
    expect([...alice.values()]).toEqual([
      {
        surfaceId: 'device:alice-phone',
        principalId: 'human:alice',
        state: 'focused',
        reportedAt: 1_000_000,
      },
    ]);
    expect(
      [
        ...presence.snapshotForPrincipals(['operator', 'human:bob']).keys(),
      ].sort(),
    ).toEqual(['device:bob-phone', `local:${TAB_B}`]);
    expect(presence.snapshotForPrincipals([]).size).toBe(0);
  });

  test('raising reports past the per-surface rate are refused without changing state', () => {
    const time = clock();
    const presence = new FocusPresence({
      now: time.now,
      reportsPerWindow: 2,
      reportWindowMs: 60_000,
    });
    send(presence, phone, TAB_A, 'hidden');
    time.advance(1_000);
    send(presence, phone, TAB_A, 'hidden');
    time.advance(1_000);
    expect(send(presence, phone, TAB_A, 'focused')).toEqual({
      accepted: false,
      retryAfterMs: 58_000,
    });
    expect(presence.snapshot().get('device:phone')?.state).toBe('hidden');
    time.advance(58_000);
    expect(send(presence, phone, TAB_A, 'focused').accepted).toBe(true);
  });

  test('a report whose seq is not above the last applied one is ignored', () => {
    const time = clock();
    const presence = new FocusPresence({ now: time.now });
    expect(presence.report(phone, TAB_A, 'focused', 5)).toMatchObject({
      applied: true,
    });
    // The page went hidden (seq 6); the slow focused (seq 5, a retry, or a
    // duplicate) lands afterwards and must not undo it.
    expect(presence.report(phone, TAB_A, 'hidden', 6)).toMatchObject({
      applied: true,
    });
    expect(presence.report(phone, TAB_A, 'focused', 5)).toEqual({
      accepted: true,
      surfaceId: 'device:phone',
      applied: false,
    });
    expect(presence.report(phone, TAB_A, 'focused', 6)).toMatchObject({
      applied: false,
    });
    expect(presence.snapshot().get('device:phone')?.state).toBe('hidden');
    expect(presence.isAnyFocused(['device:phone'])).toBe(false);
    expect(presence.report(phone, TAB_A, 'focused', 7)).toMatchObject({
      applied: true,
    });
    expect(presence.isAnyFocused(['device:phone'])).toBe(true);
  });

  test('a stale report neither counts against the rate nor is refused by it', () => {
    const presence = new FocusPresence({
      now: clock().now,
      reportsPerWindow: 1,
    });
    presence.report(phone, TAB_A, 'hidden', 10);
    for (let index = 0; index < 5; index += 1) {
      expect(presence.report(phone, TAB_A, 'focused', 3).accepted).toBe(true);
    }
    expect(presence.snapshot().get('device:phone')?.state).toBe('hidden');
  });

  test('a new document id starts its seq fresh', () => {
    const presence = new FocusPresence({ now: clock().now });
    presence.report(phone, TAB_A, 'hidden', 40);
    expect(presence.report(phone, TAB_B, 'focused', 1)).toMatchObject({
      applied: true,
    });
    expect(presence.snapshot().get('device:phone')?.state).toBe('focused');
  });
});
