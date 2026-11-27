import { describe, expect, test, vi } from 'vitest';
import {
  guardRemoteMessageSearch,
  type RemoteStationReadAuthority,
} from '../remote-station-read-authority.js';

const OWNER: RemoteStationReadAuthority = {
  hosted: false,
  current: () => true,
  owner: () => true,
};
const REMOTE = {
  matches: [
    {
      conversationId: 'remote-conversation',
      messageId: 'remote-message',
      role: 'assistant' as const,
      excerpt: 'remote excerpt',
    },
  ],
  instances: [
    {
      instanceId: 'env-1',
      instanceName: 'Home media',
      status: 'available' as const,
    },
  ],
  deferredInstanceCount: 2,
};
const WITHHELD = { matches: [], instances: [], deferredInstanceCount: 0 };

function request(headers: Record<string, string> = {}) {
  return new Request('http://station.test/api/conversations/search?query=ab', {
    headers,
  });
}

describe("remote message search is the bound owner's alone (security review H1)", () => {
  test('the bound, current owner gets the remote search', async () => {
    const search = vi.fn(async () => REMOTE);
    const guarded = guardRemoteMessageSearch(OWNER, search);
    await expect(guarded('ab', undefined, request())).resolves.toEqual(REMOTE);
    expect(search).toHaveBeenCalledWith('ab', undefined);
  });

  test.each([
    [
      'a paired device bound to someone else',
      { ...OWNER, owner: () => false },
      {},
    ],
    [
      'a principal that is no longer current',
      { ...OWNER, current: () => false },
      {},
    ],
    [
      'an agent-originated request',
      OWNER,
      { 'x-station-control-origin': 'agent-tool' },
    ],
    ['a hosted Station', { ...OWNER, hosted: true }, {}],
    ['a Station that composed no read authority', undefined, {}],
  ])(
    'withholds every remote result, names no remote Station, and sends no bearer for %s',
    async (_label, authority, headers) => {
      const search = vi.fn(async () => REMOTE);
      const guarded = guardRemoteMessageSearch(
        authority as RemoteStationReadAuthority | undefined,
        search,
      );
      await expect(guarded('ab', undefined, request(headers))).resolves.toEqual(
        WITHHELD,
      );
      expect(search).not.toHaveBeenCalled();
    },
  );

  test('a caller that passes no request is withheld, not trusted', async () => {
    const search = vi.fn(async () => REMOTE);
    const guarded = guardRemoteMessageSearch(OWNER, search);
    await expect(guarded('ab', undefined, undefined)).resolves.toEqual(
      WITHHELD,
    );
    expect(search).not.toHaveBeenCalled();
  });
});
