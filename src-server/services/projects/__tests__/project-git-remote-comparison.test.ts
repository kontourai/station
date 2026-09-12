import { normalizeGitOrigin } from '@kontourai/station-contracts/git-remote-identity';
import { describe, expect, test } from 'vitest';
import { compareProjectGitRemotes } from '../project-git-remote-comparison.js';

describe('Project Git comparison without changing persisted identity', () => {
  test.each([
    ['git@git.example:acme/repo.git', 'git.example/acme/repo'],
    ['alice@git.example:acme/repo.git', 'git.example/acme/repo'],
    ['ssh://alice@git.example/acme/repo.git', 'git.example:acme/repo'],
    ['https://git.example/acme/repo.git', 'git.example:acme/repo'],
    ['https://user:token@git.example/acme/repo.git', 'git.example/acme/repo'],
    [
      'ssh://alice@git.example:2222/acme/repo.git',
      'git.example:2222/acme/repo',
    ],
    ['alice@[2001:db8::1]:acme/repo.git', '[2001:db8::1]/acme/repo'],
    ['git@[2001:db8::1]:acme/repo.git', '[2001:db8::1]/acme/repo'],
    ['ssh://git@[2001:db8::1]/acme/repo.git', '[2001/db8::1]/acme/repo'],
    ['ssh://alice@[2001:db8::1]/acme/repo.git', '[2001/db8::1]:acme/repo'],
    [
      'ssh://alice@[2001:db8::1]:2222/acme/repo.git',
      '[2001:db8::1]:2222/acme/repo',
    ],
    ['https://Git.Example/Acme/Repo.git/', 'git.example/acme/repo'],
  ])('matches %s against existing identity %s', (url, identity) => {
    const result = compareProjectGitRemotes([url], {}, [identity]);
    expect(result.outcome).toBe('matched');
    expect(result.checkoutRemotes).toEqual([normalizeGitOrigin(url)]);
  });

  test('preserves the historical receipt canonicalization bytes', () => {
    expect(normalizeGitOrigin('alice@git.example:acme/repo.git')).toBe(
      'git.example:acme/repo',
    );
    expect(normalizeGitOrigin('git@[2001:db8::1]:acme/repo.git')).toBe(
      '[2001/db8::1]:acme/repo',
    );
  });

  test('host aliases apply only to observed checkout remotes', () => {
    const aliases = { 'git-work': 'git.example' };
    expect(
      compareProjectGitRemotes(['alice@git-work:acme/repo.git'], aliases, [
        'git.example/acme/repo',
      ]).outcome,
    ).toBe('matched');
    expect(
      compareProjectGitRemotes(['alice@git.example:acme/repo.git'], aliases, [
        'git-work/acme/repo',
      ]).outcome,
    ).toBe('different');
  });

  test('an upstream or deliberate manifest alias matches without merging a fork', () => {
    expect(
      compareProjectGitRemotes(['alice@git.example:alice/repo.git'], {}, [
        'git.example/acme/repo',
      ]).outcome,
    ).toBe('different');
    expect(
      compareProjectGitRemotes(
        ['alice@git.example:alice/repo.git', 'alice@git.example:acme/repo.git'],
        {},
        ['git.example/acme/repo'],
      ).outcome,
    ).toBe('matched');
    expect(
      compareProjectGitRemotes(['alice@git.example:acme/repo.git'], {}, [
        'forge.example/acme/repo',
        'git.example/acme/repo',
      ]).outcome,
    ).toBe('matched');
  });

  test.each([
    ['ssh://alice@git.example:2222/acme/repo.git', 'git.example/acme/repo'],
    [
      'ssh://alice@git.example:2222/acme/repo.git',
      'git.example:2223/acme/repo',
    ],
    ['alice@git.example:acme/other.git', 'git.example/acme/repo'],
    ['alice@git.other:acme/repo.git', 'git.example/acme/repo'],
  ])(
    'does not collapse a different port, host or repository: %s',
    (url, identity) => {
      expect(compareProjectGitRemotes([url], {}, [identity]).outcome).toBe(
        'different',
      );
    },
  );

  test.each([
    'ssh://alice@git.example:invalid/acme/repo',
    'ssh://alice@git.example:99999/acme/repo',
    'ssh://alice@[not-ipv6]/acme/repo',
    'alice@git.example:2222/acme/repo',
    'file:///tmp/repo',
    '../repo',
    'C:\\work\\repo',
    'https://git.example/acme/repo?token=private',
    'https://git.example/acme/repo#private',
    'ext::command',
    'ssh://alice@git.example/acme/../repo',
  ])('names unsupported or ambiguous checkout locators: %s', (url) => {
    expect(
      compareProjectGitRemotes([url], {}, ['git.example/acme/repo']).outcome,
    ).toBe('unverifiable');
  });

  test('retains the documented lowercase and single-label-host conventions', () => {
    expect(
      compareProjectGitRemotes(['https://git.example/Acme/Repo'], {}, [
        'git.example/acme/repo',
      ]).outcome,
    ).toBe('matched');
    // A relative mirror/repo and a single-label host are indistinguishable in
    // the existing portable identity; this comparison does not redesign it.
    expect(
      compareProjectGitRemotes(['mirror/repo'], {}, ['mirror/repo']).outcome,
    ).toBe('matched');
  });
});
