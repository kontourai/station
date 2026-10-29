import { describe, expect, test } from 'vitest';
import { resolveCoordinatorIdentity } from '../lib/owned-process.mjs';

describe('owned command coordinator identity', () => {
  test('a Windows birth probe that times out once is retried, not refused', () => {
    // The hosted Windows runner refused every owned command when the
    // coordinator's single 1.5s PowerShell probe ran out on a cold start.
    const timeouts: number[] = [];
    let calls = 0;
    const identity = resolveCoordinatorIdentity(4242, {
      platform: 'win32',
      alive: () => 'alive',
      lookup: () => {
        calls += 1;
        return calls === 1 ? null : '2026-10-29T02:36:44.1234567Z';
      },
      wait: (ms: number) => {
        timeouts.push(ms);
      },
    });
    expect(identity).toEqual({
      pid: 4242,
      start: '2026-10-29T02:36:44.1234567Z',
    });
    expect(calls).toBe(2);
  });

  test('an identity that never resolves is still refused, never PID-only', () => {
    expect(
      resolveCoordinatorIdentity(4242, {
        platform: 'win32',
        alive: () => 'alive',
        lookup: () => null,
        wait: () => {},
      }),
    ).toBeNull();
  });
});
