/**
 * Consent-gating tests for `resolveAndExecuteStationBoardIntent` (roadmap
 * archive#586, part of epic archive#580, S6) — the acceptance bar: "consent-gated execute
 * called exactly once with consent === true, never on truthy".
 */
import type { HostIntentBinding } from '@kontourai/console-core';
import { describe, expect, test, vi } from 'vitest';
import { resolveAndExecuteStationBoardIntent } from '../station-board-intent.js';
import type { StationIntent } from '../station-intent-bindings.js';

function writeBinding(
  execute: (intent: StationIntent) => void,
): HostIntentBinding<StationIntent> {
  return {
    product: 'station',
    command: 'task dispatch',
    sideEffect: 'write-local',
    confirmation: 'user-request',
    execute,
  };
}

function neverBinding(
  execute: (intent: StationIntent) => void,
): HostIntentBinding<StationIntent> {
  return {
    product: 'station',
    command: 'task status',
    sideEffect: 'read-local',
    confirmation: 'never',
    execute,
  };
}

function intent(product: string, command: string) {
  return { id: 'intent-1', kind: command, authority: { product, command } };
}

describe('resolveAndExecuteStationBoardIntent', () => {
  test('unbound intent never executes', async () => {
    const execute = vi.fn();
    const result = await resolveAndExecuteStationBoardIntent(
      intent('station', 'nonexistent command'),
      true,
      [writeBinding(execute)],
    );
    expect(result).toEqual({
      bound: false,
      executed: false,
      reason: 'no-matching-binding',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  test('confirmation "never" executes unconditionally, exactly once', async () => {
    const execute = vi.fn();
    const result = await resolveAndExecuteStationBoardIntent(
      intent('station', 'task status'),
      undefined,
      [neverBinding(execute)],
    );
    expect(result).toEqual({ bound: true, executed: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test('confirmation "user-request" withholds execution when consent is undefined', async () => {
    const execute = vi.fn();
    const result = await resolveAndExecuteStationBoardIntent(
      intent('station', 'task dispatch'),
      undefined,
      [writeBinding(execute)],
    );
    expect(result).toEqual({
      bound: true,
      executed: false,
      reason: 'consent-required',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  test('confirmation "user-request" withholds execution when consent is false', async () => {
    const execute = vi.fn();
    const result = await resolveAndExecuteStationBoardIntent(
      intent('station', 'task dispatch'),
      false,
      [writeBinding(execute)],
    );
    expect(result.executed).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  test.each([
    ['yes' as unknown as boolean],
    [1 as unknown as boolean],
    ['true' as unknown as boolean],
    [{} as unknown as boolean],
  ])(
    'never on truthy: consent=%p (truthy, not === true) never executes',
    async (truthyConsent) => {
      const execute = vi.fn();
      const result = await resolveAndExecuteStationBoardIntent(
        intent('station', 'task dispatch'),
        truthyConsent,
        [writeBinding(execute)],
      );
      expect(result.executed).toBe(false);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  test('confirmation "user-request" executes exactly once when consent is the literal true', async () => {
    const execute = vi.fn();
    const result = await resolveAndExecuteStationBoardIntent(
      intent('station', 'task dispatch'),
      true,
      [writeBinding(execute)],
    );
    expect(result).toEqual({ bound: true, executed: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test('execute receives the exact intent object supplied', async () => {
    let received: unknown;
    const execute = vi.fn((value: StationIntent) => {
      received = value;
    });
    const theIntent = intent('station', 'task dispatch');
    await resolveAndExecuteStationBoardIntent(theIntent, true, [
      writeBinding(execute),
    ]);
    expect(received).toBe(theIntent);
  });
});
