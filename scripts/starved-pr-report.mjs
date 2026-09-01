#!/usr/bin/env node

/**
 * station#1153: report pull requests that are ready and will never merge.
 *
 * A PR that is CLEAN, not in the merge queue, and not armed for auto-merge is
 * finished work that nothing is scheduled to land. It is the only PR state
 * with no surface anywhere: red PRs show in checks, conflicted ones show as
 * DIRTY, drafts are visibly draft. A green PR nobody armed looks exactly like
 * one that is progressing, and waits indefinitely.
 *
 * ## Why `autoMergeRequest` alone cannot find it
 *
 * That field is null for BOTH "never armed" and "already queued" — arming is
 * consumed when a PR enters the queue. Measured on this repo: two PRs read
 * null while `isInMergeQueue` was true and moving, while a third read non-null
 * with `isInMergeQueue` false. The field cannot separate ready-and-stuck from
 * ready-and-moving, and REST does not expose `isInMergeQueue` at all, so the
 * read has to go through GraphQL. See docs/strategy/multi-agent-delivery-protocol.md.
 *
 * ## Why this reports and does not arm
 *
 * Arming automatically would close the detection gap by removing the decision,
 * and the decision is load-bearing. In one evening on this repo, four PRs were
 * CLEAN with a real defect inside them, each caught by a human declining to
 * arm: an inert CSS rule that never applied, a path comparison that missed a
 * relative STATION_HOME, a capped-not-refused response read, and a change that
 * would have merged before the review which found two further regressions.
 * `CLEAN` means the gates we wrote did not object. It has never meant reviewed.
 *
 * The asymmetry decides it: a starved PR costs latency and someone notices; an
 * auto-merged unreviewed one costs a broken main.
 *
 * ## Deliberate holds
 *
 * "Held on purpose" and "forgotten" are indistinguishable from outside, so a
 * detector that cannot tell them apart becomes noise and gets skimmed — which
 * is how this state became invisible to begin with. Two ways to say "held":
 * the `blocked` label, or a HOLD_MARKER line in the PR body naming the reason.
 */

import { execFileSync } from 'node:child_process';

export const REPORT_MARKER = '<!-- starved-pr-report -->';
export const HOLD_MARKER = '<!-- starved-ok:';
const HOLD_LABEL = 'blocked';

/**
 * A PR is starved when it is ready, outside the queue, and unarmed — and its
 * author has not said it is held. Draft PRs are excluded: a draft is a visible
 * statement that the work is not offered yet.
 */
export function isStarved(pr) {
  if (!pr || pr.isDraft) return false;
  if (pr.mergeStateStatus !== 'CLEAN') return false;
  if (pr.isInMergeQueue) return false;
  if (pr.autoMergeRequest) return false;
  return !isHeld(pr);
}

export function isHeld(pr) {
  const labels = pr?.labels?.nodes ?? [];
  if (labels.some((label) => label?.name === HOLD_LABEL)) return true;
  return typeof pr?.body === 'string' && pr.body.includes(HOLD_MARKER);
}

/** Already reported: this run must not repeat a comment it already left. */
export function alreadyReported(pr) {
  const comments = pr?.comments?.nodes ?? [];
  return comments.some(
    (comment) =>
      typeof comment?.body === 'string' && comment.body.includes(REPORT_MARKER),
  );
}

export function selectStarved(pullRequests) {
  return pullRequests
    .filter((pr) => isStarved(pr))
    .filter((pr) => !alreadyReported(pr));
}

export function reportBody(number) {
  return `${REPORT_MARKER}
This pull request is **ready and will not merge**: every required check is green, it is not in the merge queue, and auto-merge is not enabled. Nothing is scheduled to land it.

Arm it when you are satisfied it is ready:

\`\`\`
gh pr merge ${number} --auto --squash    # --merge instead, if this PR's grouped commit history is the point
\`\`\`

**Verify the arming took rather than assuming it did.** Arming is lost in several ways on this repo: entering the merge queue consumes it (benign — the pull request is moving); a conflict-resolution push has dropped it; and an already-queued pull request has fallen back out to CLEAN and unarmed with no author action at all. A push does not always clear it, so this is "check afterwards", not a rule about pushes.

Check with \`isInMergeQueue\`, never \`autoMergeRequest\` alone — that field reads null both for "never armed" and "already queued", which are opposite facts:

\`\`\`
gh api graphql -f query='query{repository(owner:"kontourai",name:"station"){
  pullRequest(number:${number}){isInMergeQueue mergeStateStatus autoMergeRequest{enabledAt}}}}'
\`\`\`

**One case where arming will not help.** A pull request can also reach this state by being removed from the merge queue while the queue was jammed, rather than by never being armed — and the two look identical from here. Under \`max_entries_to_merge: 1\` a stuck head blocks everything behind it, and entries behind it have been observed dropping back to CLEAN and unarmed with no author action. The mechanism is not established; only the correlation is. If the queue's head has been AWAITING_CHECKS for a long time, re-arming this pull request just returns it behind the same blockage, and the head is what needs attention:

\`\`\`
gh api graphql -f query='query{repository(owner:"kontourai",name:"station"){mergeQueue{
  entries(first:5){nodes{position state enqueuedAt pullRequest{number}}}}}}'
\`\`\`

If it is held deliberately, say so and this will stop reporting it — either apply the \`${HOLD_LABEL}\` label, or add a line to the PR body naming the reason:

\`\`\`
${HOLD_MARKER} waiting on review of the fix round -->
\`\`\`

**Why this is worth a comment rather than a dashboard.** Ready-and-unarmed is the only PR state with no surface: red shows in checks, conflicted shows as \`DIRTY\`, drafts are visibly draft. And \`autoMergeRequest\` reads null both for "never armed" and "already queued", so the obvious field cannot tell a stuck PR from one that is actively merging.

*Reported by \`scripts/starved-pr-report.mjs\` (station#1153). This comment is posted once per pull request.*`;
}

const QUERY = `query($owner:String!, $name:String!) {
  repository(owner:$owner, name:$name) {
    pullRequests(states:OPEN, first:100) {
      nodes {
        number isDraft isInMergeQueue mergeStateStatus body
        autoMergeRequest { enabledAt }
        labels(first:20) { nodes { name } }
        comments(last:100) { nodes { body } }
      }
    }
  }
}`;

function gh(args, options = {}) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

export function main(argv = process.argv.slice(2)) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) {
    throw new Error(
      'GITHUB_REPOSITORY is required. Run this against the live board with:\n\n' +
        '  GITHUB_REPOSITORY=kontourai/station node scripts/starved-pr-report.mjs\n\n' +
        'add --apply to post comments; without it this only prints.',
    );
  }
  const [owner, name] = repository.split('/');
  const apply = argv.includes('--apply');

  const raw = gh([
    'api',
    'graphql',
    '-f',
    `query=${QUERY}`,
    '-F',
    `owner=${owner}`,
    '-F',
    `name=${name}`,
  ]);
  const nodes = JSON.parse(raw)?.data?.repository?.pullRequests?.nodes ?? [];
  const starved = selectStarved(nodes);

  if (starved.length === 0) {
    console.log('starved-pr-report: no unreported starved pull requests.');
    return;
  }

  for (const pr of starved) {
    console.log(
      `starved-pr-report: #${pr.number} is CLEAN, unqueued and unarmed.`,
    );
    if (!apply) continue;
    gh([
      'pr',
      'comment',
      String(pr.number),
      '--repo',
      repository,
      '--body',
      reportBody(pr.number),
    ]);
  }
  console.log(
    `starved-pr-report: ${starved.length} starved pull request(s)${apply ? ' commented' : ' (dry run)'}.`,
  );
}

if (process.argv[1]?.endsWith('starved-pr-report.mjs')) main();
