import { afterEach, expect, test, vi } from 'vitest';
import {
  DelegationGroupUnsupportedError,
  getDelegationGroup,
  readDelegationGroupEvents,
  readDelegationGroupMemberOutput,
} from '../client/delegation-groups';

afterEach(() => vi.unstubAllGlobals());
const base = 'https://groups.test';
const page = {
  groupId: 'group',
  afterRevision: 0,
  nextRevision: 2,
  hasMore: false,
  events: [
    { revision: 1, kind: 'created' },
    { revision: 2, kind: 'run_pending' },
  ],
};
function serve(data: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ success: true, data }),
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

test.each([
  ['foreign identity', { ...page, groupId: 'foreign' }],
  ['missing event', { ...page, events: [page.events[1]] }],
  ['backward revision', { ...page, events: [...page.events].reverse() }],
  ['hidden remainder', { ...page, nextRevision: 3 }],
  ['no progress', { ...page, events: [], nextRevision: 0, hasMore: true }],
  ['private journal', { ...page, authorization: { credential: 'private' } }],
])('group SDK refuses %s before delivering a page', async (_name, data) => {
  const fetch = serve(data);
  await expect(readDelegationGroupEvents(base, 'group')).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('group SDK preserves a valid page and sends its exact cursor', async () => {
  const fetch = serve(page);
  await expect(readDelegationGroupEvents(base, 'group')).resolves.toEqual(page);
  expect(String(fetch.mock.calls[0]?.[0])).toContain(
    '/api/orchestration/groups/group/events?afterRevision=0',
  );
});

test('old-host 404 has a supported-version explanation without retry', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ success: false, code: 'not_found' }, { status: 404 }),
  );
  vi.stubGlobal('fetch', fetch);
  await expect(getDelegationGroup(base, 'group')).rejects.toBeInstanceOf(
    DelegationGroupUnsupportedError,
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});

test.each([
  { groupId: 'foreign', seatId: 'seat' },
  { groupId: 'group', seatId: 'foreign' },
])('raw output is bound to requested group and seat: %j', async (identity) => {
  serve({
    ...identity,
    invocationId: 'invocation',
    text: 'retained result',
    modelId: 'selected-model',
    usage: { inputTokens: 1, outputTokens: 2, costMicros: 3 },
  });
  await expect(
    readDelegationGroupMemberOutput(base, 'group', 'seat'),
  ).rejects.toThrow('Unexpected member output');
});
