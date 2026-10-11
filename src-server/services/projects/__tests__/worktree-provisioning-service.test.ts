import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  worktreeCleanupTotal,
  worktreeConflictPreventedTotal,
  worktreeProvisionTotal,
} from '../../../telemetry/metrics.js';
import { execGitSync, spawnGit } from '../../../utils/git-exec.js';
import {
  type LiveRepository,
  RepositoryConfigRefusedError,
} from '../git-read-repository.js';
import {
  assertWorktreeMetadataSessionBinding,
  type GitCommandRunner,
  terminalWorktreeStateForExit,
  WorktreeProvisioningService,
  WorktreeRepositoryConfigError,
} from '../worktree-provisioning-service.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  worktreeCleanupTotal: { add: vi.fn() },
  worktreeConflictPreventedTotal: { add: vi.fn() },
  worktreeProvisionDuration: { record: vi.fn() },
  worktreeProvisionTotal: { add: vi.fn() },
}));

const tmpRoots: string[] = [];

function git(cwd: string, args: string[]) {
  return execGitSync(args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  }) as string;
}

function createRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'station-worktree-test-'));
  tmpRoots.push(dir);
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Station Test']);
  writeFileSync(join(dir, 'README.md'), '# test\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'initial']);
  return dir;
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

/**
 * For the tests that script the git runner over a folder that is not a
 * repository: the guard's answer for an ordinary repository at `folder`,
 * with no copy of its configuration (the scripted runner reads none).
 */
const scriptedRepository = async (folder: string): Promise<LiveRepository> => ({
  top: folder,
  gitDir: join(folder, '.git'),
  commonDir: join(folder, '.git'),
  repoArgs: [],
  env: { GIT_COMMON_DIR: join(folder, '.git') },
  unchanged: async () => true,
  sameIdentity: async () => true,
  settleCreatedWorktree: async () => undefined,
  dispose: async () => undefined,
});

describe('worktree isolation policy and session binding', () => {
  test('provisions nothing unless the session asked for worktree isolation', async () => {
    const service = new WorktreeProvisioningService();
    for (const isolation of [{ mode: 'shared' as const }, undefined]) {
      await expect(
        service.provision({
          repoPath: '/nonexistent-repo',
          threadId: 'shared-session',
          providerKind: 'codex',
          isolation,
        }),
      ).resolves.toBeNull();
    }
  });

  test('trims the branch prefix, sanitizes the session id into the branch, and defaults the policy', async () => {
    const repoPath = createRepo();
    const service = new WorktreeProvisioningService();
    const metadata = await service.provision({
      repoPath,
      threadId: 'thread:abc 123',
      providerKind: 'codex',
      isolation: {
        mode: 'worktree',
        policy: { branchPrefix: ' agent/session ' },
      },
    });

    expect(metadata).toEqual(
      expect.objectContaining({
        // The suffix is the first 32 hex of sha256('thread:abc 123').
        branch: 'agent/session/thread-abc-123-8c7bf363be5932bfdb399163005a316a',
        baseRef: 'HEAD',
        cleanupPolicy: 'cleanup',
        preserveOnFailure: true,
      }),
    );
    await service.cleanup({ metadata: metadata!, terminalState: 'completed' });
  });

  test('refuses an unsafe branch prefix before touching the repository', async () => {
    const calls: string[] = [];
    const runner: GitCommandRunner = {
      async run(args) {
        calls.push(args.join(' '));
        throw new Error(`unexpected git call: ${args.join(' ')}`);
      },
    };

    await expect(
      new WorktreeProvisioningService(runner, scriptedRepository).provision({
        repoPath: '/nonexistent-repo',
        threadId: 'unsafe-prefix',
        providerKind: 'codex',
        isolation: { mode: 'worktree', policy: { branchPrefix: '../bad' } },
      }),
    ).rejects.toThrow(/Invalid worktree branchPrefix/);
    expect(calls).toEqual([]);
  });

  test('binds cleanup metadata to the owning session and rejects a complete transplant', async () => {
    const repoPath = createRepo();
    const service = new WorktreeProvisioningService();
    const first = await service.provision({
      repoPath,
      threadId: 'session-first',
      providerKind: 'codex',
      isolation: { mode: 'worktree' },
    });
    const second = await service.provision({
      repoPath,
      threadId: 'session-second',
      providerKind: 'codex',
      isolation: { mode: 'worktree' },
    });
    expect(() =>
      assertWorktreeMetadataSessionBinding(second!, 'session-first'),
    ).toThrow('not bound to its session');
    await expect(
      service.cleanup({
        metadata: second!,
        terminalState: 'completed',
        sessionId: 'session-first',
      }),
    ).rejects.toThrow('not bound to its session');
    expect(existsSync(second!.path)).toBe(true);
    await service.cleanup({ metadata: first!, terminalState: 'completed' });
    await service.cleanup({ metadata: second!, terminalState: 'completed' });
  });

  test('refuses cleanup metadata transplanted between colliding lossy session suffixes', async () => {
    const repoPath = createRepo();
    const sharedPrefix = 'x'.repeat(80);
    const sessionPairs = [
      ['a/b', 'a-b'],
      [`${sharedPrefix}first`, `${sharedPrefix}second`],
    ] as const;

    for (const [firstId, secondId] of sessionPairs) {
      const service = new WorktreeProvisioningService();
      const first = await service.provision({
        repoPath,
        threadId: firstId,
        providerKind: 'codex',
        isolation: { mode: 'worktree' },
      });
      const second = await service.provision({
        repoPath,
        threadId: secondId,
        providerKind: 'codex',
        isolation: { mode: 'worktree' },
      });
      expect(first?.branch).not.toBe(second?.branch);
      expect(first?.path).not.toBe(second?.path);
      expect(() =>
        assertWorktreeMetadataSessionBinding(second!, firstId),
      ).toThrow('not bound to its session');
      await expect(
        service.cleanup({
          metadata: second!,
          terminalState: 'completed',
          sessionId: firstId,
        }),
      ).rejects.toThrow('not bound to its session');
      expect(existsSync(second!.path)).toBe(true);
      await service.cleanup({ metadata: first!, terminalState: 'completed' });
      await service.cleanup({ metadata: second!, terminalState: 'completed' });
    }
  });

  test('preserves failed exits but classifies recovered clean exits as removable', () => {
    expect(
      terminalWorktreeStateForExit({
        lifecycleState: 'canceled',
        exitCode: 1,
        events: [],
      }),
    ).toBe('failed');
    expect(
      terminalWorktreeStateForExit({
        lifecycleState: 'completed',
        exitCode: 0,
        events: [{ method: 'runtime.error' }, { method: 'runtime.recovered' }],
      }),
    ).toBe('completed');
  });

  test('removes a recovered clean worktree but preserves a failed exit worktree', async () => {
    const repoPath = createRepo();
    const service = new WorktreeProvisioningService();
    const recovered = await service.provision({
      repoPath,
      threadId: 'recovered-clean',
      providerKind: 'codex',
      isolation: { mode: 'worktree' },
    });
    const failed = await service.provision({
      repoPath,
      threadId: 'failed-exit',
      providerKind: 'codex',
      isolation: { mode: 'worktree' },
    });

    await service.cleanup({
      metadata: recovered!,
      terminalState: terminalWorktreeStateForExit({
        lifecycleState: 'completed',
        exitCode: 0,
        events: [{ method: 'runtime.error' }, { method: 'runtime.recovered' }],
      }),
    });
    await service.cleanup({
      metadata: failed!,
      terminalState: terminalWorktreeStateForExit({
        lifecycleState: 'failed',
        exitCode: 1,
        events: [{ method: 'runtime.error' }],
      }),
    });
    expect(existsSync(recovered!.path)).toBe(false);
    expect(existsSync(failed!.path)).toBe(true);
    await service.cleanup({ metadata: failed!, terminalState: 'completed' });
  });
});

describe('WorktreeProvisioningService', () => {
  // archive#3246 follow-up. `worktreeBaseDir` is a free-text policy field, so
  // `~/worktrees` used to `resolve()` to a LITERAL `~` directory relative to
  // the process cwd -- Station's own install root -- and every worktree for
  // the session would be provisioned inside it. Silent, and wrong somewhere
  // nobody looks: the same failure archive#3155 shipped for knowledge
  // namespaces.
  //
  // Nothing sets this field today (no route, CLI command, UI surface or doc),
  // so this pins a guard placed BEFORE the producer exists rather than closing
  // a reachable bug. It is the cheapest moment to get it right.
  test('expands a tilde in the worktree base dir instead of creating a literal ~ directory', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'station-worktree-tilde-'));
    tmpRoots.push(repoPath);
    const runner: GitCommandRunner = {
      async run(args) {
        if (args.includes('--show-toplevel'))
          return { stdout: `${repoPath}\n`, stderr: '', code: 0 };
        if (args.includes('config')) return { stdout: '', stderr: '', code: 0 };
        if (args.includes('status')) return { stdout: '', stderr: '', code: 0 };
        if (args.includes('--verify'))
          return { stdout: '', stderr: '', code: 1 };
        if (args.includes('add')) return { stdout: '', stderr: '', code: 0 };
        throw new Error(`unexpected git call: ${args.join(' ')}`);
      },
    };
    const service = new WorktreeProvisioningService(runner, scriptedRepository);

    const metadata = await service.provision({
      repoPath,
      threadId: 'tilde session',
      providerKind: 'codex',
      isolation: {
        mode: 'worktree',
        policy: { worktreeBaseDir: '~/station-tilde-probe' },
      },
    });

    expect(metadata?.path).toBeTruthy();
    // The discriminating assertions: pre-fix this path contained a literal
    // `~` segment under the process cwd and was NOT under the home directory.
    expect(metadata!.path).toContain(join(homedir(), 'station-tilde-probe'));
    expect(metadata!.path.split('/')).not.toContain('~');
  });

  test('uses an injectable git command runner for provision commands', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'station-worktree-runner-'));
    tmpRoots.push(repoPath);
    const worktreeBaseDir = join(
      repoPath,
      '..',
      `${basename(repoPath)}-runner`,
    );
    const calls: Array<{ args: string[]; allowCodes?: number[] }> = [];
    const runner: GitCommandRunner = {
      async run(args, options) {
        calls.push({ args, allowCodes: options?.allowCodes });
        if (args.includes('--show-toplevel')) {
          return { stdout: `${repoPath}\n`, stderr: '', code: 0 };
        }
        if (args.includes('config')) {
          return { stdout: '', stderr: '', code: 0 };
        }
        if (args.includes('status')) {
          return { stdout: '', stderr: '', code: 0 };
        }
        if (args.includes('--verify')) {
          return { stdout: '', stderr: '', code: 1 };
        }
        if (args.includes('add')) {
          return { stdout: '', stderr: '', code: 0 };
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`);
      },
    };
    const service = new WorktreeProvisioningService(runner, scriptedRepository);

    const metadata = await service.provision({
      repoPath,
      threadId: 'session runner',
      providerKind: 'codex',
      isolation: {
        mode: 'worktree',
        policy: { worktreeBaseDir },
      },
    });

    const branch = metadata!.branch;
    expect(branch).toMatch(/^station\/session\/session-runner-[a-f0-9]{32}$/);
    const segment = branch.split('/').at(-1)!;
    expect(metadata?.path).toBe(join(worktreeBaseDir, segment));
    expect(calls.map((call) => call.args.join(' '))).toEqual([
      `-C ${repoPath} status --porcelain`,
      `-C ${repoPath} rev-parse --verify --quiet refs/heads/${branch}`,
      `-C ${repoPath} worktree add -b ${branch} ${join(
        worktreeBaseDir,
        segment,
      )} HEAD`,
    ]);
    expect(calls[1]?.allowCodes).toEqual([0, 1]);
  });

  test('provisions and cleans up an isolated worktree', async () => {
    const repoPath = createRepo();
    const repoRealPath = realpathSync(repoPath);
    const worktreeBaseDir = join(
      repoPath,
      '..',
      `${basename(repoPath)}-isolated`,
    );
    const service = new WorktreeProvisioningService();

    const metadata = await service.provision({
      repoPath,
      threadId: 'session-1',
      providerKind: 'codex',
      isolation: {
        mode: 'worktree',
        policy: {
          branchPrefix: 'station/session',
          worktreeBaseDir,
        },
      },
    });

    expect(metadata).toEqual(
      expect.objectContaining({
        mode: 'worktree',
        repoPath: repoRealPath,
        // The suffix is the first 32 hex of sha256('session-1').
        branch: 'station/session/session-1-84097828fc31a8c8d29210df48901a85',
        cleanupPolicy: 'cleanup',
      }),
    );
    expect(metadata?.path && existsSync(metadata.path)).toBe(true);
    expect(
      git(repoPath, [
        'branch',
        '--list',
        '--format=%(refname:short)',
        metadata!.branch,
      ]).trim(),
    ).toBe(metadata!.branch);
    expect(worktreeProvisionTotal.add).toHaveBeenCalledWith(1, {
      outcome: 'success',
      provider_kind: 'codex',
      reason: 'created',
    });

    await expect(
      service.cleanup({
        metadata: metadata!,
        terminalState: 'completed',
      }),
    ).resolves.toBe('removed');
    const branchList = git(repoPath, ['branch', '--list', metadata!.branch]);
    expect(existsSync(metadata!.path)).toBe(false);
    expect(branchList.trim()).toBe('');
    expect(worktreeCleanupTotal.add).toHaveBeenCalledWith(1, {
      outcome: 'success',
      policy: 'cleanup',
      terminal_state: 'completed',
    });
  });

  test('preserves failed worktrees when policy requires it', async () => {
    const repoPath = createRepo();
    const service = new WorktreeProvisioningService();
    const metadata = await service.provision({
      repoPath,
      threadId: 'session-2',
      providerKind: 'claude',
      isolation: {
        mode: 'worktree',
        policy: { preserveOnFailure: true },
      },
    });

    await expect(
      service.finalize({
        metadata: metadata!,
        terminalState: 'failed',
      }),
    ).resolves.toBe('preserved');
    expect(existsSync(metadata!.path)).toBe(true);
    expect(worktreeCleanupTotal.add).toHaveBeenCalledWith(1, {
      outcome: 'preserved',
      policy: 'preserve',
      terminal_state: 'failed',
    });
  });

  test('blocks provisioning from dirty repositories', async () => {
    const repoPath = createRepo();
    writeFileSync(join(repoPath, 'README.md'), '# dirty\n');
    const service = new WorktreeProvisioningService();

    await expect(
      service.provision({
        repoPath,
        threadId: 'dirty-session',
        providerKind: 'codex',
        isolation: { mode: 'worktree' },
      }),
    ).rejects.toThrow(/dirty repository/);
    expect(worktreeConflictPreventedTotal.add).toHaveBeenCalledWith(1, {
      detection_source: 'dirty_repo',
    });
    expect(worktreeProvisionTotal.add).toHaveBeenCalledWith(1, {
      outcome: 'failure',
      provider_kind: 'codex',
      reason: 'dirty_repo',
    });
  });

  test('blocks provisioning when worktree policy targets the repository root', async () => {
    const repoPath = createRepo();
    const service = new WorktreeProvisioningService();

    await expect(
      service.provision({
        repoPath,
        threadId: 'root-path-session',
        providerKind: 'codex',
        isolation: {
          mode: 'worktree',
          policy: { worktreeBaseDir: repoPath },
        },
      }),
    ).rejects.toThrow(/repository root/);
  });

  test('blocks provisioning inside the shared repository checkout', async () => {
    const repoPath = createRepo();
    const service = new WorktreeProvisioningService();

    await expect(
      service.provision({
        repoPath,
        threadId: 'inside-repo-session',
        providerKind: 'codex',
        isolation: {
          mode: 'worktree',
          policy: { worktreeBaseDir: join(repoPath, '.worktrees') },
        },
      }),
    ).rejects.toThrow(/inside repository root/);
  });

  test('blocks provisioning when the branch already exists', async () => {
    const repoPath = createRepo();
    const service = new WorktreeProvisioningService();
    // Provision once, then remove only the worktree: the session's branch
    // stays behind, exactly as a crashed cleanup would leave it.
    const earlier = await service.provision({
      repoPath,
      threadId: 'existing-session',
      providerKind: 'claude',
      isolation: { mode: 'worktree' },
    });
    git(repoPath, ['worktree', 'remove', '--force', earlier!.path]);
    vi.clearAllMocks();

    await expect(
      service.provision({
        repoPath,
        threadId: 'existing-session',
        providerKind: 'claude',
        isolation: { mode: 'worktree' },
      }),
    ).rejects.toThrow(/branch already exists/);
    expect(worktreeConflictPreventedTotal.add).toHaveBeenCalledWith(1, {
      detection_source: 'branch_exists',
    });
  });

  test('surfaces cleanup failures with cleanup telemetry', async () => {
    const repoPath = createRepo();
    const service = new WorktreeProvisioningService();

    await expect(
      service.cleanup({
        metadata: {
          mode: 'worktree',
          repoPath: realpathSync(repoPath),
          path: join(repoPath, '..', 'missing-worktree'),
          branch: 'station/session/missing-worktree',
          baseRef: 'HEAD',
          cleanupPolicy: 'cleanup',
          preserveOnFailure: false,
          createdAt: '2026-05-03T00:00:00.000Z',
        },
        terminalState: 'completed',
      }),
    ).rejects.toThrow(/not registered/);
    expect(worktreeCleanupTotal.add).toHaveBeenCalledWith(1, {
      outcome: 'failure',
      policy: 'cleanup',
      terminal_state: 'completed',
    });
  });

  test('refuses corrupt cleanup metadata without removing another registered worktree', async () => {
    const repoPath = createRepo();
    const service = new WorktreeProvisioningService();
    const first = await service.provision({
      repoPath,
      threadId: 'session-first',
      providerKind: 'codex',
      isolation: { mode: 'worktree' },
    });
    const second = await service.provision({
      repoPath,
      threadId: 'session-second',
      providerKind: 'codex',
      isolation: { mode: 'worktree' },
    });

    await expect(
      service.cleanup({
        metadata: { ...first!, path: second!.path },
        terminalState: 'completed',
      }),
    ).rejects.toThrow(/path shape|not registered/);
    expect(existsSync(second!.path)).toBe(true);

    await service.cleanup({ metadata: first!, terminalState: 'completed' });
    await service.cleanup({ metadata: second!, terminalState: 'completed' });
  });
});

describe('repository-defined programs (#2411)', () => {
  test('refuses to provision from a repository whose own config defines a smudge filter, and runs nothing', async () => {
    const repoPath = createRepo();
    // Committed BEFORE the filter exists, so setup never runs it; only a
    // checkout into a new worktree would.
    writeFileSync(join(repoPath, '.gitattributes'), '*.txt filter=marker\n');
    writeFileSync(join(repoPath, 'payload.txt'), 'payload\n');
    git(repoPath, ['add', '.gitattributes', 'payload.txt']);
    git(repoPath, ['commit', '-m', 'attributes']);
    const marker = `${repoPath}.smudge-ran`;
    tmpRoots.push(marker);
    git(repoPath, [
      'config',
      'filter.marker.smudge',
      `sh -c 'touch "${marker}"; cat'`,
    ]);
    const service = new WorktreeProvisioningService();

    const provisioning = service.provision({
      repoPath,
      threadId: 'session-smudge',
      providerKind: 'codex',
      isolation: { mode: 'worktree' },
    });

    await expect(provisioning).rejects.toBeInstanceOf(
      WorktreeRepositoryConfigError,
    );
    await expect(provisioning).rejects.toThrow(
      "this repository's own .git/config sets filter.marker.smudge, which git would run while checking files out. Remove them, or start the chat without worktree isolation.",
    );
    expect(existsSync(marker)).toBe(false);
    expect(
      git(repoPath, ['branch', '--list', 'station/session/session-smudge-*']),
    ).toBe('');
    expect(git(repoPath, ['worktree', 'list', '--porcelain'])).not.toContain(
      'session-smudge',
    );
    expect(worktreeProvisionTotal.add).toHaveBeenCalledWith(1, {
      outcome: 'failure',
      provider_kind: 'codex',
      reason: 'repository_config_refused',
    });
  });

  test('refuses rather than proceeding when the configuration cannot be read', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'station-worktree-config-'));
    tmpRoots.push(repoPath);
    const calls: string[] = [];
    const runner: GitCommandRunner = {
      async run(args) {
        calls.push(args.join(' '));
        throw new Error(`unexpected git call: ${args.join(' ')}`);
      },
    };
    const unreadable = async () => {
      throw new RepositoryConfigRefusedError([]);
    };

    await expect(
      new WorktreeProvisioningService(runner, unreadable).provision({
        repoPath,
        threadId: 'session-unreadable',
        providerKind: 'codex',
        isolation: { mode: 'worktree' },
      }),
    ).rejects.toThrow("could not read this repository's configuration");
    expect(calls).toEqual([]);
  });

  test('a smudge filter written into the config after Station judged it does not run: the checkout reads only the judged copy', async () => {
    const repoPath = realpathSync(createRepo());
    writeFileSync(join(repoPath, '.gitattributes'), '*.txt filter=marker\n');
    writeFileSync(join(repoPath, 'payload.txt'), 'payload\n');
    git(repoPath, ['add', '.gitattributes', 'payload.txt']);
    git(repoPath, ['commit', '-m', 'attributes']);
    const marker = `${repoPath}.smudge-ran`;
    const program = `${repoPath}.smudge.sh`;
    tmpRoots.push(marker, program);
    writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\ncat\n`, {
      mode: 0o755,
    });
    const configPath = join(repoPath, '.git', 'config');
    const clean = readFileSync(configPath, 'utf-8');
    const planted = `${clean}[filter "marker"]\n\tsmudge = ${program}\n`;
    // The real runner, with the repository's config rewritten in place
    // just before `worktree add` starts: after the judgement, before git.
    const runner: GitCommandRunner = {
      run: (args, options) =>
        new Promise((resolve, reject) => {
          if (args.includes('worktree')) writeFileSync(configPath, planted);
          const child = spawnGit(args, {
            cwd: options?.cwd,
            env: options?.env,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stderr = '';
          child.stderr?.setEncoding('utf8');
          child.stderr?.on('data', (chunk: string) => {
            stderr += chunk;
          });
          child.on('error', reject);
          child.on('close', (code) =>
            (options?.allowCodes ?? [0]).includes(code ?? 1)
              ? resolve({ stdout: '', stderr, code: code ?? 1 })
              : reject(new Error(`git ${args.join(' ')}: ${stderr}`)),
          );
        }),
    };

    const metadata = await new WorktreeProvisioningService(runner).provision({
      repoPath,
      threadId: 'session-rewritten',
      providerKind: 'codex',
      isolation: { mode: 'worktree' },
    });

    expect(readFileSync(configPath, 'utf-8'), 'the rewrite happened').toBe(
      planted,
    );
    expect(existsSync(marker), 'the planted smudge filter ran').toBe(false);
    expect(
      metadata?.path && existsSync(join(metadata.path, 'payload.txt')),
    ).toBe(true);
    // The new worktree is the repository's own, not the copy's: its `.git`
    // names the repository's `worktrees` entry, which outlives the copy.
    expect(readFileSync(join(metadata!.path, '.git'), 'utf-8').trim()).toBe(
      `gitdir: ${join(repoPath, '.git', 'worktrees', basename(metadata!.path))}`,
    );
    expect(
      git(metadata!.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
    ).toBe(metadata!.branch);
    tmpRoots.push(metadata!.path, join(metadata!.path, '..'));
    // Control: plain git, reading that config, runs it on a checkout.
    git(repoPath, ['worktree', 'add', '-q', '--detach', `${repoPath}-plain`]);
    tmpRoots.push(`${repoPath}-plain`);
    expect(existsSync(marker), 'control: plain git runs it').toBe(true);
  });
});
