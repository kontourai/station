import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  applyExistingSetupImport,
  createExistingSetupImportPreview,
  detectExistingSetupImportSources,
  fetchExistingSetupImportReceipt,
  reviewExistingSetupImportTargets,
  rollbackExistingSetupImport,
} from '../client/setup-imports';

describe('existing setup import client', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('owns the exact content-free route vocabulary and apply body', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          data: [{ id: 'codex-prompts', available: true }],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          data: {
            id: 'preview-1',
            createdAt: 'now',
            expiresAt: 'later',
            entries: [],
            excluded: {},
            warnings: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          data: {
            preview: {
              id: 'preview-1',
              createdAt: 'now',
              expiresAt: 'later',
              entries: [],
              excluded: {},
              warnings: [],
            },
            witness: {
              id: '11111111-1111-4111-8111-111111111111',
              expiresAt: 'later',
              items: [],
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          data: {
            id: 'receipt-1',
            createdAt: 'now',
            previewId: 'preview-1',
            items: [],
            retryable: false,
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          data: {
            id: 'receipt-1',
            createdAt: 'now',
            previewId: 'preview-1',
            items: [],
            retryable: false,
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          data: {
            id: 'receipt-1',
            createdAt: 'now',
            previewId: 'preview-1',
            items: [],
            retryable: false,
            rolledBackAt: 'later',
          },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      detectExistingSetupImportSources('https://station.test'),
    ).resolves.toEqual([{ id: 'codex-prompts', available: true }]);
    await createExistingSetupImportPreview(
      'https://station.test',
      'codex-prompts',
    );
    await reviewExistingSetupImportTargets('https://station.test', {
      previewId: 'preview-1',
      items: [{ id: 'prompt.md:abc', action: 'skip' }],
    });
    await applyExistingSetupImport('https://station.test', {
      previewId: 'preview-1',
      witnessId: '11111111-1111-4111-8111-111111111111',
    });
    await fetchExistingSetupImportReceipt('https://station.test', 'receipt-1');
    await rollbackExistingSetupImport('https://station.test', 'receipt-1');

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://station.test/api/setup-imports/sources',
      'https://station.test/api/setup-imports/previews',
      'https://station.test/api/setup-imports/previews/preview-1/targets',
      'https://station.test/api/setup-imports/previews/preview-1/apply',
      'https://station.test/api/setup-imports/receipts/receipt-1',
      'https://station.test/api/setup-imports/receipts/receipt-1/rollback',
    ]);
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({
        witnessId: '11111111-1111-4111-8111-111111111111',
      }),
    });
  });

  test('keeps server failure messages stable', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json(
            { success: false, error: 'Operator authority required.' },
            { status: 403 },
          ),
        ),
    );
    await expect(
      detectExistingSetupImportSources('https://station.test'),
    ).rejects.toThrow('Operator authority required.');
  });
});
