import { afterEach, expect, test, vi } from 'vitest';
import {
  type PluginRecoveryInput,
  previewPluginRecovery,
  recoverPlugin,
} from '../client/plugins';

afterEach(() => vi.unstubAllGlobals());
const input: PluginRecoveryInput = {
  recoveryRevision: `sha256:${'a'.repeat(64)}`,
  consent: {
    contentDigest: `sha256:${'b'.repeat(64)}`,
    grantRevision: 'fresh-parent-grants',
    registryTrustRevision: `sha256:${'d'.repeat(64)}`,
    permissions: ['network.fetch'],
    dependencies: ['dependency'],
    dependencyApprovals: [
      {
        id: 'dependency',
        grantRevision: 'fresh-child-grants',
        registryTrustRevision: `sha256:${'e'.repeat(64)}`,
        contentDigest: `sha256:${'c'.repeat(64)}`,
        permissions: [],
        dependencies: [],
      },
    ],
  },
};

test('preview uses the exact encoded read route and preserves captured revisions and review facts', async () => {
  const preview = {
    manifest: { name: 'example', version: '1.0.0' },
    expectedInstallation: { generation: 'generation' },
    recoveryRevision: input.recoveryRevision,
    contentDigest: input.consent.contentDigest,
    grantRevision: input.consent.grantRevision,
    registryTrustRevision: input.consent.registryTrustRevision,
    permissions: {
      required: ['network.fetch'],
      autoGranted: [],
      pendingConsent: [{ permission: 'network.fetch', tier: 'active' }],
    },
    dependencies: [
      {
        id: 'dependency',
        expectedInstallation: { generation: 'child' },
        consent: input.consent.dependencyApprovals![0],
      },
    ],
    skip: ['tool:optional'],
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json(preview));
  vi.stubGlobal('fetch', fetcher);
  await expect(
    previewPluginRecovery('https://station.example', 'plugin name', {
      headers: { Authorization: 'Bearer test' },
    }),
  ).resolves.toEqual(preview);
  expect(fetcher).toHaveBeenCalledWith(
    'https://station.example/api/plugins/plugin%20name/recovery-preview',
    expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({ authorization: 'Bearer test' }),
    }),
  );
});

test('recover sends only reviewed revision and consent, preserving dependency grant revisions', async () => {
  const result = {
    success: true,
    permissions: {
      autoGranted: [],
      pendingConsent: [],
      dependencies: [{ id: 'dependency', pendingConsent: [] }],
    },
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json(result));
  vi.stubGlobal('fetch', fetcher);
  await expect(
    recoverPlugin('https://station.example', 'plugin/name', input),
  ).resolves.toEqual(result);
  const [url, options] = fetcher.mock.calls[0]!;
  expect(url).toBe('https://station.example/api/plugins/plugin%2Fname/recover');
  expect(options?.method).toBe('POST');
  expect(JSON.parse(options!.body as string)).toEqual(input);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('retains a 202 pending activation receipt without claiming success or replaying the decision', async () => {
  const result = {
    success: false,
    configurationActivation: {
      status: 'pending',
      reason: 'Runtime rebuild queued',
    },
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json(result, { status: 202 }));
  vi.stubGlobal('fetch', fetcher);
  await expect(
    recoverPlugin('https://station.example', 'example', input),
  ).resolves.toEqual(result);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test.each([409, 503])(
  'preserves recovery refusal on HTTP %s without automatic mutation retry',
  async (status) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { success: false, error: 'Recovery changed; preview again' },
          { status },
        ),
      );
    vi.stubGlobal('fetch', fetcher);
    await expect(
      recoverPlugin('https://station.example', 'example', input),
    ).rejects.toThrow('Recovery changed; preview again');
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

test('does not interpret an untyped unsuccessful 202 as accepted recovery', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { success: false, error: 'No activation receipt' },
          { status: 202 },
        ),
      ),
  );
  await expect(
    recoverPlugin('https://station.example', 'example', input),
  ).rejects.toThrow('No activation receipt');
});

test('preview propagates unavailable evidence rather than returning an empty review', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { success: false, error: 'Grant state unavailable' },
          { status: 503 },
        ),
      ),
  );
  await expect(
    previewPluginRecovery('https://station.example', 'example'),
  ).rejects.toThrow('Grant state unavailable');
});
