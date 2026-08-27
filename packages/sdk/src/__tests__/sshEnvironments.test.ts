import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://example.test'),
}));

import {
  fetchOpenSshHosts,
  fetchRemoteSessions,
  fetchSshEnvironments,
} from '../query-domains/sshEnvironments';

function mockJsonResponse(payload: unknown, ok = true) {
  vi.mocked(fetch).mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => payload,
  } as Response);
}

describe('SSH environments SDK domain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('loads environments and discovered host aliases from the protected API', async () => {
    mockJsonResponse({
      success: true,
      data: [{ profile: { id: 'remote-1' } }],
    });
    await expect(fetchSshEnvironments()).resolves.toEqual([
      { profile: { id: 'remote-1' } },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/environments/ssh',
      undefined,
    );

    mockJsonResponse({
      success: true,
      data: { hosts: [{ alias: 'brian-media' }], unavailableAliases: [] },
    });
    await expect(fetchOpenSshHosts()).resolves.toEqual({
      hosts: [{ alias: 'brian-media' }],
      unavailableAliases: [],
    });
    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/environments/ssh/hosts',
      undefined,
    );
  });

  it('surfaces safe API errors instead of returning malformed envelopes', async () => {
    mockJsonResponse({ success: false, error: 'SSH is unavailable' }, false);

    await expect(fetchOpenSshHosts()).rejects.toThrow('SSH is unavailable');
  });

  it('reads the server-side remote-session aggregate (station#1097 R1)', async () => {
    mockJsonResponse({
      success: true,
      data: {
        environments: [
          {
            environmentId: 'env-1',
            environmentName: 'Brian media',
            sessions: [{ threadId: 'thread-1' }],
          },
        ],
        unavailable: [
          { environmentId: 'env-2', environmentName: 'Offline box' },
        ],
        authenticationRequired: [
          {
            environmentId: 'env-3',
            environmentName: 'Needs pairing',
            action: 'provision_peer_credential',
          },
        ],
      },
    });

    // station#1778: this path crosses two version boundaries (client → its
    // server → a remote Station), so the undecorated fixture above models the
    // most exposed skew and is normalized at the boundary.
    await expect(fetchRemoteSessions()).resolves.toEqual({
      environments: [
        {
          environmentId: 'env-1',
          environmentName: 'Brian media',
          sessions: [
            { threadId: 'thread-1', answerability: { answerable: true } },
          ],
        },
      ],
      unavailable: [{ environmentId: 'env-2', environmentName: 'Offline box' }],
      authenticationRequired: [
        {
          environmentId: 'env-3',
          environmentName: 'Needs pairing',
          action: 'provision_peer_credential',
        },
      ],
    });
    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/environments/ssh/sessions',
      undefined,
    );
  });

  it('addresses the collection without a trailing slash (#799)', async () => {
    // The server registers `/api/environments/ssh` exactly and 404s on
    // `.../ssh/`. Both the list and the create mutation asked for `'/'`, so
    // adding an SSH environment failed outright and the Connections overview
    // showed a permanent "Environments could not be loaded" card on a
    // completely healthy instance.
    mockJsonResponse({ success: true, data: [] });
    await fetchSshEnvironments();

    const [url] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(url).toBe('http://example.test/api/environments/ssh');
    expect(String(url)).not.toMatch(/\/ssh\/$/);
  });
});
