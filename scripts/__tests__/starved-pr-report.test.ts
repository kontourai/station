import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import {
  alreadyReported,
  HOLD_MARKER,
  isHeld,
  isStarved,
  REPORT_MARKER,
  reportBody,
  SETTLE_MINUTES,
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
    updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
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

  // A PR moving between queue states reads CLEAN+unqueued+unarmed in the gap.
  // #1218 reported starved and was at queue position 1 moments later. This
  // comments once and permanently, so a transient reading is a wrong comment
  // that never expires.
  describe('a pull request caught mid-transition is not reported', () => {
    test('recently updated is not starved', () => {
      const now = Date.now();
      const justMoved = pr({
        updatedAt: new Date(now - 60_000).toISOString(),
      });
      expect(isStarved(justMoved, now)).toBe(false);
    });

    test('settled past the window is starved', () => {
      const now = Date.now();
      const settled = pr({
        updatedAt: new Date(now - (SETTLE_MINUTES + 5) * 60_000).toISOString(),
      });
      expect(isStarved(settled, now)).toBe(true);
    });

    test('an unparseable timestamp fails closed', () => {
      expect(isStarved(pr({ updatedAt: undefined }))).toBe(false);
    });
  });

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
    expect(reportBody(42)).toContain('gh pr merge 42 --auto');
    expect(reportBody(42)).not.toMatch(/--auto --(squash|merge)/u);
  });

  // Arming is lost several ways and a push does NOT reliably clear it (#1063
  // lost it across a push, #1166 did not), so the comment must say "verify"
  // rather than assert a causal rule the evidence does not support.
  // A CLEAN+unqueued pull request has at least two causes and arming only
  // helps one of them, so the comment must not present arming as unconditional.
  test('the comment names the case where arming will not help', () => {
    const body = reportBody(42);
    expect(body).toContain('One case where arming will not help');
    expect(body).toContain('mergeQueue');
    // The mechanism behind queue removal is correlation only; the comment
    // must not assert a cause it cannot support.
    expect(body).toContain('mechanism is not established');
    expect(body).not.toContain('check-response timeout');
  });

  test('the comment says to arm after the last push, and how to confirm', () => {
    const body = reportBody(42);
    expect(body).toContain('Verify the arming took');
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
