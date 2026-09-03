import { afterEach, describe, expect, test, vi } from 'vitest';
import { listPlugins, PluginCollectionHttpError } from '../client/plugins';

describe('client plugin collection', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('reads the exact canonical collection route without a trailing slash', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        plugins: [{ name: 'demo', version: '1.0.0' }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(listPlugins('https://station.example')).resolves.toEqual([
      { name: 'demo', version: '1.0.0' },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://station.example/api/plugins',
      { method: 'GET' },
    );
  });

  test('fails closed on a malformed successful collection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(Response.json({ plugins: {} })),
    );
    await expect(listPlugins('https://station.example')).rejects.toThrow(
      'Plugin collection response is malformed',
    );
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ plugins: [{ name: 'missing-version' }] }),
        ),
    );
    await expect(listPlugins('https://station.example')).rejects.toThrow(
      'Plugin collection response is malformed',
    );

    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          plugins: [
            { status: 'quarantined', name: 'future-state', version: '1' },
          ],
        }),
      ),
    );
    await expect(listPlugins('https://station.example')).rejects.toThrow(
      'Plugin collection response is malformed',
    );
  });

  test('preserves a validated rejected-manifest row without inventing a version', async () => {
    const rejected = {
      status: 'rejected',
      name: 'Legacy_Plugin',
      displayName: 'Legacy_Plugin',
      rejection: {
        code: 'invalid-plugin-name',
        reason: 'Plugin manifest name is not a canonical plugin id.',
        recovery: {
          kind: 'repair-manifest',
          instruction: 'Repair plugin.json, then choose Reload plugins.',
        },
      },
    };
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ plugins: [rejected] })),
    );

    await expect(listPlugins('https://station.example')).resolves.toEqual([
      rejected,
    ]);

    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ plugins: [{ ...rejected, version: 'invented' }] }),
        ),
    );
    await expect(listPlugins('https://station.example')).rejects.toThrow(
      'Plugin collection response is malformed',
    );
  });

  test('preserves a stable grants-unavailable failure envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          {
            success: false,
            error: 'Plugin grants are temporarily unavailable',
            grantsUnavailable: true,
          },
          { status: 503 },
        ),
      ),
    );
    const error = await listPlugins('https://station.example').catch(
      (failure) => failure,
    );
    expect(error).toBeInstanceOf(PluginCollectionHttpError);
    expect(error).toMatchObject({
      status: 503,
      envelope: {
        success: false,
        error: 'Plugin grants are temporarily unavailable',
        grantsUnavailable: true,
      },
    });
  });
});
