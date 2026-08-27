import { afterEach, describe, expect, test, vi } from 'vitest';

const client = vi.hoisted(() => ({
  applyExistingSetupImport: vi.fn(),
  createExistingSetupImportPreview: vi.fn(),
  detectExistingSetupImportSources: vi.fn(),
  fetchExistingSetupImportReceipt: vi.fn(),
  rollbackExistingSetupImport: vi.fn(),
  reviewExistingSetupImportTargets: vi.fn(),
  setClientCredentialResolver: vi.fn(),
}));

vi.mock('@kontourai/station-sdk/setup-imports', () => client);

import { runSetupImportCommand } from '../commands/setup-import.js';

describe('station setup import', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  test('dispatches canonical detect and preview verbs through the SDK client', async () => {
    client.detectExistingSetupImportSources.mockResolvedValue([]);
    client.createExistingSetupImportPreview.mockResolvedValue({
      id: 'preview',
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runSetupImportCommand(['detect', '--api-base=http://station.test']);
    await runSetupImportCommand([
      'preview',
      'codex-prompts',
      '--api-base=http://station.test',
    ]);

    expect(client.detectExistingSetupImportSources).toHaveBeenCalledWith(
      'http://station.test',
    );
    expect(client.createExistingSetupImportPreview).toHaveBeenCalledWith(
      'http://station.test',
      'codex-prompts',
    );
  });

  test('requires an explicit target witness for apply', async () => {
    await expect(
      runSetupImportCommand([
        'apply',
        'preview-1',
        '--api-base=http://station.test',
        '--data={}',
      ]),
    ).rejects.toThrow(
      'Setup import apply requires --data={"witnessId":"..."}.',
    );
  });

  test('prints the SDK canonical receipt without CLI reconstruction', async () => {
    const receipt = {
      id: 'receipt-1',
      createdAt: 'now',
      previewId: 'preview-1',
      retryable: true,
      items: [
        {
          sourceId: 'review.md:abc',
          state: 'indeterminate',
          outcome: 'indeterminate',
          reasonCode: 'rollback-unconfirmed',
          repairCode: 'retry-rollback',
          rollback: { state: 'indeterminate', retryable: true },
        },
      ],
    };
    client.fetchExistingSetupImportReceipt.mockResolvedValue(receipt);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runSetupImportCommand([
      'receipt',
      'receipt-1',
      '--api-base=http://station.test',
    ]);

    expect(client.fetchExistingSetupImportReceipt).toHaveBeenCalledWith(
      'http://station.test',
      'receipt-1',
    );
    expect(output).toHaveBeenCalledWith(JSON.stringify(receipt, null, 2));
  });
});
