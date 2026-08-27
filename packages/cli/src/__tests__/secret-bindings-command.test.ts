import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requestJson: vi.fn(),
  printFetched: vi.fn(),
}));

vi.mock('../commands/core-api', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../commands/core-api')>();
  return {
    ...original,
    configureApiCredential: vi.fn(),
    resolveApiBase: () => 'http://station.test',
    requestJson: mocks.requestJson,
    printFetched: mocks.printFetched,
  };
});

import { runCoreCommand } from '../commands/core';

describe('secret-bindings CLI', () => {
  beforeEach(() => {
    mocks.requestJson.mockReset().mockResolvedValue({ success: true });
    mocks.printFetched.mockReset();
  });

  test('forwards a structured migration request without reading material', async () => {
    await runCoreCommand('secret-bindings', [
      'migrate-stored-env',
      'github',
      '--data={"bindings":{"TOKEN":{"bindingId":"token","expectedRevision":2}}}',
    ]);

    expect(mocks.requestJson).toHaveBeenCalledWith(
      'http://station.test',
      '/api/secret-bindings/integrations/github/migrate-stored-env',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          bindings: { TOKEN: { bindingId: 'token', expectedRevision: 2 } },
        }),
      }),
    );
  });
});
