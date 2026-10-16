import { readFileSync } from 'node:fs';
import { validatePullRequestTitle } from './commit-message-gate.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

/** Validate current metadata, including for delayed edited events. No source
 * checkout, run lookup, status reconciliation or workflow wait belongs here. */
export async function checkLivePullRequestTitle({
  repository,
  event,
  request,
}) {
  const number = event.pull_request?.number;
  if (!/^[1-9]\d*$/.test(String(number)))
    throw new Error('Missing pull-request number');
  const pr = await request(`repos/${repository}/pulls/${number}`);
  if (pr.head?.sha !== event.pull_request.head.sha || pr.base?.ref !== 'main')
    throw new Error('Pull request moved to another head or target');
  const verdict = validatePullRequestTitle(pr.title, number);
  if (!verdict.ok) throw new Error(`Pull-request title: ${verdict.reason}`);
}

if (invokedDirectly(import.meta.url)) {
  try {
    await checkLivePullRequestTitle({
      repository: process.env.GITHUB_REPOSITORY,
      event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')),
      request: async (path) => {
        const response = await fetch(
          `${process.env.GITHUB_API_URL || 'https://api.github.com'}/${path}`,
          {
            headers: {
              Authorization: `Bearer ${process.env.GH_TOKEN}`,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
            },
            signal: AbortSignal.timeout(30_000),
          },
        );
        if (!response.ok) throw new Error(`GitHub API ${response.status}`);
        return response.json();
      },
    });
    console.log('Live pull-request title conforms.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
