/**
 * #4771: settling a worktree Session's output, over real repositories in
 * temporary directories and a real orchestration SQLite store. The forge is
 * the only fake: a pull request provider answering by identity.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import type { OwnerIdentity } from '@kontourai/monument';
import type {
  IPullRequestProvider,
  PullRequest,
} from '@kontourai/station-contracts/pull-request-provider';
import type { WorktreeSessionMetadata } from '@kontourai/station-contracts/workspace-isolation';
import { exactProcessIdentity } from '@kontourai/station-shared/process-identity';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../../orchestration/event-store.js';
import type { WorktreeOutputSettlementStore } from '../../orchestration/worktree-output-settlement-store.js';
import { WorktreeOutputSettlementService } from '../worktree-output-settlement-service.js';
import { WorktreeProvisioningService } from '../worktree-provisioning-service.js';

const makeTempDir = trackTempDirs();
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Station Test',
  GIT_AUTHOR_EMAIL: 'test@station.invalid',
  GIT_COMMITTER_NAME: 'Station Test',
  GIT_COMMITTER_EMAIL: 'test@station.invalid',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: ENV,
    windowsHide: true,
  }).trim();
}

const branchExists = (repo: string, branch: string) => {
  try {
    git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
};

const OWNER = { kind: 'person', id: 'human:test:owner' } as const;
const allowed = () => true;
const OTHER = { kind: 'person', id: 'human:test:other' } as const;

function repository() {
  const parent = realpathSync(makeTempDir('worktree-settlement-'));
  const repo = join(parent, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(join(repo, 'README.md'), 'project\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '--quiet', '-m', 'initial');
  return { parent, repo };
}

async function sessionWorktree(
  repo: string,
  sessionId: string,
  options: { commit?: boolean; cleanup?: boolean } = {},
): Promise<{ metadata: WorktreeSessionMetadata; head: string }> {
  const metadata = await new WorktreeProvisioningService().provision({
    repoPath: repo,
    threadId: sessionId,
    providerKind: 'codex',
    isolation: {
      mode: 'worktree',
      policy: { cleanupOnCompletion: options.cleanup === true },
    },
  });
  if (!metadata) throw new Error('no worktree');
  if (options.commit !== false) {
    writeFileSync(join(metadata.path, `${sessionId}.txt`), `${sessionId}\n`);
    git(metadata.path, 'add', '.');
    git(metadata.path, 'commit', '--quiet', '-m', `work of ${sessionId}`);
  }
  return { metadata, head: git(metadata.path, 'rev-parse', 'HEAD') };
}

function storeAt(path: string): WorktreeOutputSettlementStore {
  const events = new EventStore(path);
  closers.push(async () => {
    await events.close();
  });
  return events.worktreeOutputSettlementStore();
}

function pullRequests(read: () => Partial<PullRequest> | undefined) {
  const provider = {
    id: 'github',
    canServeHost: (host: string) => host === 'github.com',
    getPullRequestByIdentity: async () => {
      const data = read();
      return data
        ? {
            available: true,
            data: {
              provider: 'github',
              host: 'github.com',
              repository: { owner: 'acme', name: 'repo' },
              ref: '7',
              url: 'https://github.com/acme/repo/pull/7',
              title: 'work',
              body: null,
              state: 'OPEN',
              author: { login: 'someone' },
              sourceBranch: '',
              targetBranch: 'main',
              commits: 1,
              reviewStatus: 'NONE',
              comments: 0,
              nativeId: 'PR_7',
              mergeability: 'unknown',
              ...data,
            },
          }
        : { available: false, reason: 'not found' };
    },
  } as unknown as IPullRequestProvider;
  return () => [provider];
}

const PULL_REQUEST = {
  provider: 'github',
  host: 'github.com',
  repository: { owner: 'acme', name: 'repo' },
  ref: '7',
};

function fixture(
  options: {
    store?: WorktreeOutputSettlementStore;
    forge?: () => Partial<PullRequest> | undefined;
    worktrees?: WorktreeProvisioningService;
    isWorkspaceBusy?: (path: string) => boolean;
  } = {},
) {
  const { parent, repo } = repository();
  const dbPath = join(parent, 'orchestration.sqlite');
  const store = options.store ?? storeAt(dbPath);
  const service = new WorktreeOutputSettlementService({
    store,
    worktrees: options.worktrees ?? new WorktreeProvisioningService(),
    pullRequestProviders: pullRequests(options.forge ?? (() => undefined)),
    ...(options.isWorkspaceBusy
      ? { isWorkspaceBusy: options.isWorkspaceBusy }
      : {}),
  });
  return { parent, repo, dbPath, store, service };
}

describe('discard (#4771)', () => {
  test('removes exactly the Session worktree and branch Station created and records it, and the record outlives them', async () => {
    const { repo, dbPath, service } = fixture();
    const a = await sessionWorktree(repo, 'session-a');
    const b = await sessionWorktree(repo, 'session-b');
    git(repo, 'branch', 'feature/mine');
    const mainBefore = git(repo, 'rev-parse', 'main');

    const result = await service.settle({
      sessionId: 'session-a',
      metadata: a.metadata,
      actor: OWNER,
      stillAuthorized: allowed,
      request: { requestKey: 'discard-1', outcome: 'discarded' },
    });

    expect(result).toMatchObject({
      kind: 'recorded',
      settlement: {
        sessionId: 'session-a',
        state: 'settled',
        outcome: 'discarded',
        actor: OWNER,
        requestKey: 'discard-1',
        branch: a.metadata.branch,
        baseCommit: a.metadata.baseCommit,
        headCommit: a.head,
        evidence: {
          removedWorktree: true,
          removedBranch: true,
          hadUncommittedChanges: false,
          acceptedUncommittedLoss: false,
        },
      },
    });
    expect(existsSync(a.metadata.path)).toBe(false);
    expect(branchExists(repo, a.metadata.branch)).toBe(false);
    // Nothing Station did not create for this Session is touched.
    expect(existsSync(b.metadata.path)).toBe(true);
    expect(branchExists(repo, b.metadata.branch)).toBe(true);
    expect(branchExists(repo, 'feature/mine')).toBe(true);
    expect(git(repo, 'rev-parse', 'main')).toBe(mainBefore);
    // A new store over the same database still reads it.
    expect(storeAt(dbPath).read('session-a')?.record).toEqual(
      result.kind === 'recorded' ? result.settlement : undefined,
    );
  });

  test('never removes another Session worktree whose metadata is presented for this one', async () => {
    const { repo } = fixture();
    await sessionWorktree(repo, 'session-a');
    const b = await sessionWorktree(repo, 'session-b');

    await expect(
      new WorktreeProvisioningService().discardSessionWorktree({
        metadata: b.metadata,
        sessionId: 'session-a',
        expectedHead: b.head,
        acceptUncommittedLoss: true,
      }),
    ).rejects.toThrow(/not bound to its session/);
    expect(existsSync(b.metadata.path)).toBe(true);
    expect(branchExists(repo, b.metadata.branch)).toBe(true);
  });

  test('is refused with uncommitted changes unless the request accepts losing them, and records that it did', async () => {
    const { repo, service } = fixture();
    const a = await sessionWorktree(repo, 'session-a');
    writeFileSync(join(a.metadata.path, 'unsaved.txt'), 'draft\n');

    const refusedResult = await service.settle({
      sessionId: 'session-a',
      metadata: a.metadata,
      actor: OWNER,
      stillAuthorized: allowed,
      request: { requestKey: 'discard-1', outcome: 'discarded' },
    });
    expect(refusedResult).toMatchObject({
      kind: 'refused',
      reason: 'uncommitted-changes',
    });
    expect(existsSync(join(a.metadata.path, 'unsaved.txt'))).toBe(true);
    expect(service.read('session-a')).toBeUndefined();

    const accepted = await service.settle({
      sessionId: 'session-a',
      metadata: a.metadata,
      actor: OWNER,
      stillAuthorized: allowed,
      request: {
        requestKey: 'discard-2',
        outcome: 'discarded',
        acceptUncommittedLoss: true,
      },
    });
    expect(accepted).toMatchObject({
      kind: 'recorded',
      settlement: {
        outcome: 'discarded',
        evidence: {
          hadUncommittedChanges: true,
          acceptedUncommittedLoss: true,
          removedWorktree: true,
          removedBranch: true,
        },
      },
    });
    expect(existsSync(a.metadata.path)).toBe(false);
  });
});

describe('authority is asked again before any effect (#4771)', () => {
  test('a caller that lost access to the Session records and removes nothing', async () => {
    const { repo, service } = fixture();
    const a = await sessionWorktree(repo, 'session-a');
    git(repo, 'merge', '--quiet', '--no-ff', '-m', 'merge', a.metadata.branch);
    let asked = 0;
    const revoked = () => {
      asked += 1;
      return false;
    };
    for (const request of [
      { requestKey: 'discard-1', outcome: 'discarded' as const },
      { requestKey: 'kept-1', outcome: 'kept' as const },
    ])
      expect(
        await service.settle({
          sessionId: 'session-a',
          metadata: a.metadata,
          actor: OWNER,
          stillAuthorized: revoked,
          request,
        }),
      ).toMatchObject({ kind: 'refused', reason: 'authority-changed' });

    expect(asked).toBe(2);
    expect(service.read('session-a')).toBeUndefined();
    expect(existsSync(a.metadata.path)).toBe(true);
    expect(branchExists(repo, a.metadata.branch)).toBe(true);
  });
});

describe('kept is derived from the base, never asserted (#4771)', () => {
  test('is refused until the base contains the head, then records the containing commit', async () => {
    const { repo, service } = fixture();
    const a = await sessionWorktree(repo, 'session-a');
    const settleKept = (requestKey: string) =>
      service.settle({
        sessionId: 'session-a',
        metadata: a.metadata,
        actor: OWNER,
        stillAuthorized: allowed,
        request: { requestKey, outcome: 'kept' },
      });

    expect(await settleKept('kept-1')).toMatchObject({
      kind: 'refused',
      reason: 'base-does-not-contain-head',
    });
    expect(service.read('session-a')).toBeUndefined();

    git(repo, 'merge', '--quiet', '--no-ff', '-m', 'merge', a.metadata.branch);
    const tip = git(repo, 'rev-parse', 'HEAD');
    expect(await settleKept('kept-2')).toMatchObject({
      kind: 'recorded',
      settlement: {
        outcome: 'kept',
        headCommit: a.head,
        evidence: { containingCommit: tip, baseBranch: 'main' },
      },
    });
    // Recording `kept` performs no Git effect.
    expect(existsSync(a.metadata.path)).toBe(true);
    expect(branchExists(repo, a.metadata.branch)).toBe(true);
  });

  test('a squash merge is not kept; it is released through its merged pull request', async () => {
    let head = '';
    let branch = '';
    const { repo, service } = fixture({
      forge: () => ({ state: 'MERGED', sourceBranch: branch, headSha: head }),
    });
    const a = await sessionWorktree(repo, 'session-a');
    head = a.head;
    branch = a.metadata.branch;
    git(repo, 'merge', '--quiet', '--squash', a.metadata.branch);
    git(repo, 'commit', '--quiet', '-m', 'squashed');

    expect(
      await service.settle({
        sessionId: 'session-a',
        metadata: a.metadata,
        actor: OWNER,
        stillAuthorized: allowed,
        request: { requestKey: 'kept-1', outcome: 'kept' },
      }),
    ).toMatchObject({ kind: 'refused', reason: 'base-does-not-contain-head' });

    expect(
      await service.settle({
        sessionId: 'session-a',
        metadata: a.metadata,
        actor: OWNER,
        stillAuthorized: allowed,
        request: {
          requestKey: 'released-1',
          outcome: 'released',
          pullRequest: PULL_REQUEST,
        },
      }),
    ).toMatchObject({
      kind: 'recorded',
      settlement: {
        outcome: 'released',
        headCommit: a.head,
        evidence: {
          pullRequest: {
            ref: '7',
            state: 'MERGED',
            sourceBranch: a.metadata.branch,
            headSha: a.head,
          },
        },
      },
    });
  });

  test('a branch with nothing beyond its starting commit is not kept', async () => {
    const { repo, service } = fixture();
    const a = await sessionWorktree(repo, 'session-a', { commit: false });
    expect(
      await service.settle({
        sessionId: 'session-a',
        metadata: a.metadata,
        actor: OWNER,
        stillAuthorized: allowed,
        request: { requestKey: 'kept-1', outcome: 'kept' },
      }),
    ).toMatchObject({ kind: 'refused', reason: 'no-new-commits' });
  });
});

describe('released needs the forge to agree (#4771)', () => {
  test('a pull request at another head, closed, or unreadable is refused', async () => {
    let answer: Partial<PullRequest> | undefined;
    const { repo, service } = fixture({ forge: () => answer });
    const a = await sessionWorktree(repo, 'session-a');
    const release = () =>
      service.settle({
        sessionId: 'session-a',
        metadata: a.metadata,
        actor: OWNER,
        stillAuthorized: allowed,
        request: {
          requestKey: 'released-1',
          outcome: 'released',
          pullRequest: PULL_REQUEST,
        },
      });

    answer = undefined;
    expect(await release()).toMatchObject({
      reason: 'pull-request-unavailable',
    });
    answer = {
      state: 'OPEN',
      sourceBranch: a.metadata.branch,
      headSha: a.metadata.baseCommit,
    };
    expect(await release()).toMatchObject({ reason: 'pull-request-mismatch' });
    answer = { state: 'OPEN', sourceBranch: 'other', headSha: a.head };
    expect(await release()).toMatchObject({ reason: 'pull-request-mismatch' });
    answer = {
      state: 'CLOSED',
      sourceBranch: a.metadata.branch,
      headSha: a.head,
    };
    expect(await release()).toMatchObject({
      reason: 'pull-request-not-open-or-merged',
    });
    expect(service.read('session-a')).toBeUndefined();

    answer = {
      state: 'OPEN',
      sourceBranch: a.metadata.branch,
      headSha: a.head,
    };
    expect(await release()).toMatchObject({
      kind: 'recorded',
      settlement: { outcome: 'released' },
    });
  });
});

describe('at most one outcome per Session (#4771)', () => {
  test('a second settlement is refused and leaves the first record unchanged', async () => {
    const { repo, service } = fixture();
    const a = await sessionWorktree(repo, 'session-a');
    git(repo, 'merge', '--quiet', '--no-ff', '-m', 'merge', a.metadata.branch);
    const first = await service.settle({
      sessionId: 'session-a',
      metadata: a.metadata,
      actor: OWNER,
      stillAuthorized: allowed,
      request: { requestKey: 'kept-1', outcome: 'kept' },
    });
    expect(first.kind).toBe('recorded');
    const recorded = service.read('session-a');

    const second = await service.settle({
      sessionId: 'session-a',
      metadata: a.metadata,
      actor: OTHER,
      stillAuthorized: allowed,
      request: { requestKey: 'discard-1', outcome: 'discarded' },
    });

    expect(second).toMatchObject({
      kind: 'refused',
      reason: 'already-settled',
      settlement: recorded,
    });
    expect(service.read('session-a')).toEqual(recorded);
    expect(service.read('session-a')?.actor).toEqual(OWNER);
    // The refused discard removed nothing.
    expect(existsSync(a.metadata.path)).toBe(true);
    expect(branchExists(repo, a.metadata.branch)).toBe(true);
  });

  test('a retry with the same request key after a lost response returns the original record', async () => {
    const { repo, service } = fixture();
    const a = await sessionWorktree(repo, 'session-a');
    const discard = () =>
      service.settle({
        sessionId: 'session-a',
        metadata: a.metadata,
        actor: OWNER,
        stillAuthorized: allowed,
        request: { requestKey: 'discard-1', outcome: 'discarded' },
      });
    const first = await discard();
    expect(first.kind).toBe('recorded');

    const retry = await discard();
    expect(retry).toEqual({
      kind: 'existing',
      settlement: first.kind === 'recorded' ? first.settlement : undefined,
    });

    // The same key naming a different request is not a replay.
    expect(
      await service.settle({
        sessionId: 'session-a',
        metadata: a.metadata,
        actor: OWNER,
        stillAuthorized: allowed,
        request: {
          requestKey: 'discard-1',
          outcome: 'discarded',
          acceptUncommittedLoss: true,
        },
      }),
    ).toMatchObject({ kind: 'refused', reason: 'request-key-mismatch' });
  });

  test('a moved base does not change a recorded outcome', async () => {
    const { repo, service } = fixture();
    const a = await sessionWorktree(repo, 'session-a');
    const beforeMerge = git(repo, 'rev-parse', 'main');
    git(repo, 'merge', '--quiet', '--no-ff', '-m', 'merge', a.metadata.branch);
    const kept = () =>
      service.settle({
        sessionId: 'session-a',
        metadata: a.metadata,
        actor: OWNER,
        stillAuthorized: allowed,
        request: { requestKey: 'kept-1', outcome: 'kept' },
      });
    expect((await kept()).kind).toBe('recorded');
    const recorded = service.read('session-a');

    // The base moves on, then is rewound to before the merge: it no longer
    // contains the head. The record is a fact about when it was made.
    writeFileSync(join(repo, 'later.txt'), 'later\n');
    git(repo, 'add', 'later.txt');
    git(repo, 'commit', '--quiet', '-m', 'later');
    git(repo, 'reset', '--quiet', '--hard', beforeMerge);

    expect(service.read('session-a')).toEqual(recorded);
    expect(await kept()).toEqual({ kind: 'existing', settlement: recorded });
  });
});

describe('a crash between the Git effect and the record converges (#4771)', () => {
  /** A store that loses the first settle: the process died after the effect. */
  function crashingStore(store: WorktreeOutputSettlementStore) {
    let crashed = false;
    return {
      ...store,
      settlePending: (input: Parameters<typeof store.settlePending>[0]) => {
        if (!crashed) {
          crashed = true;
          throw new Error('process stopped before the record');
        }
        return store.settlePending(input);
      },
    };
  }

  test('the same request key records the requested discard, not a cleanup', async () => {
    const { parent, repo } = repository();
    const dbPath = join(parent, 'orchestration.sqlite');
    const a = await sessionWorktree(repo, 'session-a');
    const crashing = new WorktreeOutputSettlementService({
      store: crashingStore(storeAt(dbPath)),
      worktrees: new WorktreeProvisioningService(),
      pullRequestProviders: () => [],
    });
    const request = {
      sessionId: 'session-a',
      metadata: a.metadata,
      actor: OWNER,
      stillAuthorized: allowed,
      request: { requestKey: 'discard-1', outcome: 'discarded' as const },
    };

    await expect(crashing.settle(request)).rejects.toThrow(/process stopped/);
    expect(existsSync(a.metadata.path)).toBe(false);
    expect(branchExists(repo, a.metadata.branch)).toBe(false);
    expect(crashing.read('session-a')).toMatchObject({ state: 'pending' });

    // A restarted Station: a new service over a new store on the same file.
    const restarted = new WorktreeOutputSettlementService({
      store: storeAt(dbPath),
      worktrees: new WorktreeProvisioningService(),
      pullRequestProviders: () => [],
    });
    // Nothing but completing the discard can settle it now.
    expect(
      await restarted.settle({
        ...request,
        request: { requestKey: 'kept-1', outcome: 'kept' },
      }),
    ).toMatchObject({ kind: 'refused', reason: 'settlement-pending' });

    const retried = await restarted.settle(request);
    expect(retried).toMatchObject({
      kind: 'recorded',
      settlement: {
        state: 'settled',
        outcome: 'discarded',
        actor: OWNER,
        requestKey: 'discard-1',
        headCommit: a.head,
        // This attempt found both already gone.
        evidence: { removedWorktree: false, removedBranch: false },
      },
    });
  });

  test("another person's discard completes the recorded one and keeps its requester", async () => {
    const { parent, repo } = repository();
    const dbPath = join(parent, 'orchestration.sqlite');
    const a = await sessionWorktree(repo, 'session-a');
    const crashing = new WorktreeOutputSettlementService({
      store: crashingStore(storeAt(dbPath)),
      worktrees: new WorktreeProvisioningService(),
      pullRequestProviders: () => [],
    });
    await expect(
      crashing.settle({
        sessionId: 'session-a',
        metadata: a.metadata,
        actor: OWNER,
        stillAuthorized: allowed,
        request: { requestKey: 'discard-1', outcome: 'discarded' },
      }),
    ).rejects.toThrow(/process stopped/);

    const completed = await crashing.settle({
      sessionId: 'session-a',
      metadata: a.metadata,
      actor: OTHER,
      stillAuthorized: allowed,
      request: { requestKey: 'discard-2', outcome: 'discarded' },
    });
    expect(completed).toMatchObject({
      kind: 'existing',
      settlement: {
        outcome: 'discarded',
        actor: OWNER,
        requestKey: 'discard-1',
      },
    });
  });

  /** The process that wrote an intent: this one, or one that is gone. */
  function intentBy(
    store: WorktreeOutputSettlementStore,
    a: { metadata: WorktreeSessionMetadata; head: string },
    owner: OwnerIdentity | undefined,
  ) {
    store.insert({
      requestDigest: 'sha256:stale',
      ...(owner ? { owner } : {}),
      record: {
        sessionId: 'session-a',
        state: 'pending',
        outcome: 'discarded',
        actor: OTHER,
        requestKey: 'discard-stale',
        repoPath: a.metadata.repoPath,
        worktreePath: a.metadata.path,
        branch: a.metadata.branch,
        baseRef: a.metadata.baseRef,
        headCommit: a.head,
        evidence: {},
        requestedAt: '2026-11-11T00:00:00.000Z',
      },
    });
  }
  /** This process under another writer's id; `birth` overrides its own. */
  const thisProcess = (birth?: string): OwnerIdentity => {
    const exact = exactProcessIdentity(process.pid);
    if (!exact) throw new Error('this process has no exact identity');
    return {
      id: 'another-writer',
      pid: process.pid,
      identityKind: 'exact',
      birth: birth ?? exact.start,
    };
  };

  test('an intent from a process that is gone, whose worktree is intact, had no effect and gives way', async () => {
    const { repo, store, service } = fixture();
    const a = await sessionWorktree(repo, 'session-a');
    git(repo, 'merge', '--quiet', '--no-ff', '-m', 'merge', a.metadata.branch);
    // Same pid, another birth: a process that has since gone.
    intentBy(store, a, thisProcess('a-process-long-gone'));

    expect(
      await service.settle({
        sessionId: 'session-a',
        metadata: a.metadata,
        actor: OWNER,
        stillAuthorized: allowed,
        request: { requestKey: 'kept-1', outcome: 'kept' },
      }),
    ).toMatchObject({
      kind: 'recorded',
      settlement: { outcome: 'kept', actor: OWNER },
    });
  });

  test('an intent from a process that may still run it is never taken over', async () => {
    const { repo, store, service } = fixture();
    const a = await sessionWorktree(repo, 'session-a');
    git(repo, 'merge', '--quiet', '--no-ff', '-m', 'merge', a.metadata.branch);
    for (const owner of [thisProcess(), undefined]) {
      intentBy(store, a, owner);
      for (const request of [
        { requestKey: 'kept-1', outcome: 'kept' as const },
        { requestKey: 'discard-1', outcome: 'discarded' as const },
      ])
        expect(
          await service.settle({
            sessionId: 'session-a',
            metadata: a.metadata,
            actor: OWNER,
            stillAuthorized: allowed,
            request,
          }),
        ).toMatchObject({ kind: 'refused', reason: 'settlement-pending' });
      expect(service.read('session-a')).toMatchObject({
        state: 'pending',
        requestKey: 'discard-stale',
      });
      store.abandonPending('session-a', 'discard-stale');
    }
    expect(existsSync(a.metadata.path)).toBe(true);
    expect(branchExists(repo, a.metadata.branch)).toBe(true);
  });

  test('two Station processes on one database: a second request waits for the first discard', async () => {
    const { parent, repo } = repository();
    const dbPath = join(parent, 'orchestration.sqlite');
    const a = await sessionWorktree(repo, 'session-a');
    git(repo, 'merge', '--quiet', '--no-ff', '-m', 'merge', a.metadata.branch);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const paused = new WorktreeProvisioningService();
    const discard = paused.discardSessionWorktree.bind(paused);
    paused.discardSessionWorktree = async (request) => {
      entered();
      await gate;
      return discard(request);
    };
    const first = new WorktreeOutputSettlementService({
      store: storeAt(dbPath),
      worktrees: paused,
      pullRequestProviders: () => [],
    });
    const second = new WorktreeOutputSettlementService({
      store: storeAt(dbPath),
      worktrees: new WorktreeProvisioningService(),
      pullRequestProviders: () => [],
    });
    const discarding = first.settle({
      sessionId: 'session-a',
      metadata: a.metadata,
      actor: OWNER,
      stillAuthorized: allowed,
      request: { requestKey: 'discard-1', outcome: 'discarded' },
    });
    await inside;

    expect(
      await second.settle({
        sessionId: 'session-a',
        metadata: a.metadata,
        actor: OTHER,
        stillAuthorized: allowed,
        request: { requestKey: 'kept-1', outcome: 'kept' },
      }),
    ).toMatchObject({ kind: 'refused', reason: 'settlement-pending' });
    release();
    expect(await discarding).toMatchObject({
      kind: 'recorded',
      settlement: { outcome: 'discarded', actor: OWNER },
    });
    expect(second.read('session-a')).toMatchObject({
      state: 'settled',
      outcome: 'discarded',
    });
  });
});

describe('cleanup policy without a decision (#4771)', () => {
  test('is recorded as exactly that, distinct from a person discarding', async () => {
    const { repo, service } = fixture();
    const a = await sessionWorktree(repo, 'session-a', { cleanup: true });

    expect(
      await service.finalizeSessionExit({
        sessionId: 'session-a',
        metadata: a.metadata,
        terminalState: 'completed',
      }),
    ).toBe('removed');

    expect(existsSync(a.metadata.path)).toBe(false);
    expect(service.read('session-a')).toMatchObject({
      state: 'settled',
      outcome: 'cleaned-up-without-decision',
      actor: { kind: 'station', id: 'worktree-cleanup-policy' },
      headCommit: a.head,
      evidence: { terminalState: 'completed' },
    });
    // A later discard cannot rewrite it as a person's decision.
    expect(
      await service.settle({
        sessionId: 'session-a',
        metadata: a.metadata,
        actor: OWNER,
        stillAuthorized: allowed,
        request: { requestKey: 'discard-1', outcome: 'discarded' },
      }),
    ).toMatchObject({ kind: 'refused', reason: 'already-settled' });
  });

  test('a decision made first stands when cleanup later removes the worktree', async () => {
    const { repo, service } = fixture();
    const a = await sessionWorktree(repo, 'session-a', { cleanup: true });
    git(repo, 'merge', '--quiet', '--no-ff', '-m', 'merge', a.metadata.branch);
    await service.settle({
      sessionId: 'session-a',
      metadata: a.metadata,
      actor: OWNER,
      stillAuthorized: allowed,
      request: { requestKey: 'kept-1', outcome: 'kept' },
    });
    const kept = service.read('session-a');

    await service.finalizeSessionExit({
      sessionId: 'session-a',
      metadata: a.metadata,
      terminalState: 'completed',
    });

    expect(existsSync(a.metadata.path)).toBe(false);
    expect(service.read('session-a')).toEqual(kept);
  });

  test('a preserved worktree records nothing', async () => {
    const { repo, service } = fixture();
    const a = await sessionWorktree(repo, 'session-a');
    expect(
      await service.finalizeSessionExit({
        sessionId: 'session-a',
        metadata: a.metadata,
        terminalState: 'completed',
      }),
    ).toBe('preserved');
    expect(service.read('session-a')).toBeUndefined();
  });
});

/** A provisioning service whose branch deletion stops the process first. */
function stoppingBeforeBranchDeletion() {
  const worktrees = new WorktreeProvisioningService();
  Reflect.set(worktrees, 'deleteOwnBranch', async () => {
    throw new Error('process stopped after the worktree was removed');
  });
  return worktrees;
}

const discardBy = (
  service: WorktreeOutputSettlementService,
  a: { metadata: WorktreeSessionMetadata },
  options: { requestKey?: string; acceptUncommittedLoss?: boolean } = {},
) =>
  service.settle({
    sessionId: 'session-a',
    metadata: a.metadata,
    actor: OWNER,
    stillAuthorized: allowed,
    request: {
      requestKey: options.requestKey ?? 'discard-1',
      outcome: 'discarded',
      ...(options.acceptUncommittedLoss ? { acceptUncommittedLoss: true } : {}),
    },
  });

describe('a branch another checkout has (#4771)', () => {
  test('a fresh discard is refused before anything is removed', async () => {
    const { repo, service } = fixture();
    const a = await sessionWorktree(repo, 'session-a');
    git(
      repo,
      'checkout',
      '--quiet',
      '--ignore-other-worktrees',
      a.metadata.branch,
    );

    expect(await discardBy(service, a)).toMatchObject({
      kind: 'refused',
      reason: 'branch-checked-out-elsewhere',
    });
    expect(existsSync(a.metadata.path)).toBe(true);
    expect(branchExists(repo, a.metadata.branch)).toBe(true);
    expect(git(repo, 'symbolic-ref', 'HEAD')).toBe(
      `refs/heads/${a.metadata.branch}`,
    );
    expect(git(repo, 'rev-parse', '--verify', 'HEAD')).toBe(a.head);
    expect(service.read('session-a')).toBeUndefined();
  });

  test('a crash after the worktree was removed converges: the branch is deleted, or kept when checked out since', async () => {
    for (const checkedOutSince of [false, true]) {
      const { parent, repo } = repository();
      const dbPath = join(parent, 'orchestration.sqlite');
      const a = await sessionWorktree(repo, 'session-a');
      const crashing = new WorktreeOutputSettlementService({
        store: storeAt(dbPath),
        worktrees: stoppingBeforeBranchDeletion(),
        pullRequestProviders: () => [],
      });
      await expect(discardBy(crashing, a)).rejects.toThrow(/process stopped/);
      expect(existsSync(a.metadata.path)).toBe(false);
      expect(branchExists(repo, a.metadata.branch)).toBe(true);
      if (checkedOutSince) git(repo, 'switch', '--quiet', a.metadata.branch);

      const restarted = new WorktreeOutputSettlementService({
        store: storeAt(dbPath),
        worktrees: new WorktreeProvisioningService(),
        pullRequestProviders: () => [],
      });
      expect(await discardBy(restarted, a)).toMatchObject({
        kind: 'recorded',
        settlement: {
          outcome: 'discarded',
          evidence: checkedOutSince
            ? {
                removedWorktree: false,
                removedBranch: false,
                branchKept: 'checked-out-elsewhere',
              }
            : { removedWorktree: false, removedBranch: true },
        },
      });
      expect(branchExists(repo, a.metadata.branch)).toBe(checkedOutSince);
      // The base checkout still resolves its HEAD either way.
      expect(git(repo, 'rev-parse', '--verify', 'HEAD')).toMatch(/^[0-9a-f]+$/);
    }
  });
});

describe('kept against a base of HEAD (#4771)', () => {
  const keep = (
    service: WorktreeOutputSettlementService,
    a: { metadata: WorktreeSessionMetadata },
    requestKey: string,
  ) =>
    service.settle({
      sessionId: 'session-a',
      metadata: a.metadata,
      actor: OWNER,
      stillAuthorized: allowed,
      request: { requestKey, outcome: 'kept' },
    });

  test('a detached base checkout, or one on the Session branch, is not a base', async () => {
    const { repo, service } = fixture();
    const a = await sessionWorktree(repo, 'session-a');
    expect(a.metadata.baseRef).toBe('HEAD');

    git(repo, 'checkout', '--quiet', '--detach', a.head);
    expect(await keep(service, a, 'kept-1')).toMatchObject({
      kind: 'refused',
      reason: 'base-detached',
    });
    git(
      repo,
      'checkout',
      '--quiet',
      '--ignore-other-worktrees',
      a.metadata.branch,
    );
    expect(await keep(service, a, 'kept-2')).toMatchObject({
      kind: 'refused',
      reason: 'base-is-session-branch',
    });
    expect(service.read('session-a')).toBeUndefined();
  });

  test('a fast-forward merge is kept, naming the branch HEAD named', async () => {
    const { repo, service } = fixture();
    const a = await sessionWorktree(repo, 'session-a');
    git(repo, 'merge', '--quiet', '--ff-only', a.metadata.branch);

    expect(await keep(service, a, 'kept-1')).toMatchObject({
      kind: 'recorded',
      settlement: {
        headCommit: a.head,
        evidence: { containingCommit: a.head, baseBranch: 'main' },
      },
    });
  });
});

describe('what a discard checks and records (#4771)', () => {
  test('is refused while a turn runs in the Session worktree', async () => {
    const busy: string[] = [];
    const { repo, service } = fixture({
      isWorkspaceBusy: (path) => busy.includes(path),
    });
    const a = await sessionWorktree(repo, 'session-a');
    busy.push(a.metadata.path);

    expect(await discardBy(service, a)).toMatchObject({
      kind: 'refused',
      reason: 'session-running',
    });
    expect(existsSync(a.metadata.path)).toBe(true);
    expect(service.read('session-a')).toBeUndefined();
    busy.length = 0;
    expect((await discardBy(service, a)).kind).toBe('recorded');
  });

  test('ignored files go without acceptance, and the record counts them', async () => {
    const { repo, service } = fixture();
    writeFileSync(join(repo, '.gitignore'), '.env\n');
    git(repo, 'add', '.gitignore');
    git(repo, 'commit', '--quiet', '-m', 'ignore');
    const a = await sessionWorktree(repo, 'session-a');
    writeFileSync(join(a.metadata.path, '.env'), 'SECRET=local\n');

    expect(await discardBy(service, a)).toMatchObject({
      kind: 'recorded',
      settlement: {
        evidence: { hadUncommittedChanges: false, ignoredEntries: 1 },
      },
    });
  });

  test('a branch that moved after inspection is refused with nothing removed', async () => {
    const worktrees = new WorktreeProvisioningService();
    const discard = worktrees.discardSessionWorktree.bind(worktrees);
    let a!: { metadata: WorktreeSessionMetadata; head: string };
    worktrees.discardSessionWorktree = async (request) => {
      writeFileSync(join(a.metadata.path, 'late.txt'), 'late\n');
      git(a.metadata.path, 'add', 'late.txt');
      git(a.metadata.path, 'commit', '--quiet', '-m', 'late');
      return discard(request);
    };
    const { repo, service } = fixture({ worktrees });
    a = await sessionWorktree(repo, 'session-a');

    expect(await discardBy(service, a)).toMatchObject({
      kind: 'refused',
      reason: 'branch-moved',
    });
    expect(existsSync(join(a.metadata.path, 'late.txt'))).toBe(true);
    expect(branchExists(repo, a.metadata.branch)).toBe(true);
    expect(service.read('session-a')).toBeUndefined();
  });

  test('a repository config that names a program refuses without running it', async () => {
    const { parent, repo, service } = fixture();
    const a = await sessionWorktree(repo, 'session-a');
    const marker = join(parent, 'filter-ran');
    git(repo, 'config', 'filter.evil.clean', `sh -c 'touch ${marker}; cat'`);
    writeFileSync(join(a.metadata.path, '.gitattributes'), '* filter=evil\n');

    expect(await discardBy(service, a)).toMatchObject({
      kind: 'refused',
      reason: 'unsafe-repository-config',
    });
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(a.metadata.path)).toBe(true);
  });

  test('a branch turned into a symbolic ref is refused and its target kept', async () => {
    const { repo } = fixture();
    const a = await sessionWorktree(repo, 'session-a');
    git(repo, 'worktree', 'remove', a.metadata.path);
    git(repo, 'update-ref', '-d', `refs/heads/${a.metadata.branch}`);
    git(
      repo,
      'symbolic-ref',
      `refs/heads/${a.metadata.branch}`,
      'refs/heads/main',
    );

    expect(
      await new WorktreeProvisioningService().discardSessionWorktree({
        metadata: a.metadata,
        sessionId: 'session-a',
        expectedHead: a.head,
        acceptUncommittedLoss: true,
      }),
    ).toMatchObject({ kind: 'refused', reason: 'unsafe-config' });
    expect(branchExists(repo, 'main')).toBe(true);
  });
});

describe('a worktree path that is no longer the worktree (#4771)', () => {
  test('a symlink, another repository, or a moved repository is refused and nothing behind it is touched', async () => {
    // A symlink to the moved worktree: `git worktree remove` would delete
    // through it.
    {
      const { parent, repo, service } = fixture();
      const a = await sessionWorktree(repo, 'session-a');
      mkdirSync(join(parent, 'moved'));
      const moved = join(parent, 'moved', basename(a.metadata.path));
      renameSync(a.metadata.path, moved);
      symlinkSync(moved, a.metadata.path);
      expect(
        await discardBy(service, a, { acceptUncommittedLoss: true }),
      ).toMatchObject({
        kind: 'refused',
        reason: 'worktree-path-not-a-directory',
      });
      expect(existsSync(join(moved, 'session-a.txt'))).toBe(true);
      expect(branchExists(repo, a.metadata.branch)).toBe(true);
    }
    {
      const { repo, service } = fixture();
      const a = await sessionWorktree(repo, 'session-a');
      rmSync(a.metadata.path, { recursive: true, force: true });
      mkdirSync(a.metadata.path);
      git(a.metadata.path, 'init', '--quiet');
      writeFileSync(join(a.metadata.path, 'precious.txt'), 'mine\n');
      expect(
        await discardBy(service, a, { acceptUncommittedLoss: true }),
      ).toMatchObject({ kind: 'refused', reason: 'worktree-replaced' });
      expect(existsSync(join(a.metadata.path, 'precious.txt'))).toBe(true);
    }
    {
      const { parent, repo, service } = fixture();
      const a = await sessionWorktree(repo, 'session-a');
      renameSync(repo, join(parent, 'repo-moved'));
      expect(await discardBy(service, a)).toMatchObject({
        kind: 'refused',
        reason: 'repository-missing',
      });
      expect(service.read('session-a')).toBeUndefined();
    }
  });
});

describe('cleanup records what is actually gone (#4771)', () => {
  test('cleanup does not run on a worktree path that is now a symlink', async () => {
    const { parent, repo, service } = fixture();
    const a = await sessionWorktree(repo, 'session-a', { cleanup: true });
    mkdirSync(join(parent, 'moved'));
    const moved = join(parent, 'moved', basename(a.metadata.path));
    renameSync(a.metadata.path, moved);
    symlinkSync(moved, a.metadata.path);

    await expect(
      service.finalizeSessionExit({
        sessionId: 'session-a',
        metadata: a.metadata,
        terminalState: 'completed',
      }),
    ).rejects.toThrow(/symlink or not a directory/);
    expect(existsSync(join(moved, 'session-a.txt'))).toBe(true);
    expect(service.read('session-a')).toBeUndefined();
  });

  test('a branch the cleanup could not delete is recorded as kept', async () => {
    const { repo, service } = fixture();
    const a = await sessionWorktree(repo, 'session-a', { cleanup: true });
    git(
      repo,
      'checkout',
      '--quiet',
      '--ignore-other-worktrees',
      a.metadata.branch,
    );

    expect(
      await service.finalizeSessionExit({
        sessionId: 'session-a',
        metadata: a.metadata,
        terminalState: 'completed',
      }),
    ).toBe('removed');
    expect(branchExists(repo, a.metadata.branch)).toBe(true);
    expect(service.read('session-a')).toMatchObject({
      outcome: 'cleaned-up-without-decision',
      evidence: { removedWorktree: true, removedBranch: false },
    });
  });
});

describe('the forge read is bounded (#4771)', () => {
  test('a forge that never answers is refused as unavailable', async () => {
    const { repo, store } = fixture();
    const a = await sessionWorktree(repo, 'session-a');
    const silent = {
      id: 'github',
      canServeHost: () => true,
      getPullRequestByIdentity: () => new Promise(() => undefined),
    } as unknown as IPullRequestProvider;
    const service = new WorktreeOutputSettlementService({
      store,
      worktrees: new WorktreeProvisioningService(),
      pullRequestProviders: () => [silent],
      forgeDeadlineMs: 50,
    });

    expect(
      await service.settle({
        sessionId: 'session-a',
        metadata: a.metadata,
        actor: OWNER,
        stillAuthorized: allowed,
        request: {
          requestKey: 'released-1',
          outcome: 'released',
          pullRequest: PULL_REQUEST,
        },
      }),
    ).toMatchObject({
      kind: 'refused',
      reason: 'pull-request-unavailable',
      detail: 'The forge did not answer in time.',
    });
  });
});
