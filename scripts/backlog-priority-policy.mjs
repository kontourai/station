#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { validateIssueLabelAxes } from './label-manifest.mjs';

const PRIORITIES = Object.freeze(['P1', 'P2', 'P3']);
const NON_ACTIONABLE_DISPOSITIONS = Object.freeze([
  'blocked',
  'epic',
  'decision-needed',
  'acceptance-needed',
]);

/**
 * The cap is `number | null`, not the literal `null` TypeScript would infer
 * from the value alone. The distinction is load-bearing: the enforcement
 * branch is deliberately retained (`policy.maxActionableP1 !== null && …`) so
 * re-capping is a one-constant change, and the policy tests prove that by
 * spreading a numeric override over this object. Without this annotation that
 * override is a type error, which is how #3190 left `tsconfig.scripts` red.
 *
 * @type {Readonly<{
 *   maxActionableP1: number | null;
 *   priorities: readonly string[];
 *   nonActionableDispositions: readonly string[];
 *   classificationLabels: string[];
 * }>}
 */
export const BACKLOG_POLICY = Object.freeze({
  // Owner directive (2026-08-18): every bug is P1. A numeric ceiling and that
  // rule cannot coexist — there are 33 open bugs and the count moves daily, so
  // any finite number just reschedules this failure. `null` means uncapped.
  //
  // What the old cap of 5 bought was the meaning of P1: "actionable now". That
  // meaning now comes from the label itself — a bug is actionable by
  // definition, and work that is genuinely not actionable still has to say so
  // through `blocked`/`epic`/`decision-needed`/`acceptance-needed`, which a P1
  // still may not carry. Ordering within P1 is no longer expressed by scarcity.
  // `null` means uncapped; a number caps the actionable P1 queue. Annotated
  // because the frozen literal would otherwise infer the type `null`, and the
  // comparison below — and the policy tests that exercise a real cap — both
  // treat it as a number.
  /** @type {number | null} */
  maxActionableP1: null,
  priorities: PRIORITIES,
  nonActionableDispositions: NON_ACTIONABLE_DISPOSITIONS,
  // Every open issue needs one of these explicit classifications. Keep this
  // derived from the two public categories so additions cannot silently make
  // an issue look classified without being reviewed by the policy tests.
  classificationLabels: [...PRIORITIES, ...NON_ACTIONABLE_DISPOSITIONS],
});

function labelNames(issue) {
  return (issue.labels ?? []).map((label) =>
    typeof label === 'string' ? label : label.name,
  );
}

export function evaluateBacklogPriorityPolicy(
  issues,
  { policy = BACKLOG_POLICY } = {},
) {
  const openIssues = issues.filter(
    (issue) => issue.state === 'open' && !issue.pull_request,
  );
  const findings = [];
  const actionableP1Issues = [];
  const unclassifiedIssues = [];

  for (const issue of openIssues) {
    const labels = labelNames(issue);
    for (const finding of validateIssueLabelAxes(labels)) {
      findings.push(`#${issue.number} ${finding}`);
    }
    const priorities = labels.filter((label) =>
      policy.priorities.includes(label),
    );

    if (priorities.length > 1) {
      findings.push(
        `#${issue.number} has multiple priorities: ${priorities.join(', ')}.`,
      );
    }

    const nonActionableDispositions = labels.filter((label) =>
      policy.nonActionableDispositions.includes(label),
    );
    const classifications = labels.filter((label) =>
      policy.classificationLabels.includes(label),
    );

    if (classifications.length === 0) unclassifiedIssues.push(issue.number);

    if (priorities.includes('P1')) {
      if (nonActionableDispositions.length > 0) {
        findings.push(
          `#${issue.number} is P1 but also ${nonActionableDispositions.join(', ')}.`,
        );
      } else {
        actionableP1Issues.push(issue.number);
      }
    }
  }

  if (
    policy.maxActionableP1 !== null &&
    actionableP1Issues.length > policy.maxActionableP1
  ) {
    findings.push(
      `Actionable P1 queue has ${actionableP1Issues.length} issues; maximum is ${policy.maxActionableP1}: ${actionableP1Issues.map((number) => `#${number}`).join(', ')}.`,
    );
  }
  if (unclassifiedIssues.length > 0) {
    findings.push(
      `Unclassified open issues: ${unclassifiedIssues.map((number) => `#${number}`).join(', ')}. Apply one of: ${policy.classificationLabels.join(', ')}.`,
    );
  }

  return {
    findings,
    summary: {
      open: openIssues.length,
      actionableP1: actionableP1Issues.length,
      unclassified: unclassifiedIssues.length,
    },
  };
}

function readIssues(inputPath) {
  if (inputPath) return JSON.parse(readFileSync(inputPath, 'utf8'));
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) {
    throw new Error(
      'GITHUB_REPOSITORY is required without --input. Run this against the ' +
        'live backlog with:\n\n' +
        '  GITHUB_REPOSITORY=kontourai/station node ' +
        'scripts/backlog-priority-policy.mjs\n\n' +
        'or pass --input <file> to evaluate a saved issue list.',
    );
  }
  return JSON.parse(
    execFileSync(
      'gh',
      [
        'api',
        '--paginate',
        '--slurp',
        `repos/${repository}/issues?state=open&per_page=100`,
      ],
      { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
    ),
  ).flat();
}

function parseInputPath(argv) {
  const index = argv.indexOf('--input');
  if (index === -1) return undefined;
  if (!argv[index + 1]) throw new Error('--input requires a JSON path.');
  return argv[index + 1];
}

function main() {
  const issues = readIssues(parseInputPath(process.argv.slice(2)));
  const result = evaluateBacklogPriorityPolicy(issues);
  console.log(JSON.stringify(result.summary));
  for (const finding of result.findings) console.error(`FAIL: ${finding}`);
  if (result.findings.length > 0) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
