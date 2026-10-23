import { describe, expect, it } from 'vitest';
import {
  canonicalGitHubWorkItemRef,
  formatGitHubWorkItemRef,
  gitHubIssueUrlFromWorkItemRef,
  isGitHubNamespacedWorkItemRef,
  parseGitHubWorkItemRef,
  workItemRefFromGitHubIssueUrl,
  workItemRefKey,
} from '../work-item-provider.js';

describe('GitHub work-item ref <-> issue URL', () => {
  it.each([
    ['github:kontourai/station#4003', 'kontourai', 'station', 4003],
    ['github:a/b#1', 'a', 'b', 1],
    ['github:kontour-ai/my.repo_name-2#99', 'kontour-ai', 'my.repo_name-2', 99],
  ])(
    'parses %s and round-trips through its issue URL',
    (ref, owner, repo, number) => {
      expect(parseGitHubWorkItemRef(ref)).toEqual({ owner, repo, number });
      const url = gitHubIssueUrlFromWorkItemRef(ref);
      expect(url).toBe(`https://github.com/${owner}/${repo}/issues/${number}`);
      expect(workItemRefFromGitHubIssueUrl(url!)).toBe(ref);
      expect(formatGitHubWorkItemRef({ owner, repo, number })).toBe(ref);
    },
  );

  it('lowercases owner and repository at parse time: one item, one spelling (review F5)', () => {
    expect(parseGitHubWorkItemRef('github:Kontour-AI/My.Repo#99')).toEqual({
      owner: 'kontour-ai',
      repo: 'my.repo',
      number: 99,
    });
    expect(canonicalGitHubWorkItemRef('github:Kontour-AI/My.Repo#99')).toBe(
      'github:kontour-ai/my.repo#99',
    );
    expect(
      workItemRefFromGitHubIssueUrl(
        'https://github.com/Kontour-AI/My.Repo/issues/99',
      ),
    ).toBe('github:kontour-ai/my.repo#99');
    expect(workItemRefKey('github:A/B#1')).toBe(workItemRefKey('github:a/b#1'));
    // Anything else is compared as written.
    expect(workItemRefKey('Flow-Slug')).toBe('Flow-Slug');
    expect(canonicalGitHubWorkItemRef('github:a/b')).toBeNull();
    expect(isGitHubNamespacedWorkItemRef(' GitHub:a/b')).toBe(true);
    expect(isGitHubNamespacedWorkItemRef('gitlab:a/b#1')).toBe(false);
  });

  it.each([
    '',
    '#12',
    '12',
    'github:kontourai/station',
    'github:kontourai/station#',
    'github:kontourai/station#0',
    'github:kontourai/station#012',
    'github:kontourai/station#-1',
    'github:kontourai/station#1.5',
    'github:kontourai/station#1#2',
    'github:kontourai/station#99999999999999999',
    ' github:kontourai/station#1',
    'github:kontourai/station#1 ',
    'GITHUB:kontourai/station#1',
    'gitlab:kontourai/station#1',
    'github:ghe.example.com/kontourai/station#1',
    'github:kontourai/sub/station#1',
    'github:-kontourai/station#1',
    'github:kontourai-/station#1',
    'github:kontour--ai/station#1',
    `github:${'a'.repeat(40)}/station#1`,
    'github:kontourai/.#1',
    'github:kontourai/..#1',
    `github:kontourai/${'r'.repeat(101)}#1`,
    'github:kontourai/sta tion#1',
    'github:kontourai/station#1\n',
    'https://github.com/kontourai/station/issues/1',
    'xgithub:kontourai/station#1',
    'prefix github:kontourai/station#1',
  ])('refuses ref %j', (ref) => {
    expect(parseGitHubWorkItemRef(ref)).toBeNull();
    expect(gitHubIssueUrlFromWorkItemRef(ref)).toBeNull();
  });

  it.each([
    'http://github.com/kontourai/station/issues/1',
    'https://www.github.com/kontourai/station/issues/1',
    'https://GitHub.com/kontourai/station/issues/1',
    'https://ghe.example.com/kontourai/station/issues/1',
    'https://github.com.evil.example/kontourai/station/issues/1',
    'https://evil.example/github.com/kontourai/station/issues/1',
    'https://github.com:443/kontourai/station/issues/1',
    'https://github.com:8443/kontourai/station/issues/1',
    'https://user:token@github.com/kontourai/station/issues/1',
    'https://github.com/kontourai/station/pull/1',
    'https://github.com/kontourai/station/issues',
    'https://github.com/kontourai/station/issues/',
    'https://github.com/kontourai/station/issues/1/',
    'https://github.com/kontourai/station/issues/1?x=1',
    'https://github.com/kontourai/station/issues/1#issuecomment-5',
    'https://github.com/kontourai/station/issues/0',
    'https://github.com/kontourai/station/issues/01',
    'https://github.com/kontourai/x/../station/issues/1',
    'https://github.com/kontourai/station/issues/1/comments',
    'https://github.com/orgs/kontourai/station/issues/1',
    ' https://github.com/kontourai/station/issues/1',
    'github:kontourai/station#1',
    'not a url',
  ])('refuses URL %j', (url) => {
    expect(workItemRefFromGitHubIssueUrl(url)).toBeNull();
  });
});
