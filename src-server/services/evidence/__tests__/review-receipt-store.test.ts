import {
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  IndependentReviewReceipt,
  IndependentReviewRequest,
} from '@kontourai/station-contracts/review-evidence';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileReviewReceiptStore } from '../review-receipt-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

function receiptBody(
  requestId: string,
  completedAt = '2026-08-16T00:00:01.000Z',
): Omit<IndependentReviewReceipt, 'receiptId'> {
  return {
    schemaVersion: 1,
    requestId,
    mode: 'initial',
    target: {
      kind: 'git-range',
      projectSlug: 'station',
      baseRevision: 'main~1',
      headRevision: 'main',
      repositoryId: 'station',
      baseSha: '1'.repeat(40),
      headSha: '2'.repeat(40),
      diffSha256: '3'.repeat(64),
    },
    requestedBy: { actorId: 'operator' },
    implementer: { actorId: 'implementer' },
    startedAt: '2026-08-16T00:00:00.000Z',
    completedAt,
    executions: [
      {
        reviewerId: 'reviewer-1',
        executorAgentSlug: 'station',
        actor: { actorId: 'sol' },
        lens: { id: 'architecture', instructions: 'Review module seams.' },
        status: 'completed',
        startedAt: '2026-08-16T00:00:00.000Z',
        completedAt: '2026-08-16T00:00:01.000Z',
        findings: [],
        deltaAssessments: [],
      },
    ],
    findings: [],
    deltaAssessments: [],
    interpretation: {
      kind: 'review-findings',
      decision: 'input-only',
      gateVerdict: null,
    },
  };
}

function reviewRequest(requestId: string): IndependentReviewRequest {
  return {
    requestId,
    mode: 'initial',
    target: {
      kind: 'git-range',
      projectSlug: 'station',
      baseRevision: 'main~1',
      headRevision: 'main',
    },
    implementerAgentSlug: 'terra',
    reviewers: [
      {
        reviewerId: 'reviewer-1',
        executorAgentSlug: 'sol',
        lens: { id: 'architecture', instructions: 'Review module seams.' },
      },
    ],
  };
}

describe('FileReviewReceiptStore', () => {
  it('atomically joins duplicate writers and fails admission before pruning evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'station-review-receipts-'));
    roots.push(root);
    const store = new FileReviewReceiptStore(
      { workspace: (slug) => (slug === 'station' ? root : undefined) },
      {
        maxReceiptsPerProject: 2,
        coordinationDirectory: join(root, 'coordination'),
      },
    );

    const [left, right] = await Promise.all([
      store.write(receiptBody('request-one')),
      store.write(receiptBody('request-one')),
    ]);
    expect(right.receiptId).toBe(left.receiptId);

    const second = await store.write(
      receiptBody('request-two', '2026-08-16T00:00:02.000Z'),
    );
    await expect(store.write(receiptBody('request-three'))).rejects.toThrow(
      'capacity is exhausted by protected evidence',
    );
    expect(
      (await store.list('station')).map((receipt) => receipt.receiptId),
    ).toEqual([second.receiptId, left.receiptId]);
    expect(await store.read(left.receiptId, 'station')).toEqual(left);

    const directory = join(root, '.station', 'review-evidence', 'receipts');
    expect(
      (await readdir(directory)).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });

  it('fails closed when the protected receipt inventory is malformed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'station-review-receipts-'));
    roots.push(root);
    const store = new FileReviewReceiptStore(
      { workspace: () => root },
      {
        maxReceiptsPerProject: 2,
        coordinationDirectory: join(root, 'coordination'),
      },
    );
    await store.write(receiptBody('request-one'));
    await writeFile(
      join(root, '.station', 'review-evidence', 'receipts', 'not-an-id.json'),
      '{}',
      'utf8',
    );

    await expect(store.list('station')).rejects.toThrow(
      'contains an invalid entry',
    );
  });

  it('retains committed receipt truth when lock release observation throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'station-review-receipts-'));
    roots.push(root);
    const diagnostic = vi.fn();
    const store = new FileReviewReceiptStore(
      { workspace: () => root },
      {
        coordinationDirectory: join(root, 'coordination'),
        acquireLock: async (path, options) => {
          const release = await acquireFileMutationLockAsync(path, options);
          return async () => {
            await release();
            throw new Error('release observer failed after commit');
          };
        },
        diagnostic,
      },
    );

    const written = await store.write(receiptBody('release-fault'));
    await expect(store.read(written.receiptId, 'station')).resolves.toEqual(
      written,
    );
    expect(diagnostic).toHaveBeenCalledWith('lock.release', expect.any(Error));
  });

  it('refuses publication when the Project root is replaced before commit', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'station-review-root-swap-'));
    roots.push(parent);
    const root = join(parent, 'project');
    const outside = join(parent, 'outside');
    await mkdir(root);
    await mkdir(outside);
    let swapped = false;
    const store = new FileReviewReceiptStore(
      { workspace: () => root },
      {
        coordinationDirectory: join(parent, 'coordination'),
        beforeReceiptCommit: async () => {
          if (swapped) return;
          swapped = true;
          await rename(root, `${root}.original`);
          await symlink(outside, root);
        },
      },
    );

    await expect(store.write(receiptBody('root-swap'))).rejects.toThrow('root');
    expect(await readdir(outside)).toEqual([]);
  });

  it('persists an invocation fence and reconciles a lost same-owner execution as indeterminate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'station-review-requests-'));
    roots.push(root);
    const options = { coordinationDirectory: join(root, 'coordination') };
    const store = new FileReviewReceiptStore(
      { workspace: () => root },
      options,
    );
    const request = reviewRequest('idempotent-request');
    await expect(
      store.begin({ request, startedAt: '2026-08-16T00:00:00.000Z' }),
    ).resolves.toEqual({ kind: 'acquired' });
    await store.invoking({
      request,
      updatedAt: '2026-08-16T00:00:00.500Z',
    });
    await expect(
      store.status(request.requestId, 'station', true),
    ).resolves.toMatchObject({ state: 'running' });
    await expect(
      store.begin({ request, startedAt: '2026-08-16T00:00:01.000Z' }),
    ).resolves.toMatchObject({
      kind: 'existing',
      status: { state: 'indeterminate', requestId: request.requestId },
    });
  });

  it('recovers an exact completed request and refuses identity reuse', async () => {
    const root = await mkdtemp(join(tmpdir(), 'station-review-requests-'));
    roots.push(root);
    const options = { coordinationDirectory: join(root, 'coordination') };
    const store = new FileReviewReceiptStore(
      { workspace: () => root },
      options,
    );
    const request = reviewRequest('idempotent-request');
    await store.begin({ request, startedAt: '2026-08-16T00:00:00.000Z' });
    await store.invoking({
      request,
      updatedAt: '2026-08-16T00:00:00.500Z',
    });

    const receipt = await store.write(receiptBody(request.requestId));
    await store.complete({
      request,
      completedAt: receipt.completedAt,
      result: {
        receipt,
        attachment: { status: 'not-requested' },
        cleanup: { status: 'completed' },
      },
    });
    const reopened = new FileReviewReceiptStore(
      { workspace: () => root },
      options,
    );
    await expect(
      reopened.status(request.requestId, 'station'),
    ).resolves.toMatchObject({
      state: 'completed',
      result: { receipt: { receiptId: receipt.receiptId } },
    });
    await expect(
      reopened.begin({
        request: {
          ...request,
          target: { ...request.target, headRevision: 'different' },
        },
        startedAt: '2026-08-16T00:00:02.000Z',
      }),
    ).rejects.toThrow('identity collision');
  });

  it('persists the exact server-owned NOT_VERIFIED reason across a new store instance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'station-review-requests-'));
    roots.push(root);
    const options = { coordinationDirectory: join(root, 'coordination') };
    const store = new FileReviewReceiptStore(
      { workspace: () => root },
      options,
    );
    const request = reviewRequest('repo-map-policy');
    const reason = 'Review routing policy changed in the candidate.';
    await store.begin({ request, startedAt: '2026-08-16T00:00:00.000Z' });
    await store.fail({
      request,
      state: 'not-verified',
      updatedAt: '2026-08-16T00:00:01.000Z',
      unavailableLenses: ['human-review'],
      failureReason: reason,
    });

    const reopened = new FileReviewReceiptStore(
      { workspace: () => root },
      options,
    );
    await expect(
      reopened.status(request.requestId, 'station'),
    ).resolves.toMatchObject({
      state: 'not-verified',
      failureReason: reason,
      unavailableLenses: ['human-review'],
    });
  });

  it('fails admission when durable request evidence reaches its bound', async () => {
    const root = await mkdtemp(join(tmpdir(), 'station-review-requests-'));
    roots.push(root);
    const store = new FileReviewReceiptStore(
      { workspace: () => root },
      {
        maxReceiptsPerProject: 2,
        coordinationDirectory: join(root, 'coordination'),
      },
    );
    await store.begin({
      request: reviewRequest('request-one'),
      startedAt: '2026-08-16T00:00:00.000Z',
    });
    await store.begin({
      request: reviewRequest('request-two'),
      startedAt: '2026-08-16T00:00:01.000Z',
    });

    await expect(
      store.begin({
        request: reviewRequest('request-three'),
        startedAt: '2026-08-16T00:00:02.000Z',
      }),
    ).rejects.toThrow('capacity is exhausted by protected evidence');
  });
});
