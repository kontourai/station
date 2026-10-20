import { statSync, writeFileSync } from 'node:fs';
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
  const ledger = (maxRetainedDeliveries?: number) => {
    const created = createAutomationLedger({
      directory,
      busyTimeoutMs: 200,
      ...(maxRetainedDeliveries ? { maxRetainedDeliveries } : {}),
    });
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
    extra: Partial<Parameters<AutomationLedger['recordDelivery']>[0]> = {},
  ) {
    return target.recordDelivery({
      sourceId: 'source-1',
      transportId,
      semanticKey,
      eventType: 'github.workflow_run.completed',
      receivedAt: T0,
      outcome: 'matched',
      ruleId: 'rule-1',
      ...extra,
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
      // The next write past the window prunes the expired row first.
      const later = T0 + 8 * 24 * 60 * 60 * 1000;
      expect(
        delivery(second, 'guid-a', undefined, { receivedAt: later }),
      ).toMatchObject({ kind: 'recorded' });
      expect(second.listDeliveries()).toHaveLength(1);
    });

    test.each([
      ['a forged delivery', 'invalid_signature'],
      ['a transient refusal', 'policy_unavailable'],
      ['a rate-limited delivery', 'rate_limited'],
    ] as const)(
      '%s never makes the genuine delivery a duplicate',
      (_name, reason) => {
        const store = ledger();
        // Same run id, and even the same transport id a forger could replay.
        delivery(store, 'guid-a', undefined, { outcome: 'refused', reason });
        expect(delivery(store, 'guid-a')).toMatchObject({ kind: 'recorded' });
        expect(delivery(store, 'guid-b')).toMatchObject({
          kind: 'duplicate',
          layer: 'semantic',
        });
        const fresh = ledger();
        delivery(fresh, 'guid-x', 'workflow_run:200:1:completed', {
          outcome: 'refused',
          reason,
        });
        expect(
          delivery(fresh, 'guid-y', 'workflow_run:200:1:completed'),
        ).toMatchObject({ kind: 'recorded' });
      },
    );

    test('a merely received row does not take part in semantic dedupe', () => {
      const store = ledger();
      delivery(store, 'guid-a', undefined, { outcome: 'received' });
      expect(delivery(store, 'guid-b')).toMatchObject({ kind: 'recorded' });
    });

    test('a refusal flood cannot evict an accepted row inside the window', () => {
      const store = ledger(3);
      const genuine = delivery(store, 'guid-genuine', undefined, {
        outcome: 'started',
      });
      expect(genuine.kind).toBe('recorded');
      for (let index = 0; index < 6; index += 1) {
        delivery(
          store,
          `forged-${index}`,
          `workflow_run:${index}:1:completed`,
          {
            outcome: 'refused',
            reason: 'invalid_signature',
            receivedAt: T0 + 1 + index,
          },
        );
      }
      expect(
        store.listDeliveries().filter(({ outcome }) => outcome === 'refused'),
      ).toHaveLength(3);
      expect(store.listDeliveries().map(({ outcome }) => outcome)).toContain(
        'started',
      );
      expect(
        delivery(store, 'guid-fresh', undefined, { receivedAt: T0 + 10 }),
      ).toMatchObject({ kind: 'duplicate', layer: 'semantic' });
    });

    test('an invalid row ceiling is refused', () => {
      expect(() =>
        createAutomationLedger({ directory, maxRetainedDeliveries: 0 }),
      ).toThrow(RangeError);
    });

    test('the row ceiling drops the oldest deliveries on the write path', () => {
      const store = ledger(3);
      for (let index = 0; index < 5; index += 1) {
        delivery(store, `guid-${index}`, `workflow_run:${index}:1:completed`, {
          outcome: 'received',
          receivedAt: T0 + index,
        });
      }
      expect(
        store.listDeliveries().map(({ semanticKey }) => semanticKey),
      ).toEqual([
        'workflow_run:4:1:completed',
        'workflow_run:3:1:completed',
        'workflow_run:2:1:completed',
      ]);
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

    test('a per-delivery episode closes when its action settles', () => {
      const store = ledger();
      const recorded = delivery(store, 'guid-a');
      const key = 'rule-2|workflow_run:100:1:completed';
      store.openEpisode({
        ruleId: 'rule-2',
        episodeKey: key,
        episodeId: recorded.deliveryKey,
        maxAttempts: 1,
        now: T0,
        perDelivery: true,
      });
      const claim = store.claimAction({
        episodeKey: key,
        deliveryKey: recorded.deliveryKey,
        now: T0,
      });
      if (claim.kind !== 'claimed') throw new Error(claim.kind);
      claim.receipt.beginInvocation(T0);
      claim.receipt.settle({ state: 'completed', now: T0 + 1 });
      expect(store.episode(key)).toBeUndefined();
      expect(store.listEpisodes()[0]).toMatchObject({ state: 'closed' });
    });

    test('a keyed episode stays exhausted, suppressing starts, until closed', () => {
      const store = ledger();
      const recorded = delivery(store, 'guid-a');
      openEpisode(store);
      const claim = store.claimAction({
        episodeKey: EPISODE_KEY,
        deliveryKey: recorded.deliveryKey,
        now: T0,
      });
      if (claim.kind !== 'claimed') throw new Error(claim.kind);
      claim.receipt.beginInvocation(T0);
      claim.receipt.settle({ state: 'failed', now: T0 + 1 });
      expect(openEpisode(store)).toMatchObject({
        kind: 'existing',
        episode: { state: 'exhausted' },
      });
    });

    test('closed episodes are pruned after retention; unclosed ones are kept', () => {
      const store = ledger();
      openEpisode(store);
      store.closeEpisode({ episodeKey: EPISODE_KEY, now: T0 });
      store.openEpisode({
        ruleId: 'rule-9',
        episodeKey: 'still-open',
        episodeId: '1',
        maxAttempts: 1,
        now: T0,
      });
      delivery(store, 'guid-late', 'workflow_run:900:1:completed', {
        receivedAt: T0 + 32 * 24 * 60 * 60 * 1000,
      });
      expect(store.listEpisodes().map(({ episodeKey }) => episodeKey)).toEqual([
        'still-open',
      ]);
    });

    test('listEpisodes is bounded by its limit', () => {
      const store = ledger();
      for (let index = 0; index < 3; index += 1) {
        store.openEpisode({
          ruleId: 'rule-1',
          episodeKey: `key-${index}`,
          episodeId: String(index),
          maxAttempts: 1,
          now: T0 + index,
        });
      }
      expect(store.listEpisodes(2).map(({ episodeId }) => episodeId)).toEqual([
        '2',
        '1',
      ]);
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

  test.skipIf(process.platform === 'win32')(
    'creates the database and its WAL sidecars 0600',
    () => {
      const store = ledger();
      delivery(store, 'guid-a');
      for (const name of [
        'automation.sqlite',
        'automation.sqlite-wal',
        'automation.sqlite-shm',
      ]) {
        expect(statSync(join(directory, name)).mode & 0o777, name).toBe(0o600);
      }
    },
  );

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
