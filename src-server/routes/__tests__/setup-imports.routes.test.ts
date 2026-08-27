import { describe, expect, test, vi } from 'vitest';
import { createSetupImportRoutes } from '../setup-imports.js';

describe('setup import routes', () => {
  test('refuses non-operators before any source filesystem access', async () => {
    const module = { sources: vi.fn(async () => []) };
    const app = createSetupImportRoutes(module as never, {
      operatorIdentityForRequest: () => undefined,
    });
    const response = await app.request('/sources');
    expect(response.status).toBe(403);
    expect(module.sources).not.toHaveBeenCalled();
  });

  test('permits only operator authority to reach the local module', async () => {
    const module = {
      sources: vi.fn(async () => [{ id: 'codex-prompts', available: false }]),
    };
    const app = createSetupImportRoutes(module as never, {
      operatorIdentityForRequest: () => 'operator',
    });
    const response = await app.request('/sources');
    expect(response.status).toBe(200);
    expect(module.sources).toHaveBeenCalledOnce();
  });

  test('passes the canonical itemized receipt through every receipt route', async () => {
    const receipt = {
      id: 'receipt-1',
      createdAt: 'now',
      previewId: 'preview-1',
      retryable: true,
      items: [
        {
          sourceId: 'review.md:abc',
          reviewedTarget: 'review',
          state: 'applied',
          outcome: 'imported',
          targetRevision: 'a'.repeat(64),
          rollback: { state: 'available', retryable: true },
        },
      ],
    };
    const module = {
      receipt: vi.fn(async () => receipt),
      rollback: vi.fn(async () => receipt),
    };
    const app = createSetupImportRoutes(module as never, {
      operatorIdentityForRequest: () => 'operator',
    });

    await expect(
      (await app.request('/receipts/receipt-1')).json(),
    ).resolves.toEqual({
      success: true,
      data: receipt,
    });
    await expect(
      (
        await app.request('/receipts/receipt-1/rollback', { method: 'POST' })
      ).json(),
    ).resolves.toEqual({ success: true, data: receipt });
    expect(module.receipt).toHaveBeenCalledWith('receipt-1');
    expect(module.rollback).toHaveBeenCalledWith('receipt-1');
  });

  test('hosted composition rejects even an operator before the module can touch local state', async () => {
    const module = { sources: vi.fn(async () => []) };
    const app = createSetupImportRoutes(module as never, {
      operatorIdentityForRequest: () => 'operator-credential',
      isHostedExecution: () => true,
    });
    const response = await app.request('/sources');
    expect(response.status).toBe(404);
    expect(module.sources).not.toHaveBeenCalled();
  });
});
