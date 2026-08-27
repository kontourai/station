import { describe, expect, it } from 'vitest';
import {
  ClientOriginTurnPropagation,
  withClientOrigin,
} from '../client-origin-propagation.js';

const origin = {
  version: 1 as const,
  actor: { kind: 'device' as const, deviceId: 'device-1' },
  reported: { version: 1 as const, surface: 'mobile' as const, build: '1.0.0' },
};

describe('client origin propagation', () => {
  it('buffers an event emitted before provider acceptance and binds it by exact turn', () => {
    const propagation = new ClientOriginTurnPropagation();
    propagation.begin('thread-1', origin);
    const early = propagation.apply({
      eventId: 'event-1',
      provider: 'test',
      threadId: 'thread-1',
      createdAt: '2026-08-23T00:00:00.000Z',
      method: 'turn.started',
      turnId: 'turn-1',
    });
    expect(early).toBeUndefined();
    const started = propagation.settle('thread-1', 'turn-1', origin);
    expect(started?.clientOrigin).toEqual(origin);
    expect(
      propagation.apply({ ...started!, eventId: 'event-2' })?.clientOrigin,
    ).toEqual(origin);
    expect(
      withClientOrigin(
        { clientOrigin: origin },
        { ...origin, actor: { kind: 'operator' } },
      ),
    ).toEqual({ clientOrigin: origin });
  });

  it('retires an in-flight origin when a terminal arrives without a start', () => {
    const propagation = new ClientOriginTurnPropagation();
    propagation.begin('thread-2', origin);
    propagation.retire('thread-2', undefined);
    expect(
      propagation.apply({
        eventId: 'event-3',
        provider: 'test',
        threadId: 'thread-2',
        createdAt: '2026-08-23T00:00:00.000Z',
        method: 'turn.started',
        turnId: 'turn-2',
      })?.clientOrigin,
    ).toBeUndefined();
  });

  it('degrades an early event honestly when the bounded buffer is full', () => {
    const propagation = new ClientOriginTurnPropagation();
    for (
      let index = 0;
      index < ClientOriginTurnPropagation.MAX_PENDING;
      index++
    ) {
      propagation.begin(`thread-${index}`, origin);
      propagation.apply({
        eventId: `event-${index}`,
        provider: 'test',
        threadId: `thread-${index}`,
        createdAt: '2026-08-23T00:00:00.000Z',
        method: 'turn.started',
        turnId: `turn-${index}`,
      });
    }
    propagation.begin('overflow', origin);
    expect(
      propagation.apply({
        eventId: 'overflow',
        provider: 'test',
        threadId: 'overflow',
        createdAt: '2026-08-23T00:00:00.000Z',
        method: 'turn.started',
        turnId: 'turn-overflow',
      })?.clientOrigin,
    ).toBeUndefined();
  });

  // station#4075 stage 2: generalized to also propagate the dispatching/
  // steering PrincipalRef through the same begin/settle/apply lifecycle.
  describe('principal propagation (station#4075 stage 2)', () => {
    const dispatchingPrincipal = {
      id: 'human:tailscale-serve:alice',
      kind: 'human' as const,
      display: 'Alice',
    };
    const steeringPrincipal = {
      id: 'human:tailscale-serve:bob',
      kind: 'human' as const,
      display: 'Bob',
    };

    it('buffers an early turn.started and stamps BOTH clientOrigin and principal on settle', () => {
      const propagation = new ClientOriginTurnPropagation();
      propagation.begin('thread-p1', origin, dispatchingPrincipal);
      const early = propagation.apply({
        eventId: 'event-p1',
        provider: 'test',
        threadId: 'thread-p1',
        createdAt: '2026-08-23T00:00:00.000Z',
        method: 'turn.started',
        turnId: 'turn-p1',
      });
      expect(early).toBeUndefined();
      const started = propagation.settle(
        'thread-p1',
        'turn-p1',
        origin,
        dispatchingPrincipal,
      );
      expect(started?.principal).toEqual(dispatchingPrincipal);
      expect(started?.clientOrigin).toEqual(origin);
    });

    it('stamps principal on a turn.started that arrives AFTER settle (the #accepted path)', () => {
      const propagation = new ClientOriginTurnPropagation();
      propagation.begin('thread-p2', undefined, dispatchingPrincipal);
      const settleResult = propagation.settle(
        'thread-p2',
        'turn-p2',
        undefined,
        dispatchingPrincipal,
      );
      // Nothing buffered yet, so settle has nothing to return.
      expect(settleResult).toBeUndefined();
      const applied = propagation.apply({
        eventId: 'event-p2',
        provider: 'test',
        threadId: 'thread-p2',
        createdAt: '2026-08-23T00:00:00.000Z',
        method: 'turn.started',
        turnId: 'turn-p2',
      });
      expect(applied?.principal).toEqual(dispatchingPrincipal);
      expect(applied?.clientOrigin).toBeUndefined();
    });

    it('distinguishes a dispatching principal from a later steering principal on DIFFERENT turns', () => {
      const propagation = new ClientOriginTurnPropagation();
      // Turn A: dispatched by alice.
      propagation.begin('thread-p3', origin, dispatchingPrincipal);
      const dispatchApplied = propagation.apply({
        eventId: 'event-p3-start',
        provider: 'test',
        threadId: 'thread-p3',
        createdAt: '2026-08-23T00:00:00.000Z',
        method: 'turn.started',
        turnId: 'turn-p3',
      });
      expect(dispatchApplied).toBeUndefined();
      const dispatchStarted = propagation.settle(
        'thread-p3',
        'turn-p3',
        origin,
        dispatchingPrincipal,
      );
      expect(dispatchStarted?.principal).toEqual(dispatchingPrincipal);

      // Same turn, steered by bob (inputKind: 'steer', SAME turnId reused).
      propagation.begin('thread-p3', origin, steeringPrincipal);
      const steerApplied = propagation.apply({
        eventId: 'event-p3-steer',
        provider: 'test',
        threadId: 'thread-p3',
        createdAt: '2026-08-23T00:01:00.000Z',
        method: 'turn.started',
        turnId: 'turn-p3',
        inputKind: 'steer',
      });
      // Buffered as early (in-flight from the new begin()), not yet settled.
      expect(steerApplied).toBeUndefined();
      const steerStarted = propagation.settle(
        'thread-p3',
        'turn-p3',
        origin,
        steeringPrincipal,
      );
      expect(steerStarted?.principal).toEqual(steeringPrincipal);
      expect(steerStarted?.principal).not.toEqual(dispatchStarted?.principal);
    });

    it('is a no-op when neither clientOrigin nor principal is supplied', () => {
      const propagation = new ClientOriginTurnPropagation();
      expect(propagation.begin('thread-p4', undefined, undefined)).toBe(false);
      expect(
        propagation.settle('thread-p4', 'turn-p4', undefined, undefined),
      ).toBeUndefined();
    });
  });
});
