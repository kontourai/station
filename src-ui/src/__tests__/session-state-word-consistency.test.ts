import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { describe, expect, test } from 'vitest';
import { sessionStatusWord } from '../utils/session-state';
import {
  partitionSessionLanes,
  type SessionLaneId,
} from '../views/sessions/sessions-lane-model';

/**
 * archive#3227 A1 — THE INVARIANT, not four spot checks.
 *
 * A row's status word must never contradict the lane heading it sits under.
 * Rather than asserting one word per known-bad shape, this walks the whole
 * lane partition over a mixed fixture and checks every session in it, so a
 * change to the fold or to the refinement table that reintroduces a
 * contradiction fails here regardless of which shape produced it.
 *
 * `LANE_VOCABULARY` is written out independently of the implementation's own
 * `SESSION_STATE_REFINEMENTS`. Deriving it from that table would make this
 * test agree with the code by construction and prove nothing; stated here it
 * is a claim about what each heading is allowed to sit above, which the code
 * has to satisfy.
 */
const LANE_VOCABULARY: Record<SessionLaneId, ReadonlySet<string>> = {
  // You owe this session something. Which thing you owe is the refinement.
  needsYou: new Set([
    'Needs attention',
    'Waiting on you',
    'Review pending',
    'Blocked',
  ]),
  // In flight, idle, or stranded — none of them finished, none of them yours
  // to discharge. "Can't answer here" belongs to this lane by design
  // (archive#1783: an unanswerable session did not FINISH, it stopped being
  // reachable, so it is not filed under Recently finished).
  activeNow: new Set(['Running', 'Ready', 'Queued', "Can't answer here"]),
  // Over. The refinement is which ending.
  recentlyFinished: new Set(['Completed', 'Stopped', 'Failed']),
  earlier: new Set(['Completed', 'Stopped', 'Failed']),
};

const NOW = Date.parse('2026-08-18T12:00:00.000Z');

function session(
  overrides: Partial<OrchestrationSessionSummary> & { threadId: string },
): OrchestrationSessionSummary {
  return {
    provider: 'claude',
    status: 'ready',
    controlMode: 'station-owned',
    answerability: { answerable: true },
    isLoaded: true,
    isPersisted: true,
    eventCount: 4,
    createdAt: new Date(NOW - 3_600_000).toISOString(),
    updatedAt: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  };
}

const UNANSWERABLE = {
  answerable: false,
  qualification: 'provider_absent',
  observedBy: 'station-test',
  observedAt: '2026-08-18T11:00:00.000Z',
} as const;

/**
 * Every lifecycle state, every fold override, and the shapes that used to
 * disagree — in one list, so the walk below has something to catch. The four
 * A1 rows are first and named; the rest exist so no lane is accidentally
 * empty and no state is unrepresented.
 */
const MIXED_FIXTURE: OrchestrationSessionSummary[] = [
  // A1 shape 1 (#1069): lane Active now, row used to say "Running".
  session({
    threadId: 'a1-idle-running',
    lifecycleState: 'running',
    hasActiveTurn: false,
  }),
  // A1 shape 2: lane Needs you, row used to say "Running".
  session({
    threadId: 'a1-review-while-running',
    lifecycleState: 'running',
    hasActiveTurn: true,
    pendingReview: true,
  }),
  // A1 shape 3 (#1296): lane Recently finished, row used to say "Running".
  session({
    threadId: 'a1-closed-while-running',
    lifecycleState: 'running',
    hasActiveTurn: true,
    status: 'closed',
  }),
  // A1 shape 4 (#1783): lane Active now, row used to say "Waiting on you".
  session({
    threadId: 'a1-unanswerable',
    lifecycleState: 'needs_input',
    answerability: UNANSWERABLE,
  }),
  session({ threadId: 'needs-input', lifecycleState: 'needs_input' }),
  session({
    threadId: 'review-pending',
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
    threadId: 'turn-before-state',
    lifecycleState: 'queued',
    hasActiveTurn: true,
  }),
  session({ threadId: 'just-completed', lifecycleState: 'completed' }),
  session({ threadId: 'just-failed', lifecycleState: 'failed' }),
  session({ threadId: 'just-canceled', lifecycleState: 'canceled' }),
  session({ threadId: 'closed-undecorated', status: 'closed' }),
  // Old enough to fall out of Recently finished into Earlier.
  session({
    threadId: 'long-completed',
    lifecycleState: 'completed',
    updatedAt: new Date(NOW - 5 * 3_600_000).toISOString(),
  }),
  session({
    threadId: 'long-failed',
    lifecycleState: 'failed',
    updatedAt: new Date(NOW - 5 * 3_600_000).toISOString(),
  }),
];

describe('a row word can never contradict its lane heading', () => {
  const lanes = partitionSessionLanes({
    sessions: MIXED_FIXTURE,
    agents: [],
    now: NOW,
  });

  test('the fixture reaches every lane, so the walk below has power', () => {
    // Without this, a fixture edit that emptied a lane would leave the walk
    // green while checking nothing — the "unreachable fixture" failure mode.
    expect(lanes.map((lane) => lane.id).sort()).toEqual([
      'activeNow',
      'earlier',
      'needsYou',
      'recentlyFinished',
    ]);
    expect(lanes.reduce((total, lane) => total + lane.sessions.length, 0)).toBe(
      MIXED_FIXTURE.length,
    );
  });

  test('every session in every lane prints a word that lane permits', () => {
    const seen: string[] = [];
    for (const lane of lanes) {
      for (const entry of lane.sessions) {
        const word = sessionStatusWord(entry);
        seen.push(`${lane.id}/${entry.threadId}/${word}`);
        expect(
          LANE_VOCABULARY[lane.id].has(word),
          `${entry.threadId} sits under "${lane.heading}" but its row says "${word}"`,
        ).toBe(true);
      }
    }
    // Pinned so a silently-shrinking walk is visible in the diff rather than
    // passing quietly with fewer rows checked.
    expect(seen).toHaveLength(MIXED_FIXTURE.length);
  });

  test('the four A1 shapes land where the audit said, with the corrected word', () => {
    const laneOf = (threadId: string) =>
      lanes.find((lane) =>
        lane.sessions.some((entry) => entry.threadId === threadId),
      )?.id;
    const wordOf = (threadId: string) => {
      // archive#3241: no cast — `.find`'s `undefined` is handled by throwing,
      // so a missing fixture fails loudly instead of being cast past the
      // decorated wire shape.
      const found = MIXED_FIXTURE.find((entry) => entry.threadId === threadId);
      if (!found) throw new Error(`missing fixture: ${threadId}`);
      return sessionStatusWord(found);
    };

    expect(laneOf('a1-idle-running')).toBe('activeNow');
    expect(wordOf('a1-idle-running')).toBe('Ready');

    expect(laneOf('a1-review-while-running')).toBe('needsYou');
    expect(wordOf('a1-review-while-running')).toBe('Needs attention');

    expect(laneOf('a1-closed-while-running')).toBe('recentlyFinished');
    expect(wordOf('a1-closed-while-running')).toBe('Completed');

    expect(laneOf('a1-unanswerable')).toBe('activeNow');
    expect(wordOf('a1-unanswerable')).toBe("Can't answer here");
  });
});
