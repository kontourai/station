import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { DEFAULT_TURN_STALL_WINDOW_MS } from '@kontourai/station-contracts/turn-stall-window';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnProgressTracker } from '../turn-progress-tracker.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  orchestrationTurnStallDetections: { add: vi.fn() },
}));

/**
 * Unit contract for the collaborator extracted in epic #4024 slice 1
 * (#4116). The service-level turn-stall describe exercises the seam through
 * the service; these pin the two module obligations nothing there covers
 * (seam map follow-up N5): `forgetThread` must clear the pinned window so a
 * stale window never applies to the thread's NEXT session, and `dispose`
 * must cancel armed watches so no timer outlives the service.
 */
describe('TurnProgressTracker', () => {
  const PINNED_MS = 5_000;
  let warns: unknown[][];
  let projectionChanges: string[];
  let tracker: TurnProgressTracker;

  const event = (
    method: string,
    threadId: string,
    turnId: string,
  ): CanonicalRuntimeEvent =>
    ({
      method,
      threadId,
      turnId,
      provider: 'bedrock',
      createdAt: new Date().toISOString(),
    }) as unknown as CanonicalRuntimeEvent;

  beforeEach(() => {
    vi.useFakeTimers();
    warns = [];
    projectionChanges = [];
    tracker = new TurnProgressTracker({
      providerForThread: () => 'bedrock',
      loadAgentExecutionConfig: async () => ({
        turnStallWindowMs: PINNED_MS,
      }),
      publishProjectionChange: (threadId) => projectionChanges.push(threadId),
      logger: {
        warn: (...args: unknown[]) => warns.push(args),
      },
    });
  });

  afterEach(() => {
    tracker.dispose();
    vi.useRealTimers();
  });

  const armTurn = (threadId: string, turnId: string) => {
    tracker.observe(event('turn.started', threadId, turnId));
    tracker.observe(event('message.delta', threadId, turnId));
  };

  it('a silent turn stalls at the pinned per-agent window and writes the silence marker', async () => {
    await tracker.setWindow('t1', 'agent');
    armTurn('t1', 'turn-1');
    vi.advanceTimersByTime(PINNED_MS - 1);
    expect(warns).toHaveLength(0);
    vi.advanceTimersByTime(2);
    expect(warns).toHaveLength(1);
    const marker = tracker.read('t1');
    expect(marker?.progressSilence?.windowMs).toBe(PINNED_MS);
    expect(projectionChanges).toContain('t1');
  });

  it('forgetThread clears the pinned window — the NEXT session gets the default, not a stale override', async () => {
    await tracker.setWindow('t1', 'agent');
    tracker.forgetThread('t1');
    expect(tracker.read('t1')).toBeUndefined();

    armTurn('t1', 'turn-2');
    // At the stale pinned window: nothing may fire.
    vi.advanceTimersByTime(PINNED_MS + 1);
    expect(warns).toHaveLength(0);
    // At the default window: detection still works (forget did not disable it).
    vi.advanceTimersByTime(DEFAULT_TURN_STALL_WINDOW_MS);
    expect(warns).toHaveLength(1);
  });

  it('forgetThread cancels an armed watch mid-turn', async () => {
    await tracker.setWindow('t1', 'agent');
    armTurn('t1', 'turn-3');
    tracker.forgetThread('t1');
    vi.advanceTimersByTime(DEFAULT_TURN_STALL_WINDOW_MS * 2);
    expect(warns).toHaveLength(0);
    expect(tracker.read('t1')).toBeUndefined();
  });

  it('dispose cancels every armed watch — no timer outlives the service', async () => {
    await tracker.setWindow('t1', 'agent');
    armTurn('t1', 'turn-4');
    armTurn('t2', 'turn-5');
    tracker.dispose();
    vi.advanceTimersByTime(DEFAULT_TURN_STALL_WINDOW_MS * 2);
    expect(warns).toHaveLength(0);
  });
});
