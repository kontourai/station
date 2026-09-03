import { beforeEach, describe, expect, test, vi } from 'vitest';

const authenticatedFetch = vi.hoisted(() => vi.fn());
vi.mock('@kontourai/station-sdk', () => ({ authenticatedFetch }));
vi.mock('@kontourai/station-shared/random-id', () => ({
  randomCorrelationId: () => 'request-a',
}));

import {
  authorizePluginPaletteCommand,
  PluginCommandExecutionError,
} from '../plugin-command-execution';

const input = {
  pluginId: 'demo-plugin',
  pluginVersion: '1.0.0',
  commandGeneration: 'a'.repeat(64),
  commandId: 'demo-plugin.review',
  target: { kind: 'composer' as const, sessionId: 'session-a' },
  context: {
    activeChatSessionId: 'session-a',
    sessionId: 'session-a',
  },
};

beforeEach(() => authenticatedFetch.mockReset());

describe('plugin command execution client', () => {
  test('returns only an exact host receipt and sends no composer content', async () => {
    authenticatedFetch.mockResolvedValue(
      Response.json({
        success: true,
        receipt: {
          schemaVersion: 'station.plugin-command-execution/v1',
          receiptId: 'receipt-a',
          requestId: 'request-a',
          ...input,
          actor: { kind: 'operator' },
          reportedSurface: 'web',
          decision: 'authorized',
          outcome: 'admitted',
          recordedAt: '2026-09-03T00:00:00.000Z',
        },
      }),
    );

    await expect(
      authorizePluginPaletteCommand('http://station.test', input),
    ).resolves.toMatchObject({ receiptId: 'receipt-a' });
    const request = authenticatedFetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      schemaVersion: 'station.plugin-command-execution/v1',
      requestId: 'request-a',
      ...input,
    });
    expect(String(request.body)).not.toContain('prompt');
    expect(JSON.parse(String(request.body))).not.toHaveProperty('text');
  });

  test('rejects a receipt for a different installed generation', async () => {
    authenticatedFetch.mockResolvedValue(
      Response.json({
        success: true,
        receipt: {
          schemaVersion: 'station.plugin-command-execution/v1',
          receiptId: 'receipt-a',
          requestId: 'request-a',
          ...input,
          commandGeneration: 'b'.repeat(64),
          decision: 'authorized',
          outcome: 'admitted',
        },
      }),
    );

    await expect(
      authorizePluginPaletteCommand('http://station.test', input),
    ).rejects.toBeInstanceOf(PluginCommandExecutionError);
  });
});
