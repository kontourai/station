import {
  encodeTaskToolResultReference,
  MAX_TASK_REFERENCES_PER_TASK,
} from '@kontourai/station-contracts';
import { afterEach, expect, test, vi } from 'vitest';
import {
  attachTaskToolResultReference,
  getSessionToolResult,
  getTaskToolResultReferences,
} from '../client/task-tool-results';

afterEach(() => vi.unstubAllGlobals());
const safeResult = {
  resultId: 'event-a',
  name: 'tool',
  terminalStatus: 'success',
  content: [{ type: 'text', text: 'inert' }],
  truncated: false,
  omittedParts: 0,
  omittedTextBytes: 0,
  omittedMetadataBytes: 0,
};
const resultRef = (resultId: string) => ({
  authority: '@kontourai/thread',
  schemaVersion: '1.2.0',
  kind: 'result',
  threadId: 'session-a',
  resultId,
});
const link = {
  id: 'link-a',
  sourceType: 'task',
  sourceId: 'task-a',
  targetType: 'tool_result',
  targetId: encodeTaskToolResultReference('session-a', 'event-a'),
  relationType: 'references_tool_result',
  confidence: 1,
  source: 'user',
  createdAt: '2026-08-25T00:00:00.000Z',
};
function install(data: unknown, status = 200) {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(
      new Response(JSON.stringify({ success: true, data }), { status }),
    );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const attach = () =>
  attachTaskToolResultReference('http://station.test', 'task-a', {
    sessionId: 'session-a',
    eventId: 'event-a',
  });
const unavailable = {
  name: 'TaskToolResultRequestError',
  message: 'Tool result unavailable',
};

test('canonical attachment succeeds and sends only an identity reference', async () => {
  const fetch = install(link);
  await expect(attach()).resolves.toEqual(link);
  expect(fetch.mock.calls[0]?.[0]).toBe(
    'http://station.test/api/tasks/task-a/references',
  );
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
    kind: 'tool-result',
    sessionId: 'session-a',
    eventId: 'event-a',
  });
});

test.each([{ kind: 'turn' }, { targetId: 'tool-result/session-a/event-a' }])(
  'attachment rejects an extra client field before dispatch',
  async (extra) => {
    const fetch = install(link);
    await expect(
      attachTaskToolResultReference('http://station.test', 'task-a', {
        sessionId: 'session-a',
        eventId: 'event-a',
        ...extra,
      } as never),
    ).rejects.toMatchObject(unavailable);
    expect(fetch).not.toHaveBeenCalled();
  },
);

test.each(
  [
    {},
    [],
    {
      ...link,
      targetId: encodeTaskToolResultReference('other-session', 'event-a'),
    },
    {
      ...link,
      targetId: encodeTaskToolResultReference('session-a', 'other-event'),
    },
    { ...link, sourceId: 'other-task' },
    { ...link, privatePayload: 'PRIVATE_EXTRA_CANARY' },
    { ...link, id: '' },
    { ...link, id: '\ud800' },
    { ...link, id: 'x'.repeat(1025) },
    { ...link, createdAt: 'not-a-date' },
    {
      ...link,
      createdAt: ['2026-08-25T', { privatePayload: 'PRIVATE_DATE_CANARY' }],
    },
    { ...link, createdAt: { privatePayload: 'PRIVATE_DATE_CANARY' } },
    { ...link, createdAt: '2026-02-30T00:00:00.000Z' },
  ].map((data) => ({ data })),
)(
  'attachment rejects one malformed field from a proven valid relation',
  async ({ data }) => {
    install(data);
    await expect(attach()).rejects.toMatchObject(unavailable);
  },
);

test('kept list accepts available items and a single opaque unavailable sentinel', async () => {
  const values = [
    {
      id: 'link-a',
      state: 'available',
      ref: resultRef(safeResult.resultId),
      result: safeResult,
    },
    { state: 'unavailable' },
  ];
  install(values);
  await expect(
    getTaskToolResultReferences('http://station.test', 'task-a'),
  ).resolves.toEqual(values);
});

test.each([
  { id: 'link-a', state: 'available', result: safeResult },
  {
    id: 'link-a',
    state: 'available',
    ref: resultRef('other-event'),
    result: safeResult,
  },
  {
    id: 'link-a',
    state: 'available',
    ref: { ...resultRef(safeResult.resultId), extra: 'forged' },
    result: safeResult,
  },
])(
  'kept list rejects a missing, mismatched, or forged Surface result ref',
  async (data) => {
    install([data]);
    await expect(
      getTaskToolResultReferences('http://station.test', 'task-a'),
    ).rejects.toMatchObject(unavailable);
  },
);

test('accepts the full published Task reference capacity without an arbitrary lower client ceiling', async () => {
  const values = Array.from(
    { length: MAX_TASK_REFERENCES_PER_TASK },
    (_, index) => ({
      id: `link-${index}`,
      state: 'available',
      ref: resultRef(`event-${index}`),
      result: { ...safeResult, resultId: `event-${index}` },
    }),
  );
  install(values);
  await expect(
    getTaskToolResultReferences('http://station.test', 'task-a'),
  ).resolves.toHaveLength(MAX_TASK_REFERENCES_PER_TASK);
});

test.each(
  [
    [
      {
        id: '',
        state: 'available',
        ref: resultRef(safeResult.resultId),
        result: safeResult,
      },
    ],
    [
      {
        id: '\ud800',
        state: 'available',
        ref: resultRef(safeResult.resultId),
        result: safeResult,
      },
    ],
    [
      {
        id: 'x'.repeat(1025),
        state: 'available',
        ref: resultRef(safeResult.resultId),
        result: safeResult,
      },
    ],
    [
      {
        id: 'link-a',
        state: 'available',
        ref: resultRef(safeResult.resultId),
        result: safeResult,
      },
      {
        id: 'link-a',
        state: 'available',
        ref: resultRef(safeResult.resultId),
        result: safeResult,
      },
    ],
    [{ state: 'unavailable' }, { state: 'unavailable' }],
    Array.from({ length: MAX_TASK_REFERENCES_PER_TASK + 1 }, (_, index) => ({
      id: `link-${index}`,
      state: 'available',
      ref: resultRef(safeResult.resultId),
      result: safeResult,
    })),
  ].map((data) => ({ data })),
)(
  'kept list fails closed for malformed identity, duplicates, or excess cardinality',
  async ({ data }) => {
    install(data);
    await expect(
      getTaskToolResultReferences('http://station.test', 'task-a'),
    ).rejects.toMatchObject(unavailable);
  },
);

test.each(['direct', 'list', 'attach'] as const)(
  '%s transport failures cannot reveal protected URLs',
  async (operation) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('PRIVATE_SESSION_EVENT_URL_CANARY')),
    );
    const request =
      operation === 'direct'
        ? getSessionToolResult('http://station.test', 'session-a', 'event-a')
        : operation === 'list'
          ? getTaskToolResultReferences('http://station.test', 'task-a')
          : attach();
    await expect(request).rejects.toMatchObject(unavailable);
  },
);
