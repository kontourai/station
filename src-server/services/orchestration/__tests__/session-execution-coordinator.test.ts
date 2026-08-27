import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test, vi } from 'vitest';
import { SessionExecutionCoordinator } from '../session-execution-coordinator.js';
import type { SessionTurnBoundaryAuthority } from '../session-turn-boundary.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function event(
  method: 'turn.started' | 'turn.completed' | 'turn.aborted',
  turnId: string,
): CanonicalRuntimeEvent {
  return {
    eventId: `${method}-${turnId}`,
    provider: 'claude',
    threadId: 'thread-1',
    createdAt: new Date().toISOString(),
    method,
    turnId,
  } as CanonicalRuntimeEvent;
}

describe('SessionExecutionCoordinator', () => {
  test('serializes distinct turn starts and fences lifecycle transitions', async () => {
    const coordinator = new SessionExecutionCoordinator();
    const release = deferred();
    const enteredSecondTurn = vi.fn();
    const enteredLifecycle = vi.fn();

    const first = coordinator.runTurnStart('thread-1', async () => {
      await release.promise;
      return 'first';
    });
    const second = coordinator.runTurnStart('thread-1', async () => {
      enteredSecondTurn();
      return 'second';
    });
    const lifecycle = coordinator.runLifecycleTransition(
      'thread-1',
      async () => {
        enteredLifecycle();
        return 'lifecycle';
      },
    );
    await Promise.resolve();
    expect(enteredSecondTurn).not.toHaveBeenCalled();
    expect(enteredLifecycle).not.toHaveBeenCalled();
    await expect(
      coordinator.runLifecycleTransition('thread-2', async () => 'parallel'),
    ).resolves.toBe('parallel');

    release.resolve();
    await expect(Promise.all([first, lifecycle, second])).resolves.toEqual([
      'first',
      'lifecycle',
      'second',
    ]);
    expect(enteredSecondTurn).toHaveBeenCalledOnce();
    expect(enteredLifecycle).toHaveBeenCalledOnce();
  });

  test('gives a queued lifecycle transition precedence over later turn starts', async () => {
    const coordinator = new SessionExecutionCoordinator();
    const releaseTurn = deferred();
    const releaseLifecycle = deferred();
    const laterTurn = vi.fn();

    const first = coordinator.runTurnStart('thread-1', async () => {
      await releaseTurn.promise;
    });
    const lifecycle = coordinator.runLifecycleTransition(
      'thread-1',
      async () => {
        await releaseLifecycle.promise;
      },
    );
    const queuedTurn = coordinator.runTurnStart('thread-1', async () => {
      laterTurn();
    });

    releaseTurn.resolve();
    await first;
    await Promise.resolve();
    expect(laterTurn).not.toHaveBeenCalled();
    releaseLifecycle.resolve();
    await lifecycle;
    await queuedTurn;
    expect(laterTurn).toHaveBeenCalledOnce();
  });

  test('retains provider acceptance until an exact terminal event', () => {
    const coordinator = new SessionExecutionCoordinator();
    coordinator.markTurnAccepted('thread-1', 'turn-1');
    expect(coordinator.hasActiveTurn('thread-1')).toBe(true);

    coordinator.observe(event('turn.started', 'turn-1'));
    coordinator.observe(event('turn.completed', 'turn-1'));
    expect(coordinator.hasActiveTurn('thread-1')).toBe(false);
  });

  test('does not resurrect a fast turn that completed before sendTurn resolved', async () => {
    const coordinator = new SessionExecutionCoordinator();
    await coordinator.runTurnStart('thread-1', async (claim) => {
      expect(claim.beginInvocation(new Date().toISOString())).toEqual({
        kind: 'applied',
      });
      coordinator.observe(event('turn.started', 'turn-fast'));
      coordinator.observe(event('turn.completed', 'turn-fast'));
      expect(coordinator.markTurnAccepted('thread-1', 'turn-fast')).toBe(false);
      expect(claim.terminalObserved('turn-fast')).toEqual({ kind: 'applied' });
      expect(coordinator.hasActiveTurn('thread-1')).toBe(false);
    });

    expect(coordinator.hasActiveTurn('thread-1')).toBe(false);
  });

  test('forgets fast-terminal evidence after its startup so a reused provider id is not suppressed', async () => {
    const coordinator = new SessionExecutionCoordinator();
    await coordinator.runTurnStart('thread-1', async (claim) => {
      claim.beginInvocation(new Date().toISOString());
      coordinator.observe(event('turn.started', 'provider-turn'));
      coordinator.observe(event('turn.completed', 'provider-turn'));
      expect(coordinator.markTurnAccepted('thread-1', 'provider-turn')).toBe(
        false,
      );
      claim.terminalObserved('provider-turn');
    });
    expect(coordinator.hasActiveTurn('thread-1')).toBe(false);

    await coordinator.runTurnStart('thread-1', async (claim) => {
      claim.beginInvocation(new Date().toISOString());
      coordinator.markTurnAccepted('thread-1', 'provider-turn');
      claim.accepted('provider-turn', new Date().toISOString());
    });
    expect(coordinator.hasActiveTurn('thread-1')).toBe(true);
  });

  test('does not let a fast terminal from one start suppress a concurrently queued reused id', async () => {
    const coordinator = new SessionExecutionCoordinator();
    const releaseFirst = deferred();
    const secondEntered = vi.fn();
    const first = coordinator.runTurnStart('thread-1', async (claim) => {
      claim.beginInvocation(new Date().toISOString());
      coordinator.observe(event('turn.started', 'reused-provider-turn'));
      coordinator.observe(event('turn.completed', 'reused-provider-turn'));
      expect(
        coordinator.markTurnAccepted('thread-1', 'reused-provider-turn'),
      ).toBe(false);
      claim.terminalObserved('reused-provider-turn');
      await releaseFirst.promise;
    });
    const second = coordinator.runTurnStart('thread-1', async (claim) => {
      secondEntered();
      claim.beginInvocation(new Date().toISOString());
      expect(
        coordinator.markTurnAccepted('thread-1', 'reused-provider-turn'),
      ).toBe(true);
      claim.accepted('reused-provider-turn', new Date().toISOString());
    });

    await Promise.resolve();
    expect(secondEntered).not.toHaveBeenCalled();
    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(secondEntered).toHaveBeenCalledOnce();
    expect(coordinator.hasActiveTurn('thread-1')).toBe(true);
  });

  test('releases local lifecycle admission when durable acquisition throws', async () => {
    const release = vi.fn(() => ({ kind: 'applied' as const }));
    const claimLifecycle = vi
      .fn<SessionTurnBoundaryAuthority['claimLifecycle']>()
      .mockImplementationOnce(() => {
        throw new Error('sqlite unavailable');
      })
      .mockReturnValue({ kind: 'owner', release });
    const boundaries = {
      claim: vi.fn(),
      claimLifecycle,
      hasPossibleEffect: vi.fn(() => ({ kind: 'available', active: false })),
      observe: vi.fn(() => ({ kind: 'applied' })),
      reconcile: vi.fn(() => ({ kind: 'available' })),
    } as unknown as SessionTurnBoundaryAuthority;
    const coordinator = new SessionExecutionCoordinator(boundaries);

    await expect(
      coordinator.runLifecycleTransition('thread-fault', async () => 'first'),
    ).rejects.toThrow('sqlite unavailable');
    await expect(
      coordinator.runLifecycleTransition('thread-fault', async () => 'second'),
    ).resolves.toBe('second');
    expect(release).toHaveBeenCalledOnce();
  });
});
