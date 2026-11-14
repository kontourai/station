import type { EnsembleInspection } from '@kontourai/station-contracts/ensemble';
import { afterEach, expect, test, vi } from 'vitest';
import { inspectEnsemble } from '../client/ensembles';
import { setClientCredentialResolver } from '../client/http';

afterEach(() => {
  vi.unstubAllGlobals();
  setClientCredentialResolver(undefined);
});

test('inspection keeps the path in the bounded POST body and preserves scope refusal codes', async () => {
  const fetch = vi.fn(
    async (_url: unknown, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          success: false,
          code: 'ensemble_inspection_stale',
          error: 'Source changed.',
        }),
        { status: 409 },
      ),
  );
  vi.stubGlobal('fetch', fetch);
  const input = { path: '/private/team.json', bindings: {} };
  await expect(
    inspectEnsemble('https://station.test', input),
  ).rejects.toMatchObject({ status: 409, code: 'ensemble_inspection_stale' });
  expect(fetch.mock.calls[0][0]).toBe(
    'https://station.test/api/orchestration/ensembles/inspect',
  );
  expect(fetch.mock.calls[0][1]).toMatchObject({
    method: 'POST',
    body: JSON.stringify(input),
  });
  expect(String(fetch.mock.calls[0][0])).not.toContain('/private');
});

test('the client refuses oversized input before transport and oversized output before JSON projection', async () => {
  const fetch = vi.fn(async () => new Response(' '.repeat(300_000)));
  vi.stubGlobal('fetch', fetch);
  await expect(
    inspectEnsemble('https://station.test', {
      path: 'x'.repeat(20_000),
      bindings: {},
    }),
  ).rejects.toThrow('byte limit');
  expect(fetch).not.toHaveBeenCalled();
  await expect(
    inspectEnsemble('https://station.test', {
      path: '/team.json',
      bindings: {},
    }),
  ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('a changed request authority cannot dispatch inspection under another caller', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  setClientCredentialResolver(() => ({
    credential: 'private',
    origin: 'https://station.test',
    requestAuthority: {
      apiBase: 'https://station.test',
      authorityKey: 'new-owner',
      isCurrent: () => true,
    },
  }));
  await expect(
    inspectEnsemble(
      'https://station.test',
      { path: '/team.json', bindings: {} },
      {
        requestScope: {
          apiBase: 'https://station.test',
          authorityKey: 'old-owner',
        },
      },
    ),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

test.each([
  ['older host', undefined, true],
  ['available', { state: 'available' }, true],
  [
    'unavailable',
    { state: 'unavailable', detail: 'Local operator access required.' },
    true,
  ],
  ['null', null, false],
  ['unknown state', { state: 'ready' }, false],
  [
    'extra grant',
    { state: 'available', launchGrant: 'not-an-observation' },
    false,
  ],
  ['missing reason', { state: 'unavailable' }, false],
  ['blank reason', { state: 'unavailable', detail: '  ' }, false],
  [
    'oversized reason',
    { state: 'unavailable', detail: 'x'.repeat(257) },
    false,
  ],
] as const)(
  'inspection auth-check offer: %s',
  async (_name, authenticationCheck, valid) => {
    const base: EnsembleInspection = {
      version: 'station.ensemble.inspection/v1',
      source: {
        sha256: `sha256:${'a'.repeat(64)}`,
        presetId: 'team',
        name: 'Team',
        stationmaster: 'lead',
      },
      environmentId: 'this-station',
      observedAt: '2026-11-05T00:00:00Z',
      facts: [],
      resolutions: [],
      limits:
        'Authentication, entitlement, execution limits and live group bindings are unverified.',
    };
    const data = {
      ...base,
      ...(authenticationCheck === undefined ? {} : { authenticationCheck }),
    };
    const fetch = vi.fn(
      async (_url: unknown, _init?: RequestInit) =>
        new Response(JSON.stringify({ success: true, data })),
    );
    vi.stubGlobal('fetch', fetch);
    const input = {
      path: '/team.json',
      bindings: {},
      verifyAuthentication: true,
    };
    const pending = inspectEnsemble('https://station.test', input);
    if (valid) await expect(pending).resolves.toEqual(data);
    else
      await expect(pending).rejects.toThrow(
        'Invalid Ensemble inspection response',
      );
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual(input);
  },
);

test.each([
  [undefined, false],
  [{ state: 'available' }, false],
  [{ state: 'unavailable', detail: 'No reader' }, false],
  [{ state: 'bound', groupId: 'other', revision: 1 }, false],
  [{ state: 'bound', groupId: 'group-1', revision: -1 }, false],
  [
    {
      state: 'bound',
      groupId: 'group-1',
      revision: Number.MAX_SAFE_INTEGER + 1,
    },
    false,
  ],
  [{ state: 'bound', groupId: 'group-1', revision: 1, grant: true }, false],
  [{ state: 'bound', groupId: 'group-1', revision: 1 }, true],
] as const)(
  'bound group inspection validates the exact requested group and closed safe revision cell: %j',
  async (groupInspection, valid) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: true,
              data: {
                version: 'station.ensemble.inspection/v1',
                source: { sha256: `sha256:${'a'.repeat(64)}` },
                facts: [],
                resolutions: [],
                groupInspection,
              },
            }),
          ),
      ),
    );
    const pending = inspectEnsemble('https://station.test', {
      path: '/team.json',
      bindings: {},
      groupId: 'group-1',
    });
    if (valid)
      await expect(pending).resolves.toMatchObject({ groupInspection });
    else
      await expect(pending).rejects.toThrow(
        'Invalid Ensemble inspection response',
      );
  },
);

test('inspection snapshots the requested group and source before awaiting credentials', async () => {
  let releaseCredential!: (value: undefined) => void;
  const credentials = new Promise<undefined>((resolve) => {
    releaseCredential = resolve;
  });
  setClientCredentialResolver(() => credentials);
  const sha256 = `sha256:${'a'.repeat(64)}`;
  const fetch = vi.fn(
    async (_url: unknown, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          success: true,
          data: {
            version: 'station.ensemble.inspection/v1',
            source: { sha256 },
            facts: [],
            resolutions: [],
            groupInspection: {
              state: 'bound',
              groupId: 'group-1',
              revision: 0,
            },
          },
        }),
      ),
  );
  vi.stubGlobal('fetch', fetch);
  const input = {
    path: '/team.json',
    expectedPresetHash: sha256,
    bindings: {},
    groupId: 'group-1',
  };
  const pending = inspectEnsemble('https://station.test', input);
  input.groupId = 'group-2';
  input.expectedPresetHash = `sha256:${'b'.repeat(64)}`;
  releaseCredential(undefined);
  await expect(pending).resolves.toMatchObject({
    groupInspection: { state: 'bound', groupId: 'group-1' },
  });
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({
    groupId: 'group-1',
    expectedPresetHash: sha256,
  });
});
