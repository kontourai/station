import type { Notification } from '@kontourai/station-contracts/notification';
import type { IndependentReviewReceipt } from '@kontourai/station-contracts/review-evidence';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createStarterOwnerAdapter } from '../starter-owner-adapter.js';

const approval = (
  id: string,
  createdAt: string,
  source = 'approval-inbox',
  status: Notification['status'] = 'delivered',
): Notification => ({
  id,
  source,
  category: 'approval-request',
  title: 'Approval',
  priority: 'high',
  status,
  createdAt,
  updatedAt: createdAt,
});

const receipt = (receiptId: string, projectSlug: string, completedAt: string) =>
  ({
    receiptId,
    completedAt,
    target: { projectSlug },
  }) as IndependentReviewReceipt;

const deps = () => ({
  approvals: {
    list: vi.fn<() => Promise<Notification[]>>(),
    observe: vi.fn(),
  },
  runs: { readRun: vi.fn() },
  reviews: { read: vi.fn(), listAll: vi.fn() },
  authority: sessionReadAuthorityFromRequest('u', undefined, undefined),
});

describe('starter owner adapter', () => {
  beforeEach(() => vi.restoreAllMocks());

  test('selects the oldest exact open inbox approval and rejects generic rows', async () => {
    const d = deps();
    d.approvals.list.mockResolvedValue([
      approval('newer', '2026-08-24T01:00:00.000Z'),
      approval(
        'dismissed',
        '2026-08-22T00:00:00.000Z',
        'approval-inbox',
        'dismissed',
      ),
      approval('synthetic', '2026-08-23T00:00:00.000Z', 'generic-api'),
      approval('older', '2026-08-24T00:00:00.000Z'),
    ]);
    d.approvals.observe.mockReturnValue({ state: 'open' });
    await expect(
      createStarterOwnerAdapter(d).candidate('approval'),
    ).resolves.toEqual({
      state: 'current',
      reference: { kind: 'approval', id: 'older' },
    });
    expect(d.approvals.observe).toHaveBeenCalledTimes(2);
  });

  test.each(['resolved', 'expired'] as const)(
    'projects an owner-confirmed %s approval without leaking its private target',
    async (state) => {
      const d = deps();
      d.approvals.list.mockResolvedValue([
        approval('notification-1', '2026-08-24T00:00:00.000Z'),
      ]);
      d.approvals.observe.mockReturnValue({ state });
      await expect(
        createStarterOwnerAdapter(d).resolve({
          kind: 'approval',
          id: 'notification-1',
        }),
      ).resolves.toEqual({ state: 'current', completion: state });
    },
  );

  test('selects newest review evidence and reads its exact receipt/project tuple', async () => {
    const d = deps();
    d.reviews.listAll.mockResolvedValue({
      receipts: [
        receipt('older', 'alpha', '2026-08-23T00:00:00.000Z'),
        receipt('newer', 'bravo', '2026-08-24T00:00:00.000Z'),
      ],
      unavailableProjects: [],
    });
    d.reviews.read.mockResolvedValue(
      receipt('newer', 'bravo', '2026-08-24T00:00:00.000Z'),
    );
    const adapter = createStarterOwnerAdapter(d);
    await expect(adapter.candidate('receipt')).resolves.toEqual({
      state: 'current',
      reference: {
        kind: 'receipt',
        owner: 'independent-review',
        id: 'newer',
        projectSlug: 'bravo',
      },
    });
    await expect(
      adapter.resolve({
        kind: 'receipt',
        owner: 'independent-review',
        id: 'newer',
        projectSlug: 'bravo',
      }),
    ).resolves.toEqual({
      state: 'current',
      completion: 'receipt-present',
    });
    expect(d.reviews.read).toHaveBeenCalledWith('newer', 'bravo');
  });

  test('requires a scheduler-owned run for a scheduler receipt', async () => {
    const d = deps();
    d.runs.readRun.mockResolvedValue({ source: 'orchestration' });
    await expect(
      createStarterOwnerAdapter(d).resolve({
        kind: 'receipt',
        owner: 'scheduler-run',
        id: 'schedule:run-1',
      }),
    ).resolves.toEqual({ state: 'stale' });
    expect(d.runs.readRun).toHaveBeenCalledWith('schedule:run-1', d.authority);
  });

  test.each([
    { status: 'running', expected: 'running' },
    { status: 'completed', expected: 'completed' },
    { status: 'failed', expected: 'failed' },
    {
      status: 'failed',
      failureKind: 'unknown',
      expected: 'indeterminate',
    },
  ] as const)(
    'derives Scheduler $status without parsing output',
    async (input) => {
      const d = deps();
      d.runs.readRun.mockResolvedValue({
        source: 'schedule',
        status: input.status,
        ...(input.failureKind ? { failureKind: input.failureKind } : {}),
      });
      await expect(
        createStarterOwnerAdapter(d).resolve({
          kind: 'receipt',
          owner: 'scheduler-run',
          id: 'schedule:built-in:station-starter-check:run-1',
        }),
      ).resolves.toEqual({
        state: 'current',
        completion: input.expected,
      });
    },
  );
});
