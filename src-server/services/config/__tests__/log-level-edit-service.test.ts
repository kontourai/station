import { describe, expect, test, vi } from 'vitest';

let persisted: { schemaVersion: 1; receipts: unknown[] } = {
  schemaVersion: 1,
  receipts: [],
};
vi.mock('../../infra/json-store.js', () => ({
  JsonFileStore: class {
    read() {
      return structuredClone(persisted);
    }
    write(value: typeof persisted) {
      persisted = structuredClone(value);
    }
  },
}));

const { LOG_LEVEL_RECEIPT_LIMIT, LogLevelEditService, logLevelRevision } =
  await import('../log-level-edit-service.js');

describe('LogLevelEditService receipt retention', () => {
  test('keeps the newest bounded terminal receipts and deduplicates a retained key', async () => {
    persisted = { schemaVersion: 1, receipts: [] };
    let logLevel = 'info';
    const loader = {
      getProjectHomeDir: () => '/unused',
      loadAppConfig: vi.fn(async () => ({ logLevel })),
      updateAppConfig: vi.fn(
        async ({ logLevel: next }: { logLevel: string }) => {
          logLevel = next;
          return { logLevel };
        },
      ),
    };
    const service = new LogLevelEditService(loader as never);
    for (let index = 0; index < LOG_LEVEL_RECEIPT_LIMIT + 1; index += 1) {
      const next = index % 2 === 0 ? 'debug' : 'info';
      await service.apply(
        `receipt-operation-${String(index).padStart(4, '0')}`,
        logLevelRevision(logLevel as 'debug' | 'info'),
        next,
      );
    }
    expect(persisted.receipts).toHaveLength(LOG_LEVEL_RECEIPT_LIMIT);
    expect(persisted.receipts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operationId: 'receipt-operation-0000' }),
      ]),
    );
    const writes = loader.updateAppConfig.mock.calls.length;
    const evictedReplay = await service.apply(
      'receipt-operation-0000',
      logLevelRevision('info'),
      'debug',
    );
    expect(evictedReplay.kind).toBe('applied');
    expect(loader.updateAppConfig).toHaveBeenCalledTimes(writes);
    await service.apply(
      `receipt-operation-${String(LOG_LEVEL_RECEIPT_LIMIT).padStart(4, '0')}`,
      logLevelRevision('info'),
      'debug',
    );
    expect(loader.updateAppConfig).toHaveBeenCalledTimes(writes);
  });
});
