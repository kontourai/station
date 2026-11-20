import { existsSync } from 'node:fs';
import { readdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { execGit } from '../../../utils/git-exec.js';
import { GitReviewWorkspaceSource } from '../git-review-workspace-source.js';
import { ReviewEvidenceModule } from '../review-evidence-module.js';
import { FileReviewReceiptStore } from '../review-receipt-store.js';
import {
  TaskCodeReviewModule,
  type TaskCodeReviewScope,
} from '../task-code-review-module.js';

const makeTempDir = trackTempDirs();

const publication = vi.hoisted(() => {
  let afterReceiptSync: (() => void) | undefined;
  return {
    set(callback: (() => void) | undefined) {
      afterReceiptSync = callback;
    },
    take() {
      const callback = afterReceiptSync;
      afterReceiptSync = undefined;
      return callback;
    },
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const descriptor = await actual.open(...args);
      if (
        typeof args[0] === 'string' &&
        /\/receipts\/[0-9a-f]{64}\.json\..+\.tmp$/.test(
          args[0].replaceAll('\\', '/'),
        )
      ) {
        const sync = descriptor.sync.bind(descriptor);
        descriptor.sync = async () => {
          await sync();
          publication.take()?.();
        };
      }
      return descriptor;
    },
  };
});

afterEach(() => publication.set(undefined));

async function fixture(options: { beforeReceiptCommit?: () => void } = {}) {
  const root = await realpath(makeTempDir('station-task-code-review-'));
  const git = async (...args: string[]) =>
    (await execGit(args, { cwd: root, timeout: 5000 })).stdout.trim();
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Review fixture');
  await git('config', 'user.email', 'review@example.test');
  await writeFile(
    join(root, '.gitignore'),
    '.station/\ncoordination/\nreview-workspaces/\n',
  );
  await writeFile(join(root, 'work.txt'), 'base\n');
  await git('add', '.');
  await git('commit', '-m', 'base');
  const base = await git('rev-parse', 'HEAD');
  await writeFile(join(root, 'work.txt'), 'changed\n');
  await git('commit', '-am', 'change');
  const head = await git('rev-parse', 'HEAD');
  const project = {
    id: 'project-1',
    slug: 'project',
    name: 'Project',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    workingDirectory: root,
    agents: [],
  };
  let workspace = root;
  let current = true;
  const scope: TaskCodeReviewScope = {
    project,
    task: {
      id: 'task-1',
      projectId: project.id,
      title: 'Review the change',
      description: '',
      priority: 'normal',
      status: 'in_progress',
      agentId: 'implementer',
      createdBy: 'operator',
      createdAt: '2026-01-02T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      workspaceBinding: { availability: 'available', workingDirectory: root },
    },
    owner: { ownerUserId: 'operator' },
    assertCurrent() {
      if (!current) throw new Error('Task revoked');
    },
    assertMayExecute() {
      this.assertCurrent();
    },
  };
  const resolver = { workspace: () => workspace };
  const store = new FileReviewReceiptStore(resolver, {
    coordinationDirectory: join(root, 'coordination'),
    ...options,
  });
  const execute = vi.fn(async () => ({
    kind: 'completed' as const,
    workspaceRelease: 'safe' as const,
    output: { findings: [], deltaAssessments: [] },
  }));
  const reviews = new ReviewEvidenceModule({
    source: new GitReviewWorkspaceSource(
      { workspace: () => root },
      join(root, 'review-workspaces'),
    ),
    receipts: store,
    submissions: store,
    executor: { workspaceAccess: 'read-only', execute },
    principals: {
      resolveAgent: async (slug) => ({ actorId: `agent:${slug}` }),
    },
    observer: { record() {}, diagnostic() {} },
  });
  const module = new TaskCodeReviewModule({
    reviews,
    submissions: store,
    baseCommit: () => base,
    reviewers: async () => [{ slug: 'reviewer', name: 'Reviewer' }],
    reportError() {},
  });
  const request = {
    requestId: 'review-1',
    projectId: project.id,
    projectCreatedAt: project.createdAt,
    taskCreatedAt: scope.task.createdAt,
    baseSha: base,
    headSha: head,
    reviewerAgentSlug: 'reviewer',
  };
  return {
    root,
    git,
    module,
    reviews,
    resolver,
    scope,
    store,
    execute,
    request,
    revoke: () => {
      current = false;
    },
    replaceWorkspace: (replacement: string) => {
      workspace = replacement;
      current = false;
    },
  };
}

describe('Task code review producer and consumer', () => {
  it('refuses revocation after temporary receipt sync but before rename', async () => {
    const f = await fixture();
    publication.set(f.revoke);
    await expect(f.module.run(f.scope, f.request)).rejects.toThrow(
      'Task revoked',
    );
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(await f.store.list(f.scope.project.slug)).toEqual([]);
  });

  it('never pairs a Task receipt with a replacement Project admission', async () => {
    const f = await fixture();
    const completed = await f.module.run(f.scope, f.request);
    if (!completed.result) throw new Error('Task reviewer did not complete');
    const replacement = await realpath(
      makeTempDir('station-reader-replacement-'),
    );
    const other = new FileReviewReceiptStore(
      { workspace: () => replacement },
      { coordinationDirectory: join(replacement, 'coordination') },
    );
    await other.begin({
      request: {
        requestId: f.request.requestId,
        mode: 'initial',
        target: {
          kind: 'git-range',
          projectSlug: f.scope.project.slug,
          baseRevision: f.request.baseSha,
          headRevision: f.request.headSha,
        },
        implementerAgentSlug: 'implementer',
        reviewers: [
          {
            reviewerId: 'reviewer',
            executorAgentSlug: 'reviewer',
            lens: {
              id: 'correctness',
              instructions: 'Review the Project change.',
            },
          },
        ],
      },
      startedAt: '2026-11-15T00:00:00Z',
    });
    vi.spyOn(f.resolver, 'workspace')
      .mockReturnValueOnce(f.root)
      .mockReturnValue(replacement);
    expect(
      await f.reviews.read(
        completed.result.receipt.receiptId,
        f.scope.project.slug,
        false,
      ),
    ).toBeNull();
  });

  it('does not publish the old Task review into a replacement Project after execution', async () => {
    const f = await fixture();
    const replacement = await realpath(
      makeTempDir('station-replacement-review-'),
    );
    f.execute.mockImplementationOnce(async () => {
      f.replaceWorkspace(replacement);
      return {
        kind: 'completed',
        workspaceRelease: 'safe',
        output: { findings: [], deltaAssessments: [] },
      };
    });
    await expect(f.module.run(f.scope, f.request)).rejects.toThrow();
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(existsSync(join(replacement, '.station'))).toBe(false);
    expect(
      (await readdir(join(f.root, 'review-workspaces'))).filter((name) =>
        name.startsWith('review-'),
      ),
    ).toEqual([]);
  });

  it('rechecks Task authority at the actual receipt publication seam', async () => {
    let revoke = () => {};
    const f = await fixture({ beforeReceiptCommit: () => revoke() });
    revoke = f.revoke;
    await expect(f.module.run(f.scope, f.request)).rejects.toThrow(
      'Task revoked',
    );
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(await f.store.list(f.scope.project.slug)).toEqual([]);
  });

  it.each([
    { id: 'replacement-project', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'project-1', createdAt: '2026-01-03T00:00:00Z' },
  ])(
    'refuses unadmitted saved intent after the Project incarnation changes to %j',
    async (replacement) => {
      const f = await fixture();
      const scope = {
        ...f.scope,
        project: { ...f.scope.project, ...replacement },
        task: { ...f.scope.task, projectId: f.scope.project.slug },
      };
      await expect(f.module.run(scope, f.request)).rejects.toMatchObject({
        code: 'project-changed',
      });
      expect(f.execute).not.toHaveBeenCalled();
      expect(
        await f.store.hasTaskRequest(scope.project.slug, f.request.requestId, {
          projectId: scope.project.id,
          projectCreatedAt: scope.project.createdAt,
          taskId: scope.task.id,
          taskCreatedAt: scope.task.createdAt,
        }),
      ).toBe(false);
      const current = await f.module.run(scope, {
        ...f.request,
        requestId: 'new-project-intent',
        projectId: scope.project.id,
        projectCreatedAt: scope.project.createdAt,
      });
      expect(current.state).toBe('completed');
      expect(f.execute).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps an exact Task review through retries and distinguishes moved HEAD from dirty files', async () => {
    const f = await fixture();
    const before = await f.module.read(f.scope);
    expect(before.workspace).toMatchObject({
      state: 'available',
      kind: 'project-checkout',
      headSha: f.request.headSha,
      dirty: false,
    });
    expect(before.requests).toEqual([]);
    const first = await f.module.run(f.scope, f.request);
    expect(first.state).toBe('completed');
    await f.module.run(f.scope, f.request);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect((await f.module.read(f.scope)).requests).toMatchObject([
      {
        requestId: f.request.requestId,
        freshness: 'same-revision',
        findings: [],
      },
    ]);
    await writeFile(join(f.root, 'work.txt'), 'uncommitted\n');
    const dirty = await f.module.read(f.scope);
    expect(dirty.workspace.dirty).toBe(true);
    expect(dirty.requests[0].freshness).toBe('same-revision');
    await f.git('commit', '-am', 'later change');
    expect((await f.module.read(f.scope)).requests[0]).toMatchObject({
      headSha: f.request.headSha,
      freshness: 'different-revision',
    });
    await f.module.run(f.scope, f.request);
    expect(f.execute).toHaveBeenCalledTimes(1);
    await expect(
      f.module.run(f.scope, { ...f.request, requestId: 'stale-new-request' }),
    ).rejects.toThrow('checkout changed');
    const missingWorkspace = {
      ...f.scope,
      task: {
        ...f.scope.task,
        workspaceBinding: { availability: 'unavailable' as const },
      },
    };
    await expect(
      f.module.run(missingWorkspace, {
        ...f.request,
        requestId: 'unavailable-new-request',
      }),
    ).rejects.toThrow('checkout changed or is unavailable');
    const replacement = {
      ...f.scope,
      task: { ...f.scope.task, createdAt: '2026-01-03T00:00:00Z' },
    };
    expect((await f.module.read(replacement)).requests).toEqual([]);
    await expect(
      f.module.run(replacement, {
        ...f.request,
        taskCreatedAt: replacement.task.createdAt,
      }),
    ).rejects.toThrow('identity collision');
    f.revoke();
    await expect(f.module.read(f.scope)).rejects.toThrow('Task revoked');
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('refuses a self reviewer before any review submission and separates corrupt history from empty history', async () => {
    const f = await fixture();
    await expect(
      f.module.run(f.scope, { ...f.request, reviewerAgentSlug: 'implementer' }),
    ).rejects.toThrow('independent reviewer');
    expect(f.execute).not.toHaveBeenCalled();
    await f.module.run(f.scope, f.request);
    await writeFile(
      join(f.root, '.station/review-evidence/receipts/.requests/bad.json'),
      '{}',
    );
    const view = await f.module.read(f.scope);
    expect(view.workspace.state).toBe('available');
    expect(view.requestsUnavailable).toBe(true);
  });
});
