import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IndependentReviewReceipt } from '@kontourai/station-contracts/review-evidence';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ReadOnlyReviewExecutor,
  type ReadOnlyReviewWorkspace,
  ReviewEvidenceModule,
  type ReviewExecutionOutcome,
  ReviewProjectWorkspaceMissingError,
  type ReviewSelectionResolver,
  type ReviewWorkspaceSource,
} from '../review-evidence-module.js';
import { FileReviewReceiptStore } from '../review-receipt-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function harness(options?: {
  outcomes?: Record<string, ReviewExecutionOutcome>;
  attach?: () => Promise<{ evidenceId: string }>;
  timeoutMs?: number;
  selectionResolver?: ReviewSelectionResolver;
}) {
  const root = await mkdtemp(join(tmpdir(), 'station-review-evidence-'));
  roots.push(root);
  const project = join(root, 'project');
  await mkdir(join(project, 'src'), { recursive: true });
  await writeFile(join(project, 'src', 'module.ts'), 'one\ntwo\n', 'utf8');
  const close = vi.fn(async () => {});
  const workspace: ReadOnlyReviewWorkspace = {
    root: project,
    target: {
      kind: 'git-range',
      projectSlug: 'station',
      baseRevision: 'base',
      headRevision: 'head',
      repositoryId: 'github.com/kontourai/station',
      baseSha: '1'.repeat(40),
      headSha: '2'.repeat(40),
      diffSha256: '3'.repeat(64),
    },
    async validateLocation(location) {
      if (location.file !== 'src/module.ts' || location.line > 2) {
        throw new Error('location is absent from reviewed head');
      }
    },
    close,
  };
  const execute = vi.fn(
    async ({ reviewer }) =>
      options?.outcomes?.[reviewer.reviewerId] ?? {
        kind: 'completed' as const,
        workspaceRelease: 'safe' as const,
        output: {
          findings: [
            {
              location: { file: 'src/module.ts', line: 2 },
              scenario: {
                stateOrInput: 'the write commits and an observer throws',
                wrongOutcome: 'the caller receives a retryable failure',
              },
              severity: 'high',
              confidence: 'high',
              basis: 'reasoned-from-code',
              summary: 'Observer failure overturns committed truth.',
            },
          ],
          deltaAssessments: [],
        },
      },
  );
  const executor: ReadOnlyReviewExecutor = {
    workspaceAccess: 'read-only',
    execute,
  };
  const receipts = new FileReviewReceiptStore(
    {
      workspace: (slug) => (slug === 'station' ? project : undefined),
    },
    {
      coordinationDirectory: join(root, 'coordination'),
    },
  );
  let tick = 0;
  const diagnostic = vi.fn();
  // Typed from the seam, not inferred from this happy-path callback: the
  // real `open` receives the resolved target, and a mock inferred as
  // zero-arg makes an assertion on that argument a compile error rather
  // than a test.
  const open = vi.fn<ReviewWorkspaceSource['open']>(async () => workspace);
  const module = new ReviewEvidenceModule({
    source: { open },
    executor,
    receipts,
    submissions: receipts,
    principals: {
      resolveAgent: vi.fn(async (agentSlug) => ({
        actorId: `agent:${agentSlug}`,
        displayName: agentSlug,
      })),
    },
    observer: { record: vi.fn(), diagnostic },
    ...(options?.attach ? { attachment: { attach: options.attach } } : {}),
    ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options?.selectionResolver
      ? { selectionResolver: options.selectionResolver }
      : {}),
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
  });
  return {
    module,
    project,
    close,
    execute,
    open,
    receipts,
    workspace,
    diagnostic,
  };
}

const request = {
  requestId: 'request-1',
  mode: 'initial',
  target: {
    kind: 'git-range',
    projectSlug: 'station',
    baseRevision: 'base',
    headRevision: 'head',
  },
  implementerAgentSlug: 'terra',
  reviewers: [
    {
      reviewerId: 'sol-1',
      executorAgentSlug: 'reviewer-agent',
      lens: { id: 'failure-totality', instructions: 'Review failure truth.' },
    },
  ],
} as const;

const repoMapTarget = {
  ...request.target,
  repositoryId: 'github.com/kontourai/station',
  baseSha: '1'.repeat(40),
  headSha: '2'.repeat(40),
  diffSha256: '3'.repeat(64),
};

const repoMapRouting = {
  kind: 'repo-map' as const,
  policyRevision: 'a'.repeat(40),
  repoMapSha256: 'b'.repeat(64),
  registrySha256: 'c'.repeat(64),
  routerVersion: 1 as const,
  affectedNodes: ['product.src-server'],
};

describe('ReviewEvidenceModule', () => {
  it('persists trusted repo-map routing alongside the durable receipt', async () => {
    const selectionResolver: ReviewSelectionResolver = {
      resolve: vi.fn(async () => ({
        kind: 'selected' as const,
        reviewers: [...request.reviewers],
        target: repoMapTarget,
        routing: repoMapRouting,
      })),
    };
    const { module } = await harness({ selectionResolver });
    const status = await module.run(
      { ...request, reviewers: [], selection: { kind: 'repo-map' } },
      { requestedBy: { actorId: 'user:operator' } },
    );
    expect(status).toMatchObject({
      state: 'completed',
      routing: { policyRevision: 'a'.repeat(40) },
      result: { receipt: { routing: { registrySha256: 'c'.repeat(64) } } },
    });
  });

  it.each([
    {
      name: 'no reviewers',
      reviewers: [],
      result: { target: repoMapTarget, routing: repoMapRouting },
      reason: 'Repo Map review routing did not select any reviewers.',
    },
    {
      name: 'too many reviewers',
      reviewers: Array.from({ length: 9 }, (_, index) => ({
        ...request.reviewers[0],
        reviewerId: `sol-${index + 1}`,
        executorAgentSlug: `reviewer-${index + 1}`,
      })),
      result: { target: repoMapTarget, routing: repoMapRouting },
      reason: 'Repo Map review routing exceeded the reviewer limit.',
    },
    {
      name: 'duplicate reviewer actor',
      reviewers: [
        ...request.reviewers,
        { ...request.reviewers[0], reviewerId: 'sol-2' },
      ],
      result: { target: repoMapTarget, routing: repoMapRouting },
      reason:
        'Repo Map review routing could not allocate independent reviewers.',
    },
    {
      name: 'missing target',
      result: { routing: repoMapRouting },
    },
    {
      name: 'missing routing',
      result: { target: repoMapTarget },
    },
    {
      name: 'malformed binding',
      result: {
        target: { ...repoMapTarget, headSha: 'not-a-sha' },
        routing: { ...repoMapRouting, policyRevision: 'HEAD' },
      },
    },
  ])(
    'persists NOT_VERIFIED for Repo Map selection with $name before workspace or executor use',
    async ({ result, reviewers = request.reviewers, reason }) => {
      const selectionResolver: ReviewSelectionResolver = {
        resolve: vi.fn(
          async () =>
            ({
              kind: 'selected' as const,
              reviewers: [...reviewers],
              ...result,
            }) as never,
        ),
      };
      const { module, execute, open } = await harness({ selectionResolver });

      await expect(
        module.run(
          { ...request, reviewers: [], selection: { kind: 'repo-map' } },
          { requestedBy: { actorId: 'user:operator' } },
        ),
      ).resolves.toMatchObject({
        state: 'not-verified',
        failureReason:
          reason ??
          'Repo Map review routing did not provide a valid immutable target and policy binding.',
        unavailableLenses: ['human-review'],
      });
      expect(open).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('persists NOT_VERIFIED selection unavailability without opening a workspace or invoking a reviewer', async () => {
    const selectionResolver: ReviewSelectionResolver = {
      resolve: vi.fn(async () => ({
        kind: 'unavailable' as const,
        reason: 'No eligible reviewer.',
        unavailableLenses: ['runtime'],
      })),
    };
    const { module, execute, open } = await harness({ selectionResolver });
    const status = await module.run(
      { ...request, reviewers: [], selection: { kind: 'repo-map' } },
      { requestedBy: { actorId: 'user:operator' } },
    );
    expect(status).toMatchObject({
      state: 'not-verified',
      unavailableLenses: ['runtime'],
    });
    expect(execute).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('persists a server-owned Repo Map policy NOT_VERIFIED reason before workspace or executor use', async () => {
    const reason = 'Review routing policy changed in the candidate.';
    const selectionResolver: ReviewSelectionResolver = {
      resolve: vi.fn(async () => ({
        kind: 'unavailable' as const,
        reason,
        unavailableLenses: ['human-review'],
      })),
    };
    const { module, execute, open, project } = await harness({
      selectionResolver,
    });
    const status = await module.run(
      { ...request, reviewers: [], selection: { kind: 'repo-map' } },
      { requestedBy: { actorId: 'user:operator' } },
    );
    const reopened = new FileReviewReceiptStore(
      { workspace: (slug) => (slug === 'station' ? project : undefined) },
      { coordinationDirectory: join(project, '.station', 'review-test-locks') },
    );

    expect(status).toMatchObject({
      state: 'not-verified',
      failureReason: reason,
      unavailableLenses: ['human-review'],
    });
    await expect(
      reopened.status(request.requestId, 'station'),
    ).resolves.toMatchObject({
      state: 'not-verified',
      failureReason: reason,
      unavailableLenses: ['human-review'],
    });
    expect(execute).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('uses the selected immutable SHA target when a symbolic ref moves before workspace open', async () => {
    const selectedTarget = repoMapTarget;
    const selectionResolver: ReviewSelectionResolver = {
      resolve: vi.fn(async () => ({
        kind: 'selected' as const,
        reviewers: [...request.reviewers],
        target: selectedTarget,
        routing: repoMapRouting,
      })),
    };
    const { module, open, workspace } = await harness({ selectionResolver });
    open.mockImplementationOnce(async (input) => {
      // The symbolic HEAD moves after routing; the source still receives the
      // immutable selection rather than re-resolving the caller's ref.
      expect(input).toMatchObject({
        baseRevision: selectedTarget.baseSha,
        headRevision: selectedTarget.headSha,
      });
      return { ...workspace, target: selectedTarget };
    });

    await expect(
      module.run(
        {
          ...request,
          reviewers: [],
          selection: { kind: 'repo-map' },
        },
        { requestedBy: { actorId: 'user:operator' } },
      ),
    ).resolves.toMatchObject({ state: 'completed' });
  });

  it('rejects an actual selected-target binding mismatch without invoking an executor', async () => {
    const selectedTarget = repoMapTarget;
    const selectionResolver: ReviewSelectionResolver = {
      resolve: vi.fn(async () => ({
        kind: 'selected' as const,
        reviewers: [...request.reviewers],
        target: selectedTarget,
        routing: repoMapRouting,
      })),
    };
    const { module, execute, open, workspace } = await harness({
      selectionResolver,
    });
    open.mockImplementationOnce(async () => ({
      ...workspace,
      target: { ...selectedTarget, headSha: '7'.repeat(40) },
    }));

    await expect(
      module.run(
        {
          ...request,
          reviewers: [],
          selection: { kind: 'repo-map' },
        },
        { requestedBy: { actorId: 'user:operator' } },
      ),
    ).resolves.toMatchObject({ state: 'rejected' });
    expect(open).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it('persists content-addressed findings as evidence input with no verdict', async () => {
    const { module, project, close, execute } = await harness();
    const result = await runCompleted(module, request);

    expect(result.attachment).toEqual({ status: 'not-requested' });
    expect(result.receipt).toMatchObject({
      schemaVersion: 1,
      requestId: 'request-1',
      mode: 'initial',
      requestedBy: { actorId: 'user:operator' },
      implementer: { actorId: 'agent:terra', displayName: 'terra' },
      interpretation: {
        kind: 'review-findings',
        decision: 'input-only',
        gateVerdict: null,
      },
      executions: [
        {
          reviewerId: 'sol-1',
          actor: {
            actorId: 'agent:reviewer-agent',
            displayName: 'reviewer-agent',
          },
          status: 'completed',
        },
      ],
    });
    expect(result.receipt.receiptId).toMatch(/^[0-9a-f]{64}$/);
    expect(result.receipt.findings[0]).toMatchObject({
      reviewerId: 'sol-1',
      lensId: 'failure-totality',
      location: { file: 'src/module.ts', line: 2 },
      basis: 'reasoned-from-code',
    });
    expect(result.receipt.findings[0].findingId).toMatch(/^[0-9a-f]{64}$/);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: expect.objectContaining({ root: project }),
        prompt: expect.stringContaining(
          'Do not propose edits or make a merge decision',
        ),
      }),
    );
    expect(close).toHaveBeenCalledOnce();
    await expect(
      module.read(result.receipt.receiptId, 'station'),
    ).resolves.toEqual(result.receipt);
  });

  it('records individual reviewer failure without exposing provider detail', async () => {
    const { module } = await harness({
      outcomes: {
        'sol-1': {
          kind: 'failed',
          reason: '/Users/private/token provider exploded',
          workspaceRelease: 'safe',
        },
      },
    });
    const { receipt } = await runCompleted(module, request);
    expect(receipt.executions[0]).toMatchObject({
      status: 'failed',
      failureReason: 'The reviewer could not complete this review.',
      findings: [],
    });
    expect(JSON.stringify(receipt)).not.toContain('/Users/private');
  });

  it('retains the workspace when an executor throws after its invocation boundary', async () => {
    const { module, close, execute } = await harness();
    execute.mockRejectedValueOnce(new Error('observer failed after dispatch'));

    const result = await runCompleted(module, request);

    expect(result.receipt.executions[0]).toMatchObject({ status: 'failed' });
    expect(result.cleanup.status).toBe('retained');
    expect(close).not.toHaveBeenCalled();
  });

  it('enforces its own deadline when an executor ignores abort', async () => {
    const { module, close, execute } = await harness({ timeoutMs: 1_000 });
    execute.mockImplementationOnce(() => new Promise(() => {}));

    const result = await runCompleted(module, request);

    expect(result.receipt.executions[0]).toMatchObject({
      status: 'timed-out',
    });
    expect(result.cleanup.status).toBe('retained');
    expect(close).not.toHaveBeenCalled();
  }, 5_000);

  it('joins concurrent retries of the same durable request without reinvoking', async () => {
    const { module, execute } = await harness();
    const first = module.run(request, {
      requestedBy: { actorId: 'user:operator' },
    });
    const second = module.run(request, {
      requestedBy: { actorId: 'user:operator' },
    });

    const [left, right] = await Promise.all([first, second]);
    expect(execute).toHaveBeenCalledOnce();
    expect(left).toEqual(right);
    expect(left.state).toBe('completed');
  });

  it('requires every claimed prior finding to be assessed by every delta reviewer', async () => {
    const first = await harness();
    const prior = (await runCompleted(first.module, request)).receipt;
    const second = await harness({
      outcomes: {
        'sol-1': {
          kind: 'completed',
          workspaceRelease: 'safe',
          output: { findings: [], deltaAssessments: [] },
        },
      },
    });
    // Seed the exact prior receipt into the second project store.
    const { receiptId: _receiptId, ...priorBody } = prior;
    const seeded = await second.receipts.write(priorBody);
    second.workspace.target.baseSha = seeded.target.headSha;

    const deltaStatus = await second.module.run(
      {
        ...request,
        requestId: 'request-2',
        mode: 'delta',
        delta: {
          priorReceiptId: seeded.receiptId,
          claimedFindingIds: [seeded.findings[0].findingId],
        },
      },
      { requestedBy: { actorId: 'user:operator' } },
    );
    if (deltaStatus.state !== 'completed' || !deltaStatus.result) {
      throw (
        second.diagnostic.mock.calls[0]?.[0]?.error ??
        new Error('delta review did not complete')
      );
    }
    const result = deltaStatus.result;
    expect(result.receipt.executions[0]).toMatchObject({
      status: 'invalid-output',
      deltaAssessments: [],
    });
  });

  it('keeps still-present findings available through chained delta receipts', async () => {
    const first = await harness();
    const initial = (await runCompleted(first.module, request)).receipt;
    const originalFinding = initial.findings[0];
    const second = await harness({
      outcomes: {
        'sol-1': {
          kind: 'completed',
          workspaceRelease: 'safe',
          output: {
            findings: [],
            deltaAssessments: [
              {
                priorFindingId: originalFinding.findingId,
                outcome: 'still-present',
                explanation: 'The triggering path remains unchanged.',
              },
            ],
          },
        },
        'sol-2': {
          kind: 'completed',
          workspaceRelease: 'safe',
          output: {
            findings: [],
            deltaAssessments: [
              {
                priorFindingId: originalFinding.findingId,
                outcome: 'closed',
                explanation: 'This reviewer cannot reproduce the finding.',
              },
            ],
          },
        },
        'sol-3': {
          kind: 'failed',
          reason: 'Reviewer runtime unavailable.',
          workspaceRelease: 'safe',
        },
      },
    });
    const { receiptId: _initialId, ...initialBody } = initial;
    const seededInitial = await second.receipts.write(initialBody);
    second.workspace.target.baseSha = seededInitial.target.headSha;
    const secondStatus = await second.module.run(
      {
        ...request,
        requestId: 'request-chain-2',
        reviewers: [
          ...request.reviewers,
          {
            reviewerId: 'sol-2',
            executorAgentSlug: 'reviewer-agent-2',
            lens: {
              id: 'failure-totality',
              instructions: 'Review failure truth.',
            },
          },
          {
            reviewerId: 'sol-3',
            executorAgentSlug: 'reviewer-agent-3',
            lens: {
              id: 'failure-totality',
              instructions: 'Review failure truth.',
            },
          },
        ],
        mode: 'delta',
        delta: {
          priorReceiptId: seededInitial.receiptId,
          claimedFindingIds: [originalFinding.findingId],
        },
      },
      { requestedBy: { actorId: 'user:operator' } },
    );
    if (secondStatus.state !== 'completed' || !secondStatus.result) {
      throw new Error('first delta did not complete');
    }
    const third = await harness({
      outcomes: {
        'sol-1': {
          kind: 'completed',
          workspaceRelease: 'safe',
          output: {
            findings: [],
            deltaAssessments: [
              {
                priorFindingId: originalFinding.findingId,
                outcome: 'still-present',
                explanation: 'The original finding remains applicable.',
              },
            ],
          },
        },
      },
    });
    await third.receipts.write(initialBody);
    const { receiptId: _secondId, ...secondBody } = secondStatus.result.receipt;
    const seededSecond = await third.receipts.write(secondBody);
    third.workspace.target.baseSha = seededSecond.target.headSha;
    const thirdStatus = await third.module.run(
      {
        ...request,
        requestId: 'request-chain-3',
        mode: 'delta',
        delta: {
          priorReceiptId: seededSecond.receiptId,
          claimedFindingIds: [originalFinding.findingId],
        },
      },
      { requestedBy: { actorId: 'user:operator' } },
    );
    if (thirdStatus.state !== 'completed') {
      throw third.diagnostic.mock.calls[0]?.[0]?.error ?? thirdStatus;
    }
    expect(
      thirdStatus.state === 'completed' && thirdStatus.result?.receipt.delta,
    ).toMatchObject({ claimedFindingIds: [originalFinding.findingId] });
  });

  it('attaches the durable receipt additively and preserves it when attachment fails', async () => {
    const attach = vi.fn(async () => {
      throw new Error('flow storage unavailable');
    });
    const { module, diagnostic } = await harness({ attach });
    const result = await runCompleted(module, {
      ...request,
      flow: { runId: 'run-1', gate: 'independent-review' },
    });
    expect(result.attachment).toEqual({
      status: 'unavailable',
      reason: 'Review evidence could not be attached.',
    });
    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'attachment.attach' }),
    );
    await expect(
      module.read(result.receipt.receiptId, 'station'),
    ).resolves.toEqual(result.receipt);
  });

  it('refuses a tampered or symlink-routed receipt', async () => {
    const { module, project } = await harness();
    const { receipt } = await runCompleted(module, request);
    const path = join(
      project,
      '.station',
      'review-evidence',
      'receipts',
      `${receipt.receiptId}.json`,
    );
    const parsed = JSON.parse(
      await readFile(path, 'utf8'),
    ) as IndependentReviewReceipt;
    parsed.findings[0].summary = 'tampered';
    await writeFile(path, JSON.stringify(parsed), 'utf8');
    await expect(module.read(receipt.receiptId, 'station')).rejects.toThrow();

    const secondRoot = await mkdtemp(join(tmpdir(), 'station-review-link-'));
    roots.push(secondRoot);
    const linkedProject = join(secondRoot, 'project');
    const outside = join(secondRoot, 'outside');
    await mkdir(linkedProject, { recursive: true });
    await mkdir(outside, { recursive: true });
    await mkdir(join(linkedProject, '.station'), { recursive: true });
    await symlink(outside, join(linkedProject, '.station', 'review-evidence'));
    const store = new FileReviewReceiptStore(
      { workspace: () => linkedProject },
      { coordinationDirectory: join(secondRoot, 'coordination') },
    );
    const { receiptId: _id, ...body } = receipt;
    await expect(store.write(body)).rejects.toThrow('unsafe component');
  });

  it('fails closed before reading an unbounded cross-Project inventory', async () => {
    const list = vi.fn(async () => []);
    const module = new ReviewEvidenceModule({
      source: { open: vi.fn(async () => Promise.reject(new Error('unused'))) },
      executor: {
        workspaceAccess: 'read-only',
        execute: vi.fn(async () => ({
          kind: 'failed' as const,
          reason: 'unused',
          workspaceRelease: 'safe' as const,
        })),
      },
      receipts: {
        write: vi.fn(async () => Promise.reject(new Error('unused'))),
        read: vi.fn(async () => null),
        list,
        references: vi.fn(async () => []),
      },
      submissions: {
        begin: vi.fn(async () => ({ kind: 'acquired' as const })),
        invoking: vi.fn(async () => {}),
        complete: vi.fn(async () => Promise.reject(new Error('unused'))),
        fail: vi.fn(async () => Promise.reject(new Error('unused'))),
        status: vi.fn(async () => null),
      },
      principals: { resolveAgent: vi.fn(async () => null) },
      observer: { record: vi.fn(), diagnostic: vi.fn() },
    });

    await expect(
      module.listAll(
        Array.from({ length: 257 }, (_, index) => `project-${index}`),
      ),
    ).rejects.toThrow('Project inventory exceeds the limit');
    expect(list).not.toHaveBeenCalled();
  });

  it('loads only the bounded newest aggregate receipts after cheap reference selection', async () => {
    const read = vi.fn(async (receiptId: string, projectSlug: string) => ({
      receiptId,
      target: { projectSlug },
      completedAt: receiptId,
    }));
    const references = vi.fn(async (projectSlug: string) =>
      Array.from({ length: 256 }, (_, index) => ({
        receiptId: `${projectSlug}-${String(index).padStart(3, '0')}`,
        projectSlug,
        completedAt: `2026-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
      })),
    );
    const module = new ReviewEvidenceModule({
      source: { open: vi.fn(async () => Promise.reject(new Error('unused'))) },
      executor: {
        workspaceAccess: 'read-only',
        execute: vi.fn(async () => Promise.reject(new Error('unused'))),
      },
      receipts: {
        write: vi.fn(async () => Promise.reject(new Error('unused'))),
        read: read as never,
        list: vi.fn(async () => []),
        references,
      },
      submissions: {
        begin: vi.fn(async () => ({ kind: 'acquired' as const })),
        invoking: vi.fn(async () => {}),
        complete: vi.fn(async () => Promise.reject(new Error('unused'))),
        fail: vi.fn(async () => Promise.reject(new Error('unused'))),
        status: vi.fn(async () => null),
      },
      principals: { resolveAgent: vi.fn(async () => null) },
      observer: { record: vi.fn(), diagnostic: vi.fn() },
    });

    const result = await module.listAll(
      Array.from({ length: 256 }, (_, index) => `project-${index}`),
    );
    expect(result.receipts).toHaveLength(512);
    expect(result.unavailableProjects).toEqual([]);
    expect(references).toHaveBeenCalledTimes(256);
    expect(read).toHaveBeenCalledTimes(512);
  });

  it('aggregates readable projects and names unreadable ones instead of failing (#3303)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'station-review-totality-'));
    roots.push(root);
    const healthy = join(root, 'healthy');
    await mkdir(join(healthy, 'src'), { recursive: true });
    await writeFile(join(healthy, 'src', 'module.ts'), 'one\ntwo\n', 'utf8');
    const corrupt = join(root, 'corrupt');
    await mkdir(join(corrupt, '.station', 'review-evidence', 'receipts'), {
      recursive: true,
    });
    await writeFile(
      join(corrupt, '.station', 'review-evidence', 'receipts', 'stray.json'),
      '{}',
      'utf8',
    );
    const workspaces: Record<string, string | undefined> = {
      station: healthy,
      // A configured path that does not exist on disk (moved/deleted root).
      'gone-project': join(root, 'does-not-exist'),
      // No workingDirectory at all: a NORMAL state, silent by design.
      'no-workspace': undefined,
      'corrupt-project': corrupt,
    };
    const receipts = new FileReviewReceiptStore(
      { workspace: (slug) => workspaces[slug] },
      { coordinationDirectory: join(root, 'coordination') },
    );
    const executor: ReadOnlyReviewExecutor = {
      workspaceAccess: 'read-only',
      execute: vi.fn(async () => ({
        kind: 'completed' as const,
        workspaceRelease: 'safe' as const,
        output: { findings: [], deltaAssessments: [] },
      })),
    };
    let tick = 0;
    const module = new ReviewEvidenceModule({
      source: {
        open: vi.fn(async () => ({
          root: healthy,
          target: {
            kind: 'git-range' as const,
            projectSlug: 'station',
            baseRevision: 'base',
            headRevision: 'head',
            repositoryId: 'github.com/kontourai/station',
            baseSha: '1'.repeat(40),
            headSha: '2'.repeat(40),
            diffSha256: '3'.repeat(64),
          },
          validateLocation: async () => {},
          close: async () => {},
        })),
      },
      executor,
      receipts,
      submissions: receipts,
      principals: {
        resolveAgent: vi.fn(async (agentSlug) => ({
          actorId: `agent:${agentSlug}`,
          displayName: agentSlug,
        })),
      },
      observer: { record: vi.fn(), diagnostic: vi.fn() },
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
    });
    const { receipt } = await runCompleted(module, request);

    const aggregate = await module.listAll([
      'station',
      'gone-project',
      'no-workspace',
      'corrupt-project',
    ]);
    expect(aggregate.receipts.map((entry) => entry.receiptId)).toEqual([
      receipt.receiptId,
    ]);
    // The missing-workspace project contributes nothing and is NOT reported
    // unavailable — it is a normal configured state (flow-reviews posture).
    expect(aggregate.unavailableProjects).toEqual([
      { projectSlug: 'corrupt-project', reason: 'receipts-unreadable' },
      { projectSlug: 'gone-project', reason: 'workspace-unreadable' },
    ]);
  });

  it('reports a project whose coordination lock cannot be acquired instead of failing (#3303)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'station-review-lock-'));
    roots.push(root);
    const healthy = join(root, 'healthy');
    const locked = join(root, 'locked');
    await mkdir(healthy, { recursive: true });
    await mkdir(locked, { recursive: true });
    const lockAcquisitions: Array<{ path: string; timeoutMs?: number }> = [];
    const receipts = new FileReviewReceiptStore(
      {
        workspace: (slug) =>
          slug === 'station' ? healthy : slug === 'locked' ? locked : undefined,
      },
      {
        coordinationDirectory: join(root, 'coordination'),
        acquireLock: async (path: string, options?: { timeoutMs?: number }) => {
          lockAcquisitions.push({ path, timeoutMs: options?.timeoutMs });
          if (path.includes(lockIdentityFor(locked))) {
            throw new Error('lifecycle journal lock is held by a live process');
          }
          return async () => {};
        },
      },
    );
    const module = new ReviewEvidenceModule({
      source: { open: vi.fn(async () => Promise.reject(new Error('unused'))) },
      executor: {
        workspaceAccess: 'read-only',
        execute: vi.fn(async () => Promise.reject(new Error('unused'))),
      },
      receipts,
      submissions: receipts,
      principals: { resolveAgent: vi.fn(async () => null) },
      observer: { record: vi.fn(), diagnostic: vi.fn() },
    });

    const aggregate = await module.listAll(['station', 'locked']);
    expect(aggregate.receipts).toEqual([]);
    expect(aggregate.unavailableProjects).toEqual([
      { projectSlug: 'locked', reason: 'lock-unavailable' },
    ]);
    // The read path degrades sooner than the mutation deadline: every
    // aggregate-read acquisition carries the bounded read timeout.
    expect(lockAcquisitions.length).toBeGreaterThan(0);
    for (const acquisition of lockAcquisitions) {
      expect(acquisition.timeoutMs).toBe(2_500);
    }
  });

  it('treats a workspace that vanishes between reference read and receipt read as normal, not unavailable', async () => {
    const reference = {
      receiptId: 'a'.repeat(64),
      projectSlug: 'vanishing',
      completedAt: '2026-01-01T00:00:00.000Z',
    };
    const module = new ReviewEvidenceModule({
      source: { open: vi.fn(async () => Promise.reject(new Error('unused'))) },
      executor: {
        workspaceAccess: 'read-only',
        execute: vi.fn(async () => Promise.reject(new Error('unused'))),
      },
      receipts: {
        write: vi.fn(async () => Promise.reject(new Error('unused'))),
        read: vi.fn(async () => {
          throw new ReviewProjectWorkspaceMissingError('vanishing');
        }),
        list: vi.fn(async () => []),
        references: vi.fn(async () => [reference]),
      },
      submissions: {
        begin: vi.fn(async () => ({ kind: 'acquired' as const })),
        invoking: vi.fn(async () => {}),
        complete: vi.fn(async () => Promise.reject(new Error('unused'))),
        fail: vi.fn(async () => Promise.reject(new Error('unused'))),
        status: vi.fn(async () => null),
      },
      principals: { resolveAgent: vi.fn(async () => null) },
      observer: { record: vi.fn(), diagnostic: vi.fn() },
    });

    const aggregate = await module.listAll(['vanishing']);
    expect(aggregate.receipts).toEqual([]);
    expect(aggregate.unavailableProjects).toEqual([]);
  });
});

function lockIdentityFor(workspacePath: string): string {
  const identity = statSync(workspacePath);
  return createHash('sha256')
    .update(`${realpathSync(workspacePath)}\0${identity.dev}\0${identity.ino}`)
    .digest('hex');
}

async function runCompleted(module: ReviewEvidenceModule, value: unknown) {
  const status = await module.run(value, {
    requestedBy: { actorId: 'user:operator' },
  });
  expect(status.state).toBe('completed');
  if (status.state !== 'completed' || !status.result) {
    throw new Error('expected completed review status');
  }
  return status.result;
}
