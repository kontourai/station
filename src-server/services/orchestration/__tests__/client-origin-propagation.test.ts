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

  it('#4827 fix round 2: stamps a composer send as the person and drops an adapter-supplied mark', () => {
    const propagation = new ClientOriginTurnPropagation();
    const base = {
      provider: 'test',
      createdAt: '2026-11-12T00:00:00.000Z',
      method: 'turn.started' as const,
    };
    propagation.begin(
      'thread-a',
      origin,
      undefined,
      undefined,
      undefined,
      'interactive',
      undefined,
      'person',
    );
    propagation.settle('thread-a', 'turn-a', origin);
    const marked = propagation.apply({
      ...base,
      threadId: 'thread-a',
      eventId: 'e-a',
      turnId: 'turn-a',
    });
    expect(marked?.method === 'turn.started' && marked.authoredBy).toBe(
      'person',
    );

    propagation.begin('thread-b', origin);
    propagation.settle('thread-b', 'turn-b', origin);
    const claimed = propagation.apply({
      ...base,
      threadId: 'thread-b',
      eventId: 'e-b',
      turnId: 'turn-b',
      authoredBy: 'person',
    });
    expect(claimed && 'authoredBy' in claimed).toBe(false);
  });

  it('#4827: stamps an admitted MCP prompt as such and drops an adapter-supplied prompt source', () => {
    const propagation = new ClientOriginTurnPropagation();
    const base = {
      provider: 'test',
      createdAt: '2026-11-12T00:00:00.000Z',
      method: 'turn.started' as const,
    };
    propagation.begin(
      'thread-m',
      origin,
      undefined,
      undefined,
      undefined,
      'interactive',
      'mcp-prompt',
    );
    const settled = propagation.settle('thread-m', 'turn-m', origin);
    expect(settled).toBeUndefined();
    const stamped = propagation.apply({
      ...base,
      threadId: 'thread-m',
      eventId: 'e-m',
      turnId: 'turn-m',
    });
    expect(stamped?.method === 'turn.started' && stamped.promptSource).toBe(
      'mcp-prompt',
    );

    // An ordinary send gets none, and an adapter cannot claim one.
    propagation.begin('thread-p', origin);
    propagation.settle('thread-p', 'turn-p', origin);
    const plain = propagation.apply({
      ...base,
      threadId: 'thread-p',
      eventId: 'e-p',
      turnId: 'turn-p',
      promptSource: 'mcp-prompt',
    });
    expect(plain?.method === 'turn.started' && plain.clientOrigin).toEqual(
      origin,
    );
    expect(plain && 'promptSource' in plain).toBe(false);
  });

  it('#4512: stamps a classified dispatch origin, holding an early start of a send with no client origin', () => {
    const propagation = new ClientOriginTurnPropagation();
    const base = {
      provider: 'test',
      createdAt: '2026-11-04T00:00:00.000Z',
      method: 'turn.started' as const,
    };
    // A delegated first turn carries no client origin or principal; its
    // origin alone reserves the turn, so a start the engine reports before
    // acceptance is held and stamped rather than published as unknown.
    expect(
      propagation.begin(
        'thread-d',
        undefined,
        undefined,
        undefined,
        undefined,
        'delegation',
      ),
    ).toBe(true);
    expect(
      propagation.apply({
        ...base,
        threadId: 'thread-d',
        eventId: 'e-d1',
        turnId: 'turn-d1',
        // An adapter cannot name its own origin.
        dispatchOrigin: 'interactive',
      }),
    ).toBeUndefined();
    const settled = propagation.settle(
      'thread-d',
      'turn-d1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'delegation',
    );
    expect(settled?.method === 'turn.started' && settled.dispatchOrigin).toBe(
      'delegation',
    );
    // `unknown` reserves nothing and is stamped only on a late start.
    expect(
      propagation.begin(
        'thread-u',
        undefined,
        undefined,
        undefined,
        undefined,
        'unknown',
      ),
    ).toBe(false);
    // With no attribution at all, an adapter-supplied origin is dropped.
    const unattributed = propagation.apply({
      ...base,
      threadId: 'thread-x',
      eventId: 'e-x1',
      turnId: 'turn-x1',
      dispatchOrigin: 'task-dispatch',
    });
    expect(unattributed).toBeDefined();
    expect(
      unattributed?.method === 'turn.started' &&
        'dispatchOrigin' in unattributed,
    ).toBe(false);
  });

  it('stamps the send key on the turn that send started, and never believes an adapter-supplied key', () => {
    const propagation = new ClientOriginTurnPropagation();
    const base = {
      provider: 'test',
      threadId: 'thread-k',
      createdAt: '2026-10-13T00:00:00.000Z',
      method: 'turn.started' as const,
    };
    // A user send (it has an origin) holds its early start and stamps it.
    expect(
      propagation.begin('thread-k', origin, undefined, undefined, 'key-1'),
    ).toBe(true);
    expect(
      propagation.apply({ ...base, eventId: 'e-1', turnId: 'turn-k1' }),
    ).toBeUndefined();
    const settled = propagation.settle('thread-k', 'turn-k1', origin);
    expect(settled?.method === 'turn.started' && settled.clientTurnId).toBe(
      'key-1',
    );
    // A key alone holds nothing back (an internal keyed send's events keep
    // flowing); a start arriving after acceptance is still stamped.
    expect(
      propagation.begin('thread-i', undefined, undefined, undefined, 'key-2'),
    ).toBe(false);
    expect(
      propagation.settle(
        'thread-i',
        'turn-i1',
        undefined,
        undefined,
        undefined,
        'key-2',
      ),
    ).toBeUndefined();
    const late = propagation.apply({
      ...base,
      threadId: 'thread-i',
      eventId: 'e-3',
      turnId: 'turn-i1',
    });
    expect(late?.method === 'turn.started' && late.clientTurnId).toBe('key-2');
    // No reservation: an adapter's own claim of a key is stripped.
    const forged = propagation.apply({
      ...base,
      eventId: 'e-2',
      turnId: 'turn-k2',
      clientTurnId: 'someone-elses-key',
    });
    expect(forged).toBeDefined();
    expect(forged && 'clientTurnId' in forged).toBe(false);
  });

  it.each(['early', 'late'])(
    'binds a legacy %s start only to its accepted turn',
    (timing) => {
      const propagation = new ClientOriginTurnPropagation();
      propagation.begin('legacy', origin, undefined, undefined, 'trusted-key');
      propagation.bindInvocation('legacy', 'invocation');
      const event = {
        eventId: 'legacy-event',
        provider: 'test',
        threadId: 'legacy',
        createdAt: '2026-10-22T00:00:00.000Z',
        method: 'turn.started' as const,
        turnId: 'accepted-turn',
        clientTurnId: 'forged-key',
      };
      expect(
        propagation.apply({ ...event, invocationId: 'other' }),
      ).not.toHaveProperty('clientTurnId');
      if (timing === 'early') expect(propagation.apply(event)).toBeUndefined();
      propagation.settle(
        'legacy',
        'accepted-turn',
        origin,
        undefined,
        undefined,
        'trusted-key',
        'invocation',
      );
      const result =
        timing === 'early'
          ? propagation.takeLegacyRouting('legacy', 'accepted-turn')
          : propagation.apply(event);
      expect(result).toMatchObject({
        turnId: 'accepted-turn',
        clientTurnId: 'trusted-key',
        clientOrigin: origin,
      });
      expect(
        propagation.apply({ ...event, turnId: 'unrelated' }),
      ).not.toHaveProperty('clientTurnId');
    },
  );

  it('a send that fails before acceptance hands back the start it held, instead of losing it', () => {
    const propagation = new ClientOriginTurnPropagation();
    propagation.begin('thread-c', origin);
    const start = {
      eventId: 'event-c',
      provider: 'test',
      threadId: 'thread-c',
      createdAt: '2026-10-13T00:00:00.000Z',
      method: 'turn.started' as const,
      turnId: 'turn-c',
    };
    expect(propagation.apply(start)).toBeUndefined();
    expect(propagation.cancel('thread-c')).toEqual([start]);
    expect(propagation.cancel('thread-c')).toEqual([]);
  });

  it('#2324: passes a provider-triggered start straight through while a send holds a reservation', () => {
    const propagation = new ClientOriginTurnPropagation();
    propagation.begin('thread-p', origin);
    const providerStart = {
      eventId: 'event-p',
      provider: 'claude' as const,
      threadId: 'thread-p',
      createdAt: '2026-09-23T00:00:00.000Z',
      method: 'turn.started' as const,
      turnId: 'provider:p-1',
      metadata: { trigger: 'provider' },
    };
    // Not held for the in-flight send, and never given its origin.
    expect(propagation.apply(providerStart)).toEqual(providerStart);
    // The send's own start is still held and bound on settle.
    expect(
      propagation.apply({
        ...providerStart,
        eventId: 'event-send',
        turnId: 'send-1',
        metadata: undefined,
      }),
    ).toBeUndefined();
    expect(
      propagation.settle('thread-p', 'send-1', origin)?.clientOrigin,
    ).toEqual(origin);
    // Retiring the reservation drops nothing the provider turn owns.
    propagation.begin('thread-p', origin);
    propagation.retire('thread-p', undefined);
    expect(propagation.apply(providerStart)).toEqual(providerStart);
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

  // archive#4075 stage 2: generalized to also propagate the dispatching/
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

it('keeps old and untagged starts away from a pending invocation without rewriting origin', () => {
  const propagation = new ClientOriginTurnPropagation();
  expect(propagation.begin('t', origin, undefined, undefined, 'B-key')).toBe(
    true,
  );
  propagation.bindInvocation('t', 'B');
  const base = {
    method: 'turn.started' as const,
    eventId: 'start',
    provider: 'claude',
    threadId: 't',
    turnId: 'N',
    createdAt: '2030-01-01T00:00:00Z',
  };
  for (const invocationId of ['A', undefined]) {
    expect(
      propagation.apply({ ...base, invocationId })?.clientOrigin,
    ).toBeUndefined();
    propagation.retire('t', undefined, 'A');
  }
  expect(
    propagation.apply({ ...base, eventId: 'B', invocationId: 'B' }),
  ).toBeUndefined();
  const accepted = propagation.settle(
    't',
    'N',
    origin,
    undefined,
    undefined,
    'B-key',
    'B',
  );
  expect(accepted).toMatchObject({
    invocationId: 'B',
    clientTurnId: 'B-key',
    clientOrigin: origin,
  });
});
