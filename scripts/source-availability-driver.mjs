import { readFileSync } from 'node:fs';
import {
  HIGHER,
  reduceIssueAvailability,
  SOURCE,
} from './issue-availability.mjs';
import {
  commitsInRange,
  mergedIssueFacts,
  validatePushRange,
} from './lib/github-merged-issue-facts.mjs';

export const REPOSITORY = 'kontourai/station';
const labelNames = (labels = []) =>
  new Set(
    labels.map((label) => (typeof label === 'string' ? label : label.name)),
  );

/** Fresh-read label writer. It never replaces a label collection wholesale. */
export function createSourceLabelAdapter(api) {
  return {
    async project(number) {
      let issue;
      try {
        issue = await api.getIssue(number);
      } catch {
        return { kind: 'unavailable' };
      }
      const decision = reduceIssueAvailability(issue.labels);
      if (decision.kind !== 'source') return decision;
      try {
        await api.addLabel(number, SOURCE);
      } catch {}
      let readback;
      try {
        readback = await api.getIssue(number);
      } catch {
        return { kind: 'unavailable' };
      }
      const labels = labelNames(readback.labels);
      const higher = HIGHER.filter((label) => labels.has(label));
      if (higher.length === 0)
        return labels.has(SOURCE)
          ? { kind: 'source' }
          : { kind: 'unavailable' };
      if (labels.has(SOURCE)) {
        try {
          await api.removeLabel(number, SOURCE);
        } catch {}
      }
      let repaired;
      try {
        repaired = labelNames((await api.getIssue(number)).labels);
      } catch {
        return { kind: 'unavailable' };
      }
      const repairedHigher = HIGHER.filter((label) => repaired.has(label));
      if (repaired.has(SOURCE)) return { kind: 'unavailable' };
      if (repairedHigher.length === 1) return { kind: 'higher-won' };
      return { kind: 'conflict' };
    },
  };
}

/** Validate all observed facts before the first label write. */
export async function runSourceAvailability(
  event,
  { exec, api, checkedOutSha },
) {
  if (
    event?.repository?.full_name !== REPOSITORY ||
    event?.ref !== 'refs/heads/main' ||
    !validatePushRange(event.before, event.after) ||
    checkedOutSha !== event.after
  )
    return { kind: 'ignored' };
  const commits = commitsInRange(event.before, event.after, exec);
  if (!commits) return { kind: 'unavailable' };
  const pulls = [];
  for (const sha of commits) {
    let page;
    try {
      page = await api.pullsForCommit(sha);
    } catch {
      return { kind: 'unavailable' };
    }
    if (
      !Array.isArray(page) ||
      page.length > 100 ||
      pulls.length + page.length > 256
    )
      return { kind: 'unavailable' };
    pulls.push(...page);
  }
  // pullsForCommit returns a SEPARATE object per commit for the same pull, so
  // a multi-commit merge push yields duplicates. Deduplicate ONCE and use the
  // same instances for both the closing-issue fetch and the facts derivation:
  // fetching onto deduped instances while deriving over the raw array left
  // every duplicate without closingIssues, failing every merge-commit push
  // (squash pushes, one commit and one object, never hit it).
  const uniquePulls = [...new Map(pulls.map((pr) => [pr.number, pr])).values()];
  for (const pr of uniquePulls) {
    if (!Number.isSafeInteger(pr?.number) || pr.number < 1)
      return { kind: 'unavailable' };
    let closingIssues;
    try {
      closingIssues = await api.closingIssuesForPull(pr.number);
    } catch {
      return { kind: 'unavailable' };
    }
    if (!Array.isArray(closingIssues) || closingIssues.length > 100)
      return { kind: 'unavailable' };
    pr.closingIssues = closingIssues;
  }
  const issues = mergedIssueFacts({
    pulls: uniquePulls,
    commits,
    owner: 'kontourai',
    repo: 'station',
    main: 'main',
  });
  if (issues === null) return { kind: 'unavailable' };
  const writer = createSourceLabelAdapter(api);
  const outcomes = [];
  for (const number of issues)
    outcomes.push([number, await writer.project(number)]);
  return outcomes.some(([, outcome]) =>
    ['conflict', 'unavailable'].includes(outcome.kind),
  )
    ? { kind: 'unavailable', outcomes }
    : { kind: 'projected', outcomes };
}

if (process.argv[1]?.endsWith('source-availability-driver.mjs')) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  // GitHub workflow supplies this narrow REST adapter; command exits nonzero
  // before a mutation on malformed/ambiguous discovery facts.
  const request = async (path, options = {}) => {
    const response = await fetch(`https://api.github.com${path}`, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        ...options.headers,
      },
    });
    if (!response.ok) throw new Error(`GitHub API ${response.status}`);
    if (response.headers.get('link')?.includes('rel="next"'))
      throw new Error('GitHub API pagination exceeded the bounded page');
    if (response.status === 204) return null;
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > 1_000_000)
      throw new Error('GitHub API response exceeded the byte bound');
    const text = await response.text();
    if (Buffer.byteLength(text) > 1_000_000)
      throw new Error('GitHub API response exceeded the byte bound');
    return JSON.parse(text);
  };
  const api = {
    pullsForCommit: (sha) =>
      request(`/repos/kontourai/station/commits/${sha}/pulls?per_page=100`),
    getIssue: (number) => request(`/repos/kontourai/station/issues/${number}`),
    addLabel: (number, name) =>
      request(`/repos/kontourai/station/issues/${number}/labels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labels: [name] }),
      }),
    removeLabel: (number, name) =>
      request(
        `/repos/kontourai/station/issues/${number}/labels/${encodeURIComponent(name)}`,
        { method: 'DELETE' },
      ),
    closingIssuesForPull: async (number) => {
      const data = await request('/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query:
            'query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){closingIssuesReferences(first:100){nodes{number repository{nameWithOwner}} pageInfo{hasNextPage}}}}}',
          variables: { owner: 'kontourai', repo: 'station', number },
        }),
      });
      if (Array.isArray(data?.errors) && data.errors.length > 0)
        throw new Error('GitHub GraphQL returned errors');
      const connection =
        data?.data?.repository?.pullRequest?.closingIssuesReferences;
      if (
        !connection ||
        connection.pageInfo?.hasNextPage ||
        !Array.isArray(connection.nodes)
      )
        throw new Error('closing issue facts are ambiguous');
      return connection.nodes.map((issue) => ({
        number: issue.number,
        repository: { full_name: issue.repository?.nameWithOwner },
      }));
    },
  };
  const result = await runSourceAvailability(event, {
    exec: undefined,
    api,
    checkedOutSha: process.env.GITHUB_SHA,
  });
  if (result.kind === 'unavailable') {
    // A silent exit 1 made this gate undiagnosable from CI for hours; the
    // outcome list, when present, names which issue projection failed.
    console.error(
      `source availability could not be derived for this push${
        result.outcomes
          ? `; outcomes: ${JSON.stringify(result.outcomes)}`
          : ' (facts stage: commits, pulls, or closing issues unresolvable)'
      }`,
    );
    process.exitCode = 1;
  }
}
