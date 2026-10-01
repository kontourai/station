import { describe, expect, test } from 'vitest';
import { judgeRepositoryConfig } from '../git-repository-config.js';

/** `git config --show-scope --null --list` output: `scope NUL key LF value NUL`. */
function listing(entries: Array<[scope: string, key: string, value: string]>) {
  return entries
    .map(([scope, key, value]) => `${scope}\0${key}\n${value}\0`)
    .join('');
}

const refusedKeys = (
  entries: Array<[string, string, string]>,
  purpose: 'read' | 'write' = 'read',
) => {
  const verdict = judgeRepositoryConfig(listing(entries), purpose);
  return verdict.ok ? [] : 'keys' in verdict ? verdict.keys : ['unreadable'];
};

describe('judgeRepositoryConfig', () => {
  test.each([
    ['extensions.partialclone', 'origin'],
    ['remote.origin.promisor', 'true'],
    ['remote.origin.partialclonefilter', 'blob:none'],
    ['extensions.somethingnew', 'true'],
    ['credential.helper', '!touch /tmp/x'],
    ['credential.https://example.test.helper', 'store'],
    ['core.sshcommand', 'sh -c x'],
    ['core.gitproxy', 'proxy-command'],
    ['core.askpass', '/tmp/ask'],
    ['core.editor', 'sh -c x'],
    ['sequence.editor', 'sh -c x'],
    ['core.pager', 'sh -c x'],
    ['pager.diff', 'sh -c x'],
    ['gpg.program', '/tmp/gpg'],
    ['gpg.ssh.defaultkeycommand', 'sh -c x'],
    ['gc.recentobjectshook', 'sh -c x'],
    ['uploadpack.packobjectshook', 'sh -c x'],
    ['remote.origin.vcs', 'ext'],
    ['remote.origin.uploadpack', 'sh -c x'],
    ['url.https://evil.test/.insteadof', 'https://github.com/'],
    ['http.proxy', 'http://evil.test:8080'],
    ['http.https://github.com/.proxy', 'http://evil.test:8080'],
    ['http.cookiefile', '/tmp/cookies'],
    ['fetch.bundleuri', 'https://evil.test/bundle'],
    ['submodule.lib.update', '!sh -c x'],
    ['filter.x.clean', 'sh -c x'],
    ['diff.external', 'sh -c x'],
  ])('a repository-scope %s refuses a read', (key, value) => {
    expect(refusedKeys([['local', key, value]])).toEqual([key]);
    expect(refusedKeys([['worktree', key, value]])).toEqual([key]);
    // The operator's own configuration applies by design.
    expect(refusedKeys([['global', key, value]])).toEqual([]);
    expect(refusedKeys([['system', key, value]])).toEqual([]);
  });

  test('an ordinary repository passes, for a read and for a commit or push', () => {
    const ordinary: Array<[string, string, string]> = [
      ['local', 'core.repositoryformatversion', '1'],
      ['local', 'core.filemode', 'true'],
      ['local', 'core.bare', 'false'],
      ['local', 'core.hookspath', '.husky/_'],
      ['local', 'core.fsmonitor', 'true'],
      ['local', 'extensions.objectformat', 'sha256'],
      ['local', 'extensions.refstorage', 'reftable'],
      ['local', 'extensions.worktreeconfig', 'true'],
      ['local', 'remote.origin.url', 'https://github.com/acme/pulse.git'],
      ['local', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
      ['local', 'remote.origin.gh-resolved', 'base'],
      ['local', 'branch.main.remote', 'origin'],
      ['local', 'branch.main.merge', 'refs/heads/main'],
      ['local', 'branch.main.vscode-merge-base', 'origin/main'],
      ['local', 'branch.main.pushremote', 'origin'],
      ['local', 'pager.branch', 'false'],
      ['local', 'submodule.lib.update', 'rebase'],
      ['local', 'submodule.lib.url', 'https://github.com/acme/lib.git'],
      ['local', 'protocol.file.allow', 'always'],
      ['local', 'http.sslverify', 'true'],
      ['local', 'user.name', 'Someone'],
    ];
    expect(refusedKeys(ordinary, 'read')).toEqual([]);
    expect(refusedKeys(ordinary, 'write')).toEqual([]);
  });

  test('a commit or push also refuses includes, a remote named by an address, and a program fsmonitor', () => {
    const entries: Array<[string, string, string]> = [
      ['local', 'include.path', '/tmp/more'],
      ['local', 'remote.https://github.com/acme/pulse.git.url', 'x'],
      ['local', 'core.fsmonitor', '.git/hooks/fsmonitor'],
    ];
    expect(refusedKeys(entries, 'read')).toEqual([]);
    expect(refusedKeys(entries, 'write')).toEqual([
      'core.fsmonitor',
      'include.path',
      'remote.https://github.com/acme/pulse.git.url',
    ]);
  });
});
