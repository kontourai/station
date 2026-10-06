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

/** A group's members; a live group absent because it is empty reads `[]`. */
const membersOf = (
  groups: ReturnType<typeof groupMobileActivity>,
  id: string,
): HomeWorkItem[] => groups.find((g) => g.id === id)?.items ?? [];

describe('groupMobileActivity snooze', () => {
  const NOW = 1_000_000;
  it('a live snooze wins over an otherwise-active item', () => {
    const groups = groupMobileActivity(
      [item({ id: 'x', lifecycleLabel: 'Running' })],
      NOW,
      { x: NOW + 1000 },
    );
    expect(groups.find((g) => g.id === 'snoozed')?.items).toHaveLength(1);
    expect(membersOf(groups, 'running')).toHaveLength(0);
    // An empty live group is omitted, not printed as an empty header.
    expect(groups.some((g) => g.id === 'running')).toBe(false);
  });
  it('a lapsed snooze returns the item to its natural group', () => {
    const groups = groupMobileActivity(
      [item({ id: 'x', lifecycleLabel: 'Running' })],
      NOW,
      { x: NOW - 1 },
    );
    expect(membersOf(groups, 'running')).toHaveLength(1);
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
    expect(membersOf(secondGroups, 'running')).toHaveLength(0);
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
    expect(membersOf(groups, 'running')).toEqual([chatItem]);
    expect(groups.find((g) => g.id === 'snoozed')?.items).toHaveLength(0);
  });
});

describe('snoozeWakeAt', () => {
  it('the one preset set: two durations and two mornings', () => {
    expect(SNOOZE_OPTIONS.map((option) => option.label)).toEqual([
      '1 hour',
      '3 hours',
      'Tomorrow 9am',
      'Next Monday 9am',
    ]);
  });

  it('adds fixed durations', () => {
    expect(snoozeWakeAt(SNOOZE_OPTIONS[0], 1_000)).toBe(3_601_000);
    expect(snoozeWakeAt(SNOOZE_OPTIONS[1], 1_000)).toBe(10_801_000);
  });

  it('"Tomorrow 9am" is always tomorrow, even before 9 today', () => {
    const now = new Date(2026, 7, 13, 8, 59).getTime();
    expect(snoozeWakeAt(SNOOZE_OPTIONS[2], now)).toBe(
      new Date(2026, 7, 14, 9).getTime(),
    );
  });

  it('"Next Monday 9am" lands in a later week, skipping a Monday today', () => {
    // 2026-08-13 is a Thursday; 2026-08-17 is a Monday.
    const thursday = new Date(2026, 7, 13, 15).getTime();
    expect(snoozeWakeAt(SNOOZE_OPTIONS[3], thursday)).toBe(
      new Date(2026, 7, 17, 9).getTime(),
    );
    const monday = new Date(2026, 7, 17, 8).getTime();
    expect(snoozeWakeAt(SNOOZE_OPTIONS[3], monday)).toBe(
      new Date(2026, 7, 24, 9).getTime(),
    );
  });
});

/**
 * archive#1783 — the mobile grouping is derived from `lifecycleLabel`, so the
 * `'Unanswerable'` label added to `orchestrationLifecycleLabel` reaches this
 * surface without a second derivation.
 *
 * archive#3227 A6 changed WHERE such an item files: the groups now come from
 * the shared lane partition (`partitionHomeWorkItems`), whose live lanes
 * mean "not finished" — and archive#1783's own desktop adjudication was that an
 * unanswerable session did not finish, it stopped being reachable. So it
 * stays live on mobile exactly as it does on desktop — under Idle, since
 * nothing is running and nothing here can answer it — carrying its basis
 * (`unanswerableNotice` + the translated "Can't answer here" status),
 * rather than sitting under a group that claims the work ended.
 */
describe('groupMobileActivity answerability (station#1783, re-adjudicated by #3227 A6)', () => {
  const NOW = 1_000_000;

  it('an Unanswerable item is Idle — it has not finished, and nothing is running or answerable', () => {
    const groups = groupMobileActivity(
      [item({ id: 'dead', lifecycleLabel: 'Unanswerable', updatedAt: NOW })],
      NOW,
    );
    expect(membersOf(groups, 'idle').map((i) => i.id)).toEqual(['dead']);
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

  it('control: a Needs attention item is Needs you', () => {
    const groups = groupMobileActivity(
      [item({ id: 'live', lifecycleLabel: 'Needs attention' })],
      NOW,
    );
    expect(membersOf(groups, 'needsYou')).toHaveLength(1);
  });

  it('next-9am stays calendar-correct across a DST boundary', () => {
    // US DST spring-forward 2026-03-08: 02:00 -> 03:00. Adding 24h of
    // milliseconds would land at 10am; setting calendar fields must not.
    const beforeSpring = new Date(2026, 2, 7, 22, 0, 0); // Mar 7, 10pm local
    const wake = new Date(
      snoozeWakeAt(SNOOZE_OPTIONS[2], beforeSpring.getTime()),
    );
    expect(wake.getHours()).toBe(9);
    expect(wake.getDate()).toBe(8);
  });
});
