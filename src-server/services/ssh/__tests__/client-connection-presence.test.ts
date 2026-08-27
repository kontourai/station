import { describe, expect, test } from 'vitest';
import { ClientConnectionPresence } from '../client-connection-presence.js';

const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';

describe('ClientConnectionPresence', () => {
  test('deduplicates duplicate stream references and releases idempotently', () => {
    const presence = new ClientConnectionPresence();
    const first = presence.connect('phone', SESSION_A)!;
    const duplicate = presence.connect('phone', SESSION_A)!;
    expect(presence.snapshot(['phone']).get('phone')?.sessionCount).toBe(1);
    first.release();
    expect(presence.snapshot(['phone']).get('phone')?.sessionCount).toBe(1);
    duplicate.release();
    duplicate.release();
    expect(presence.snapshot(['phone']).has('phone')).toBe(false);
  });

  test('expires stale presence and never revives an expired or revoked device', () => {
    let now = 0;
    const presence = new ClientConnectionPresence({
      now: () => now,
      leaseMs: 10,
    });
    const lease = presence.connect('phone', SESSION_A)!;
    now = 11;
    expect(presence.snapshot(['phone']).has('phone')).toBe(false);
    lease.touch();
    expect(presence.snapshot(['phone']).has('phone')).toBe(false);
    presence.disconnectDevice('phone');
    lease.touch();
    expect(presence.snapshot(['phone']).has('phone')).toBe(false);
  });

  test('retains duplicate stream references across expiry until every lease releases', () => {
    let now = 0;
    const presence = new ClientConnectionPresence({
      now: () => now,
      leaseMs: 10,
    });
    const first = presence.connect('phone', SESSION_A)!;
    const second = presence.connect('phone', SESSION_A)!;
    now = 11;
    expect(presence.snapshot(['phone']).has('phone')).toBe(false);
    first.touch();
    first.release();
    expect(presence.snapshot(['phone']).has('phone')).toBe(false);
    second.release();
    expect(presence.snapshot(['phone']).has('phone')).toBe(false);
  });

  test('bounds sessions without exposing an unbounded registry', () => {
    const presence = new ClientConnectionPresence({ capacity: 1 });
    expect(presence.connect('one', SESSION_A)).toBeTruthy();
    expect(presence.connect('two', SESSION_B)).toBeUndefined();
  });

  test('reserves a fair per-device ceiling so another paired device can connect', () => {
    const presence = new ClientConnectionPresence({
      capacity: 3,
      perDeviceCapacity: 2,
    });
    expect(presence.connect('one', SESSION_A)).toBeTruthy();
    expect(presence.connect('one', SESSION_B)).toBeTruthy();
    expect(
      presence.connect('one', '33333333-3333-4333-8333-333333333333'),
    ).toBeUndefined();
    expect(
      presence.connect('two', '44444444-4444-4444-8444-444444444444'),
    ).toBeTruthy();
  });

  test('does not retain revocation tombstones across churn', () => {
    const presence = new ClientConnectionPresence();
    for (let index = 0; index < 1_000; index += 1) {
      const id = `device-${index}`;
      presence.connect(id, SESSION_A);
      presence.disconnectDevice(id);
    }
    expect(presence.snapshot([]).size).toBe(0);
    // A new pairing record may use the same display id without inheriting a
    // hidden revocation accumulator from this process-local projection.
    expect(presence.connect('device-999', SESSION_B)).toBeTruthy();
  });
});
