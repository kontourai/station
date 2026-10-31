import { afterEach, expect, test, vi } from 'vitest';
import {
  createDelegationGroup,
  DelegationGroupBudgetInsufficientError,
  DelegationGroupUnsupportedError,
  getDelegationGroup,
  readDelegationGroupEvents,
  readDelegationGroupMemberOutput,
} from '../client/delegation-groups';

afterEach(() => vi.unstubAllGlobals());

test('group SDK preserves an explicit preflight budget refusal', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json(
      {
        success: false,
        code: 'group_budget_insufficient',
        failurePhase: 'refused',
      },
      { status: 409 },
    ),
  );
  vi.stubGlobal('fetch', fetch);
  const request = createDelegationGroup('https://groups.test', {
    operationId: 'budget',
    projectSlug: 'source',
    resourceId: 'local:source',
    deadlineAt: Date.parse('2026-10-31T00:05:00Z'),
    maxConcurrent: 2,
    budget: {
      inputTokens: 2 * 1048576,
      outputTokens: 30,
      costMicros: 2 * 3145878,
    },
    members: ['left', 'right', 'join'].map((seatId) => ({
      seatId,
      agentId: 'reviewer',
      brief: 'Review the source',
      maxOutputTokens: 10,
    })),
  });
  await expect(request).rejects.toBeInstanceOf(
    DelegationGroupBudgetInsufficientError,
  );
  await expect(request).rejects.toMatchObject({
    status: 409,
    code: 'group_budget_insufficient',
    failurePhase: 'refused',
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});
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
    afterCodeUnit: 0,
    nextCodeUnit: 15,
    hasMore: false,
    modelId: 'selected-model',
    usage: { inputTokens: 1, outputTokens: 2, costMicros: 3 },
  });
  await expect(
    readDelegationGroupMemberOutput(base, 'group', 'seat'),
  ).rejects.toThrow('Unexpected member output');
});

test('member output preserves a bounded continuation page and its exact cursor', async () => {
  const output = {
    groupId: 'group',
    seatId: 'seat',
    invocationId: 'invocation',
    text: '😀done',
    afterCodeUnit: 32767,
    nextCodeUnit: 32773,
    hasMore: false,
    modelId: 'selected-model',
    usage: { inputTokens: 1, outputTokens: 2, costMicros: 3 },
  };
  const fetch = serve(output);
  await expect(
    readDelegationGroupMemberOutput(base, 'group', 'seat', {
      afterCodeUnit: 32767,
    }),
  ).resolves.toEqual(output);
  expect(String(fetch.mock.calls[0]?.[0])).toContain(
    '/output?afterCodeUnit=32767',
  );
});

test.each([
  { afterCodeUnit: 1, nextCodeUnit: 4, text: 'abc', hasMore: false },
  { afterCodeUnit: 0, nextCodeUnit: 4, text: 'abc', hasMore: false },
  { afterCodeUnit: 0, nextCodeUnit: 0, text: '', hasMore: true },
])('member output refuses inconsistent cursor metadata: %j', async (page) => {
  serve({
    groupId: 'group',
    seatId: 'seat',
    invocationId: 'invocation',
    ...page,
    modelId: 'selected-model',
    usage: { inputTokens: 1, outputTokens: 2, costMicros: 3 },
  });
  await expect(
    readDelegationGroupMemberOutput(base, 'group', 'seat'),
  ).rejects.toThrow('Unexpected member output');
});
