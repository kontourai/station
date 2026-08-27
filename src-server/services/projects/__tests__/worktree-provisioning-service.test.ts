import {
  existsSync,
  mkdtempSync,
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
import { execGitSync } from '../../../utils/git-exec.js';
import {
  assertWorktreeMetadataSessionBinding,
  buildWorktreeBranchName,
  type GitCommandRunner,
  shouldUseWorktreeIsolation,
  terminalWorktreeStateForExit,
  validateWorktreePolicy,
  WorktreeProvisioningService,
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

describe('worktree isolation helpers', () => {
  test('detects worktree isolation mode', () => {
    expect(shouldUseWorktreeIsolation({ mode: 'worktree' })).toBe(true);
    expect(shouldUseWorktreeIsolation({ mode: 'shared' })).toBe(false);
    expect(shouldUseWorktreeIsolation(undefined)).toBe(false);
  });

  test('normalizes branch policy and rejects unsafe refs', () => {
    expect(validateWorktreePolicy({ branchPrefix: ' agent/session ' })).toEqual(
      expect.objectContaining({
        branchPrefix: 'agent/session',
        baseRef: 'HEAD',
        cleanupPolicy: 'cleanup',
        preserveOnFailure: true,
      }),
    );

    expect(() => validateWorktreePolicy({ branchPrefix: '../bad' })).toThrow(
      /Invalid worktree branchPrefix/,
    );
  });

  test('builds stable branch names from session ids', () => {
    expect(
      buildWorktreeBranchName({
        branchPrefix: 'station/session',
        threadId: 'thread:abc 123',
      }),
    ).toMatch(/^station\/session\/thread-abc-123-[a-f0-9]{32}$/);
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
  // station#3246 follow-up. `worktreeBaseDir` is a free-text policy field, so
  // `~/worktrees` used to `resolve()` to a LITERAL `~` directory relative to
  // the process cwd -- Station's own install root -- and every worktree for
  // the session would be provisioned inside it. Silent, and wrong somewhere
  // nobody looks: the same failure station#3155 shipped for knowledge
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
        if (args.includes('status')) return { stdout: '', stderr: '', code: 0 };
        if (args.includes('--verify'))
          return { stdout: '', stderr: '', code: 1 };
        if (args.includes('add')) return { stdout: '', stderr: '', code: 0 };
        throw new Error(`unexpected git call: ${args.join(' ')}`);
      },
    };
    const service = new WorktreeProvisioningService(runner);

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
    const service = new WorktreeProvisioningService(runner);

    const metadata = await service.provision({
      repoPath,
      threadId: 'session runner',
      providerKind: 'codex',
      isolation: {
        mode: 'worktree',
        policy: { worktreeBaseDir },
      },
    });

    const branch = buildWorktreeBranchName({ threadId: 'session runner' });
    const segment = branch.split('/').at(-1)!;
    expect(metadata?.path).toBe(join(worktreeBaseDir, segment));
    expect(calls.map((call) => call.args.join(' '))).toEqual([
      `-C ${repoPath} rev-parse --show-toplevel`,
      `-C ${repoPath} status --porcelain`,
      `-C ${repoPath} rev-parse --verify --quiet refs/heads/${branch}`,
      `-C ${repoPath} worktree add -b ${branch} ${join(
        worktreeBaseDir,
        segment,
      )} HEAD`,
    ]);
    expect(calls[2]?.allowCodes).toEqual([0, 1]);
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
        branch: buildWorktreeBranchName({ threadId: 'session-1' }),
        cleanupPolicy: 'cleanup',
      }),
    );
    expect(metadata?.path && existsSync(metadata.path)).toBe(true);
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
    const branchList = git(repoPath, [
      'branch',
      '--list',
      'station/session/session-1',
    ]);
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
    git(repoPath, [
      'branch',
      buildWorktreeBranchName({ threadId: 'existing-session' }),
    ]);
    const service = new WorktreeProvisioningService();

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
