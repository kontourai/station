import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attentionCountForProject,
  attentionProjectCounts,
} from '@kontourai/station-contracts/attention';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { AttentionProjectionService } from '../attention-projection.js';
import { ProposedChangeService } from '../proposed-change-service.js';

/**
 * #2064 (D4): the project row's "1 needs you" is DERIVED from the attention
 * projection's own items, never a number a producer wrote down.
 *
 * This drives the real `ProposedChangeService` over a real store directory
 * rather than a stubbed `list`, because the property under test is exactly
 * that the count follows the SOURCE: adding a change to the store raises it,
 * deciding that change lowers it, and nothing in between records a count that
 * could be left stale. A fixture array standing in for the store would prove
 * the mapping and not the derivation.
 */
describe('per-project attention counts', () => {
  let dir: string;
  let changes: ProposedChangeService;
  let projection: AttentionProjectionService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'attention-counts-'));
    changes = new ProposedChangeService(dir);
    projection = new AttentionProjectionService(
      { list: () => [] } as never,
      {
        listSessionReadModel: async () => [],
        readSessionFlowRun: async () => null,
        readSession: async () => ({ session: {} as never, events: [] }),
      } as never,
      { getRunConsole: async () => ({ gates: [] }) } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      changes,
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function proposeChange(projectId: string, path: string) {
    return changes.create({
      sessionId: 'thread-1',
      projectId,
      path,
      changeType: 'modify',
      contentKind: 'code',
      sourceRuntime: 'claude',
      proposedSnapshot: { content: 'after' },
    });
  }

  test('a count is zero until a source item exists, rises with it, and falls when it is decided', async () => {
    expect(
      attentionCountForProject((await projection.list()).items, 'campfit'),
    ).toBe(0);

    const change = await proposeChange('campfit', 'src/index.ts');
    expect(
      attentionCountForProject((await projection.list()).items, 'campfit'),
    ).toBe(1);

    await proposeChange('campfit', 'src/other.ts');
    expect(
      attentionCountForProject((await projection.list()).items, 'campfit'),
    ).toBe(2);

    // Decided at the SOURCE, through the same service the inbox's Approve
    // posts to. Nothing tells the projection; it stops projecting because the
    // change is no longer pending.
    await changes.approve(change.id, { reason: 'Approved from notifications' });
    expect(
      attentionCountForProject((await projection.list()).items, 'campfit'),
    ).toBe(1);
  });

  /**
   * An acknowledged item leaves the per-project count for the same reason it
   * leaves the bell — one predicate, read in both places.
   *
   * Driven with `session-failed`, the kind acknowledgement exists for, and
   * deliberately NOT with a proposed change: #2064 (a) refuses that ack
   * outright (a pending decision resolves by being decided), and the refusal
   * has its own test in `attention-projection.test.ts`. Asserting this
   * property through a kind the server now refuses would have tested the
   * refusal twice and this property not at all.
   */
  test('an acknowledged item leaves the project count, exactly as it leaves the bell', async () => {
    const acknowledged = new Map<string, string>();
    const failedSession = {
      threadId: 'thread-failed',
      createdAt: '2026-09-13T12:00:00.000Z',
      updatedAt: '2026-09-13T12:00:00.000Z',
      provider: 'test',
      status: 'idle',
      lifecycleState: 'failed',
      projectSlug: 'campfit',
      answerability: { answerable: false },
    };
    const acknowledging = new AttentionProjectionService(
      { list: () => [] } as never,
      {
        listSessionReadModel: async () => [failedSession],
        readSessionFlowRun: async () => null,
        readSession: async () => ({ session: {} as never, events: [] }),
      } as never,
      { getRunConsole: async () => ({ gates: [] }) } as never,
      undefined,
      {
        getMany: () => acknowledged,
        acknowledge: ({ conversationId, updatedAt }) =>
          void acknowledged.set(conversationId, updatedAt),
      },
      undefined,
      undefined,
      undefined,
      changes,
    );
    // The failed session and one pending change, both in campfit.
    await proposeChange('campfit', 'src/index.ts');
    expect(
      attentionCountForProject((await acknowledging.list()).items, 'campfit'),
    ).toBe(2);

    expect(
      await acknowledging.acknowledge('session-failed:thread-failed'),
    ).toBe(true);
    const { items, pendingCount } = await acknowledging.list();
    // Still projected — acknowledgement is history, not deletion — and out of
    // BOTH counts, because they read one predicate.
    expect(
      items.some((item) => item.id === 'session-failed:thread-failed'),
    ).toBe(true);
    expect(attentionCountForProject(items, 'campfit')).toBe(1);
    expect(pendingCount).toBe(1);
  });

  test("one project's items never count toward another's, and the bell counts both", async () => {
    await proposeChange('campfit', 'src/index.ts');
    await proposeChange('ferry', 'src/main.ts');
    await proposeChange('ferry', 'src/router.ts');

    const { items, pendingCount } = await projection.list();
    expect(attentionCountForProject(items, 'campfit')).toBe(1);
    expect(attentionCountForProject(items, 'ferry')).toBe(2);
    expect(attentionCountForProject(items, 'thread')).toBe(0);
    // The bell's own number, over the same array — three pending decisions.
    expect(pendingCount).toBe(3);
    expect([...attentionProjectCounts(items).entries()].sort()).toEqual([
      ['campfit', 1],
      ['ferry', 2],
    ]);
  });
});
