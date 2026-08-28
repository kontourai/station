import { describe, expect, it } from 'vitest';
import { groupMobileActivity } from '../components/chat-dock/mobile-activity-groups';
import {
  computeStableActiveOrder,
  type HomeLaneItem,
  isTerminalLifecycle,
  orderItemsByKeys,
  partitionHomeWorkItems,
  sortSettledTail,
  sortSnoozedShelf,
  TERMINAL_LINGER_MS,
  terminalSinceFromRecency,
  WOKE_PILL_WINDOW_MS,
  withStableIds,
} from '../views/home/home-lane-model';
import type { HomeWorkItem } from '../views/home/home-view-model';

/** Defaults `stableId` to `id` — these tests exercise ordering/partition
 * behavior, not the identity-alias mechanism itself (see the dedicated
 * `withStableIds` describe block below for that). */
function item(
  over: Partial<HomeWorkItem> & { id: string; stableId?: string },
): HomeLaneItem {
  return {
    kind: 'chat',
    kindLabel: 'Direct chat',
    title: `${over.id} title`,
    projectLabel: 'p',
    agentLabel: 'a',
    modelLabel: 'm',
    updatedAt: 0,
    lifecycleLabel: 'Recent',
    ...over,
    stableId: over.stableId ?? over.id,
  };
}

describe('computeStableActiveOrder (AC1 ordering invariant)', () => {
  it('never reorders the active lane on status churn — only lane entry moves a row', () => {
    const now = 1_000_000;
    const a = item({ id: 'a', lifecycleLabel: 'Running', updatedAt: now });
    const b = item({ id: 'b', lifecycleLabel: 'Ready', updatedAt: now - 1000 });
    const c = item({
      id: 'c',
      lifecycleLabel: 'Needs attention',
      updatedAt: now - 2000,
    });

// Initial mount: no previous order, so items enter recency-ordered.
    let order = computeStableActiveOrder([], [a, b, c]);
    expect(order).toEqual(['a', 'b', 'c']);

// Feed a sequence of status flips on the SAME set of ids. None of these
// transitions leave the active lane (Running/Ready/Needs attention are
// all still "active"), so the row order must not move even though the
// recency-based comparator that seeded initial order would reshuffle
// them if re-applied.
    const flips: HomeLaneItem[][] = [
      [
        { ...a, lifecycleLabel: 'Needs attention', updatedAt: now + 1 },
        { ...b, lifecycleLabel: 'Running', updatedAt: now + 2 },
        { ...c, lifecycleLabel: 'Ready', updatedAt: now + 3 },
      ],
      [
        { ...a, lifecycleLabel: 'Running', updatedAt: now + 10 },
        { ...b, lifecycleLabel: 'Needs attention', updatedAt: now + 11 },
        { ...c, lifecycleLabel: 'Running', updatedAt: now + 12 },
      ],
      [
        { ...a, lifecycleLabel: 'Ready', updatedAt: now + 20 },
        { ...b, lifecycleLabel: 'Ready', updatedAt: now + 21 },
        { ...c, lifecycleLabel: 'Needs attention', updatedAt: now + 999 },
      ],
    ];

    for (const flip of flips) {
      order = computeStableActiveOrder(order, flip);
      expect(order).toEqual(['a', 'b', 'c']);
    }
  });

  it('inserts a genuinely new item at the top, ahead of existing stable rows', () => {
    const now = 1_000_000;
    const a = item({ id: 'a', updatedAt: now - 5000 });
    const b = item({ id: 'b', updatedAt: now - 6000 });
    let order = computeStableActiveOrder([], [a, b]);
    expect(order).toEqual(['a', 'b']);

    const d = item({ id: 'd', updatedAt: now });
    order = computeStableActiveOrder(order, [a, b, d]);
    expect(order).toEqual(['d', 'a', 'b']);

// A further status flip on all three must still not reorder them.
    order = computeStableActiveOrder(order, [
      { ...a, lifecycleLabel: 'Running', updatedAt: now + 1 },
      { ...b, lifecycleLabel: 'Needs attention', updatedAt: now + 2 },
      { ...d, lifecycleLabel: 'Ready', updatedAt: now + 3 },
    ]);
    expect(order).toEqual(['d', 'a', 'b']);
  });

  it('drops an id that leaves the active lane and never resurrects its slot', () => {
    const now = 1_000_000;
    const a = item({ id: 'a', updatedAt: now });
    const b = item({ id: 'b', updatedAt: now - 1 });
    const c = item({ id: 'c', updatedAt: now - 2 });
    let order = computeStableActiveOrder([], [a, b, c]);
    expect(order).toEqual(['a', 'b', 'c']);

// b leaves the lane (settled/snoozed elsewhere).
    order = computeStableActiveOrder(order, [a, c]);
    expect(order).toEqual(['a', 'c']);

// If b later returns (e.g. woke from snooze) it re-enters as new, at top.
    order = computeStableActiveOrder(order, [a, c, b]);
    expect(order).toEqual(['b', 'a', 'c']);
  });
});

describe('orderItemsByKeys', () => {
  it('realizes a stable id order back into HomeWorkItem rows', () => {
    const a = item({ id: 'a' });
    const b = item({ id: 'b' });
    expect(orderItemsByKeys([b, a], ['a', 'b'])).toEqual([a, b]);
  });
});

describe('isTerminalLifecycle', () => {
  it('treats Completed and Failed as terminal for the linger window', () => {
    expect(isTerminalLifecycle('Completed')).toBe(true);
    expect(isTerminalLifecycle('Failed')).toBe(true);
    expect(isTerminalLifecycle('Needs attention')).toBe(false);
    expect(isTerminalLifecycle('Running')).toBe(false);
    expect(isTerminalLifecycle('Ready')).toBe(false);
    expect(isTerminalLifecycle('Recent')).toBe(false);
    expect(isTerminalLifecycle('Current')).toBe(false);
  });
});

describe('partitionHomeWorkItems (AC3 linger + snooze partition)', () => {
  const now = 1_000_000;

  it('keeps a freshly-terminal item in Recently finished, never Active now', () => {
    const a = item({ id: 'a', lifecycleLabel: 'Completed', updatedAt: now });
    const { active, recentlyFinished, settled } = partitionHomeWorkItems({
      items: [a],
      now,
      snoozedUntil: new Map(),
      terminalSince: new Map([['a', now]]),
    });
    expect(active).toEqual([]);
    expect(recentlyFinished).toEqual([a]);
    expect(settled).toEqual([]);
  });

  it('moves a terminal item to the settled tail once T minutes have elapsed', () => {
    const a = item({ id: 'a', lifecycleLabel: 'Completed', updatedAt: now });
    const justUnder = partitionHomeWorkItems({
      items: [a],
      now,
      snoozedUntil: new Map(),
      terminalSince: new Map([['a', now - (TERMINAL_LINGER_MS - 1)]]),
    });
    expect(justUnder.active).toEqual([]);
    expect(justUnder.recentlyFinished).toEqual([a]);
    expect(justUnder.settled).toEqual([]);

    const atOrOver = partitionHomeWorkItems({
      items: [a],
      now,
      snoozedUntil: new Map(),
      terminalSince: new Map([['a', now - TERMINAL_LINGER_MS]]),
    });
    expect(atOrOver.active).toEqual([]);
    expect(atOrOver.recentlyFinished).toEqual([]);
    expect(atOrOver.settled).toEqual([a]);
  });

  it('treats a failed item as terminal without conflating it with attention work', () => {
    const failed = item({ id: 'failed', lifecycleLabel: 'Failed' });
    const attention = item({
      id: 'attention',
      lifecycleLabel: 'Needs attention',
    });
    const partition = partitionHomeWorkItems({
      items: [failed, attention],
      now,
      snoozedUntil: new Map(),
      terminalSince: new Map([['failed', now]]),
    });
    expect(partition.recentlyFinished).toEqual([failed]);
    expect(partition.active).toEqual([attention]);
  });

  it('keeps a completed conversation in Recently finished until its rendered version is acknowledged', () => {
    const conversation = item({
      id: 'conversation-1',
      lifecycleLabel: 'Completed',
      updatedAt: now - 24 * 60 * 60 * 1000,
      conversationUpdatedAt: '2026-08-02T20:00:00.000Z',
    });
    const unseen = partitionHomeWorkItems({
      items: [conversation],
      now,
      snoozedUntil: new Map(),
      terminalSince: new Map([['conversation-1', 0]]),
    });
    expect(unseen.recentlyFinished).toEqual([conversation]);
    expect(unseen.settled).toEqual([]);

    const acknowledged = partitionHomeWorkItems({
      items: [
        {
          ...conversation,
          acknowledgedAt: Date.parse('2026-08-02T20:00:00.000Z'),
        },
      ],
      now,
      snoozedUntil: new Map(),
      terminalSince: new Map(),
    });
    expect(acknowledged.recentlyFinished).toEqual([]);
    expect(acknowledged.settled.map((entry) => entry.id)).toEqual([
      'conversation-1',
    ]);
  });

  it('a live snooze wins over every other classification', () => {
    const a = item({ id: 'a', lifecycleLabel: 'Running', updatedAt: now });
    const { active, snoozed } = partitionHomeWorkItems({
      items: [a],
      now,
      snoozedUntil: new Map([['a', now + 1000]]),
      terminalSince: new Map(),
    });
    expect(active).toEqual([]);
    expect(snoozed).toEqual([a]);
  });

  it('a lapsed snooze returns the item to its natural lane', () => {
    const a = item({ id: 'a', lifecycleLabel: 'Running', updatedAt: now });
    const { active, snoozed } = partitionHomeWorkItems({
      items: [a],
      now,
      snoozedUntil: new Map([['a', now - 1]]),
      terminalSince: new Map(),
    });
    expect(active).toEqual([a]);
    expect(snoozed).toEqual([]);
  });
});

/**
 * archive#3227 A6: "Active now" (and every sibling group label) must mean ONE
 * thing. Desktop Home partitions through `partitionHomeWorkItems`; the mobile
 * switcher/inbox groups through `groupMobileActivity`, which used to carry a
 * private `Running`/`Needs attention` predicate and its own 10-minute window
* so one device read "Active now 14" on Home and "Active now 1" on the
 * switcher, with the difference filed under "Just finished" having finished
 * nothing. These tests pin the INVARIANT (bucket-for-bucket agreement on a
 * mixed fixture, and one shared linger window), not spot values, so any
 * future re-fork of the predicate or the window fails here.
 */
describe('desktop/mobile lane agreement (station#3227 A6)', () => {
  const now = 10_000_000;
  const HOUR = 60 * 60 * 1000;

// One of everything: every non-terminal label, terminal work on both sides
// of the linger window, conversation-backed terminal work in both
// acknowledgement states, and a live snooze.
  const mixed: HomeWorkItem[] = [
    item({ id: 'running', lifecycleLabel: 'Running', updatedAt: now }),
    item({
      id: 'attention',
      lifecycleLabel: 'Needs attention',
      updatedAt: now,
    }),
    item({ id: 'ready', lifecycleLabel: 'Ready', updatedAt: now - HOUR }),
// The audit's exact symptom: an idle-but-open chat, an hour old. The old
// mobile grouping filed it under "Just finished"/"Earlier"; it finished
// nothing.
    item({
      id: 'idle-recent',
      lifecycleLabel: 'Recent',
      updatedAt: now - HOUR,
    }),
    item({
      id: 'unanswerable',
      lifecycleLabel: 'Unanswerable',
      updatedAt: now - HOUR,
    }),
    item({
      id: 'fresh-done',
      lifecycleLabel: 'Completed',
      updatedAt: now - 60_000,
    }),
    item({
      id: 'old-done',
      lifecycleLabel: 'Completed',
      updatedAt: now - 2 * HOUR,
    }),
    item({
      id: 'conv-unseen',
      lifecycleLabel: 'Completed',
      updatedAt: now - 24 * HOUR,
      conversationUpdatedAt: '2026-08-02T20:00:00.000Z',
    }),
    item({
      id: 'conv-acked',
      lifecycleLabel: 'Completed',
      updatedAt: now - 24 * HOUR,
      conversationUpdatedAt: '2026-08-02T20:00:00.000Z',
      acknowledgedAt: Date.parse('2026-08-02T20:00:00.000Z'),
    }),
    item({
      id: 'fresh-failed',
      lifecycleLabel: 'Failed',
      updatedAt: now - 60_000,
    }),
    item({ id: 'snoozed-running', lifecycleLabel: 'Running', updatedAt: now }),
  ];
  const snoozeWake = now + 60_000;

  function desktopPartition() {
// The same wiring `useHomeWorkLanes` performs, with the store-less
// `terminalSince` proxy both surfaces share on a fresh load.
    return partitionHomeWorkItems({
      items: withStableIds(mixed, new Map()),
      now,
      snoozedUntil: new Map([['snoozed-running', snoozeWake]]),
      terminalSince: terminalSinceFromRecency(mixed),
    });
  }

  function mobileGroups() {
    return groupMobileActivity(mixed, now, { 'snoozed-running': snoozeWake });
  }

  const ids = (entries: readonly HomeWorkItem[]) =>
    entries.map((entry) => entry.id);
  const mobileIds = (groupId: string) =>
    ids(mobileGroups().find((group) => group.id === groupId)?.items ?? []);

  it('desktop and mobile agree bucket-for-bucket on a mixed fixture', () => {
    const desktop = desktopPartition();
    expect(mobileIds('active')).toEqual(ids(desktop.active));
    expect(mobileIds('settled')).toEqual(ids(desktop.recentlyFinished));
    expect(mobileIds('snoozed')).toEqual(ids(desktop.snoozed));
    expect(mobileIds('earlier')).toEqual(ids(desktop.settled));
  });

  it('"Active now" is the shared not-finished lane — idle/unanswerable work is active, terminal work never is', () => {
    expect(mobileIds('active')).toEqual([
      'running',
      'attention',
      'ready',
      'idle-recent',
      'unanswerable',
    ]);
    expect(mobileIds('settled')).toEqual([
      'fresh-done',
      'conv-unseen',
      'fresh-failed',
    ]);
    expect(mobileIds('earlier')).toEqual(['old-done', 'conv-acked']);
  });

  it('both surfaces settle non-conversation terminal work at the SAME shared linger boundary', () => {
// Just under the window: "Just finished" on both. The old mobile
// 10-minute window would already have filed this under "Earlier".
    const justUnder = item({
      id: 'done',
      lifecycleLabel: 'Completed',
      updatedAt: now - (TERMINAL_LINGER_MS - 1),
    });
// At the window: settled/"Earlier" on both.
    const atBoundary = item({
      id: 'done',
      lifecycleLabel: 'Completed',
      updatedAt: now - TERMINAL_LINGER_MS,
    });

    for (const [fixture, finishedBucket, earlierBucket] of [
      [justUnder, ['done'], []],
      [atBoundary, [], ['done']],
    ] as const) {
      const desktop = partitionHomeWorkItems({
        items: withStableIds([fixture], new Map()),
        now,
        snoozedUntil: new Map(),
        terminalSince: terminalSinceFromRecency([fixture]),
      });
      const mobile = groupMobileActivity([fixture], now);
      expect(ids(desktop.recentlyFinished)).toEqual(finishedBucket);
      expect(ids(desktop.settled)).toEqual(earlierBucket);
      expect(
        ids(mobile.find((group) => group.id === 'settled')?.items ?? []),
      ).toEqual(finishedBucket);
      expect(
        ids(mobile.find((group) => group.id === 'earlier')?.items ?? []),
      ).toEqual(earlierBucket);
    }
  });
});

describe('sortSnoozedShelf', () => {
  it('sorts the collapsed shelf by wake time ascending', () => {
    const a = item({ id: 'a' });
    const b = item({ id: 'b' });
    const c = item({ id: 'c' });
    const snoozedUntil = new Map([
      ['a', 3000],
      ['b', 1000],
      ['c', 2000],
    ]);
    expect(sortSnoozedShelf([a, b, c], snoozedUntil)).toEqual([b, c, a]);
  });
});

describe('sortSettledTail', () => {
  it('sorts the settled tail by when work ended, most recent first', () => {
    const a = item({ id: 'a' });
    const b = item({ id: 'b' });
    const c = item({ id: 'c' });
    const terminalSince = new Map([
      ['a', 1000],
      ['b', 3000],
      ['c', 2000],
    ]);
    expect(sortSettledTail([a, b, c], terminalSince)).toEqual([b, c, a]);
  });
});

describe('woke-from-snooze pill window', () => {
  it('is a named, positive constant', () => {
    expect(WOKE_PILL_WINDOW_MS).toBeGreaterThan(0);
  });
});

describe('withStableIds (AC1 identity-alias fix, review finding)', () => {
  it('keeps the same stable id when `id` changes but `chatSessionId` persists', () => {
    const aliasMap = new Map<string, string>();
    const [before] = withStableIds(
      [
        {
          ...item({ id: 'local-1' }),
          kind: 'chat',
          chatSessionId: 'local-1',
        },
      ],
      aliasMap,
    );
    expect(before.stableId).toBe('local-1');

    const [after] = withStableIds(
      [
        {
          ...item({ id: 'conv-99' }),
          kind: 'chat',
          chatSessionId: 'local-1',
        },
      ],
      aliasMap,
    );
    expect(after.id).toBe('conv-99');
    expect(after.stableId).toBe('local-1');
  });

  it('keeps the same stable id when a persisted-task correlation swaps the item', () => {
    const aliasMap = new Map<string, string>();
    const [before] = withStableIds(
      [
        {
          ...item({ id: 'thread-1' }),
          kind: 'orchestration',
          orchestrationThreadId: 'thread-1',
        },
      ],
      aliasMap,
    );
    expect(before.stableId).toBe('thread-1');

    const [after] = withStableIds(
      [
        {
          ...item({ id: 'task-42' }),
          kind: 'task',
          taskSessionId: 'thread-1',
        },
      ],
      aliasMap,
    );
    expect(after.id).toBe('task-42');
    expect(after.stableId).toBe('thread-1');
  });

  it('assigns a fresh stable id to a genuinely new item', () => {
    const aliasMap = new Map<string, string>();
    const [resolved] = withStableIds([item({ id: 'brand-new' })], aliasMap);
    expect(resolved.stableId).toBe('brand-new');
  });

  it('prunes aliases for canonical ids no longer reachable from any item', () => {
    const aliasMap = new Map<string, string>();
    withStableIds([{ ...item({ id: 'a' }), chatSessionId: 'a' }], aliasMap);
    expect(aliasMap.size).toBeGreaterThan(0);

    withStableIds([], aliasMap);
    expect(aliasMap.size).toBe(0);
  });

// archive#1097: a remote-session item's `id` is namespaced
// (`remote:<environmentId>:<threadId>`) and it never sets
// `orchestrationThreadId`/`chatSessionId`/`taskSessionId` (see
// `home-view-model.ts`'s `buildSessionWorkItem`), so even a raw threadId
// collision between a local orchestration item and a remote one — which
// this test forces on purpose — can never alias the two under a shared
// stable id.
  it('never aliases a remote-session item with a local item that happens to share the same raw thread id', () => {
    const aliasMap = new Map<string, string>();
    const [local, remote] = withStableIds(
      [
        {
          ...item({ id: 'thread-1' }),
          kind: 'orchestration',
          orchestrationThreadId: 'thread-1',
        },
        {
          ...item({ id: 'remote:env-a:thread-1' }),
          kind: 'remote-session',
          environmentId: 'env-a',
          environmentLabel: 'Brian media',
        },
      ],
      aliasMap,
    );
    expect(local.stableId).toBe('thread-1');
    expect(remote.stableId).toBe('remote:env-a:thread-1');
    expect(local.stableId).not.toBe(remote.stableId);
  });
});
