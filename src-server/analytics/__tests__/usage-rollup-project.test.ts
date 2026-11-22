/**
 * #5068: Project usage. Usage for two Tasks in one Project sums to the
 * Project total, and the coordinator's share (the Project's own Sessions,
 * no Task) is its own row. Another Project's usage never joins it.
 */

import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import {
  projectUsageTotals,
  type UsageReceipt,
} from '@kontourai/station-contracts/usage-rollup';
import { describe, expect, test } from 'vitest';
import {
  type UsageReceiptSource,
  UsageRollupService,
} from '../usage-rollup-service.js';

const receipt = (
  id: string,
  overrides: Partial<UsageReceipt> = {},
): UsageReceipt => ({
  id,
  stationId: 'local',
  provider: 'claude',
  model: 'opus',
  occurredAt: '2026-11-10T00:00:00.000Z',
  observedAt: '2026-11-10T00:00:00.000Z',
  inputTokens: 100,
  outputTokens: 10,
  pricing: { status: 'unpriced' },
  ...overrides,
});

const RECEIPTS: UsageReceipt[] = [
  receipt('coordinator', { projectSlug: 'export' }),
  receipt('task-a-1', { projectSlug: 'export', taskId: 'task-a' }),
  receipt('task-a-2', {
    projectSlug: 'export',
    taskId: 'task-a',
    model: 'sonnet',
    inputTokens: 40,
    outputTokens: 4,
  }),
  receipt('task-b', { projectSlug: 'export', taskId: 'task-b' }),
  receipt('other-project', { projectSlug: 'billing', taskId: 'task-z' }),
  receipt('no-project'),
];

const source: UsageReceiptSource = {
  stationId: 'local',
  async read(request) {
    return {
      receipts: RECEIPTS,
      aggregateReceipts: RECEIPTS,
      coverage: {
        stationId: 'local',
        state: 'complete',
        window: { from: request.from, to: request.to },
      },
    };
  },
};

const authority = sessionReadAuthorityFromRequest(
  'human:local:operator',
  undefined,
  undefined,
);

describe('Project usage rollup', () => {
  const read = (groupBy: 'task' | 'model' | 'project', projectSlug?: string) =>
    new UsageRollupService([source]).read(
      {
        from: '2026-11-01',
        to: '2026-11-30',
        groupBy,
        pageSize: 100,
        ...(projectSlug ? { projectSlug } : {}),
      },
      authority,
    );

  test('two Tasks and the coordinator sum to the Project total', async () => {
    const byProject = await read('project');
    const exportRow = byProject.rows.find(
      (row) => row.projectSlug === 'export',
    );
    expect(exportRow).toMatchObject({ inputTokens: 340, outputTokens: 34 });

    const byTask = await read('task', 'export');
    expect(
      byTask.rows.map((row) => row.taskId ?? 'coordinator').sort(),
    ).toEqual(['coordinator', 'task-a', 'task-b']);
    const totals = projectUsageTotals(byTask.rows);
    expect(totals.total).toBe(
      exportRow!.inputTokens! + exportRow!.outputTokens!,
    );
    expect(totals.coordinator).toBe(110);
  });

  test("by model stays inside the Project, and another Project's usage never joins it", async () => {
    const byModel = await read('model', 'export');
    expect(
      Object.fromEntries(
        byModel.rows.map((row) => [row.model, row.inputTokens]),
      ),
    ).toEqual({ opus: 300, sonnet: 40 });
    const billing = await read('task', 'billing');
    expect(billing.rows.map((row) => row.taskId)).toEqual(['task-z']);
  });
});
