import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import {
  alreadyReported,
  HOLD_MARKER,
  isHeld,
  isStarved,
  REPORT_MARKER,
  reportBody,
  selectStarved,
} from '../starved-pr-report.mjs';

function pr(overrides: Record<string, unknown> = {}) {
  return {
    number: 1,
    isDraft: false,
    isInMergeQueue: false,
    mergeStateStatus: 'CLEAN',
    body: '',
    autoMergeRequest: null,
    labels: { nodes: [] },
    comments: { nodes: [] },
    ...overrides,
  };
}

describe('starved pull request detection', () => {
  test('a CLEAN, unqueued, unarmed pull request is starved', () => {
    expect(isStarved(pr())).toBe(true);
  });

  // The whole reason this cannot be done with autoMergeRequest alone: a queued
  // PR reads null there too, and is moving, not stuck.
  test('a queued pull request is not starved even though it reads unarmed', () => {
    expect(
      isStarved(pr({ isInMergeQueue: true, autoMergeRequest: null })),
    ).toBe(false);
  });

  test('an armed pull request is not starved', () => {
    expect(isStarved(pr({ autoMergeRequest: { enabledAt: 'now' } }))).toBe(
      false,
    );
  });

  test.each([['BLOCKED'], ['DIRTY'], ['UNSTABLE'], ['UNKNOWN']])(
    'a %s pull request is not starved — it is not ready',
    (status) => {
      expect(isStarved(pr({ mergeStateStatus: status }))).toBe(false);
    },
  );

  test('a draft is not starved — being draft is a visible statement', () => {
    expect(isStarved(pr({ isDraft: true }))).toBe(false);
  });

  describe('deliberate holds are distinguishable from forgotten', () => {
    test('the blocked label holds it', () => {
      const held = pr({ labels: { nodes: [{ name: 'blocked' }] } });
      expect(isHeld(held)).toBe(true);
      expect(isStarved(held)).toBe(false);
    });

    test('a hold marker in the body holds it', () => {
      const held = pr({ body: `${HOLD_MARKER} waiting on review -->` });
      expect(isHeld(held)).toBe(true);
      expect(isStarved(held)).toBe(false);
    });

    test('an unrelated label does not hold it', () => {
      expect(isHeld(pr({ labels: { nodes: [{ name: 'P2' }] } }))).toBe(false);
    });
  });

  test('a pull request already carrying the report is not re-reported', () => {
    const reported = pr({ comments: { nodes: [{ body: REPORT_MARKER }] } });
    expect(alreadyReported(reported)).toBe(true);
    expect(selectStarved([reported])).toEqual([]);
  });

  test('selection keeps only unreported starved pull requests', () => {
    const starved = pr({ number: 10 });
    const queued = pr({ number: 11, isInMergeQueue: true });
    const held = pr({ number: 12, labels: { nodes: [{ name: 'blocked' }] } });
    expect(selectStarved([starved, queued, held]).map((p) => p.number)).toEqual(
      [10],
    );
  });

  test('the comment carries its own marker so the next run can see it', () => {
    expect(reportBody(42)).toContain(REPORT_MARKER);
    expect(reportBody(42)).toContain('gh pr merge 42 --auto --squash');
  });

  // A push clears auto-merge, so "re-arm" without "after your last push" is
  // advice that fails silently: the PR reads armed when checked and is starved
  // a minute later. Observed on #1063.
  test('the comment says to arm after the last push, and how to confirm', () => {
    const body = reportBody(42);
    expect(body).toContain('AFTER your last push');
    expect(body).toContain('isInMergeQueue');
  });
});

// Run as a real child process: the refusal is only reachable through the
// script's own entrypoint, and asserting the exit status is the only way to
// prove the rejection path still rejects.
describe('refusing without GITHUB_REPOSITORY', () => {
  test('names the command that works, and exits non-zero', () => {
    const { GITHUB_REPOSITORY: _dropped, ...env } = process.env;
    const result = spawnSync(
      process.execPath,
      ['scripts/starved-pr-report.mjs'],
      { encoding: 'utf8', env },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'GITHUB_REPOSITORY=kontourai/station node scripts/starved-pr-report.mjs',
    );
    expect(result.stderr).toContain('--apply');
  });
});
