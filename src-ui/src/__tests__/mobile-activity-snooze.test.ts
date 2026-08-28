import { describe, expect, it } from 'vitest';
import {
  groupMobileActivity,
  SNOOZE_OPTIONS,
  snoozeWakeAt,
} from '../components/chat-dock/mobile-activity-groups';
import type { HomeWorkItem } from '../views/home/home-view-model';

const item = (over: Partial<HomeWorkItem>): HomeWorkItem =>
  ({
    id: 'a',
    kind: 'chat',
    kindLabel: 'Direct chat',
    title: 't',
    projectLabel: 'p',
    agentLabel: 'a',
    modelLabel: 'm',
    updatedAt: 0,
    lifecycleLabel: 'Recent',
    ...over,
  }) as HomeWorkItem;

describe('groupMobileActivity snooze', () => {
  const NOW = 1_000_000;
  it('a live snooze wins over an otherwise-active item', () => {
    const groups = groupMobileActivity(
      [item({ id: 'x', lifecycleLabel: 'Running' })],
      NOW,
      { x: NOW + 1000 },
    );
    expect(groups.find((g) => g.id === 'snoozed')?.items).toHaveLength(1);
    expect(groups.find((g) => g.id === 'active')?.items).toHaveLength(0);
  });
  it('a lapsed snooze returns the item to its natural group', () => {
    const groups = groupMobileActivity(
      [item({ id: 'x', lifecycleLabel: 'Running' })],
      NOW,
      { x: NOW - 1 },
    );
    expect(groups.find((g) => g.id === 'active')?.items).toHaveLength(1);
    expect(groups.find((g) => g.id === 'snoozed')?.items).toHaveLength(0);
  });

  it('keeps an old completed conversation in Just finished until its rendered version is acknowledged', () => {
    const completed = item({
      id: 'conversation-1',
      lifecycleLabel: 'Completed',
      updatedAt: NOW - 24 * 60 * 60 * 1000,
      conversationUpdatedAt: '2026-08-02T20:00:00.000Z',
    });
    const unseen = groupMobileActivity([completed], NOW);
    expect(unseen.find((g) => g.id === 'settled')?.items).toEqual([completed]);

    const acknowledged = groupMobileActivity(
      [
        {
          ...completed,
          acknowledgedAt: Date.parse('2026-08-02T20:00:00.000Z'),
        },
      ],
      NOW,
    );
    expect(acknowledged.find((g) => g.id === 'settled')?.items).toEqual([]);
    expect(
      acknowledged
        .find((g) => g.id === 'earlier')
        ?.items.map((entry) => entry.id),
    ).toEqual(['conversation-1']);
  });

// archive#1311 (opposite direction from archive#1295's original
// report): a Station-native/bedrock direct chat re-synthesizes a FRESH
// `chatSessionId` on every reopen (`useOpenConversation`'s
// `${agentSlug}:${Date.now}` branch) while its `conversationId` (== the
// item's `id` here) stays constant. Keying the snooze on `chatSessionId`
// would lose it on every close+reopen — `item.id` (which already prefers
// the conversationId) must be what wins, unaffected by chatSessionId
// churning underneath it.
  it('a snooze on a reopened chat survives even though chatSessionId is re-synthesized on every reopen', () => {
    const beforeReopen = item({
      id: 'conv-stable',
      chatSessionId: 'agent-1:1000',
      lifecycleLabel: 'Running',
    });
    const firstGroups = groupMobileActivity([beforeReopen], NOW, {
      'conv-stable': NOW + 1000,
    });
    expect(firstGroups.find((g) => g.id === 'snoozed')?.items).toEqual([
      beforeReopen,
    ]);

// Reopened: same conversationId (`id`), but a brand-new synthesized
// `chatSessionId` — exactly what `useOpenConversation`'s bedrock/
// Station-native branch produces on every reopen.
    const afterReopen = item({
      id: 'conv-stable',
      chatSessionId: 'agent-1:2000',
      lifecycleLabel: 'Running',
    });
    const secondGroups = groupMobileActivity([afterReopen], NOW, {
      'conv-stable': NOW + 1000,
    });
    expect(secondGroups.find((g) => g.id === 'snoozed')?.items).toEqual([
      afterReopen,
    ]);
    expect(secondGroups.find((g) => g.id === 'active')?.items).toHaveLength(0);
  });

// A stale snooze keyed by an id the item no longer carries at all must not
// falsely apply.
  it('a snooze entry matching neither the current id does not apply', () => {
    const chatItem = item({
      id: 'conv-123',
      chatSessionId: 'store-key-1',
      lifecycleLabel: 'Running',
    });
    const groups = groupMobileActivity([chatItem], NOW, {
      'unrelated-key': NOW + 1000,
    });
    expect(groups.find((g) => g.id === 'active')?.items).toEqual([chatItem]);
    expect(groups.find((g) => g.id === 'snoozed')?.items).toHaveLength(0);
  });
});

describe('snoozeWakeAt', () => {
  it('adds fixed durations', () => {
    expect(snoozeWakeAt(SNOOZE_OPTIONS[0], 1_000)).toBe(1_801_000);
  });

  it('uses today at 9am before the local boundary', () => {
    const now = new Date(2026, 7, 13, 8, 59).getTime();
    expect(snoozeWakeAt(SNOOZE_OPTIONS[2], now)).toBe(
      new Date(2026, 7, 13, 9).getTime(),
    );
  });

  it('uses tomorrow at 9am at and after the local boundary', () => {
    const atNine = new Date(2026, 7, 13, 9).getTime();
    expect(snoozeWakeAt(SNOOZE_OPTIONS[2], atNine)).toBe(
      new Date(2026, 7, 14, 9).getTime(),
    );
  });
});

/**
 * archive#1783 — the mobile grouping is derived from `lifecycleLabel`, so the
 * `'Unanswerable'` label added to `orchestrationLifecycleLabel` reaches this
 * surface without a second derivation.
 *
 * archive#3227 A6 changed WHERE such an item files: the groups now come from
 * the shared lane partition (`partitionHomeWorkItems`), whose Active lane
 * means "not finished" — and archive#1783's own desktop adjudication was that an
 * unanswerable session did not finish, it stopped being reachable. So it
 * stays in "Active now" on mobile exactly as it does on desktop, carrying
 * its basis (`unanswerableNotice` + the translated "Can't answer here"
 * status), rather than sitting under a group that claims the work ended.
 * The pre-A6 behavior (dropping it out of Active) was one half of the
 * two-derivations defect: the same session was "Active now" on Home and
 * not-active in the switcher.
 */
describe('groupMobileActivity answerability (station#1783, re-adjudicated by #3227 A6)', () => {
  const NOW = 1_000_000;

  it('an Unanswerable item is Active — it has not finished, matching the desktop lane', () => {
    const groups = groupMobileActivity(
      [item({ id: 'dead', lifecycleLabel: 'Unanswerable', updatedAt: NOW })],
      NOW,
    );
    expect(
      groups.find((g) => g.id === 'active')?.items.map((i) => i.id),
    ).toEqual(['dead']);
  });

  it('...and it is not dropped or double-filed — it lands in exactly one real group', () => {
// Annotate/de-prioritize, never filter: the row still exists, carrying
// `unanswerableNotice`, in exactly one group.
    const groups = groupMobileActivity(
      [item({ id: 'dead', lifecycleLabel: 'Unanswerable', updatedAt: NOW })],
      NOW,
    );
    expect(groups.flatMap((g) => g.items).map((i) => i.id)).toEqual(['dead']);
  });

  it('control: a Needs attention item is still Active', () => {
    const groups = groupMobileActivity(
      [item({ id: 'live', lifecycleLabel: 'Needs attention' })],
      NOW,
    );
    expect(groups.find((g) => g.id === 'active')?.items).toHaveLength(1);
  });

  it('next-9am stays calendar-correct across a DST boundary', () => {
 // US DST spring-forward : 02:00 -> 03:00. Adding 24h of
// milliseconds would land at 10am; setting calendar fields must not.
    const beforeSpring = new Date(2026, 2, 7, 22, 0, 0); // Mar 7, 10pm local
    const wake = new Date(
      snoozeWakeAt(SNOOZE_OPTIONS[2], beforeSpring.getTime()),
    );
    expect(wake.getHours()).toBe(9);
    expect(wake.getDate()).toBe(8);
  });
});
