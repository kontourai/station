import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ReceiverExecutionRefusal } from '../../projects/project-contribution-service.js';
import { verifyPreparedCheckout } from '../execution-preparation.js';

/**
 * The `git-commit` adapter against real repositories. The delegation suite
 * proves where the check sits in the effect order; this one proves what the
 * adapter reads and what it refuses to run.
 */

function git(cwd: string, args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=a@example.test', '-c', 'user.name=A', ...args],
    {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      env: { PATH: process.env.PATH ?? '', HOME: cwd },
    },
  ).trim();
}

const makeTempDir = trackTempDirs();
let dir: string;
let checkout: string;
let head: string;

beforeEach(() => {
  dir = makeTempDir('execution-preparation-');
  checkout = join(dir, 'checkout');
  mkdirSync(join(checkout, 'service', 'inner'), { recursive: true });
  git(checkout, ['init', '--initial-branch', 'main']);
  writeFileSync(join(checkout, 'service', 'inner', 'A.md'), 'a\n');
  writeFileSync(join(checkout, '.gitignore'), 'ignored/\n');
  git(checkout, ['add', '-A']);
  git(checkout, ['commit', '-m', 'fixture']);
  head = git(checkout, ['rev-parse', 'HEAD']);
});

function verify(cwd = checkout, value = head) {
  return verifyPreparedCheckout({
    requirement: {
      protocol: 'station.execution-preparation/v1',
      mode: 'existing-realization',
      version: { scheme: 'git-commit', value },
      guarantees: ['version-matched-when-checked'],
    },
    resourceId: 'git.example/acme/repo',
    resourceKind: 'git',
    checkoutRoot: checkout,
    cwd,
  });
}

async function refusalCode(promise: Promise<unknown>): Promise<string> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ReceiverExecutionRefusal);
  return (error as ReceiverExecutionRefusal).code;
}

describe('git-commit adapter', () => {
  test('reads HEAD from a nested execution root and counts untracked files only', async () => {
    writeFileSync(join(checkout, 'one.txt'), '1\n');
    writeFileSync(join(checkout, 'service', 'two.txt'), '2\n');
    mkdirSync(join(checkout, 'ignored'));
    writeFileSync(join(checkout, 'ignored', 'skip.txt'), 'x\n');
    const receipt = await verify(join(checkout, 'service', 'inner'));
    expect(receipt.observed).toEqual({ scheme: 'git-commit', value: head });
    // Ignored files are not counted; untracked ones are counted, not named.
    expect(receipt.untrackedFiles).toBe(2);
  });

  test('a repository-configured fsmonitor program is never run', async () => {
    const marker = join(dir, 'fsmonitor-ran');
    const hook = join(dir, 'fsmonitor.sh');
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    git(checkout, ['config', 'core.fsmonitor', hook]);
    // Reads run with fsmonitor forced off, so the check still answers.
    const receipt = await verify();
    expect(receipt.observed.value).toBe(head);
    expect(existsSync(marker), 'the fsmonitor program ran').toBe(false);
  });

  test('a repository-defined clean filter refuses as unavailable without running', async () => {
    const marker = join(dir, 'filter-ran');
    writeFileSync(join(checkout, '.gitattributes'), '*.md filter=planted\n');
    git(checkout, ['add', '.gitattributes']);
    git(checkout, ['commit', '-m', 'attributes']);
    const filtered = git(checkout, ['rev-parse', 'HEAD']);
    git(checkout, [
      'config',
      'filter.planted.clean',
      `sh -c 'touch "${marker}"; cat'`,
    ]);
    expect(await refusalCode(verify(checkout, filtered))).toBe(
      'execution_preparation_unavailable',
    );
    expect(existsSync(marker), 'the clean filter ran').toBe(false);
  });

  describe('state git status hides', () => {
    function addSubmodule(): void {
      const sub = join(dir, 'sub');
      mkdirSync(sub);
      git(sub, ['init', '--initial-branch', 'main']);
      writeFileSync(join(sub, 'f'), '1\n');
      git(sub, ['add', 'f']);
      git(sub, ['commit', '-m', 's1']);
      writeFileSync(join(sub, 'f'), '2\n');
      git(sub, ['commit', '-am', 's2']);
      git(checkout, [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '-q',
        sub,
        'sub',
      ]);
      git(checkout, ['commit', '-m', 'add submodule']);
      head = git(checkout, ['rev-parse', 'HEAD']);
    }

    test('control: a clean checkout with a submodule matches', async () => {
      addSubmodule();
      expect((await verify()).observed.value).toBe(head);
    });

    test('an unstaged submodule commit change refuses as a tracked change', async () => {
      addSubmodule();
      git(join(checkout, 'sub'), ['checkout', '-q', 'HEAD~1']);
      expect(await refusalCode(verify())).toBe(
        'execution_preparation_tracked_changes',
      );
    });

    test('a staged submodule commit change refuses as a tracked change', async () => {
      addSubmodule();
      git(join(checkout, 'sub'), ['checkout', '-q', 'HEAD~1']);
      git(checkout, ['add', 'sub']);
      expect(await refusalCode(verify())).toBe(
        'execution_preparation_tracked_changes',
      );
    });

    test('an assume-unchanged entry refuses as unverifiable', async () => {
      git(checkout, [
        'update-index',
        '--assume-unchanged',
        'service/inner/A.md',
      ]);
      writeFileSync(join(checkout, 'service', 'inner', 'A.md'), 'hidden\n');
      expect(await refusalCode(verify())).toBe(
        'execution_preparation_tracked_state_unverifiable',
      );
    });

    test('a skip-worktree entry refuses as unverifiable', async () => {
      git(checkout, ['update-index', '--skip-worktree', 'service/inner/A.md']);
      writeFileSync(join(checkout, 'service', 'inner', 'A.md'), 'hidden\n');
      expect(await refusalCode(verify())).toBe(
        'execution_preparation_tracked_state_unverifiable',
      );
    });
  });

  test('a malformed version refuses before the checkout is read', async () => {
    // Dirty AND malformed: the answer is the mismatch, so the caller learns
    // nothing about the tree.
    writeFileSync(join(checkout, 'service', 'inner', 'A.md'), 'dirty\n');
    expect(await refusalCode(verify(checkout, head.slice(0, 7)))).toBe(
      'execution_preparation_version_mismatch',
    );
  });

  test('a directory that is not a repository is unavailable, not a mismatch', async () => {
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    const code = await refusalCode(
      verifyPreparedCheckout({
        requirement: {
          protocol: 'station.execution-preparation/v1',
          mode: 'existing-realization',
          version: { scheme: 'git-commit', value: head },
          guarantees: ['version-matched-when-checked'],
        },
        resourceId: 'git.example/acme/repo',
        resourceKind: 'git',
        checkoutRoot: plain,
        cwd: plain,
      }),
    );
    expect(code).toBe('execution_preparation_unavailable');
  });

  test('a missing checkout is unavailable', async () => {
    const missing = join(dir, 'missing');
    const code = await refusalCode(
      verifyPreparedCheckout({
        requirement: {
          protocol: 'station.execution-preparation/v1',
          mode: 'existing-realization',
          version: { scheme: 'git-commit', value: head },
          guarantees: ['version-matched-when-checked'],
        },
        resourceId: 'git.example/acme/repo',
        resourceKind: 'git',
        checkoutRoot: missing,
        cwd: missing,
      }),
    );
    expect(code).toBe('execution_preparation_unavailable');
  });

  test('only the exact full object id matches', async () => {
    expect((await verify(checkout, head)).observed.value).toBe(head);
    for (const value of [head.slice(0, 7), head.toUpperCase(), 'a'.repeat(64)])
      expect(await refusalCode(verify(checkout, value))).toBe(
        'execution_preparation_version_mismatch',
      );
  });

  test('an admission without a resource kind refuses as an unsupported kind', async () => {
    const code = await refusalCode(
      verifyPreparedCheckout({
        requirement: {
          protocol: 'station.execution-preparation/v1',
          mode: 'existing-realization',
          version: { scheme: 'git-commit', value: head },
          guarantees: ['version-matched-when-checked'],
        },
        resourceId: 'git.example/acme/repo',
        resourceKind: undefined,
        checkoutRoot: checkout,
        cwd: checkout,
      }),
    );
    expect(code).toBe('execution_preparation_kind_unsupported');
  });
});
