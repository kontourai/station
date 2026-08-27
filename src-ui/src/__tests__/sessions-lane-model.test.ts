import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { describe, expect, test } from 'vitest';
import {
  hasTruncatedProjectAttribution,
  matchesProjectFilter,
  partitionSessionLanes,
  SESSION_LANE_ORDER,
  sessionProjectFilterKey,
  sessionProjectKeys,
} from '../views/sessions/sessions-lane-model';

const NOW = Date.parse('2026-08-18T12:00:00.000Z');

function session(
  overrides: Partial<OrchestrationSessionSummary> & { threadId: string },
): OrchestrationSessionSummary {
  return {
    provider: 'claude',
    status: 'ready',
    controlMode: 'station-owned',
    // station#1778: required decoration, supplied rather than cast away.
    answerability: { answerable: true },
    isLoaded: true,
    isPersisted: true,
    eventCount: 12,
    createdAt: new Date(NOW - 3_600_000).toISOString(),
    updatedAt: new Date(NOW - 3_600_000).toISOString(),
    ...overrides,
  };
}

function laneOf(
  sessions: OrchestrationSessionSummary[],
  threadId: string,
): string | undefined {
  return partitionSessionLanes({ sessions, agents: [], now: NOW }).find(
    (lane) => lane.sessions.some((entry) => entry.threadId === threadId),
  )?.id;
}

describe('partitionSessionLanes (station#3027)', () => {
  test('assigns each state to its lane through Home’s own partition', () => {
    const sessions = [
      session({ threadId: 'needs-input', lifecycleState: 'needs_input' }),
      session({
        threadId: 'review',
        lifecycleState: 'review_pending',
        pendingReview: true,
      }),
      session({ threadId: 'blocked', lifecycleState: 'blocked' }),
      session({
        threadId: 'running',
        lifecycleState: 'running',
        hasActiveTurn: true,
      }),
      session({ threadId: 'queued', lifecycleState: 'queued' }),
      session({
        threadId: 'just-done',
        lifecycleState: 'completed',
        updatedAt: new Date(NOW - 60_000).toISOString(),
      }),
      session({
        threadId: 'just-failed',
        lifecycleState: 'failed',
        updatedAt: new Date(NOW - 120_000).toISOString(),
      }),
      session({
        threadId: 'long-done',
        lifecycleState: 'completed',
        updatedAt: new Date(NOW - 5 * 3_600_000).toISOString(),
      }),
    ];

    expect(laneOf(sessions, 'needs-input')).toBe('needsYou');
    expect(laneOf(sessions, 'review')).toBe('needsYou');
    expect(laneOf(sessions, 'blocked')).toBe('needsYou');
    expect(laneOf(sessions, 'running')).toBe('activeNow');
    expect(laneOf(sessions, 'queued')).toBe('activeNow');
    expect(laneOf(sessions, 'just-done')).toBe('recentlyFinished');
    expect(laneOf(sessions, 'just-failed')).toBe('recentlyFinished');
    expect(laneOf(sessions, 'long-done')).toBe('earlier');
  });

  test('emits lanes in reading order and never emits an empty one', () => {
    const lanes = partitionSessionLanes({
      sessions: [
        session({
          threadId: 'long-done',
          lifecycleState: 'completed',
          updatedAt: new Date(NOW - 5 * 3_600_000).toISOString(),
        }),
        session({ threadId: 'needs-input', lifecycleState: 'needs_input' }),
      ],
      agents: [],
      now: NOW,
    });

    expect(lanes.map((lane) => lane.id)).toEqual(['needsYou', 'earlier']);
    // Not merely "in order" — in the DECLARED order, so a reordering of
    // SESSION_LANE_ORDER cannot pass by coincidence of this fixture.
    const declared = SESSION_LANE_ORDER.filter((id) =>
      lanes.some((lane) => lane.id === id),
    );
    expect(lanes.map((lane) => lane.id)).toEqual(declared);
    expect(lanes.some((lane) => lane.sessions.length === 0)).toBe(false);
  });

  test('a heading carries its lane’s count', () => {
    const lanes = partitionSessionLanes({
      sessions: [
        session({ threadId: 'a', lifecycleState: 'needs_input' }),
        session({ threadId: 'b', lifecycleState: 'needs_input' }),
        session({
          threadId: 'c',
          lifecycleState: 'running',
          hasActiveTurn: true,
        }),
      ],
      agents: [],
      now: NOW,
    });

    expect(lanes.map((lane) => lane.heading)).toEqual([
      'Needs you · 2',
      'Active now · 1',
    ]);
  });

  test('orders each lane newest-first', () => {
    const lanes = partitionSessionLanes({
      sessions: [
        session({
          threadId: 'oldest',
          lifecycleState: 'queued',
          updatedAt: new Date(NOW - 3 * 3_600_000).toISOString(),
        }),
        session({
          threadId: 'newest',
          lifecycleState: 'queued',
          updatedAt: new Date(NOW - 60_000).toISOString(),
        }),
        session({
          threadId: 'middle',
          lifecycleState: 'queued',
          updatedAt: new Date(NOW - 3_600_000).toISOString(),
        }),
      ],
      agents: [],
      now: NOW,
    });

    expect(lanes[0].sessions.map((entry) => entry.threadId)).toEqual([
      'newest',
      'middle',
      'oldest',
    ]);
  });

  test('an unanswerable waiting session is NOT claimed as "Needs you"', () => {
    // station#1783: `needs_input` plus an observed negative answerability is a
    // session nothing can act on. Filing it under "Needs you" would tell the
    // reader to do something no affordance can do.
    const sessions = [
      session({
        threadId: 'stranded',
        lifecycleState: 'needs_input',
        answerability: {
          answerable: false,
          qualification: 'provider_absent',
          observedBy: 'sessions-lane-model.test',
          observedAt: new Date(NOW).toISOString(),
        },
      }),
    ];

    expect(laneOf(sessions, 'stranded')).toBe('activeNow');
  });

  test('every session lands in exactly one lane', () => {
    const sessions = [
      session({ threadId: 'a', lifecycleState: 'needs_input' }),
      session({
        threadId: 'b',
        lifecycleState: 'running',
        hasActiveTurn: true,
      }),
      session({
        threadId: 'c',
        lifecycleState: 'completed',
        updatedAt: new Date(NOW - 60_000).toISOString(),
      }),
      session({
        threadId: 'd',
        lifecycleState: 'canceled',
        updatedAt: new Date(NOW - 5 * 3_600_000).toISOString(),
      }),
      session({ threadId: 'e', status: 'closed' }),
    ];
    const lanes = partitionSessionLanes({ sessions, agents: [], now: NOW });
    const placed = lanes.flatMap((lane) =>
      lane.sessions.map((entry) => entry.threadId),
    );

    expect(placed.slice().sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(new Set(placed).size).toBe(placed.length);
  });
});

describe('project attribution keys and the filter predicate', () => {
  test('a delegated project slug wins, then the session’s own slug', () => {
    expect(
      sessionProjectKeys(
        session({
          threadId: 'x',
          projectSlug: 'local',
          delegation: {
            taskId: 'task:x',
            projectSlug: 'remote',
          },
        }),
      ),
    ).toEqual(['remote']);
    expect(
      sessionProjectKeys(session({ threadId: 'x', projectSlug: 'station' })),
    ).toEqual(['station']);
  });

  test('an unattributed session has no keys and matches no project filter', () => {
    const orphan = session({ threadId: 'x' });
    expect(sessionProjectKeys(orphan)).toEqual([]);
    expect(matchesProjectFilter(orphan, 'station')).toBe(false);
    expect(matchesProjectFilter(orphan, null)).toBe(true);
  });

  test('an AMBIGUOUS session survives BOTH candidates’ filters', () => {
    // station#1462: a directory configured as two projects. Picking a winner
    // here would make the session vanish from the other project's filter with
    // no signal at all — the exact failure the ambiguous state exists to stop.
    const ambiguous = session({
      threadId: 'x',
      projectAttribution: {
        state: 'ambiguous',
        candidates: ['station', 'beacon'],
      },
    });

    expect(sessionProjectKeys(ambiguous)).toEqual(['station', 'beacon']);
    expect(matchesProjectFilter(ambiguous, 'station')).toBe(true);
    expect(matchesProjectFilter(ambiguous, 'beacon')).toBe(true);
    expect(matchesProjectFilter(ambiguous, 'lantern')).toBe(false);
    // ...and it is not a filter CONTROL: one click cannot say which it meant.
    expect(sessionProjectFilterKey(ambiguous)).toBeNull();
  });

  test('a TRUNCATED candidate list fails open rather than hiding the row', () => {
    const truncated = session({
      threadId: 'x',
      projectAttribution: {
        state: 'ambiguous',
        candidates: ['station', 'beacon'],
        omittedCandidates: 3,
      },
    });

    expect(hasTruncatedProjectAttribution(truncated)).toBe(true);
    // The bounded-away tail may contain 'lantern'; a strict miss would hide
    // the row from a filter it might genuinely belong to.
    expect(matchesProjectFilter(truncated, 'lantern')).toBe(true);
    expect(matchesProjectFilter(truncated, 'station')).toBe(true);
  });

  test('an unambiguous session is the only kind that becomes a filter control', () => {
    expect(
      sessionProjectFilterKey(
        session({ threadId: 'x', projectSlug: 'station' }),
      ),
    ).toBe('station');
    expect(sessionProjectFilterKey(session({ threadId: 'x' }))).toBeNull();
  });

  test('no filter matches everything', () => {
    for (const candidate of [
      session({ threadId: 'a', projectSlug: 'station' }),
      session({ threadId: 'b' }),
    ]) {
      expect(matchesProjectFilter(candidate, null)).toBe(true);
    }
  });
});
