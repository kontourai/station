#!/usr/bin/env node
/**
 * Explains a merge-queue removal on the pull request itself (#3101 C and E).
 *
 * Landing automation runs this from trusted base policy on
 * `pull_request_target: dequeued`. It never executes candidate code: it reads
 * the Checks and Actions APIs, and for a conflict runs `git merge-tree` over
 * fetched objects.
 *
 * - failed_checks: a comment naming the merge group's failing checks, their
 *   error annotations (fast-checks shards annotate each failed test) and the
 *   failing runs' artifacts.
 * - merge_conflict with conflicting files against current main: a comment
 *   listing them. That is a real conflict and wakes the owner.
 * - merge_conflict that merges cleanly with current main: the conflict was with
 *   an entry ahead in the queue. A `station-autoland` PR is re-armed once per
 *   head, pinned to the head merge-tree checked; anything else gets a comment.
 *
 * Each new removal posts a new comment, so the owner is notified, and
 * minimizes this app's earlier reports as outdated. A removal this app has
 * already reported is not reported again. Only the app's own comments count:
 * a marker in anyone else's comment is ignored.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { invokedDirectly } from './lib/module-entry.mjs';
import { github, listGithub } from './qualification-evidence.mjs';

const REPORT_MARKER = '<!-- station-merge-queue-dequeue';
// Reasons measured on this repository's RemovedFromMergeQueueEvent timeline.
const REASONS = new Map([
  ['failed_checks', 'failure'],
  ['merge_conflict', 'conflict'],
]);
const FAILED_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'action_required',
  'startup_failure',
]);
const GROUP_BRANCH = /^gh-readonly-queue\/main\/pr-([1-9][0-9]*)-[0-9a-f]{40}$/;
const GENERIC_ANNOTATION = /^Process completed with exit code \d+\.?$/;
const SHA = /^[0-9a-f]{40}$/;
const LIMITS = Object.freeze({
  checks: 10,
  annotations: 8,
  annotationChars: 800,
  artifacts: 12,
  files: 50,
  lineChars: 300,
  // GitHub refuses comment bodies over 65,536 characters.
  bodyChars: 60_000,
});
const TRUNCATED = 'Truncated to fit the comment size limit; read the job log.';

/** The removal's lower-case reason, mapped to what this script explains. */
function classifyRemoval(reason) {
  return REASONS.get(String(reason ?? '').toLowerCase()) ?? null;
}

/** The newest merge-group run whose branch names this PR, before `removedAt`. */
function groupRunFor(runs, number, removedAt) {
  return (
    runs
      .filter((run) => {
        const match = GROUP_BRANCH.exec(run.head_branch ?? '');
        return (
          match &&
          Number(match[1]) === number &&
          SHA.test(run.head_sha ?? '') &&
          Date.parse(run.created_at) <= removedAt
        );
      })
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ??
    null
  );
}

function failingCheckRuns(checkRuns) {
  return checkRuns.filter((check) => FAILED_CONCLUSIONS.has(check.conclusion));
}

function usefulAnnotations(annotations) {
  return annotations.filter(
    (annotation) =>
      annotation.annotation_level === 'failure' &&
      !GENERIC_ANNOTATION.test(String(annotation.message ?? '').trim()),
  );
}

/**
 * The PR has already been dequeued for a conflict at this head: a second
 * conflict removal after the head commit means re-arming did not help.
 */
function repeatedConflict(removals, headCommittedAt) {
  const since = Date.parse(headCommittedAt);
  return (
    removals.filter(
      (removal) =>
        classifyRemoval(removal.reason) === 'conflict' &&
        Date.parse(removal.createdAt) >= since,
    ).length > 1
  );
}

function rearmEligible(pr, repository) {
  return (
    pr.state === 'open' &&
    !pr.draft &&
    pr.base?.ref === 'main' &&
    pr.head?.repo?.full_name === repository &&
    pr.labels?.some((label) => label.name === 'station-autoland') === true &&
    !pr.auto_merge
  );
}

/** Untrusted text (check names, test names, messages) as a literal block. */
function codeBlock(text) {
  const longest = Math.max(
    2,
    ...[...String(text).matchAll(/`+/g)].map((run) => run[0].length),
  );
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}
function inlineLiteral(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim().slice(0, 200);
  const longest = Math.max(
    0,
    ...[...flat.matchAll(/`+/g)].map((run) => run[0].length),
  );
  const fence = '`'.repeat(longest + 1);
  return `${fence} ${flat} ${fence}`;
}
function trustedLink(url, server) {
  return typeof url === 'string' && url.startsWith(`${server}/`) ? url : null;
}
function marker(key) {
  return `${REPORT_MARKER} ${key} -->`;
}

function renderFailureReport({ removedAt, group, checks, server, repository }) {
  const lines = [
    marker(`failure:${removedAt}`),
    '### Removed from the merge queue: failing checks',
    '',
  ];
  if (!group) {
    lines.push(
      'No merge-group run for this pull request was found, so the failing check cannot be named. Read the PR timeline and the Actions tab.',
    );
    return lines.join('\n');
  }
  lines.push(
    `Merge group \`${group.head_sha.slice(0, 12)}\` ([run](${server}/${repository}/actions/runs/${group.id})).`,
    '',
  );
  if (checks.length === 0)
    lines.push(
      'No completed failing check run was recorded on the merge group. A required check may have timed out waiting to start.',
    );
  const shown = checks.slice(0, LIMITS.checks);
  // Each check gets an equal share of the body, so one noisy check cannot
  // push the others out or the comment over GitHub's limit.
  const budget = Math.floor(LIMITS.bodyChars / Math.max(1, shown.length)) - 200;
  for (const check of shown)
    lines.push(...checkSection(check, { server, repository, budget }), '');
  if (checks.length > LIMITS.checks)
    lines.push(
      `${checks.length - LIMITS.checks} more failing check(s) omitted.`,
    );
  lines.push(
    '',
    'Fix the failure and push; the merge queue verifies the next candidate.',
  );
  return lines.join('\n');
}

function annotationText(annotations) {
  return annotations
    .map((annotation) =>
      [
        annotation.path && annotation.path !== '.github'
          ? `${annotation.path}${annotation.title ? ` :: ${annotation.title}` : ''}`.slice(
              0,
              LIMITS.lineChars,
            )
          : String(annotation.title || '').slice(0, LIMITS.lineChars),
        String(annotation.message ?? '').slice(0, LIMITS.annotationChars),
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');
}

function checkSection(check, { server, repository, budget }) {
  const link = trustedLink(check.html_url, server);
  const head = [
    `#### ${inlineLiteral(check.name)} — ${check.conclusion}${link ? ` ([job](${link}))` : ''}`,
    '',
  ];
  const tail = [];
  const annotations = check.annotations.slice(0, LIMITS.annotations);
  if (check.annotations.length > annotations.length)
    tail.push(
      '',
      `${check.annotations.length - annotations.length} more annotation(s) omitted.`,
    );
  if (check.artifacts.length) {
    tail.push('', 'Artifacts:');
    for (const artifact of check.artifacts.slice(0, LIMITS.artifacts))
      tail.push(
        `- [${inlineLiteral(artifact.name)}](${server}/${repository}/actions/runs/${artifact.runId}/artifacts/${artifact.id}) (${artifact.size_in_bytes} bytes)`,
      );
  }
  if (!annotations.length)
    return [
      ...head,
      'No error annotation beyond the exit status; read the job log.',
      ...tail,
    ];
  let text = annotationText(annotations);
  const fixed = [...head, ...tail].join('\n').length + 40;
  if (fixed + text.length > budget) {
    text = text.slice(0, Math.max(0, budget - fixed - TRUNCATED.length));
    tail.unshift('', TRUNCATED);
  }
  return [...head, codeBlock(text), ...tail];
}

function renderConflictReport({ removedAt, files, headSha, mainSha, outcome }) {
  const lines = [
    marker(`conflict:${removedAt}`),
    '### Removed from the merge queue: merge conflict',
    '',
  ];
  if (files.length) {
    lines.push(
      `Head \`${headSha.slice(0, 12)}\` conflicts with main \`${mainSha.slice(0, 12)}\` in ${files.length} file(s):`,
      '',
      codeBlock(
        files
          .slice(0, LIMITS.files)
          .map((file) => file.slice(0, LIMITS.lineChars))
          .join('\n'),
      ),
    );
    if (files.length > LIMITS.files)
      lines.push('', `${files.length - LIMITS.files} more file(s) omitted.`);
    lines.push(
      '',
      'Merge `origin/main`, resolve, re-run any generator that owns a conflicted file, and push. Automation does not resolve conflicts.',
    );
  } else {
    lines.push(
      `Head \`${headSha.slice(0, 12)}\` merges cleanly with main \`${mainSha.slice(0, 12)}\`; the conflict was with a pull request ahead of it in the queue.`,
      '',
      outcome === 'repeated'
        ? 'Automation re-arms a head at most once and did not re-arm it this time. Merge `origin/main` once the PR ahead lands, then re-arm.'
        : 'Re-arm auto-merge to re-enter the queue, or add `station-autoland` to let automation do it once per head.',
    );
  }
  return lines.join('\n');
}

/** This app's own earlier reports; a marker in anyone else's comment is not one. */
function ownReports(comments, author) {
  return comments.filter(
    (comment) =>
      comment.user?.login === author &&
      String(comment.body ?? '').startsWith(REPORT_MARKER),
  );
}

async function graphql(query, variables, env) {
  const base =
    env.GITHUB_GRAPHQL_URL ||
    `${env.GITHUB_API_URL || 'https://api.github.com'}/graphql`;
  const url = new URL(base);
  if (
    url.protocol !== 'https:' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  )
    throw new Error('GitHub GraphQL must use HTTPS');
  const response = await fetch(base, {
    method: 'POST',
    headers: {
      ...(env.GH_TOKEN ? { Authorization: `Bearer ${env.GH_TOKEN}` } : {}),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`GitHub GraphQL: HTTP ${response.status}`);
  const data = await response.json();
  if (data.errors?.length)
    throw new Error(`GitHub GraphQL: ${data.errors[0].message}`);
  return data.data;
}

const TIMELINE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(last: 1) { nodes { commit { oid committedDate } } }
      timelineItems(last: 50, itemTypes: [REMOVED_FROM_MERGE_QUEUE_EVENT]) {
        nodes { ... on RemovedFromMergeQueueEvent { createdAt reason } }
      }
    }
  }
}`;

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  }).trim();
}

/** Exact conflicting paths of head against current main, from Git itself. */
function conflictingFiles(cwd, headSha) {
  if (!SHA.test(headSha)) throw new Error('head SHA must be 40 hex digits');
  git(['fetch', '--no-tags', '--quiet', 'origin', 'main', headSha], cwd);
  const mainSha = git(['rev-parse', 'refs/remotes/origin/main'], cwd);
  const result = spawnSync(
    'git',
    [
      'merge-tree',
      '--write-tree',
      '--name-only',
      '--no-messages',
      mainSha,
      headSha,
    ],
    { cwd, encoding: 'utf8', timeout: 120_000, windowsHide: true },
  );
  if (result.status === 0) return { mainSha, files: [] };
  if (result.status !== 1)
    throw new Error(
      `git merge-tree failed (${result.status ?? result.signal}): ${result.stderr}`,
    );
  const [, ...files] = result.stdout.split('\n').filter(Boolean);
  return { mainSha, files };
}

async function failureChecks(groupSha, env) {
  const actions = { env: { ...env, GH_TOKEN: env.ACTIONS_TOKEN } };
  const { check_runs: checkRuns } = await github(
    `commits/${groupSha}/check-runs?per_page=100`,
    actions,
  );
  const checks = [];
  const artifactsByRun = new Map();
  for (const check of failingCheckRuns(checkRuns ?? []).slice(
    0,
    LIMITS.checks,
  )) {
    const annotations = usefulAnnotations(
      await github(`check-runs/${check.id}/annotations?per_page=50`, actions),
    );
    const runId = /\/actions\/runs\/([0-9]+)\//.exec(
      check.details_url ?? '',
    )?.[1];
    if (runId && !artifactsByRun.has(runId))
      artifactsByRun.set(
        runId,
        (
          await github(`actions/runs/${runId}/artifacts?per_page=100`, actions)
        ).artifacts
          .filter((artifact) => !artifact.expired)
          .map((artifact) => ({ ...artifact, runId })),
      );
    checks.push({
      ...check,
      annotations,
      artifacts: runId ? artifactsByRun.get(runId) : [],
    });
  }
  return checks.concat(
    failingCheckRuns(checkRuns ?? [])
      .slice(LIMITS.checks)
      .map((check) => ({ ...check, annotations: [], artifacts: [] })),
  );
}

const MINIMIZE_MUTATION = `mutation($id: ID!) {
  minimizeComment(input: { subjectId: $id, classifier: OUTDATED }) {
    minimizedComment { isMinimized }
  }
}`;

/**
 * Posts a new comment so the owner is notified (an edit is silent), then
 * minimizes this app's earlier reports. A removal already reported is skipped.
 */
async function postReport(number, report, env) {
  const author = env.COMMENT_AUTHOR;
  if (!author) throw new Error('COMMENT_AUTHOR is required');
  // Backstop: the per-check budget keeps the body far below GitHub's limit.
  const body =
    report.length > LIMITS.bodyChars + 4_000
      ? `${report.slice(0, LIMITS.bodyChars)}\n\n${TRUNCATED}`
      : report;
  const earlier = ownReports(
    await listGithub(`issues/${number}/comments`, null, { env }),
    author,
  );
  const key = body.split('\n', 1)[0];
  if (earlier.some((comment) => comment.body.split('\n', 1)[0] === key)) {
    console.log(`#${number}: this removal is already reported`);
    return;
  }
  await github(`issues/${number}/comments`, {
    method: 'POST',
    body: { body },
    env,
  });
  console.log(`#${number}: posted the removal report`);
  for (const comment of earlier)
    try {
      await graphql(MINIMIZE_MUTATION, { id: comment.node_id }, env);
    } catch (error) {
      // The new report is already posted; a stale one left visible is cosmetic.
      console.log(
        `::warning::#${number}: could not minimize report ${comment.id}: ${error.message}`,
      );
    }
}

async function explainDequeue({
  env = process.env,
  cwd = process.cwd(),
  now = Date.now,
} = {}) {
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const number = Number(event.pull_request?.number);
  if (event.action !== 'dequeued' || !Number.isInteger(number))
    return 'ignored';
  const repository = env.GITHUB_REPOSITORY;
  const [owner, name] = repository.split('/');
  const server = env.GITHUB_SERVER_URL || 'https://github.com';
  const timeline = (await graphql(TIMELINE_QUERY, { owner, name, number }, env))
    .repository.pullRequest;
  const removals = timeline.timelineItems.nodes;
  const removal = removals.at(-1);
  // A removal older than this event's window belongs to an earlier dequeue.
  if (!removal || now() - Date.parse(removal.createdAt) > 30 * 60_000) {
    console.log(`#${number}: no recent merge-queue removal on the timeline`);
    return 'ignored';
  }
  const kind = classifyRemoval(removal.reason);
  if (!kind) {
    console.log(`#${number}: removal reason ${removal.reason} needs no report`);
    return 'ignored';
  }
  const removedAt = Date.parse(removal.createdAt);
  if (kind === 'failure') {
    const since = new Date(removedAt - 6 * 60 * 60_000).toISOString();
    const { workflow_runs: runs } = await github(
      `actions/runs?event=merge_group&per_page=100&created=%3E%3D${since}`,
      { env: { ...env, GH_TOKEN: env.ACTIONS_TOKEN } },
    );
    const group = groupRunFor(runs ?? [], number, removedAt);
    const checks = group ? await failureChecks(group.head_sha, env) : [];
    await postReport(
      number,
      renderFailureReport({
        removedAt: removal.createdAt,
        group,
        checks,
        server,
        repository,
      }),
      env,
    );
    return 'reported-failure';
  }
  const pr = await github(`pulls/${number}`, { env });
  const { mainSha, files } = conflictingFiles(cwd, pr.head.sha);
  let outcome = 'conflict';
  if (files.length === 0) {
    const head = timeline.commits.nodes.at(-1)?.commit;
    if (!rearmEligible(pr, repository)) outcome = 'clean';
    // A head the timeline does not show yet is treated as already re-armed.
    else if (
      head?.oid !== pr.head.sha ||
      repeatedConflict(removals, head.committedDate)
    )
      outcome = 'repeated';
    else {
      // Consent is the station-autoland label; GitHub owns the queue and its
      // checks. Once per head: a second conflict removal stops here.
      execFileSync(
        'gh',
        [
          'pr',
          'merge',
          String(number),
          '--repo',
          repository,
          '--auto',
          // Arm only the head merge-tree checked; a later push is refused.
          '--match-head-commit',
          pr.head.sha,
        ],
        { env, stdio: 'inherit', timeout: 30_000, windowsHide: true },
      );
      console.log(`#${number}: merges cleanly with main; re-armed once`);
      return 'rearmed';
    }
  }
  await postReport(
    number,
    renderConflictReport({
      removedAt: removal.createdAt,
      files,
      headSha: pr.head.sha,
      mainSha,
      outcome,
    }),
    env,
  );
  return `reported-${outcome}`;
}

if (invokedDirectly(import.meta.url))
  explainDequeue()
    .then((outcome) => console.log(`dequeue: ${outcome}`))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
