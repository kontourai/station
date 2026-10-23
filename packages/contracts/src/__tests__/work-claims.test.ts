import { describe, expect, test } from 'vitest';
import {
  parseWorkClaimView,
  workClaimSubjectDetail,
  workClaimSubjectLabel,
} from '../work-claims.js';

/** A claim exactly as Station's `workClaimView` answers it. */
const ROUTE_CLAIM = {
  claimId: 'claim_1',
  sessionId: 's1',
  conversationId: 'c1',
  scope: { kind: 'project', id: 'p1' },
  taskId: 'task-1',
  workItemRef: 'kontourai/station#3413',
  paths: ['src/a.ts'],
  note: 'tests',
  claimedAt: '2026-10-21T10:00:00.000Z',
  renewedAt: '2026-10-21T10:00:00.000Z',
  expiresAt: '2026-10-21T10:30:00.000Z',
};

describe('work claims (#3413 B)', () => {
  test('parses a route claim unchanged, and refuses one missing an identity, scope or time', () => {
    expect(parseWorkClaimView(ROUTE_CLAIM)).toEqual(ROUTE_CLAIM);
    expect(
      parseWorkClaimView({ ...ROUTE_CLAIM, scope: { kind: 'global' } })?.scope,
    ).toEqual({ kind: 'global' });
    for (const broken of [
      null,
      'claim',
      { ...ROUTE_CLAIM, claimId: '' },
      { ...ROUTE_CLAIM, sessionId: 7 },
      { ...ROUTE_CLAIM, scope: { kind: 'project' } },
      { ...ROUTE_CLAIM, scope: { kind: 'elsewhere' } },
      { ...ROUTE_CLAIM, expiresAt: undefined },
    ])
      expect(parseWorkClaimView(broken)).toBeUndefined();
  });

  test('a label names the work item, else the first path’s last segment and the count; the detail names all', () => {
    expect(workClaimSubjectLabel(ROUTE_CLAIM)).toBe('kontourai/station#3413');
    expect(
      workClaimSubjectLabel({ paths: ['src-server/deep/work-claims.ts'] }),
    ).toBe('work-claims.ts');
    expect(workClaimSubjectLabel({ paths: ['docs/', 'a.ts', 'b.ts'] })).toBe(
      'docs +2',
    );
    expect(workClaimSubjectLabel({})).toBe('');
    expect(workClaimSubjectDetail(ROUTE_CLAIM)).toBe(
      'kontourai/station#3413, src/a.ts',
    );
  });
});
