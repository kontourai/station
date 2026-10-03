import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ReceiverExecutionRefusal } from '../../projects/project-contribution-service.js';
import {
  gitCommitAdapter,
  verifyPreparedCheckout,
} from '../execution-preparation.js';

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

let dir: string;
let checkout: string;
let head: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'execution-preparation-'));
  checkout = join(dir, 'checkout');
  mkdirSync(join(checkout, 'service', 'inner'), { recursive: true });
  git(checkout, ['init', '--initial-branch', 'main']);
  writeFileSync(join(checkout, 'service', 'inner', 'A.md'), 'a\n');
  writeFileSync(join(checkout, '.gitignore'), 'ignored/\n');
  git(checkout, ['add', '-A']);
  git(checkout, ['commit', '-m', 'fixture']);
  head = git(checkout, ['rev-parse', 'HEAD']);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
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

  test('a directory that is not a repository is unavailable, not a mismatch', async () => {
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    const outcome = await gitCommitAdapter.observe({ root: plain, cwd: plain });
    expect(outcome).toEqual({ state: 'unavailable' });
  });

  test('a missing checkout is unavailable', async () => {
    const outcome = await gitCommitAdapter.observe({
      root: join(dir, 'missing'),
      cwd: join(dir, 'missing'),
    });
    expect(outcome).toEqual({ state: 'unavailable' });
  });

  test('only a full object id is well formed', () => {
    expect(gitCommitAdapter.isWellFormed(head)).toBe(true);
    expect(gitCommitAdapter.isWellFormed(head.slice(0, 7))).toBe(false);
    expect(gitCommitAdapter.isWellFormed(head.toUpperCase())).toBe(false);
    expect(gitCommitAdapter.isWellFormed('a'.repeat(64))).toBe(true);
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
