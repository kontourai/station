import { describe, expect, test, vi } from 'vitest';
import {
  beginActionOperationTracking,
  handoffActionOperationId,
} from '../action-operation-tracker.js';

const actor = { accountId: 'account-a' };
const operation = {
  id: 'operation-a',
  scope: { accountId: 'account-a' },
  title: 'Fork conversation',
  cancellation: 'unsupported' as const,
  domain: {
    kind: 'conversation-fork' as const,
    sourceConversationId: 'source-a',
    targetConversationId: 'target-a',
  },
  reentry: {
    kind: 'conversation' as const,
    agentId: 'codex',
    conversationId: 'target-a',
  },
};

describe('action operation tracker isolation', () => {
  test('admission failure does not escape into the domain mutation', async () => {
    const logger = { warn: vi.fn() };
    await expect(
      beginActionOperationTracking({
        service: {
          create: vi.fn().mockRejectedValue(new Error('store unavailable')),
          update: vi.fn(),
        } as never,
        actor,
        operation,
        logger,
      }),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      'Action operation admission unavailable',
      expect.objectContaining({ error: 'store unavailable' }),
    );
  });

  test('running and terminal publication failures are observations, not domain failures', async () => {
    const logger = { warn: vi.fn() };
    const service = {
      create: vi.fn().mockResolvedValue({ id: 'operation-a', revision: 1 }),
      update: vi
        .fn()
        .mockRejectedValueOnce(new Error('running publish failed'))
        .mockRejectedValueOnce(new Error('terminal publish failed')),
    };
    const tracker = await beginActionOperationTracking({
      service: service as never,
      actor,
      operation,
      logger,
    });
    await expect(
      tracker?.update({
        status: 'running',
        progress: { kind: 'phase', code: 'preparing' },
      }),
    ).resolves.toBeUndefined();
    await expect(
      tracker?.update({ status: 'succeeded' }),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  test('handoff ids are stable for one canonical adoption coordinate', () => {
    const first = handoffActionOperationId({
      accountId: 'account-a',
      sourceSessionId: 'source-a',
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
    });
    expect(
      handoffActionOperationId({
        accountId: 'account-a',
        sourceSessionId: 'source-a',
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
      }),
    ).toBe(first);
    expect(
      handoffActionOperationId({
        accountId: 'account-a',
        sourceSessionId: 'source-a',
        idempotencyKey: '22222222-2222-4222-8222-222222222222',
      }),
    ).not.toBe(first);
  });
});
