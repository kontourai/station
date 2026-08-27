import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import { describe, expect, test } from 'vitest';
import {
  OrchestrationStreamPresence,
  orchestrationStreamPresenceSubjectForSession,
} from '../orchestration-stream-presence.js';

function humanPrincipalFixture(subject: string): PrincipalRef {
  return {
    id: `human:tailscale-serve:${subject}`,
    kind: 'human',
    display: subject,
  };
}

describe('OrchestrationStreamPresence (station#1225)', () => {
  test('isConnected is false for a user with no connections', () => {
    const presence = new OrchestrationStreamPresence();
    expect(presence.isConnected('user-1')).toBe(false);
    expect(presence.hasAnyConnection()).toBe(false);
  });

  test('connect() marks a user connected until its disposer runs', () => {
    const presence = new OrchestrationStreamPresence();
    const disconnect = presence.connect('user-1');
    expect(presence.isConnected('user-1')).toBe(true);
    expect(presence.hasAnyConnection()).toBe(true);

    disconnect();
    expect(presence.isConnected('user-1')).toBe(false);
    expect(presence.hasAnyConnection()).toBe(false);
  });

  test('a user with two concurrent streams stays connected until BOTH disconnect', () => {
    const presence = new OrchestrationStreamPresence();
    const disconnectTabA = presence.connect('user-1');
    const disconnectTabB = presence.connect('user-1');
    expect(presence.isConnected('user-1')).toBe(true);

    disconnectTabA();
    expect(presence.isConnected('user-1')).toBe(true);

    disconnectTabB();
    expect(presence.isConnected('user-1')).toBe(false);
  });

  test('disconnecting the same connection twice is a safe no-op', () => {
    const presence = new OrchestrationStreamPresence();
    const disconnectTabA = presence.connect('user-1');
    presence.connect('user-1');
    disconnectTabA();
    disconnectTabA();
    // A double-release of tab A's own disposer must not also decrement tab
    // B's still-live connection.
    expect(presence.isConnected('user-1')).toBe(true);
  });

  test('presence is scoped per user', () => {
    const presence = new OrchestrationStreamPresence();
    const disconnect = presence.connect('user-1');
    expect(presence.isConnected('user-2')).toBe(false);
    disconnect();
    expect(presence.hasAnyConnection()).toBe(false);
  });

  test('hasAnyConnection is true when any user (not necessarily the queried one) is connected', () => {
    const presence = new OrchestrationStreamPresence();
    presence.connect('user-1');
    expect(presence.isConnected('user-2')).toBe(false);
    expect(presence.hasAnyConnection()).toBe(true);
  });

  test('keeps hosted presence separate for tenants that share a user', () => {
    const presence = new OrchestrationStreamPresence();
    const alpha = orchestrationStreamPresenceSubjectForSession('shared-user', {
      tenantId: 'alpha' as any,
      source: 'session',
    });
    const bravo = orchestrationStreamPresenceSubjectForSession('shared-user', {
      tenantId: 'bravo' as any,
      source: 'session',
    });

    const releaseAlpha = presence.connect(alpha);
    expect(presence.isConnected(alpha)).toBe(true);
    expect(presence.isConnected(bravo)).toBe(false);

    const releaseBravo = presence.connect(bravo);
    releaseAlpha();
    expect(presence.isConnected(alpha)).toBe(false);
    expect(presence.isConnected(bravo)).toBe(true);
    releaseBravo();
  });
});

describe('OrchestrationStreamPresence roster (station#4075 stage 3 slice 2)', () => {
  test('roster() is empty with no connections', () => {
    const presence = new OrchestrationStreamPresence();
    expect(presence.roster()).toEqual([]);
  });

  test('connect() with a principal retains it; disconnect() releases it exactly (symmetry)', () => {
    const presence = new OrchestrationStreamPresence();
    const alice = humanPrincipalFixture('alice');
    const disconnect = presence.connect('user-1', alice);

    expect(presence.roster()).toEqual([{ principal: alice, connections: 1 }]);

    disconnect();
    expect(presence.roster()).toEqual([]);
  });

  test('two concurrent connections for the same principal report connections: 2, and only the LAST disconnect clears the roster entry', () => {
    const presence = new OrchestrationStreamPresence();
    const alice = humanPrincipalFixture('alice');
    const disconnectA = presence.connect('user-1', alice);
    const disconnectB = presence.connect('user-1', alice);

    expect(presence.roster()).toEqual([{ principal: alice, connections: 2 }]);

    disconnectA();
    expect(presence.roster()).toEqual([{ principal: alice, connections: 1 }]);

    disconnectB();
    expect(presence.roster()).toEqual([]);
  });

  test('connect() without a principal (the test-only getUserId escape hatch) ref-counts but never appears in the roster', () => {
    const presence = new OrchestrationStreamPresence();
    const disconnect = presence.connect('user-1');

    expect(presence.isConnected('user-1')).toBe(true);
    expect(presence.roster()).toEqual([]);

    disconnect();
  });

  test('the roster is independent per distinct principal and reports each with its own count', () => {
    const presence = new OrchestrationStreamPresence();
    const alice = humanPrincipalFixture('alice');
    const bob = humanPrincipalFixture('bob');
    presence.connect('user-alice', alice);
    presence.connect('user-bob', bob);
    presence.connect('user-bob', bob);

    expect(presence.roster()).toEqual([
      { principal: alice, connections: 1 },
      { principal: bob, connections: 2 },
    ]);
  });

  test('roster capacity: a principal beyond the configured cap is never tracked in the roster, but its connection still counts for isConnected', () => {
    const presence = new OrchestrationStreamPresence({ rosterCapacity: 2 });
    const alice = humanPrincipalFixture('alice');
    const bob = humanPrincipalFixture('bob');
    const carol = humanPrincipalFixture('carol');
    presence.connect('user-alice', alice);
    presence.connect('user-bob', bob);
    presence.connect('user-carol', carol);

    // Overflow is explicit: only the first two distinct principals (in
    // connect order) are retained in the roster.
    expect(presence.roster()).toEqual([
      { principal: alice, connections: 1 },
      { principal: bob, connections: 1 },
    ]);
    // The overflowed connection is still a real, counted connection — the
    // push-on-completion gate's signal is completely unaffected by the
    // roster bound.
    expect(presence.isConnected('user-carol')).toBe(true);
  });

  test('roster capacity freed by a full disconnect admits a later distinct principal', () => {
    const presence = new OrchestrationStreamPresence({ rosterCapacity: 1 });
    const alice = humanPrincipalFixture('alice');
    const bob = humanPrincipalFixture('bob');
    const disconnectAlice = presence.connect('user-alice', alice);
    presence.connect('user-bob', bob);
    expect(presence.roster()).toEqual([{ principal: alice, connections: 1 }]);

    disconnectAlice();
    // A NEW connect() call for bob (not a retroactive update of the earlier
    // overflowed one) is what gets tracked once capacity frees up — its
    // count starts fresh at 1, since the first (refused) connection was
    // never retained in the roster to begin with.
    presence.connect('user-bob', bob);
    expect(presence.roster()).toEqual([{ principal: bob, connections: 1 }]);
  });

  test('per-principal connection cap: the reported count saturates, but the real ref count still balances every connect() with its disconnect()', () => {
    const presence = new OrchestrationStreamPresence({
      rosterConnectionsPerPrincipalCapacity: 2,
    });
    const alice = humanPrincipalFixture('alice');
    const disconnect1 = presence.connect('user-1', alice);
    const disconnect2 = presence.connect('user-1', alice);
    const disconnect3 = presence.connect('user-1', alice);

    // Reported count saturates at the cap, not the real refs (3).
    expect(presence.roster()).toEqual([{ principal: alice, connections: 2 }]);
    expect(presence.isConnected('user-1')).toBe(true);

    disconnect1();
    // Real refs (3 -> 2) is still above the cap, so the report is unchanged.
    expect(presence.roster()).toEqual([{ principal: alice, connections: 2 }]);

    disconnect2();
    // Real refs now 1 — below the cap, so the report reflects it exactly.
    expect(presence.roster()).toEqual([{ principal: alice, connections: 1 }]);

    disconnect3();
    // The third disconnect() exactly balances the third connect(): the
    // entry is fully released, not left dangling by the earlier saturation.
    expect(presence.roster()).toEqual([]);
    expect(presence.isConnected('user-1')).toBe(false);
  });

  test('disconnecting the same connection twice does not double-release the principal roster entry', () => {
    const presence = new OrchestrationStreamPresence();
    const alice = humanPrincipalFixture('alice');
    const disconnectA = presence.connect('user-1', alice);
    presence.connect('user-1', alice);
    disconnectA();
    disconnectA();

    expect(presence.roster()).toEqual([{ principal: alice, connections: 1 }]);
  });

  test('onRosterOp reports retain/release/capacity without exposing principal identity', () => {
    const ops: Array<'retain' | 'release' | 'capacity'> = [];
    const presence = new OrchestrationStreamPresence({
      rosterCapacity: 1,
      onRosterOp: (op) => ops.push(op),
    });
    const alice = humanPrincipalFixture('alice');
    const bob = humanPrincipalFixture('bob');
    const disconnectAlice = presence.connect('user-alice', alice);
    presence.connect('user-bob', bob); // refused: over capacity
    disconnectAlice();

    expect(ops).toEqual(['retain', 'capacity', 'release']);
  });

  test('roster() is sorted deterministically by principal id', () => {
    const presence = new OrchestrationStreamPresence();
    const zed = humanPrincipalFixture('zed');
    const alice = humanPrincipalFixture('alice');
    presence.connect('user-zed', zed);
    presence.connect('user-alice', alice);

    expect(presence.roster().map((entry) => entry.principal.id)).toEqual([
      alice.id,
      zed.id,
    ]);
  });
});
