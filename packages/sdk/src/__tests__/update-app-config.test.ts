/**
 * station#settings-revamp slice-1 review finding 4: `updateAppConfig`
 * (the plain function `useUpdateConfigMutation` wraps) types its input as
 * `Partial<AppConfig>` — the `@ts-expect-error` block below is a
 * compile-time regression guard, checked by `tsc --noEmit` (this repo's
 * `.test.ts` files are typechecked; vitest itself strips types without
 * checking them, so this only bites on the typecheck gate, not on
 * `vitest run`) — and surfaces the route's `ignoredKeys` sibling field
 * instead of discarding it.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://example.test'),
}));

import {
  updateAppConfig,
  updateAppLogLevel,
} from '../query-domains/agentAdmin';

describe('updateAppConfig', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('PUTs the config to /config/app and returns { data, ignoredKeys } from the route payload', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { defaultModel: 'gpt-4' },
          ignoredKeys: [
            { key: 'managedChatOrchestration', reason: 'runtime-derived' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(updateAppConfig({ defaultModel: 'gpt-4' })).resolves.toEqual({
      data: { defaultModel: 'gpt-4' },
      ignoredKeys: [
        { key: 'managedChatOrchestration', reason: 'runtime-derived' },
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://example.test/config/app',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ defaultModel: 'gpt-4' }),
      }),
    );
  });

  test('resolves with ignoredKeys undefined when the route omits it (nothing was stripped)', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ success: true, data: { defaultModel: 'gpt-4' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await updateAppConfig({ defaultModel: 'gpt-4' });
    expect(result.data).toEqual({ defaultModel: 'gpt-4' });
    expect(result.ignoredKeys).toBeUndefined();
  });

  test('updates Log Level through the revisioned endpoint with an ETag and idempotency key', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ success: true, value: 'info', revision: 'rev-1' }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            value: 'debug',
            revision: 'rev-2',
            operationId: 'config-edit-00000001',
          }),
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      updateAppLogLevel('http://example.test', 'debug'),
    ).resolves.toEqual({
      value: 'debug',
      revision: 'rev-2',
      operationId: 'config-edit-00000001',
    });
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('http://example.test/config/app/log-level');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(JSON.stringify({ value: 'debug' }));
    const headers = new Headers(init.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('If-Match')).toBe('rev-1');
    expect(headers.get('Idempotency-Key')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  test('surfaces the server error message on a 400 (e.g. a required-key violation)', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          error: 'defaultModel: required — cannot be cleared',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      updateAppConfig({ defaultModel: null as unknown as string }),
    ).rejects.toThrow('defaultModel: required — cannot be cleared');
  });

  // Compile-time only — never executed. A typo'd key must fail `tsc
  // --noEmit`, not silently round-trip to the server to be dropped as
  // `ignored: 'unknown'`.
  test("type-level: a typo'd config key is rejected at compile time", () => {
    const acceptsConfig = (input: Parameters<typeof updateAppConfig>[0]) =>
      input;
    acceptsConfig({
      // @ts-expect-error — `defaultModell` is not a key of AppConfig.
      defaultModell: 'gpt-4',
    });
    expect(true).toBe(true);
  });
});
