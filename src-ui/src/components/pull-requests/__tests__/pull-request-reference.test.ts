import { describe, expect, test } from 'vitest';
import { parsePullRequestReference } from '../pull-request-reference';

const scope = {
  provider: 'github',
  host: 'github.com',
  repository: { owner: 'kontourai', name: 'station' },
};

describe('parsePullRequestReference', () => {
  test('a GitHub pull URL names its own host and repository', () => {
    expect(
      parsePullRequestReference('https://github.com/lantern/lantern/pull/42'),
    ).toEqual({
      provider: 'github',
      host: 'github.com',
      repository: { owner: 'lantern', name: 'lantern' },
      ref: '42',
    });
    // A self-hosted GitHub Enterprise host is GitHub's provider by Station's
    // own host rule, and the host keeps its port.
    expect(
      parsePullRequestReference('https://git.example.com:8443/o/r/pull/7'),
    ).toEqual({
      provider: 'github',
      host: 'git.example.com:8443',
      repository: { owner: 'o', name: 'r' },
      ref: '7',
    });
  });

  test('a GitLab merge request URL keeps its group path as the owner', () => {
    expect(
      parsePullRequestReference(
        'https://gitlab.com/group/sub/project/-/merge_requests/9',
      ),
    ).toEqual({
      provider: 'gitlab',
      host: 'gitlab.com',
      repository: { owner: 'group/sub', name: 'project' },
      ref: '9',
    });
  });

  test('the provider comes from the URL’s shape, so a self-managed GitLab is GitLab and GitHub Enterprise is GitHub', () => {
    // The pane-id host rule names gitlab.com alone; linking by that rule
    // would send a self-managed merge request to the GitHub reader.
    expect(
      parsePullRequestReference(
        'https://git.corp.example/platform/web/app/-/merge_requests/12',
      ),
    ).toEqual({
      provider: 'gitlab',
      host: 'git.corp.example',
      repository: { owner: 'platform/web', name: 'app' },
      ref: '12',
    });
    expect(
      parsePullRequestReference('https://github.example.com/o/r/pull/7'),
    ).toEqual({
      provider: 'github',
      host: 'github.example.com',
      repository: { owner: 'o', name: 'r' },
      ref: '7',
    });
  });

  test('a number, with or without #, reads against the scope', () => {
    expect(parsePullRequestReference('#42', scope)).toEqual({
      ...scope,
      ref: '42',
    });
    expect(parsePullRequestReference('42', scope)).toEqual({
      ...scope,
      ref: '42',
    });
    // No scope, no repository: nothing is guessed.
    expect(parsePullRequestReference('#42')).toBeNull();
  });

  test('owner/repo#n names a repository on the scope’s host', () => {
    expect(parsePullRequestReference('lantern/lantern#3', scope)).toEqual({
      provider: 'github',
      host: 'github.com',
      repository: { owner: 'lantern', name: 'lantern' },
      ref: '3',
    });
  });

  test('anything else is refused rather than guessed', () => {
    for (const text of [
      '',
      '   ',
      'pull 42',
      'https://github.com/lantern/lantern',
      'https://github.com/lantern/lantern/issues/42',
      'https://gitlab.com/g/p/-/merge_requests/x',
      'javascript:alert(1)',
      'lantern#3',
    ]) {
      expect(parsePullRequestReference(text, scope)).toBeNull();
    }
  });
});
