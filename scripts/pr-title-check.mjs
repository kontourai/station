import { readFileSync } from 'node:fs';
import { validatePullRequestTitle } from './commit-message-gate.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

/** The workflow publishes pending before setup and serializes this publisher
 * per head. Terminal decisions use live metadata, never edited-event titles. */
export async function publishTitlePolicy({
  repository,
  event,
  eventName,
  apiUrl,
  token,
}) {
  const sha =
    eventName === 'pull_request_target'
      ? event.pull_request?.head?.sha
      : eventName === 'merge_group'
        ? event.merge_group?.head_sha
        : undefined;
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Missing exact policy head');
  const request = async (path, body) => {
    const response = await fetch(`${apiUrl}/repos/${repository}/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub API ${response.status}`);
    return response.json();
  };
  // The workflow's always() fallback publishes failure if any operation throws.
  let verdict;
  if (eventName === 'merge_group') {
    if (event.merge_group.base_ref !== 'refs/heads/main')
      throw new Error('Unexpected merge-group target');
    verdict = {
      ok: true,
      description: 'PR titles checked before queue admission',
    };
  } else {
    const number = event.pull_request.number;
    if (!/^[1-9]\d*$/.test(String(number)))
      throw new Error('Missing pull-request number');
    const pr = await request(`pulls/${number}`);
    if (pr.head?.sha !== sha || pr.base?.ref !== 'main' || pr.state !== 'open')
      throw new Error('Pull request moved to another head or target');
    // Associated PRs can contain this commit without owning it as their head.
    // Refuse a full page: the status must never certify a truncated owner set.
    const associated = await request(`commits/${sha}/pulls?per_page=100`);
    if (!Array.isArray(associated) || associated.length >= 100)
      throw new Error('Incomplete shared-head pull-request inventory');
    const owners = associated.filter(
      (candidate) =>
        candidate.state === 'open' &&
        candidate.base?.ref === 'main' &&
        candidate.head?.sha === sha,
    );
    if (!owners.some((candidate) => candidate.number === number))
      throw new Error('Triggered pull request missing from exact-head owners');
    const valid =
      validatePullRequestTitle(pr.title, number).ok &&
      owners.every(
        (candidate) =>
          validatePullRequestTitle(candidate.title, candidate.number).ok,
      );
    verdict = {
      ok: valid,
      description: valid
        ? 'All open main-target titles at this head conform'
        : 'An open main-target title at this head does not conform',
    };
  }
  await request(`statuses/${sha}`, {
    context: 'PR title policy',
    state: verdict.ok ? 'success' : 'failure',
    description: verdict.description,
  });
  if (!verdict.ok) throw new Error('Pull-request title does not conform');
}

if (invokedDirectly(import.meta.url)) {
  try {
    await publishTitlePolicy({
      repository: process.env.GITHUB_REPOSITORY,
      event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')),
      eventName: process.env.GITHUB_EVENT_NAME,
      apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
      token: process.env.GH_TOKEN,
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
