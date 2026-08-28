import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { describe, expect, test } from 'vitest';
import { metadataRows } from '../hooks/useMutableSessionDetailState';
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

function projectRow(item: OrchestrationSessionSummary): string | undefined {
  return metadataRows(item).find((row) => row.label === 'Project')?.value;
}

/**
 * archive#1462/#1463 fix round. The detail panel read
 * `delegation?.projectSlug ?? projectSlug` directly, so it could contradict
 * the list it was opened from — a heading qualified as an unverified name
 * match became a bare slug one click later, and an ambiguous attached session
 * had no slug on either field so its row was filtered out of the panel
 * entirely. A caveat a surface withdraws on the next screen is worse than no
 * caveat, and the whole point of #1462 is that "no project" and "too many
 * projects" are different facts.
 */
describe('session detail Project row agrees with the list heading', () => {
  test('an unverified cross-machine join keeps its qualifier in the detail row', () => {
    const item = session({
      delegation: {
        taskId: 'task-1',
        projectSlug: 'station',
        projectSlugJoin: 'unverified-cross-machine',
      },
    });

    expect(projectRow(item)).toBe('station (unverified name match)');
    // archive#3227 A3: the second read here used to be
    // `sessionProjectSection`, a wrapper that called the same helper the
    // detail row does — the two could not disagree, so the assertion had no
    // power. Home's row label WAS a genuinely separate derivation
    // (`session.projectSlug || 'No project'`, which dropped a delegated slug
    // entirely and would have returned 'No project' here). Pinning the detail
    // row against Home is the cross-surface claim this test was written to
    // make.
    expect(buildOrchestrationItems([item], [])[0].projectLabel).toBe(
      projectRow(item),
    );
  });

  test('an ambiguous attached session renders a row naming the candidates instead of disappearing', () => {
    const item = session({
      controlMode: 'read-only-attached',
      projectAttribution: { state: 'ambiguous', candidates: ['alpha', 'beta'] },
    });

    expect(projectRow(item)).toBe('ambiguous (alpha, beta)');
  });

  test('a session with no project attribution still has no Project row', () => {
    // The row filter is not defeated: an absent project is still absent,
    // rather than becoming a row reading "null" or "Unassigned".
    expect(projectRow(session({}))).toBeUndefined();
  });
});
