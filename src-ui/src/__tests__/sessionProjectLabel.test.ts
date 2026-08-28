import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { describe, expect, test } from 'vitest';
import { sessionProjectLabel } from '../utils/sessionDisplay';
import { buildOrchestrationItems } from '../views/home/home-view-model';

function session(
  overrides: Partial<OrchestrationSessionSummary>,
): OrchestrationSessionSummary {
  return {
    provider: 'claude',
    threadId: 'thread-1',
    status: 'ready',
    controlMode: 'station-owned',
    isLoaded: true,
    isPersisted: true,
    eventCount: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
// archive#1778: a cast is an EXEMPTION from the required-member
// enforcement, so this fixture is typed rather than asserted. The
// decoration is irrelevant to what this file tests — that is exactly why
// it would have gone unnoticed as undecorated.
    answerability: { answerable: true },
    ...overrides,
  } satisfies OrchestrationSessionSummary as OrchestrationSessionSummary;
}

/**
 * The labels this function can produce, pinned together: the value of
 * "unverified name match" and "ambiguous" is that their ABSENCE also means
 * something, so a test that only covered the honest states would not notice
 * the qualifier leaking onto a settled binding.
 *
 * archive#3227 A3 retired `sessionProjectSection` (the `Project · <label>`
 * heading wrapper) — it never regained a rendering caller and Home's project
 * grouping wants neither its prefix nor its 'Unassigned' fold. Every case it
 * covered is kept here against `sessionProjectLabel`, which is what it
 * delegated to and what every surface now reads directly; only the constant
 * `Project · ` prefix and the null fold are gone from the expectations.
 */
describe('sessionProjectLabel', () => {
  test('a project this Station resolved itself reads as a plain binding', () => {
    expect(sessionProjectLabel(session({ projectSlug: 'station' }))).toBe(
      'station',
    );
  });

// The fold that used to spell 'Unassigned' here now lives at each display
// site, so the helper's own answer for "nothing known" is `null` — a
// distinguishable absence rather than a string a caller might render.
  test('no project at all reads as null, not as a label', () => {
    expect(sessionProjectLabel(session({}))).toBeNull();
  });

  test('an ambiguous attribution names the candidates rather than picking one (station#1462)', () => {
    expect(
      sessionProjectLabel(
        session({
          projectAttribution: {
            state: 'ambiguous',
            candidates: ['alpha', 'beta'],
          },
        }),
      ),
    ).toBe('ambiguous (alpha, beta)');
  });

  test('an unverified cross-machine slug join is qualified, a verified one is not (station#1463)', () => {
    expect(
      sessionProjectLabel(
        session({
          delegation: {
            taskId: 'task-1',
            projectSlug: 'station',
            projectSlugJoin: 'unverified-cross-machine',
          },
        }),
      ),
    ).toBe('station (unverified name match)');
    expect(
      sessionProjectLabel(
        session({ delegation: { taskId: 'task-1', projectSlug: 'station' } }),
      ),
    ).toBe('station');
  });

// archive#1463 FIX ROUND: a directory match proves the DIRECTORY, and
// archive#1462 is the standing proof that two projects can sit on one
// directory — so the name is still unverified and must still say so.
  test('a directory-corroborated join keeps the unverified-name caveat (station#1463)', () => {
    expect(
      sessionProjectLabel(
        session({
          delegation: {
            taskId: 'task-1',
            projectSlug: 'station',
            projectSlugJoin: 'directory-corroborated',
          },
        }),
      ),
    ).toBe('station (unverified name match, directory corroborated)');
  });

  test('a local join reads as a plain binding (station#1463)', () => {
    expect(
      sessionProjectLabel(
        session({
          delegation: {
            taskId: 'task-1',
            projectSlug: 'station',
            projectSlugJoin: 'local',
          },
        }),
      ),
    ).toBe('station');
  });

// archive#1462 FIX ROUND,.
  test('a bounded candidate list counts what it omitted (station#1462)', () => {
    expect(
      sessionProjectLabel(
        session({
          projectAttribution: {
            state: 'ambiguous',
            candidates: ['alpha', 'beta'],
            omittedCandidates: 4,
          },
        }),
      ),
    ).toBe('ambiguous (alpha, beta, and 4 more)');
  });
});

/**
 * archive#1462/archive#1463 FIX ROUND: the sessions list and the session detail
 * panel must not disagree about the same session. The detail panel used to
 * read `delegation?.projectSlug ?? projectSlug` directly, so a heading
 * qualified as an unverified name match became a row reading
 * "Project: station" one click later, and an ambiguous attached session's
 * row vanished entirely (no slug on either field). Both now go through
 * `sessionProjectLabel`, so these assertions are what pins them together.
 *
* archive#3227 A3 : the cross-surface pin here used to compare the
 * label against `sessionProjectSection`, which DERIVED its value from the
 * same call — it could not fail. Home is the surface that genuinely computed
 * a second answer (`session.projectSlug || 'No project'`, which dropped a
 * delegated slug and called an ambiguous session project-less), so Home is
 * what this now pins against. It is a real second read of the same fact.
 */
describe('sessionProjectLabel is the single source every surface reads', () => {
  test("Home's row label is the canonical label for every attributable shape", () => {
    const cases = [
      session({ projectSlug: 'station' }),
      session({
        delegation: {
          taskId: 'task-1',
          projectSlug: 'station',
          projectSlugJoin: 'unverified-cross-machine',
        },
      }),
      session({
        projectAttribution: { state: 'ambiguous', candidates: ['a', 'b'] },
      }),
    ];

    for (const item of cases) {
      const label = sessionProjectLabel(item);
      expect(label).toBeTruthy();
      expect(buildOrchestrationItems([item], [])[0].projectLabel).toBe(label);
    }
  });

// The one case where Home legitimately renders a string the helper does not
// produce: nothing is known, so there is no label to agree with.
  test('Home folds only the nothing-known case, and folds it to its own copy', () => {
    expect(buildOrchestrationItems([session({})], [])[0].projectLabel).toBe(
      'No project',
    );
  });

  test('an ambiguous session gets a rendered row instead of being filtered out', () => {
    expect(
      sessionProjectLabel(
        session({
          projectAttribution: {
            state: 'ambiguous',
            candidates: ['alpha', 'beta'],
          },
        }),
      ),
    ).toBe('ambiguous (alpha, beta)');
  });

  test('only a session with nothing known reads as null', () => {
    expect(sessionProjectLabel(session({}))).toBeNull();
  });
});
