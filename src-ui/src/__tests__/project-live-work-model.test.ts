import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { describe, expect, test } from 'vitest';
import {
  projectLiveCount,
  projectLiveLabel,
  projectLiveLanes,
  projectLiveLanesBySlug,
} from '../views/project-page/project-live-work-model';

/**
 * station#3202. The sidebar badge and the project page's Live work section are
 * the same function, so what is asserted here is (a) that the scoping is the
 * Sessions list's own project predicate, (b) that only the two LIVE lanes
 * survive, and (c) the agreement itself — the count is the length of the list.
 *
 * Lane MEMBERSHIP is not re-asserted here: it belongs to
 * `sessions-lane-model.test.ts` / `home-lane-model.test.ts` and re-pinning it
 * in a third place is how the third classifier gets written by accident. What
 * is pinned is that this module reuses them.
 */
function session(
  overrides: Partial<OrchestrationSessionSummary> &
    Pick<OrchestrationSessionSummary, 'threadId'>,
): OrchestrationSessionSummary {
  // station#3241: no cast — the old summary-typed assertion was hiding three
  // values the wire shape does not admit (`controlMode: 'managed'`,
  // `status: 'open'`, an unbranded agent slug). The fixture now compiles
  // against the contract, so a future wire-shape move fails here instead of
  // asserting a session that cannot occur.
  return {
    provider: 'claude',
    controlMode: 'station-owned',
    status: 'ready',
    projectSlug: 'station',
    createdAt: '2026-08-02T19:00:00.000Z',
    updatedAt: '2026-08-02T20:00:00.000Z',
    answerability: { answerable: true },
    isLoaded: true,
    isPersisted: true,
    eventCount: 12,
    ...overrides,
  };
}

const NOW = Date.parse('2026-08-02T21:00:00.000Z');

const waiting = session({
  threadId: 'waiting',
  lifecycleState: 'needs_input',
  pendingReview: true,
});
const running = session({
  threadId: 'running',
  lifecycleState: 'running',
  hasActiveTurn: true,
});
const finished = session({ threadId: 'finished', lifecycleState: 'completed' });
/**
 * A run that finished SECONDS ago, which `partitionHomeWorkItems` files under
 * `recentlyFinished` rather than `settled` (the terminal linger window).
 *
 * This fixture exists because of a fault injection that the suite did not
 * catch: adding `'recentlyFinished'` to `PROJECT_LIVE_LANE_IDS` — the exact
 * mistake of letting the archive leak into the live section — passed every
 * test, because every terminal fixture was an hour old and therefore already
 * `settled`. The mutation was unreachable, not harmless.
 */
const justFinished = session({
  threadId: 'just-finished',
  lifecycleState: 'completed',
  updatedAt: '2026-08-02T20:59:30.000Z',
  lastEventAt: '2026-08-02T20:59:30.000Z',
});
/**
 * A SECOND waiting session, so at least one lane holds more than one row.
 *
 * Also the product of an uncaught fault injection: `projectLiveCount` returning
 * `lanes.length` instead of the total number of sessions passed the whole
 * suite, because every lane in every fixture happened to hold exactly one
 * session. A count that agrees with its list only at cardinality one is not
 * evidence of agreement.
 */
const alsoWaiting = session({
  threadId: 'also-waiting',
  lifecycleState: 'blocked',
  updatedAt: '2026-08-02T20:30:00.000Z',
  lastEventAt: '2026-08-02T20:30:00.000Z',
});
const elsewhere = session({
  threadId: 'elsewhere',
  projectSlug: 'beacon',
  lifecycleState: 'needs_input',
  pendingReview: true,
});

function lanesFor(
  sessions: OrchestrationSessionSummary[],
  projectSlug = 'station',
) {
  return projectLiveLanes({ sessions, agents: [], projectSlug, now: NOW });
}

describe('projectLiveLanes', () => {
  test('keeps only the live lanes, in the Sessions list’s reading order', () => {
    const lanes = lanesFor([finished, running, waiting]);
    expect(lanes.map((lane) => lane.id)).toEqual(['needsYou', 'activeNow']);
    expect(lanes.map((lane) => lane.heading)).toEqual([
      'Needs you · 1',
      'Active now · 1',
    ]);
  });

  test('a finished session is not live work and appears in no lane here', () => {
    // Recently finished / Earlier are the Sessions list's job; the project
    // page shows what is in flight, not an archive.
    expect(lanesFor([finished])).toEqual([]);
  });

  test('a run that finished seconds ago is still not live work', () => {
    // The reachable form of the leg above: this session IS in the partition's
    // `recentlyFinished` bucket, so only the lane filter keeps it out of here.
    expect(lanesFor([justFinished])).toEqual([]);
    expect(projectLiveCount(lanesFor([justFinished, running]))).toBe(1);
    expect(projectLiveLabel(lanesFor([justFinished, running]))).toBe(
      'Active now: 1',
    );
  });

  test('an empty lane is never emitted', () => {
    const lanes = lanesFor([running]);
    expect(lanes.map((lane) => lane.id)).toEqual(['activeNow']);
  });

  test('scopes to one project', () => {
    expect(
      lanesFor([waiting, elsewhere]).flatMap((lane) =>
        lane.sessions.map((entry) => entry.threadId),
      ),
    ).toEqual(['waiting']);
    expect(
      lanesFor([waiting, elsewhere], 'beacon').flatMap((lane) =>
        lane.sessions.map((entry) => entry.threadId),
      ),
    ).toEqual(['elsewhere']);
  });

  test('an ambiguously attributed session appears under every candidate', () => {
    // `matchesProjectFilter`'s rule, reused rather than restated: a filter
    // never hides a session it cannot prove is unrelated, so a working
    // directory configured as two projects is counted by both rather than
    // filed under an arbitrary winner.
    const ambiguous = session({
      threadId: 'ambiguous',
      projectSlug: undefined,
      lifecycleState: 'needs_input',
      pendingReview: true,
      projectAttribution: {
        state: 'ambiguous',
        candidates: ['station', 'beacon'],
      },
    });

    expect(projectLiveCount(lanesFor([ambiguous]))).toBe(1);
    expect(projectLiveCount(lanesFor([ambiguous], 'beacon'))).toBe(1);
    expect(projectLiveCount(lanesFor([ambiguous], 'unrelated'))).toBe(0);
  });
});

describe('the badge number and the section list are one derivation', () => {
  test('the count is the total length of the lanes rendered', () => {
    // Deliberately UNEVEN — two rows in one lane, one in the other — so a
    // count that secretly returns the number of lanes cannot pass.
    const lanes = lanesFor([
      waiting,
      alsoWaiting,
      running,
      finished,
      elsewhere,
    ]);
    expect(lanes).toHaveLength(2);
    expect(projectLiveCount(lanes)).toBe(
      lanes.reduce((total, lane) => total + lane.sessions.length, 0),
    );
    expect(projectLiveCount(lanes)).toBe(3);
  });

  test('the label accounts for every session the count totals', () => {
    const lanes = lanesFor([waiting, alsoWaiting, running]);
    expect(projectLiveLabel(lanes)).toBe('Needs you: 2 · Active now: 1');
    const labelled = projectLiveLabel(lanes)
      .split(' · ')
      .reduce((total, part) => total + Number(part.split(': ')[1]), 0);
    expect(labelled).toBe(projectLiveCount(lanes));
  });

  test('nothing live means no lanes, a zero count and an empty label', () => {
    const lanes = lanesFor([finished]);
    expect(lanes).toEqual([]);
    expect(projectLiveCount(lanes)).toBe(0);
    expect(projectLiveLabel(lanes)).toBe('');
  });
});

describe('projectLiveLanesBySlug', () => {
  test('answers per project from one pass of the session list', () => {
    const bySlug = projectLiveLanesBySlug({
      sessions: [waiting, alsoWaiting, running, elsewhere, finished],
      agents: [],
      projectSlugs: ['station', 'beacon', 'unused'],
      now: NOW,
    });

    expect(projectLiveCount(bySlug.get('station') ?? [])).toBe(3);
    expect(projectLiveCount(bySlug.get('beacon') ?? [])).toBe(1);
    expect(bySlug.get('unused')).toEqual([]);
  });
});
