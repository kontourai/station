import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { describe, expect, test } from 'vitest';
import { metadataRows } from '../hooks/useMutableSessionDetailState';

function session(
  overrides: Partial<OrchestrationSessionSummary>,
): OrchestrationSessionSummary {
  return {
    provider: 'claude',
    threadId: 'station-child-1',
    status: 'ready',
    controlMode: 'station-owned',
    isLoaded: true,
    isPersisted: true,
    eventCount: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    // archive#1778: a cast is an EXEMPTION from the required-member
    // enforcement, so this fixture is typed rather than asserted.
    answerability: { answerable: true },
    ...overrides,
  } satisfies OrchestrationSessionSummary as OrchestrationSessionSummary;
}

function continuedFromRow(
  item: OrchestrationSessionSummary,
): string | undefined {
  return metadataRows(item).find((row) => row.label === 'Continued from')
    ?.value;
}

/**
 * Activity iteration 2 (attached-session adoption honesty). The server stamps
 * `continuationSourceThreadId` on every adopted child (`buildAdoptedChild`,
 * a archive#1165 server-owned fact), and the field is on the public summary
 * contract — but no surface rendered it, so a session Station created by
 * continuing an external transcript presented as an ordinary Station session.
 * These pin that the adopted session's own detail discloses its provenance
 * through the existing `metadataRows` derivation, with no special case in
 * `sessionTitle` or a bespoke component.
 */
describe('session detail Continued-from row (adoption provenance)', () => {
  test('an adopted session renders the SOURCE thread id, not its own', () => {
    const item = session({
      continuationSourceThreadId: 'external:claude:5dfa0c',
    });

    expect(continuedFromRow(item)).toBe('external:claude:5dfa0c');
    // Discriminating direction: the row must quote the source, never the
    // child's own id — a swap here would still render "a" provenance row.
    expect(continuedFromRow(item)).not.toBe(item.threadId);
  });

  test('an ordinary Station session has no Continued-from row at all', () => {
    // The row filter is not defeated: absent provenance stays absent rather
    // than becoming a row reading "null" or an empty string.
    expect(continuedFromRow(session({}))).toBeUndefined();
    expect(
      continuedFromRow(session({ continuationSourceThreadId: '  ' })),
    ).toBeUndefined();
  });
});
