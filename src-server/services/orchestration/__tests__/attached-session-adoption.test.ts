import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { OrchestrationCommandReceipt } from '@kontourai/station-contracts/orchestration';
import type { ProviderSession } from '@kontourai/station-contracts/provider';
import { describe, expect, it, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type {
  AdoptionLedger,
  AdoptionReservation,
} from '../adoption-ledger.js';
import {
  AttachedSessionAdoption,
  type AttachedSessionAdoptionDeps,
} from '../attached-session-adoption.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

/**
 * Unit pins for the C14 extraction (epic archive#4024, archive#4143). Three
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
  it('rejects unsupported external continuation before resolving or invoking an adapter', async () => {
    const source: ProviderSession = {
      provider: 'acp',
      threadId: 'external:acp:fixture',
      status: 'ready',
      cwd: '/fixture/project',
      controlMode: 'read-only-attached',
      attachedSource: {
        kind: 'fixture-source',
        externalSessionId: 'native-source',
      },
      createdAt: '2026-09-06T00:00:00Z',
      updatedAt: '2026-09-06T00:00:00Z',
    };
    let adapterRequests = 0;
    const { deps } = makeDeps({
      eventStore: { readSessions: () => [source] } as unknown as EventStore,
      listProjects: () => [
        { slug: 'project', workingDirectory: '/fixture/project' },
      ],
      requireAdapter: () => {
        adapterRequests += 1;
        throw new Error('must not invoke');
      },
    });
    await expect(
      new AttachedSessionAdoption(deps).adopt(source.threadId, receipt()),
    ).rejects.toThrow(
      'Station has not established independent continuation support for this engine.',
    );
    expect(adapterRequests).toBe(0);
  });

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

describe('service owner wiring (plan condition 3)', () => {
  const makeTempDir = trackTempDirs();

  /**
   * The service vouches for its reservations from `initialize()` (which
   * every dispatch runs first) until `shutdown()`. While it runs, another
   * instance's boot reconciliation must leave its reservation alone; once it
   * has shut down, the reservation is dead and the next boot reclaims it.
   * Observed through real services sharing one ledger.
   */
  it("a running service's reservation survives another boot, and is reclaimed once it shuts down", async () => {
    const directory = realpathSync(makeTempDir('station-adoption-owner-'));
    const cwd = join(directory, 'project');
    mkdirSync(cwd);
    const store = new EventStore(join(directory, 'events.sqlite'));
    const ledger = store.createAdoptionLedger();
    const now = '2026-09-06T00:00:00.000Z';
    const source: ProviderSession = {
      provider: 'claude',
      threadId: 'external:claude:fixture',
      cwd,
      status: 'ready',
      controlMode: 'read-only-attached',
      attachedSource: {
        kind: 'claude-transcript',
        externalSessionId: 'native-source',
        affinity: { kind: 'fixture-home', ref: 'admitted-source' },
      },
      createdAt: now,
      updatedAt: now,
    };
    store.upsertSession(source);
    let releaseAdoption: (error: Error) => void = () => {};
    let adoptionStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      adoptionStarted = resolve;
    });
    let providerAdoptions = 0;
    class AdoptingAdapter extends GateTestAdapter {
      readonly adoptionLifecycle = 'reported' as const;
      adoptSession(): Promise<ProviderSession> {
        providerAdoptions += 1;
        if (providerAdoptions > 1)
          return Promise.reject(
            new Error('a second adoption reached the provider'),
          );
        adoptionStarted();
        return new Promise((_resolve, reject) => {
          releaseAdoption = reject;
        });
      }
      async discardSession(): Promise<void> {}
    }
    const services: OrchestrationService[] = [];
    const service = () => {
      const created = new OrchestrationService({
        adapterRegistry: createGateTestRegistry(new AdoptingAdapter()),
        eventBus: new EventBus(),
        eventStore: store,
        adoptionLedger: ledger,
        listProjects: () => [{ slug: 'project', workingDirectory: cwd }],
        logger: { debug: () => {}, warn: () => {} },
      });
      services.push(created);
      return created;
    };
    const adopt = (owner: OrchestrationService) =>
      owner.dispatch({ type: 'adoptSession', sourceThreadId: source.threadId });
    try {
      const running = service();
      const adoption = adopt(running).catch(() => undefined);
      await started;
      const [held] = ledger.reservations();
      expect(held).toMatchObject({ status: 'pending', ownerPid: process.pid });

      // A peer boot while the owner runs: its adopt awaits its own boot
      // reconciliation first, then meets the still-held reservation.
      await expect(adopt(service())).rejects.toThrow(
        'This attached session is already being continued.',
      );
      expect(ledger.reservations()).toEqual([held]);

      await running.shutdown();
      service().initialize();
      await vi.waitFor(() => expect(ledger.reservations()).toEqual([]), {
        timeout: 2_000,
      });

      releaseAdoption(new Error('released after the probe'));
      await adoption;
    } finally {
      for (const created of services.reverse()) await created.shutdown();
      store.close();
    }
  });
});
