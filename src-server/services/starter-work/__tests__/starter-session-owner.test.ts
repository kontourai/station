/**
 * #2493: Starter Work's continue-session owner adopts through the same
 * `adoptSession` command `/commands` dispatches. The launching request's
 * full-access grant must reach that dispatch's context, where
 * `OrchestrationService` stamps the adopted child `host` only with it
 * (pinned in orchestration-service.test.ts, "#2493 Q2").
 */
import { describe, expect, test, vi } from 'vitest';
import { fullAccessGrantForTesting } from '../../../security/coding-authority.js';
import { createStarterSessionOwner } from '../starter-session-owner.js';

function orchestration() {
  const dispatchWithReceipt = vi.fn(async () => ({
    receipt: { commandId: 'receipt-1' },
    result: { threadId: 'adopted-child', controlMode: 'station-owned' },
  }));
  return {
    dispatchWithReceipt,
    owner: createStarterSessionOwner({
      readSession: vi.fn(),
      dispatchWithReceipt,
    } as never),
  };
}

describe('createStarterSessionOwner (#2493)', () => {
  test("an unverified agent's launch carries its unattributed marker to the adoption", async () => {
    const { dispatchWithReceipt, owner } = orchestration();
    await owner.continue({
      sourceSessionId: 'attached',
      operationId: 'op-3',
      fullAccessGrant: null,
      owner: {
        ownerUserId: 'human:local:operator',
        ownerAttribution: 'unattributed-agent',
      },
    });
    expect((dispatchWithReceipt.mock.calls[0] as unknown[])[1]).toEqual({
      userId: 'human:local:operator',
      ownerAttribution: 'unattributed-agent',
    });
  });

  test("a grant reaches the adoption dispatch's context", async () => {
    const { dispatchWithReceipt, owner } = orchestration();
    const grant = fullAccessGrantForTesting();
    await expect(
      owner.continue({
        sourceSessionId: 'attached',
        operationId: 'op-1',
        fullAccessGrant: grant,
        owner: { ownerUserId: 'human:device:phone' },
      }),
    ).resolves.toMatchObject({ state: 'continued' });
    expect(dispatchWithReceipt).toHaveBeenCalledWith(
      {
        type: 'adoptSession',
        sourceThreadId: 'attached',
        idempotencyKey: 'op-1',
      },
      { userId: 'human:device:phone', fullAccessGrant: grant },
    );
  });

  test('no grant carries only the caller, so the child is workspace and owned by it', async () => {
    const { dispatchWithReceipt, owner } = orchestration();
    await owner.continue({
      sourceSessionId: 'attached',
      operationId: 'op-2',
      fullAccessGrant: null,
      owner: { ownerUserId: 'human:device:phone' },
    });
    // The caller authorizes the source and owns the child; without it the
    // child would record no owner and be readable by no caller.
    expect(dispatchWithReceipt).toHaveBeenCalledTimes(1);
    expect(dispatchWithReceipt.mock.calls[0]).toEqual([
      expect.objectContaining({ type: 'adoptSession' }),
      { userId: 'human:device:phone' },
    ]);
  });
});
