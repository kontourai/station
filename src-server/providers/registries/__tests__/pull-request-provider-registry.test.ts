import { afterEach, describe, expect, test } from 'vitest';
import { GitHubPullRequestProvider } from '../../../services/pull-requests/github-pull-request-provider.js';
import { GitLabPullRequestProvider } from '../../../services/pull-requests/gitlab-pull-request-provider.js';
import {
  clearAll,
  listProviders,
  registerPullRequestProvider,
} from '../registry.js';

afterEach(() => clearAll());

describe('pull request provider registry', () => {
  test('retains GitHub and GitLab as additive providers', () => {
    registerPullRequestProvider(new GitHubPullRequestProvider());
    registerPullRequestProvider(new GitLabPullRequestProvider());
    expect(
      listProviders('pullRequest').map((entry) => entry.provider.id),
    ).toEqual(['github', 'gitlab']);
  });
});
