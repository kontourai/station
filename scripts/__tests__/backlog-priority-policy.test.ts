import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  BACKLOG_ISSUE_OFFENDERS,
  BACKLOG_ISSUE_TITLE,
  BACKLOG_POLICY,
  backlogIssueFromNode,
  backlogReadIsComplete,
  buildBacklogReport,
  evaluateBacklogPriorityPolicy,
  upsertBacklogIssue,
} from '../backlog-priority-policy.mjs';

const makeTempDir = trackTempDirs();
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
      { encoding: 'utf8', env, windowsHide: true },
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
    function runWithStubbedGh(
      response: string,
      { failure = false, summary = '', args = [] as string[] } = {},
    ) {
      const directory = makeTempDir('backlog-gate-');
      writeFileSync(
        join(directory, 'gh'),
        failure
          ? // The transport failure shape gh prints for a 5xx answer.
            `#!/bin/sh\necho 'gh: Server Error (HTTP 502)' >&2\nexit 1\n`
          : `#!/bin/sh\ncat <<'JSON'\n${response}\nJSON\n`,
        { mode: 0o755 },
      );
      const { GITHUB_STEP_SUMMARY: _dropped, ...env } = process.env;
      return spawnSync(
        process.execPath,
        ['scripts/backlog-priority-policy.mjs', ...args],
        {
          encoding: 'utf8',
          windowsHide: true,
          env: {
            ...env,
            ...(summary ? { GITHUB_STEP_SUMMARY: summary } : {}),
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

    // Report-only: findings are reported (annotation and job summary) and
    // exit 0. Without this, the two above are satisfied by a gate that
    // refuses everything; an unclassified issue also has to still be
    // REPORTED, so the completeness check cannot swallow the findings.
    test('a complete read reports its findings and exits 0', () => {
      const directory = makeTempDir('backlog-summary-');
      const summary = join(directory, 'summary.md');
      const report = join(directory, 'report.md');
      const result = runWithStubbedGh(
        connection([node(1, [p2]), node(2, [])], 2),
        { summary, args: ['--report', report] },
      );
      const head = spawnSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
        windowsHide: true,
      }).stdout.trim();
      expect(readFileSync(report, 'utf8')).toContain(
        `<!-- backlog-policy findings=1 revision=${head} -->`,
      );

      expect(result.stdout).toContain('"open":2');
      expect(result.stderr).toContain(
        '::warning title=Backlog policy::Unclassified open issues: #2.',
      );
      const written = readFileSync(summary, 'utf8');
      expect(written).toContain('Unclassified: 1.');
      expect(written).toContain('- Unclassified open issues: #2.');
      expect(result.status).toBe(0);
    });

    test('an API failure still fails', () => {
      const result = runWithStubbedGh('', { failure: true });

      expect(result.stderr).toContain('HTTP 502');
      expect(result.stdout).toBe('');
      expect(result.status).not.toBe(0);
    });

    // The workflow runs the label check first in the same `bash -e` step;
    // live-label drift and a malformed manifest exit non-zero there, before
    // the report-only policy runs.
    test('label drift and a malformed manifest still fail the label check', () => {
      const directory = makeTempDir('backlog-labels-');
      const manifest = JSON.parse(
        readFileSync('.github/labels.json', 'utf8'),
      ) as { labels: { name: string; color: string; description: string }[] };
      // The shape the labels API returns, as the workflow saves it.
      const live = manifest.labels.map((label, index) => ({
        id: index + 1,
        node_id: `LA_${index + 1}`,
        url: `https://api.github.com/repos/kontourai/station/labels/${encodeURIComponent(label.name)}`,
        default: false,
        ...label,
      }));
      const check = (labels: object[]) => {
        const input = join(directory, `live-${labels.length}.json`);
        writeFileSync(input, JSON.stringify(labels));
        return spawnSync(
          process.execPath,
          ['scripts/label-manifest.mjs', `--input=${input}`],
          { encoding: 'utf8', windowsHide: true },
        );
      };
      expect(check(live).status).toBe(0);
      const drifted = check([
        ...live,
        { ...live[0], id: 999, name: 'surprise' },
      ]);
      expect(drifted.status).not.toBe(0);
      expect(drifted.stderr).toContain('Unexpected live labels: surprise.');
      const truncated = check(live.slice(1));
      expect(truncated.status).not.toBe(0);
      expect(truncated.stderr).toContain('Missing live labels: P1.');
      // The manifest itself is read from the working directory.
      const root = makeTempDir('backlog-manifest-');
      mkdirSync(join(root, '.github'));
      writeFileSync(join(root, '.github', 'labels.json'), '{"labels": 1}');
      const malformed = spawnSync(
        process.execPath,
        [resolve('scripts/label-manifest.mjs')],
        { cwd: root, encoding: 'utf8', windowsHide: true },
      );
      expect(malformed.status).not.toBe(0);
      expect(malformed.stderr).toContain('schemaVersion 1');
      const workflow = readFileSync(
        '.github/workflows/backlog-priority-policy.yml',
        'utf8',
      );
      expect(workflow.indexOf('node scripts/label-manifest.mjs')).toBeLessThan(
        workflow.indexOf('node scripts/backlog-priority-policy.mjs'),
      );
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

  describe('tracking issue', () => {
    const revision = 'a'.repeat(40);
    const many = Array.from({ length: 120 }, (_, index) =>
      issue(1000 + index, []),
    );
    const write = (body: string) => {
      const directory = makeTempDir('backlog-issue-');
      const path = join(directory, 'report.md');
      writeFileSync(path, body);
      return path;
    };

    test('lists counts and the first offenders without cross-referencing them', () => {
      const result = evaluateBacklogPriorityPolicy([
        ...many,
        issue(7, [p1, blocked]),
      ]);
      const body = buildBacklogReport(result, { revision });
      expect(body).toContain(
        `<!-- backlog-policy findings=2 revision=${revision} -->`,
      );
      expect(body).toContain('Unclassified: 120.');
      expect(body).toContain(
        `## Unclassified (${BACKLOG_ISSUE_OFFENDERS} of 120)`,
      );
      expect(body).toContain('`#1049`');
      expect(body).not.toContain('#1050');
      expect(body).toContain('- `#7` is P1 but also blocked.');
      // Every issue number sits in a code span, so no timeline backlinks.
      expect(body.replace(/`#\d+`/g, '')).not.toMatch(/#\d/);
      expect(BACKLOG_ISSUE_OFFENDERS).toBe(50);
    });

    test('posts only a bounded, mention-free report for the checked-out revision', () => {
      const posted: string[] = [];
      const gh = (existing: string) => (args: string[]) => {
        const body = args.find((arg) => arg.startsWith('body=@'));
        if (body) posted.push(readFileSync(body.slice(6), 'utf8'));
        return args.includes('GET')
          ? existing && `${existing}\tgithub-actions[bot]`
          : '9';
      };
      const report = buildBacklogReport(
        evaluateBacklogPriorityPolicy([issue(1, [])]),
        { revision },
      ).replace('# Backlog', '@octocat # Backlog');
      const path = write(report);
      expect(
        upsertBacklogIssue({
          repo: 'o/r',
          reportPath: path,
          head: revision,
          gh: gh(''),
        }),
      ).toEqual({ action: 'created', number: 9 });
      expect(posted[0]).toContain('@\u200boctocat');
      expect(posted[0]).toContain(BACKLOG_ISSUE_TITLE);
      expect(() =>
        upsertBacklogIssue({
          repo: 'o/r',
          reportPath: path,
          head: 'b'.repeat(40),
          gh: gh(''),
        }),
      ).toThrow(/refusing to post it/);
      const huge = write(`${report}${'x'.repeat(65_536)}`);
      expect(() =>
        upsertBacklogIssue({
          repo: 'o/r',
          reportPath: huge,
          head: revision,
          gh: gh(''),
        }),
      ).toThrow(/refusing to post more than 65536/);
      expect(posted).toHaveLength(1);
      const clean = write(
        buildBacklogReport(evaluateBacklogPriorityPolicy([issue(1, [p2])]), {
          revision,
        }),
      );
      expect(
        upsertBacklogIssue({
          repo: 'o/r',
          reportPath: clean,
          head: revision,
          gh: gh('4'),
        }),
      ).toEqual({ action: 'closed', number: 4 });
    });

    test('the audit job writes the report and a dependency-free job posts it', () => {
      type Step = {
        run?: string;
        uses?: string;
        with?: Record<string, unknown>;
      };
      type Job = {
        needs?: string;
        if?: string;
        permissions?: Record<string, string>;
        steps: Step[];
      };
      const workflow = load(
        readFileSync('.github/workflows/backlog-priority-policy.yml', 'utf8'),
      ) as { permissions: Record<string, string>; jobs: Record<string, Job> };
      expect(workflow.permissions).toEqual({
        contents: 'read',
        issues: 'read',
      });
      const { enforce, 'backlog-issue': poster } = workflow.jobs;
      const runs = (job: Job) =>
        job.steps.map((step) => step.run ?? '').join('\n');
      expect(enforce.permissions).toBeUndefined();
      expect(runs(enforce)).toContain(
        'node scripts/backlog-priority-policy.mjs --report .artifacts/backlog-policy-report.md',
      );
      expect(
        enforce.steps.find((step) =>
          step.uses?.startsWith('actions/upload-artifact@'),
        )?.with,
      ).toMatchObject({ name: 'backlog-policy-report' });
      expect(poster.needs).toBe('enforce');
      expect(poster.if).toBeUndefined();
      expect(poster.permissions).toEqual({ contents: 'read', issues: 'write' });
      expect(runs(poster)).not.toMatch(/dependencies:ci|npm |pnpm|curl/);
      expect(runs(poster)).toContain(
        'node scripts/backlog-priority-policy.mjs --upsert --report .artifacts/backlog-policy-report.md',
      );
      expect(poster.steps[0].with?.['persist-credentials']).toBe(false);
    });
  });
});
