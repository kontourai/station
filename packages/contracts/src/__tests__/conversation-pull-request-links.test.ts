import { describe, expect, it } from 'vitest';
import {
  type LinkedPullRequestSnapshot,
  linkedPullRequestMatches,
} from '../conversation-pull-request-links.js';

const open: LinkedPullRequestSnapshot = {
  title: 'Change',
  pullRequestState: 'OPEN',
  isDraft: false,
  mergeability: 'mergeable',
};

describe('linked pull request filters', () => {
  it('expires a queue removal and lets passing checks supersede it', () => {
    const at = '2026-11-26T10:00:00Z';
    const now = Date.parse(at);
    const removed: LinkedPullRequestSnapshot = {
      ...open,
      landing: { state: 'removed', id: 'removal-1', at },
    };
    expect(linkedPullRequestMatches(removed, 'failing', now)).toBe(true);
    expect(
      linkedPullRequestMatches(removed, 'failing', now + 16 * 60_000),
    ).toBe(false);
    expect(
      linkedPullRequestMatches(
        { ...removed, checks: 'passing' },
        'failing',
        now,
      ),
    ).toBe(false);
  });

  it.each(['not-queued', 'not-applicable'] as const)(
    'uses explicit forge merge readiness when reviews are absent and landing is %s',
    (state) => {
      const snapshot: LinkedPullRequestSnapshot = {
        ...open,
        checks: 'passing',
        landing: { state },
      };
      expect(linkedPullRequestMatches(snapshot, 'ready')).toBe(false);
      expect(
        linkedPullRequestMatches(
          { ...snapshot, reviewGateSatisfied: true },
          'ready',
        ),
      ).toBe(true);
      expect(
        linkedPullRequestMatches(
          {
            ...snapshot,
            reviewDecision: 'review_required',
            reviewGateSatisfied: true,
          },
          'ready',
        ),
      ).toBe(false);
    },
  );
});
