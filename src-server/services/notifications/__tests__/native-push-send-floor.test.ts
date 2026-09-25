import { describe, expect, test } from 'vitest';
import {
  createNativePushSendFloor,
  NATIVE_PUSH_MIN_SEND_INTERVAL_MS as INTERVAL,
} from '../native-push-send-floor.js';

const NOW = 1_800_000_000_000;

describe('native push send floor', () => {
  test('reserves consecutive slots one interval apart for one phone', () => {
    const floor = createNativePushSendFloor();
    expect(floor.reserve('a', NOW)).toBe(NOW);
    expect(floor.reserve('a', NOW)).toBe(NOW + INTERVAL);
    expect(floor.reserve('a', NOW + 1)).toBe(NOW + 2 * INTERVAL);
    expect(floor.lastSendAt('a')).toBe(NOW + 2 * INTERVAL);
  });

  test("reserving slots ahead for one phone never forgets another phone's recent send", () => {
    const floor = createNativePushSendFloor();
    floor.record('b', NOW - 1_000);
    for (let i = 0; i < 4; i += 1) floor.reserve('a', NOW);
    expect(floor.lastSendAt('a')).toBe(NOW + 3 * INTERVAL);
    // B is still inside its interval, so it is still floored.
    expect(floor.lastSendAt('b')).toBe(NOW - 1_000);
    expect(floor.reserve('b', NOW)).toBe(NOW - 1_000 + INTERVAL);
  });

  test('a send older than the interval is forgotten', () => {
    const floor = createNativePushSendFloor();
    floor.record('b', NOW - INTERVAL - 1);
    floor.record('a', NOW);
    expect(floor.lastSendAt('b')).toBeUndefined();
    expect(floor.reserve('b', NOW)).toBe(NOW);
  });

  test('the card earns the next slot after CARD_YIELD_AFTER holds, once, and its own send clears the count', () => {
    const floor = createNativePushSendFloor();
    floor.deferCard('a');
    expect(floor.takeCardYield('a')).toBe(false);
    floor.deferCard('a');
    expect(floor.takeCardYield('a')).toBe(true);
    expect(floor.takeCardYield('a')).toBe(false);
    floor.deferCard('a');
    floor.recordCard('a', NOW);
    floor.deferCard('a');
    expect(floor.takeCardYield('a')).toBe(false);
    expect(floor.lastSendAt('a')).toBe(NOW);
  });

  test('a released slot gives the phone back its previous send, unless something was recorded after it', () => {
    const floor = createNativePushSendFloor();
    floor.record('a', NOW);
    const slot = floor.reserve('a', NOW);
    floor.release('a', slot, NOW);
    expect(floor.lastSendAt('a')).toBe(NOW);
    const fresh = floor.reserve('b', NOW);
    floor.release('b', fresh);
    expect(floor.lastSendAt('b')).toBeUndefined();
    const held = floor.reserve('a', NOW);
    floor.recordCard('a', held + 1);
    floor.release('a', held, NOW);
    expect(floor.lastSendAt('a')).toBe(held + 1);
  });
});
