import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import {
  BACKLOG_POLICY,
  backlogIssueFromNode,
  backlogReadIsComplete,
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
  test('is audited daily and on demand, not on every issue event', () => {
    const workflow = readFileSync(
      '.github/workflows/backlog-priority-policy.yml',
      'utf8',
    );
    // `issues: read` under permissions stays; an `issues:` trigger with types does not.
    expect(workflow).not.toMatch(/^ {2}issues:\n {4}types:/m);
    expect(workflow).toContain("cron: '23 13 * * *'");
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('node scripts/backlog-priority-policy.mjs');
    expect(workflow).toContain('node scripts/label-manifest.mjs --input=');
    expect(workflow).toContain('issues: read');
    expect(workflow).toContain('runs-on: ubuntu-22.04');
    expect(workflow).not.toContain('physical-host-capacity@');
    expect(workflow).not.toContain('self-hosted');
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
    // The queue is uncapped, and stayed uncapped when the "every bug is P1"
    // derivation was removed (2026-09-09). This asserts the DEFAULT policy
    // specifically — a future reviewer changing `maxActionableP1` back to a
    // number must change this test deliberately.
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

  // Run as a real child process: the message is only reached through the
  // script's own entrypoint, and asserting the exit status is the only way to
  // prove the rejection path still rejects.
  test('refusing without GITHUB_REPOSITORY names the command that works', () => {
    const { GITHUB_REPOSITORY: _dropped, ...env } = process.env;
    const result = spawnSync(
      process.execPath,
      ['scripts/backlog-priority-policy.mjs'],
      { encoding: 'utf8', env },
    );
    expect(result.status).not.toBe(0);
    // The remedy, not just the mechanism: a reader who has only ever run this
    // by hand needs the invocation, not the name of the variable it lacks.
    expect(result.stderr).toContain(
      'GITHUB_REPOSITORY=kontourai/station node scripts/backlog-priority-policy.mjs',
    );
    expect(result.stderr).toContain('--input');
  });

  test('does not count pull requests as unclassified open issues', () => {
    const issues: Array<ReturnType<typeof issue> & { pull_request?: object }> =
      [{ ...issue(999, []), pull_request: {} }];
    expect(evaluateBacklogPriorityPolicy(issues)).toMatchObject({
      findings: [],
      summary: { open: 0, actionableP1: 0, unclassified: 0 },
    });
  });

  describe('completeness of the live read', () => {
    const directories: string[] = [];
    afterAll(() => {
      for (const directory of directories)
        rmSync(directory, { recursive: true, force: true });
    });

    function connection(nodes: object[], totalCount: number) {
      return JSON.stringify({
        data: {
          repository: {
            issues: {
              totalCount,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes,
            },
          },
        },
      });
    }

    function node(number: number, labels: string[]) {
      return { number, labels: { nodes: labels.map((name) => ({ name })) } };
    }

    /**
     * Puts a `gh` on PATH ahead of the real one, answering the backlog query
     * with `response`. These drive the script's own entrypoint and assert the
     * exit status: the summary is printed from `main`, and the refusal only
     * exists there.
     */
    function runWithStubbedGh(response: string) {
      const directory = mkdtempSync(join(tmpdir(), 'backlog-gate-'));
      directories.push(directory);
      writeFileSync(
        join(directory, 'gh'),
        `#!/bin/sh\ncat <<'JSON'\n${response}\nJSON\n`,
        { mode: 0o755 },
      );
      return spawnSync(
        process.execPath,
        ['scripts/backlog-priority-policy.mjs'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            GITHUB_REPOSITORY: 'kontourai/station',
            PATH: `${directory}:${process.env.PATH}`,
          },
        },
      );
    }

    test('a read that returns nothing is refused, not reported as clean', () => {
      // The measured failure: the REST listing answered 200 with an empty
      // array while 361 issues were open, and the gate printed
      // `{"open":0,"actionableP1":0,"unclassified":0}` and exited 0.
      const result = runWithStubbedGh(connection([], 361));

      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain('"unclassified":0');
      expect(result.stderr).toContain('Read 0 of 361');
    });

    test('a partial read is refused even though it parses and classifies', () => {
      // Distinct from the empty case: these issues are real, well-formed and
      // fully classified. The read is clean AND wrong, which is the shape a
      // tolerance would let through.
      const result = runWithStubbedGh(connection([node(1, [p2])], 361));

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Read 1 of 361');
    });

    test('a complete read is still accepted, with its findings', () => {
      // Without this, the two above are satisfied by a gate that refuses
      // everything. An unclassified issue also has to still be REPORTED, so
      // the completeness check cannot be swallowing the findings it guards.
      const result = runWithStubbedGh(
        connection([node(1, [p2]), node(2, [])], 2),
      );

      expect(result.stdout).toContain('"open":2');
      expect(result.stderr).toContain('Unclassified open issues: #2');
      expect(result.status).not.toBe(0);
    });

    test('a complete and fully classified read exits clean', () => {
      const result = runWithStubbedGh(
        connection([node(1, [p2]), node(2, [p1])], 2),
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('"open":2');
      expect(result.stdout).toContain('"unclassified":0');
    });

    test('a GraphQL node becomes the shape the policy evaluates', () => {
      // GraphQL returns neither `state` nor `pull_request`: the query filters
      // to open, and `repository.issues` never contains a pull request. The
      // evaluator reads both, because its other caller is a saved REST list.
      expect(backlogIssueFromNode(node(7, [p1, 'bug']))).toEqual({
        number: 7,
        state: 'open',
        labels: [{ name: p1 }, { name: 'bug' }],
      });
    });

    test('completeness compares against the count from the same response', () => {
      expect(backlogReadIsComplete([{ number: 1 }, { number: 2 }], 2)).toBe(
        true,
      );
      expect(backlogReadIsComplete([], 2)).toBe(false);
      expect(backlogReadIsComplete([{ number: 1 }], 2)).toBe(false);
    });
  });
});
