#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { validateIssueLabelAxes } from './label-manifest.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';
import {
  assertReportRevision,
  postableReport,
  runGh,
  upsertTrackingIssue,
} from './lib/tracking-issue.mjs';

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
  // Uncapped. The cap of 5 was dropped when "every bug is P1" made a numeric
  // ceiling incoherent; that derivation has since been removed (owner
  // decision, 2026-09-09) and the queue was left uncapped rather than
  // silently re-capped, because restoring a ceiling would fail the gate on a
  // backlog nobody has re-triaged. Whether P1 should be capped again is an
  // open question, not a settled one.
  //
  // What a cap bought was the meaning of P1: "actionable now". That meaning
  // now rests on the rule below — a P1 may not also carry
  // `blocked`/`epic`/`decision-needed`/`acceptance-needed`, so work that is
  // not actionable has to say why. `null` means uncapped; a number caps the
  // queue. Annotated because the frozen literal would otherwise infer the type
  // `null`, and the comparison below — and the policy tests that exercise a
  // real cap — both treat it as a number.
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
    unclassifiedIssues,
    summary: {
      open: openIssues.length,
      actionableP1: actionableP1Issues.length,
      unclassified: unclassifiedIssues.length,
    },
  };
}

/**
 * How many times to re-read the backlog before giving up.
 *
 * A mismatch is usually the endpoint truncating (see `readIssues`), which the
 * next attempt clears. It can also be a genuine concurrent change — this gate
 * runs ON issue events, so an issue opening between the count and the listing
 * is a real race. Both resolve by reading again; only a persistent mismatch
 * fails, and the message prints every attempt so a 374-vs-375 race is legible
 * as such rather than as a truncation.
 */
/**
 * Issues only — GraphQL's `repository.issues` excludes pull requests, unlike
 * the REST listing — with the label names the policy classifies on, and the
 * server's own `totalCount` in the same response so completeness is checked
 * against the same source that produced the page.
 */
const BACKLOG_QUERY = `query($owner:String!,$name:String!,$after:String){
  repository(owner:$owner,name:$name){
    issues(states:OPEN, first:100, after:$after){
      totalCount
      pageInfo{ hasNextPage endCursor }
      nodes{ number labels(first:100){ nodes{ name } } }
    }
  }
}`;

/**
 * The policy reads `state` and `pull_request` because its other caller is a
 * saved REST list (`--input`). GraphQL returns neither: the query already
 * filters to `states:OPEN`, and `repository.issues` never contains a pull
 * request. Stamping `state` here keeps one shape flowing into the evaluator
 * rather than teaching it a second one.
 */
export function backlogIssueFromNode(node) {
  return {
    number: node.number,
    state: 'open',
    labels: node.labels.nodes,
  };
}

export function backlogReadIsComplete(issues, totalCount) {
  return issues.length >= totalCount;
}

function runQuery(repository, after) {
  const [owner, name] = repository.split('/');
  const args = [
    'api',
    'graphql',
    '-f',
    `query=${BACKLOG_QUERY}`,
    '-F',
    `owner=${owner}`,
    '-F',
    `name=${name}`,
  ];
  if (after) args.push('-F', `after=${after}`);
  return JSON.parse(
    execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }),
  ).data.repository.issues;
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

  // Read through GraphQL rather than `repos/:owner/:repo/issues?state=open`.
  // That REST listing truncates: it answers 200 with a SHORT page and no
  // `Link: rel="next"`, so a walk cannot tell a truncated list from a
  // finished one, and `gh` exits 0 with nothing on stderr. Measured on
  // 2026-09-15 against 361 open issues, consecutive identical reads returned
  // 5, 96, 100, 109, 192, 200, 300 and 375 items; sometimes a short final
  // page claiming completeness, sometimes an empty page behind a cursor.
  // Retrying does not converge, because a truncated read is a prefix and the
  // short page presents itself as the end. The same walk over GraphQL
  // returned 361 on every attempt.
  //
  // The damage was one-directional, which is why nobody saw it. Every finding
  // this policy produces is existential — "these issues are unclassified" —
  // so a short read produces FEWER findings and an empty read produces none.
  // The gate printed `{"open":0,"actionableP1":0,"unclassified":0}` and
  // exited 0 against a backlog of 361 open issues: a clean bill of health for
  // a backlog it had not read.
  //
  // `totalCount` comes back in the same response as the first page, so the
  // completeness check below is against the server's own count rather than a
  // second endpoint that could disagree for its own reasons.
  const issues = [];
  let after;
  let totalCount = 0;
  for (;;) {
    const connection = runQuery(repository, after);
    totalCount = connection.totalCount;
    issues.push(...connection.nodes.map(backlogIssueFromNode));
    if (!connection.pageInfo.hasNextPage) break;
    after = connection.pageInfo.endCursor;
  }

  if (backlogReadIsComplete(issues, totalCount)) return issues;

  throw new Error(
    `Read ${issues.length} of ${totalCount} open issues from the ` +
      `${repository} backlog.\n\n` +
      'Evaluating a partial read would report FEWER unclassified issues than ' +
      'exist, so this fails rather than passing on a short read.',
  );
}

export const BACKLOG_ISSUE_TITLE = 'Backlog policy findings';
// The tracker is itself an open issue the policy audits, so it carries a
// priority.
export const BACKLOG_ISSUE_LABELS = Object.freeze(['P2']);
/** Entries per list in the tracker; the run summary lists every finding. */
export const BACKLOG_ISSUE_OFFENDERS = 50;
const MARKER = 'backlog-policy';

// `#123` in an issue body adds a cross-reference to issue 123's timeline on
// every edit; a code span names the issue without that.
const quoteIssueNumbers = (text) => text.replace(/#(\d+)/g, '`#$1`');

/** The tracking issue body for one evaluation at one revision. */
export function buildBacklogReport(result, { revision }) {
  const { open, actionableP1, unclassified } = result.summary;
  const shown = result.unclassifiedIssues.slice(0, BACKLOG_ISSUE_OFFENDERS);
  const others = result.findings.filter(
    (finding) => !finding.startsWith('Unclassified open issues:'),
  );
  return `${[
    `<!-- ${MARKER} findings=${result.findings.length} revision=${revision} -->`,
    `# ${BACKLOG_ISSUE_TITLE}`,
    '',
    `The daily [backlog policy](../blob/main/docs/reference/backlog-disposition-policy.md) audit at ${revision}. Open issues: ${open}. Actionable P1: ${actionableP1}. Unclassified: ${unclassified}.`,
    '',
    ...(unclassified
      ? [
          `## Unclassified (${shown.length} of ${unclassified})`,
          '',
          `Apply one of: ${BACKLOG_POLICY.classificationLabels.join(', ')}.`,
          '',
          shown.map((number) => `\`#${number}\``).join(' '),
          '',
        ]
      : []),
    ...(others.length
      ? [
          '## Other findings',
          '',
          ...others
            .slice(0, BACKLOG_ISSUE_OFFENDERS)
            .map((finding) => `- ${quoteIssueNumbers(finding)}`),
          ...(others.length > BACKLOG_ISSUE_OFFENDERS
            ? [
                `- ${others.length - BACKLOG_ISSUE_OFFENDERS} more; the run summary lists every finding.`,
              ]
            : []),
          '',
        ]
      : []),
    ...(result.findings.length ? [] : ['_Nothing to report._', '']),
  ].join('\n')}`;
}

/**
 * Keep the one tracking issue current from a report another job wrote: only
 * one stamped with this checkout's revision (current, which is not proof of
 * who wrote it), with mentions broken and the posted text within the bound.
 * @param {{ repo: string, reportPath: string, head?: string, gh?: (args: string[]) => string }} input
 */
export function upsertBacklogIssue({
  repo,
  reportPath,
  head = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim(),
  gh = runGh,
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? ''))
    throw new Error('--repo must be owner/name');
  const match = new RegExp(
    `^<!-- ${MARKER} findings=(\\d+) revision=([a-f0-9]{40}) -->$`,
    'm',
  ).exec(readFileSync(reportPath, 'utf8'));
  if (!match) throw new Error(`report is missing the ${MARKER} marker`);
  assertReportRevision(match[2], head);
  return upsertTrackingIssue({
    repo,
    reportPath: postableReport(reportPath),
    title: BACKLOG_ISSUE_TITLE,
    labels: BACKLOG_ISSUE_LABELS,
    outstanding: Number(match[1]),
    gh,
  });
}

function flagValue(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--'))
    throw new Error(`${name} requires a value.`);
  return value;
}

function parseInputPath(argv) {
  const index = argv.indexOf('--input');
  if (index === -1) return undefined;
  if (!argv[index + 1]) throw new Error('--input requires a JSON path.');
  return argv[index + 1];
}

/**
 * Report-only: policy findings are printed, annotated and written to the job
 * summary, and the process still exits 0. A permanently red daily run was
 * ignored, so the red no longer carries information. An unreadable or
 * partial backlog is not a finding: `readIssues` throws, and the process
 * exits non-zero, as does the label-manifest check the workflow runs first.
 */
function main() {
  const argv = process.argv.slice(2);
  const reportPath = flagValue(argv, '--report');
  if (argv.includes('--upsert')) {
    if (!reportPath) throw new Error('--upsert requires --report <path>.');
    const outcome = upsertBacklogIssue({
      repo: flagValue(argv, '--repo'),
      reportPath,
    });
    console.log(
      `[backlog-policy] ${outcome.action}${outcome.number ? ` #${outcome.number}` : ''}`,
    );
    return;
  }
  const issues = readIssues(parseInputPath(argv));
  const result = evaluateBacklogPriorityPolicy(issues);
  if (reportPath)
    writeFileSync(
      reportPath,
      buildBacklogReport(result, {
        revision: execFileSync('git', ['rev-parse', 'HEAD'], {
          encoding: 'utf8',
          windowsHide: true,
        }).trim(),
      }),
    );
  console.log(JSON.stringify(result.summary));
  for (const finding of result.findings)
    console.error(`::warning title=Backlog policy::${finding}`);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath)
    appendFileSync(
      summaryPath,
      [
        '## Backlog policy',
        '',
        `Open issues: ${result.summary.open}. Actionable P1: ${result.summary.actionableP1}. Unclassified: ${result.summary.unclassified}.`,
        '',
        ...(result.findings.length
          ? result.findings.map((finding) => `- ${finding}`)
          : ['No findings.']),
        '',
      ].join('\n'),
    );
}

if (invokedDirectly(import.meta.url)) main();
