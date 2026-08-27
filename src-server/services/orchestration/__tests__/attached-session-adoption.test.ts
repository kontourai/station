import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrchestrationCommandReceipt } from '@kontourai/station-contracts/orchestration';
import type { ProviderSession } from '@kontourai/station-contracts/provider';
import { describe, expect, it } from 'vitest';
import type {
  AdoptionLedger,
  AdoptionReservation,
} from '../adoption-ledger.js';
import {
  AttachedSessionAdoption,
  type AttachedSessionAdoptionDeps,
} from '../attached-session-adoption.js';
import type { EventStore } from '../event-store.js';

/**
 * Unit pins for the C14 extraction (epic #4024 slice 3, #4143). Three
 * contracts the seam map calls identity-critical and the service suite
 * cannot see from outside the collaborator:
 *
 * 1. `startReconciliation()` stores AND returns the same promise `adopt()`
 *    later awaits, with no internal catch — a rejected reclamation must
 *    fail the adoption path, never silently proceed against an unreclaimed
 *    ledger (plan §4).
 * 2. `registerOwner()`/`unregisterOwner()` toggle whether THIS instance's
 *    reservations count as live to reconciliation — the reason they are
 *    wired from `initialize()`/`shutdown()` and never the constructor.
 * 3. The idempotency-intent map is scoped per caller: this pin varies
 *    USER only (a caller cannot join another user's in-flight intent by
 *    presenting the same idempotency key); the source/tenant components of
 *    the key are not separately pinned here.
 */

function makeDeps(overrides: Partial<AttachedSessionAdoptionDeps> = {}) {
  const counters = { liveSessions: 0, persistReceipt: 0 };
  const deps: AttachedSessionAdoptionDeps = {
    adapterRegistry: { get: () => undefined },
    logger: { warn: () => {} },
    canReadSessionForCommand: () => true,
    tenantContextFor: () => undefined,
    liveSessions: () => {
      counters.liveSessions += 1;
      return [] as ProviderSession[];
    },
    trackSession: () => {},
    evictCollidingAttachedAliases: () => {},
    persistReceipt: () => {
      counters.persistReceipt += 1;
    },
    requireAdapter: () => {
      throw new Error('requireAdapter should not be reached in these pins');
    },
    assertAdapterCurrent: () => {},
    assertAdapterReady: async () => {},
    withAcceptedModelLaunchPlan: (_adapter, input) => input,
    recordAcceptedModelLaunchPlan: () => {},
    modelLaunchPlanFromInput: () => {
      throw new Error('modelLaunchPlanFromInput should not be reached');
    },
    modelLaunchRequestedOverrideFromInput: () => false,
    forgetAbandonedAdoptionMemory: () => {},
    logCleanupFailure: () => {},
    ...overrides,
  };
  return { deps, counters };
}

function reservation(
  fields: Partial<AdoptionReservation>,
): AdoptionReservation {
  return {
    reservationId: 'res-1',
    targetThreadId: 'target-1',
    sourceThreadId: 'source-1',
    provider: 'claude',
    status: 'pending',
    ownerId: 'owner-1',
    ownerPid: process.pid,
    ...fields,
  } as AdoptionReservation;
}

const receipt = () =>
  ({ commandId: 'cmd-1', status: 'accepted' }) as OrchestrationCommandReceipt;

describe('AttachedSessionAdoption', () => {
  it('startReconciliation stores and returns the same rejecting promise adopt() awaits — no internal catch', async () => {
    const boom = new Error('ledger read failed');
    const ledger = {
      reservations: () => {
        throw boom;
      },
    } as unknown as AdoptionLedger;
    const { deps } = makeDeps({ adoptionLedger: ledger });
    const adoption = new AttachedSessionAdoption(deps);

    const kicked = adoption.startReconciliation();
    await expect(kicked).rejects.toBe(boom);

    // Identity, observed behaviorally: adopt()'s first await is the STORED
    // reconciliation promise, so the same rejection (same object) gates it.
    await expect(adoption.adopt('source-1', receipt())).rejects.toBe(boom);
  });

  it('registerOwner/unregisterOwner toggle reservation liveness for reconciliation', async () => {
    const reclaimOwnerIds: string[] = [];
    let pending: AdoptionReservation[] = [];
    const ledger = {
      reservations: () => pending,
      reclaim: (input: { ownerId: string }) => {
        reclaimOwnerIds.push(input.ownerId);
        return undefined; // not reclaimed as owner → reconcile skips cleanup
      },
    } as unknown as AdoptionLedger;
    const { deps } = makeDeps({
      adoptionLedger: ledger,
      adapterRegistry: {
        get: () =>
          ({ discardSession: async () => {} }) as unknown as ReturnType<
            AttachedSessionAdoptionDeps['adapterRegistry']['get']
          >,
      },
    });
    const adoption = new AttachedSessionAdoption(deps);

    // A reservation held by an unknown owner in THIS pid is dead: reclaim is
    // attempted, and its call hands us the instance's own ownerId.
    pending = [reservation({ ownerId: 'no-such-owner' })];
    await adoption.startReconciliation();
    expect(reclaimOwnerIds).toHaveLength(1);
    const instanceOwnerId = reclaimOwnerIds[0]!;

    // The instance's OWN reservation, before registerOwner(): still dead.
    pending = [reservation({ ownerId: instanceOwnerId })];
    await adoption.startReconciliation();
    expect(reclaimOwnerIds).toHaveLength(2);

    // After registerOwner(): live — reconciliation must skip it.
    adoption.registerOwner();
    await adoption.startReconciliation();
    expect(reclaimOwnerIds).toHaveLength(2);

    // After unregisterOwner(): dead again.
    adoption.unregisterOwner();
    await adoption.startReconciliation();
    expect(reclaimOwnerIds).toHaveLength(3);
  });

  it('idempotency intents are scoped by user — a different user never joins, the same scope does', async () => {
    const { deps, counters } = makeDeps({
      eventStore: {
        readSessions: () => [],
      } as unknown as EventStore,
    });
    const adoption = new AttachedSessionAdoption(deps);

    // Issue all three in one tick so the first intent is still in-flight
    // when the later calls consult the map.
    const p1 = adoption.adopt('source-1', receipt(), 'user-a', undefined, 'k1');
    const p2 = adoption.adopt('source-1', receipt(), 'user-b', undefined, 'k1');
    const p3 = adoption.adopt('source-1', receipt(), 'user-a', undefined, 'k1');
    const [r1, r2, r3] = await Promise.allSettled([p1, p2, p3]);

    // All reject (no adoptable source exists), but HOW they reject is the
    // contract: p1 and p2 each ran their own resolution (two liveSessions
    // scans — user-b did NOT join user-a's intent despite the shared key),
    // while p3 joined p1's intent (no third scan, and the very same error
    // object propagates through the join).
    expect(r1.status).toBe('rejected');
    expect(r2.status).toBe('rejected');
    expect(r3.status).toBe('rejected');
    // 2 = p1 and p2 each ran their own resolution; this count is the ONLY
    // observable proving p2 (different user, same key) did not join. It
    // depends on which early guard throws first — a legitimate guard
    // reordering may change it; re-derive rather than loosen.
    expect(counters.liveSessions).toBe(2);
    expect((r3 as PromiseRejectedResult).reason).toBe(
      (r1 as PromiseRejectedResult).reason,
    );
    // The joiner rejected before its receipt persistence step.
    expect(counters.persistReceipt).toBe(0);
  });
});

describe('service wiring source invariants (plan condition 3)', () => {
  /**
   * `registerOwner()` must be wired from `initialize()` and
   * `unregisterOwner()` from `shutdown()` — NEVER the service constructor.
   * The suite cannot observe this behaviorally (a constructed-but-never-
   * initialized service cannot own a reservation, so no runtime probe can
   * distinguish the two wirings), and the fault injection that moved
   * registration into the constructor ran 355/355 green — this source
   * invariant is the guard, same technique as slice 2's teardown-site
   * invariant.
   */
  it('registers the adoption owner from initialize(), never the constructor', () => {
    const source = readFileSync(
      join(__dirname, '..', 'orchestration-service.ts'),
      'utf8',
    );
    const register = 'this.adoption.registerOwner();';
    const unregister = 'this.adoption.unregisterOwner();';
    expect(source.split(register).length - 1).toBe(1);
    expect(source.split(unregister).length - 1).toBe(1);

    const initializeAt = source.indexOf('\n  initialize(): void {');
    const shutdownAt = source.indexOf('\n  async shutdown(): Promise<void> {');
    expect(initializeAt).toBeGreaterThan(0);
    expect(shutdownAt).toBeGreaterThan(0);
    // Containment in the METHOD BODY, not merely "after the declaration"
    // (review round 1: an after-the-marker index check stays green if the
    // call migrates into any later method). A method body ends at the first
    // method-level close (`\n  }`) after its declaration — inside a body
    // every close is indented deeper, so this is exact for this file.
    const initializeBody = source.slice(
      initializeAt,
      source.indexOf('\n  }', initializeAt),
    );
    const shutdownBody = source.slice(
      shutdownAt,
      source.indexOf('\n  }', shutdownAt),
    );
    expect(initializeBody).toContain(register);
    expect(shutdownBody).toContain(unregister);
  });
});
