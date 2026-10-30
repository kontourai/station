import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, test, vi } from 'vitest';

// The shared identity module is replaced so the production default path of
// executeOwnedCommand can be driven: an unavailable first probe, then exact.
const ownProbe = vi.hoisted(() => ({
  results: [] as Array<{ state: string; identity?: unknown }>,
  calls: 0,
}));
vi.mock('../../packages/shared/src/process-identity.mjs', async (load) => {
  const actual = await load<Record<string, unknown>>();
  return {
    ...actual,
    resolveOwnProcessIdentity: (
      pid: number,
      dependencies: Record<string, unknown> = {},
    ) => {
      if (dependencies.lookup)
        return (
          actual.resolveOwnProcessIdentity as (
            pid: number,
            deps: Record<string, unknown>,
          ) => unknown
        )(pid, dependencies);
      ownProbe.calls += 1;
      return ownProbe.results.shift() ?? { state: 'unavailable' };
    },
  };
});

const { executeOwnedCommand, resolveCoordinatorIdentity } = await import(
  '../lib/owned-process.mjs'
);

afterEach(() => {
  ownProbe.results = [];
  ownProbe.calls = 0;
});

describe('owned command coordinator identity', () => {
  test('a Windows birth probe that times out once is retried, not refused', () => {
    // The hosted Windows runner refused every owned command when the
    // coordinator's single 1.5s PowerShell probe ran out on a cold start.
    let calls = 0;
    const identity = resolveCoordinatorIdentity(4101, {
      platform: 'win32',
      alive: () => 'alive',
      lookup: () => {
        calls += 1;
        return calls === 1 ? null : '2026-10-29T02:36:44.1234567Z';
      },
      wait: () => {},
    });
    expect(identity).toEqual({
      pid: 4101,
      start: '2026-10-29T02:36:44.1234567Z',
    });
    expect(calls).toBe(2);
  });

  test('an identity that never resolves is refused, never PID-only, and not kept', () => {
    let calls = 0;
    const never = {
      platform: 'win32',
      alive: () => 'alive',
      lookup: () => {
        calls += 1;
        return null;
      },
      wait: () => {},
    };
    expect(resolveCoordinatorIdentity(4102, never)).toBeNull();
    const afterFirst = calls;
    expect(resolveCoordinatorIdentity(4102, never)).toBeNull();
    expect(calls).toBeGreaterThan(afterFirst);
  });

  test('an exact identity is resolved once per process, then reused', () => {
    let calls = 0;
    const once = {
      platform: 'win32',
      alive: () => 'alive',
      lookup: () => {
        calls += 1;
        return '2026-10-29T03:00:00.0000000Z';
      },
      wait: () => {},
    };
    const first = resolveCoordinatorIdentity(4103, once);
    expect(resolveCoordinatorIdentity(4103, once)).toBe(first);
    expect(calls).toBe(1);
  });

  test('executeOwnedCommand resolves its Windows coordinator through the own-process schedule by default', () => {
    // Drives the production default resolver (no resolveParentIdentity).
    ownProbe.results = [
      {
        state: 'exact',
        identity: { pid: process.pid, start: 'coordinator-birth' },
      },
    ];
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      pid: 4242,
      kill: () => true,
      send: () => true,
    });
    const spawn = vi.fn(() => child);
    const execution = executeOwnedCommand(
      'check.exe',
      [],
      spawn as never,
      'fixture',
      { guardExecutable: 'guard.exe' },
      { platform: 'win32' },
    );
    expect(ownProbe.calls).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(execution.child).toBe(child);
  });
});
