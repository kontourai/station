import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  type AutomationLedger,
  automationDeliveryKey,
  createAutomationLedger,
} from '../automation-ledger.js';
import { AutomationPolicyUnavailableError } from '../automation-store.js';

const makeTempDir = trackTempDirs();

const T0 = Date.parse('2026-10-05T12:00:00.000Z');
const EPISODE_KEY = JSON.stringify([
  'rule-1',
  'kontourai/station',
  '.github/workflows/main-qualification.yml',
  'main',
]);

describe('AutomationLedger', () => {
  let directory: string;
  const open: AutomationLedger[] = [];
  const ledger = () => {
    const created = createAutomationLedger({ directory, busyTimeoutMs: 200 });
    open.push(created);
    return created;
  };

  beforeEach(() => {
    directory = join(makeTempDir('automation-ledger-'), 'automation');
  });

  afterEach(() => {
    for (const handle of open.splice(0)) {
      try {
        handle.close();
      } catch {
        // Already closed by the test to simulate a crash.
      }
    }
  });

  function delivery(
    target: AutomationLedger,
    transportId: string,
    semanticKey = 'workflow_run:100:1:completed',
  ) {
    return target.recordDelivery({
      sourceId: 'source-1',
      transportId,
      semanticKey,
      eventType: 'github.workflow_run.completed',
      receivedAt: T0,
      outcome: 'matched',
      ruleId: 'rule-1',
    });
  }

  function openEpisode(target: AutomationLedger, maxAttempts = 1) {
    return target.openEpisode({
      ruleId: 'rule-1',
      episodeKey: EPISODE_KEY,
      episodeId: '100',
      maxAttempts,
      now: T0,
    });
  }

  describe('delivery dedupe', () => {
    test('a repeated transport id is a transport duplicate and is not recorded twice', () => {
      const store = ledger();
      const first = delivery(store, 'guid-a');
      expect(first).toEqual({
        kind: 'recorded',
        deliveryKey: automationDeliveryKey('source-1', 'guid-a'),
      });
      expect(delivery(store, 'guid-a')).toMatchObject({
        kind: 'duplicate',
        layer: 'transport',
      });
      expect(store.listDeliveries()).toHaveLength(1);
    });

    test('a new transport id for the same run is recorded as a semantic duplicate', () => {
      const store = ledger();
      delivery(store, 'guid-a');
      expect(delivery(store, 'guid-b')).toMatchObject({
        kind: 'duplicate',
        layer: 'semantic',
      });
      const outcomes = store
        .listDeliveries()
        .map(({ outcome }) => outcome)
        .sort();
      expect(outcomes).toEqual(['duplicate', 'matched']);
    });

    test('rows hold a hashed key, never the delivery GUID', () => {
      const store = ledger();
      delivery(store, 'guid-secretish-0001');
      expect(JSON.stringify(store.listDeliveries())).not.toContain(
        'guid-secretish-0001',
      );
    });

    test('dedupe survives a restart and expires after the retention window', () => {
      const first = ledger();
      delivery(first, 'guid-a');
      first.close();
      const second = ledger();
      expect(delivery(second, 'guid-a')).toMatchObject({ kind: 'duplicate' });
      expect(second.pruneDeliveries(T0 + 8 * 24 * 60 * 60 * 1000)).toBe(1);
      expect(delivery(second, 'guid-a')).toMatchObject({ kind: 'recorded' });
    });
  });

  describe('episodes', () => {
    test('a second red run joins the open episode instead of opening another', () => {
      const store = ledger();
      expect(openEpisode(store).kind).toBe('opened');
      const again = store.openEpisode({
        ruleId: 'rule-1',
        episodeKey: EPISODE_KEY,
        episodeId: '101',
        maxAttempts: 1,
        now: T0 + 1,
      });
      expect(again).toMatchObject({
        kind: 'existing',
        episode: { episodeId: '100', state: 'open', attemptCount: 0 },
      });
    });

    test('closing an episode lets the next red run open a new one', () => {
      const store = ledger();
      openEpisode(store);
      expect(
        store.closeEpisode({ episodeKey: EPISODE_KEY, now: T0 + 5 }),
      ).toMatchObject({ state: 'closed' });
      expect(store.episode(EPISODE_KEY)).toBeUndefined();
      const next = store.openEpisode({
        ruleId: 'rule-1',
        episodeKey: EPISODE_KEY,
        episodeId: '200',
        maxAttempts: 1,
        now: T0 + 10,
      });
      expect(next).toMatchObject({
        kind: 'opened',
        episode: { episodeId: '200' },
      });
      expect(store.listEpisodes()).toHaveLength(2);
    });
  });

  describe('claim, beginInvocation, settle', () => {
    test('a settled action records the start and exhausts a one-attempt episode', () => {
      const store = ledger();
      const recorded = delivery(store, 'guid-a');
      openEpisode(store);
      const claim = store.claimAction({
        episodeKey: EPISODE_KEY,
        deliveryKey: recorded.deliveryKey,
        now: T0,
      });
      if (claim.kind !== 'claimed') throw new Error(claim.kind);
      expect(claim.receipt.attempt).toBe(1);
      expect(
        store.claimAction({
          episodeKey: EPISODE_KEY,
          deliveryKey: recorded.deliveryKey,
          now: T0,
        }),
      ).toEqual({ kind: 'busy' });

      expect(claim.receipt.beginInvocation(T0 + 1)).toBe('applied');
      expect(
        claim.receipt.settle({
          state: 'completed',
          now: T0 + 2,
          taskId: 'task-1',
          sessionId: 'session-1',
        }),
      ).toBe('applied');
      expect(claim.receipt.settle({ state: 'completed', now: T0 + 3 })).toBe(
        'stale',
      );

      expect(store.episode(EPISODE_KEY)).toMatchObject({
        state: 'exhausted',
        attemptCount: 1,
      });
      expect(store.listDeliveries()[0]).toMatchObject({
        outcome: 'started',
        ruleId: 'rule-1',
        episodeId: '100',
        taskId: 'task-1',
        sessionId: 'session-1',
      });
      expect(
        store.claimAction({
          episodeKey: EPISODE_KEY,
          deliveryKey: recorded.deliveryKey,
          now: T0 + 4,
        }),
      ).toEqual({ kind: 'exhausted' });
    });

    test('a released pre-invocation claim consumes no attempt', () => {
      const store = ledger();
      const recorded = delivery(store, 'guid-a');
      openEpisode(store);
      const claim = store.claimAction({
        episodeKey: EPISODE_KEY,
        deliveryKey: recorded.deliveryKey,
        now: T0,
      });
      if (claim.kind !== 'claimed') throw new Error(claim.kind);
      expect(claim.receipt.release()).toBe('applied');
      expect(claim.receipt.beginInvocation(T0)).toBe('stale');
      expect(store.episode(EPISODE_KEY)).toMatchObject({ attemptCount: 0 });
      expect(
        store.claimAction({
          episodeKey: EPISODE_KEY,
          deliveryKey: recorded.deliveryKey,
          now: T0,
        }).kind,
      ).toBe('claimed');
    });

    test('a restart before invocation re-claims the same attempt', () => {
      const crashed = ledger();
      const recorded = delivery(crashed, 'guid-a');
      openEpisode(crashed);
      const claim = crashed.claimAction({
        episodeKey: EPISODE_KEY,
        deliveryKey: recorded.deliveryKey,
        now: T0,
      });
      expect(claim.kind).toBe('claimed');
      crashed.close();

      const restarted = ledger();
      const reclaimed = restarted.claimAction({
        episodeKey: EPISODE_KEY,
        deliveryKey: recorded.deliveryKey,
        now: T0 + 1,
      });
      expect(reclaimed).toMatchObject({
        kind: 'claimed',
        receipt: { attempt: 1, episodeId: '100' },
      });
    });

    test('a restart after invocation is indeterminate and never replayed', () => {
      const crashed = ledger();
      const recorded = delivery(crashed, 'guid-a');
      openEpisode(crashed, 3);
      const claim = crashed.claimAction({
        episodeKey: EPISODE_KEY,
        deliveryKey: recorded.deliveryKey,
        now: T0,
      });
      if (claim.kind !== 'claimed') throw new Error(claim.kind);
      expect(claim.receipt.beginInvocation(T0 + 1)).toBe('applied');
      crashed.close();

      const restarted = ledger();
      // Attempts remain (1 of 3), yet the unknown result fences the episode.
      expect(
        restarted.claimAction({
          episodeKey: EPISODE_KEY,
          deliveryKey: recorded.deliveryKey,
          now: T0 + 2,
        }),
      ).toEqual({ kind: 'indeterminate' });
      expect(restarted.episode(EPISODE_KEY)).toMatchObject({
        state: 'indeterminate',
        attemptCount: 1,
      });
      expect(restarted.listDeliveries()[0]).toMatchObject({
        outcome: 'indeterminate',
      });
      // A later red run joins the fenced episode; it does not open a fresh one.
      expect(openEpisode(restarted, 3)).toMatchObject({
        kind: 'existing',
        episode: { state: 'indeterminate' },
      });
    });

    test('an indeterminate settlement by its live owner is not replayed either', () => {
      const store = ledger();
      const recorded = delivery(store, 'guid-a');
      openEpisode(store, 3);
      const claim = store.claimAction({
        episodeKey: EPISODE_KEY,
        deliveryKey: recorded.deliveryKey,
        now: T0,
      });
      if (claim.kind !== 'claimed') throw new Error(claim.kind);
      claim.receipt.beginInvocation(T0);
      claim.receipt.settle({ state: 'indeterminate', now: T0 + 1 });
      expect(
        store.claimAction({
          episodeKey: EPISODE_KEY,
          deliveryKey: recorded.deliveryKey,
          now: T0 + 2,
        }),
      ).toEqual({ kind: 'indeterminate' });
    });

    test('a live claim held by another handle in this process is not stolen', () => {
      const holder = ledger();
      const other = ledger();
      const recorded = delivery(holder, 'guid-a');
      openEpisode(holder);
      expect(
        holder.claimAction({
          episodeKey: EPISODE_KEY,
          deliveryKey: recorded.deliveryKey,
          now: T0,
        }).kind,
      ).toBe('claimed');
      expect(
        other.claimAction({
          episodeKey: EPISODE_KEY,
          deliveryKey: recorded.deliveryKey,
          now: T0,
        }),
      ).toEqual({ kind: 'busy' });
    });
  });

  test('a corrupt ledger fails closed with policy_unavailable', () => {
    const first = ledger();
    first.close();
    writeFileSync(
      join(directory, 'automation.sqlite'),
      Buffer.alloc(8192, 0x5a),
    );
    for (const suffix of ['-wal', '-shm']) {
      try {
        writeFileSync(join(directory, `automation.sqlite${suffix}`), '');
      } catch {
        // Absent sidecars are fine.
      }
    }
    expect(() => ledger()).toThrow(AutomationPolicyUnavailableError);
    expect(() => ledger()).toThrow(
      expect.objectContaining({ code: 'policy_unavailable' }),
    );
  });
});
