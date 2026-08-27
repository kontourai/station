import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  BACKLOG_POLICY,
  evaluateBacklogPriorityPolicy,
} from '../backlog-priority-policy.mjs';

const [p1, p2, p3] = BACKLOG_POLICY.priorities;
const [blocked, epic, decisionNeeded, acceptanceNeeded] =
  BACKLOG_POLICY.nonActionableDispositions;

function issue(number: number, labels: string[]) {
  return {
    number,
    state: 'open',
    labels: labels.map((name) => ({ name })),
  };
}

describe('backlog priority policy', () => {
  test('is enforced on issue changes, daily drift checks, and manual audits', () => {
    const workflow = readFileSync(
      '.github/workflows/backlog-priority-policy.yml',
      'utf8',
    );
    expect(workflow).toContain(
      'types: [opened, reopened, closed, labeled, unlabeled]',
    );
    expect(workflow).toContain("cron: '23 13 * * *'");
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('node scripts/backlog-priority-policy.mjs');
    expect(workflow).toContain('node scripts/label-manifest.mjs --input=');
    expect(workflow).toContain('issues: read');
    expect(workflow).toContain(
      'runs-on: [self-hosted, Linux, X64, kontour-linux, heavy-host]',
    );
    expect(workflow).toContain('physical-host-capacity@');
  });

  test('accepts a bounded actionable queue and explicit non-actionable dispositions', () => {
    const result = evaluateBacklogPriorityPolicy([
      issue(1, [p1, 'bug']),
      issue(2, [p1]),
      issue(3, [p2, blocked]),
      issue(4, [p3, epic]),
      issue(5, [decisionNeeded]),
      issue(6, [acceptanceNeeded]),
    ]);

    expect(result.findings).toEqual([]);
    expect(result.summary).toEqual({
      open: 6,
      actionableP1: 2,
      unclassified: 0,
    });
  });

  test('rejects multiple priority labels', () => {
    expect(
      evaluateBacklogPriorityPolicy([issue(7, [p1, p2])]).findings,
    ).toContain(`#7 has multiple priorities: ${p1}, ${p2}.`);
  });

  test('rejects conflicting lifecycle or stage labels and retired vocabulary', () => {
    expect(
      evaluateBacklogPriorityPolicy([
        issue(71, [p2, 'needs:maintainer', 'needs:reporter']),
        issue(72, [p3, 'stage:source', 'stage:stable']),
        issue(73, [p3, 'needs:triage']),
      ]).findings,
    ).toEqual(
      expect.arrayContaining([
        '#71 Conflicting lifecycle labels: needs:maintainer, needs:reporter.',
        '#72 Conflicting stage labels: stage:source, stage:stable.',
        "#73 Retired label 'needs:triage' is not allowed.",
      ]),
    );
  });

  test.each(BACKLOG_POLICY.nonActionableDispositions)(
    'rejects P1 combined with %s',
    (excludedLabel) => {
      expect(
        evaluateBacklogPriorityPolicy([issue(8, [p1, excludedLabel])]).findings,
      ).toContain(`#8 is ${p1} but also ${excludedLabel}.`);
    },
  );

  test('does not cap the P1 queue when the policy is uncapped', () => {
    // Owner directive (2026-08-18): every bug is P1, so the queue is uncapped.
    // This asserts the DEFAULT policy specifically — a future reviewer changing
    // `maxActionableP1` back to a number must change this test deliberately.
    expect(BACKLOG_POLICY.maxActionableP1).toBeNull();
    const manyP1Issues = Array.from({ length: 50 }, (_, index) =>
      issue(index + 1, [p1]),
    );
    expect(evaluateBacklogPriorityPolicy(manyP1Issues).findings).toEqual([]);
  });

  test('still rejects an oversized P1 queue when a policy sets a ceiling', () => {
    // The enforcement itself is retained, not deleted, so re-capping is a
    // one-constant change rather than a re-implementation.
    const cappedPolicy = { ...BACKLOG_POLICY, maxActionableP1: 5 };
    const oversizedP1Issues = Array.from({ length: 6 }, (_, index) =>
      issue(index + 1, [p1]),
    );
    expect(
      evaluateBacklogPriorityPolicy(oversizedP1Issues, {
        policy: cappedPolicy,
      }).findings,
    ).toContain(
      `Actionable ${p1} queue has ${oversizedP1Issues.length} issues; maximum is 5: ${oversizedP1Issues.map(({ number }) => `#${number}`).join(', ')}.`,
    );
  });

  test('fails every issue without a priority or explicit non-actionable disposition', () => {
    const result = evaluateBacklogPriorityPolicy([
      issue(9, ['bug']),
      issue(10, []),
    ]);
    expect(result.findings).toEqual([
      `Unclassified open issues: #9, #10. Apply one of: ${BACKLOG_POLICY.classificationLabels.join(', ')}.`,
    ]);
    expect(result.summary).toEqual({
      open: 2,
      actionableP1: 0,
      unclassified: 2,
    });
  });

  test('does not count pull requests as unclassified open issues', () => {
    const issues: Array<ReturnType<typeof issue> & { pull_request?: object }> =
      [{ ...issue(999, []), pull_request: {} }];
    expect(evaluateBacklogPriorityPolicy(issues)).toMatchObject({
      findings: [],
      summary: { open: 0, actionableP1: 0, unclassified: 0 },
    });
  });
});
