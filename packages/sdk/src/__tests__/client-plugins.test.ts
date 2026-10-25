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
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://station.example/api/plugins',
      { method: 'GET', headers: { 'X-Station-Client-Protocol': '3' } },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

    for (const malformed of [
      {
        ...rejected,
        rejection: {
          ...rejected.rejection,
          recovery: {
            ...rejected.rejection.recovery,
            kind: ['repair-manifest'],
          },
        },
      },
      {
        ...rejected,
        rejection: {
          ...rejected.rejection,
          reason: 'Invalid\u202Eplugin',
        },
      },
    ]) {
      vi.stubGlobal(
        'fetch',
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(Response.json({ plugins: [malformed] })),
      );
      await expect(listPlugins('https://station.example')).rejects.toThrow(
        'Plugin collection response is malformed',
      );
    }
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

test('preserves typed pending readiness and rejects malformed readiness without changing rejected-row semantics', async () => {
  const row = {
    name: 'pending',
    version: '1',
    hasBundle: false,
    installationReadiness: { state: 'pending', recovery: 'review' },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ plugins: [row] })),
  );
  await expect(listPlugins('https://station.example')).resolves.toEqual([row]);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json({
        plugins: [
          {
            ...row,
            installationReadiness: {
              state: 'pending',
              recovery: 'run-command',
            },
          },
        ],
      }),
    ),
  );
  await expect(listPlugins('https://station.example')).rejects.toThrow(
    'malformed',
  );
  vi.unstubAllGlobals();
});

test('carries a ready record’s commands and generation and fails closed on malformed ones', async () => {
  const ready = {
    name: 'demo',
    version: '1.0.0',
    installationReadiness: { state: 'ready' },
    commands: [
      {
        version: '1.0',
        id: 'demo.open',
        title: 'Open',
        intent: { kind: 'navigate', surfaceId: 'plugins' },
      },
    ],
    installationGeneration: '["incarnation","digest"]',
  };
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ plugins: [ready] })),
  );
  await expect(listPlugins('https://station.example')).resolves.toEqual([
    ready,
  ]);
  for (const malformed of [
    { ...ready, installationGeneration: 42 },
    { ...ready, installationGeneration: '' },
    { ...ready, commands: { open: true } },
  ]) {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ plugins: [malformed] })),
    );
    await expect(listPlugins('https://station.example')).rejects.toThrow(
      'Plugin collection response is malformed',
    );
  }
  vi.unstubAllGlobals();
});

test('#1521: carries the persisted registry receipt unchanged and fails closed on a reshaped one', async () => {
  const digest = (fill: string) => `sha256:${fill.repeat(64)}`;
  // The exact shape `verifyRegistryAcquisition` writes into the activation plan.
  const receipt = {
    version: 1,
    policyScope: 'local',
    policyEpoch: 'epoch-1',
    policyFingerprint: digest('a'),
    registryKeyDigest: digest('b'),
    registryId: 'signed-tools',
    claimDigest: digest('c'),
    packageDigest: digest('d'),
    signer: { keyId: 'primary', spkiFingerprint: digest('e') },
  };
  const row = {
    name: 'signed-tools',
    version: '1.0.0',
    registryTrust: { state: 'verified', revision: digest('f'), receipt },
  };
  for (const registryTrust of [
    row.registryTrust,
    {
      state: 'verified',
      revision: digest('f'),
      receipt: { ...receipt, signer: null },
    },
    { state: 'none' },
    { state: 'unavailable' },
  ]) {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ plugins: [{ ...row, registryTrust }] }),
        ),
    );
    await expect(listPlugins('https://station.example')).resolves.toEqual([
      { ...row, registryTrust },
    ]);
  }
  for (const registryTrust of [
    // A package-authored badge is not a receipt.
    { state: 'verified', revision: digest('f') },
    {
      state: 'verified',
      revision: digest('f'),
      receipt: { ...receipt, publisher: 'acme' },
    },
    { state: 'verified', revision: 'pinned', receipt },
    { state: 'none', receipt },
    { state: 'trusted' },
  ]) {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ plugins: [{ ...row, registryTrust }] }),
        ),
    );
    await expect(listPlugins('https://station.example')).rejects.toThrow(
      'malformed',
    );
  }
  vi.unstubAllGlobals();
});
