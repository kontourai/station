import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  StationRequestAuthorityError,
  setClientCredentialResolver,
} from '../client/http';
import {
  fetchUsageExport,
  type UsageExportQuery,
} from '../client/usage-export';
import { usageExportFixture } from './usage-export.fixture';

const scope = {
  apiBase: 'https://station.example.test',
  authorityKey: 'person-a:1',
};
const input: UsageExportQuery = {
  expectedStationId: 'station-a',
  from: '2026-10-01',
  to: '2026-10-11',
  scope: 'individual',
};
let current = true;
const fetch = vi.fn<typeof globalThis.fetch>();
beforeEach(() => {
  current = true;
  fetch.mockReset();
  setClientCredentialResolver(() => ({
    origin: scope.apiBase,
    requestAuthority: { ...scope, isCurrent: () => current },
  }));
  vi.stubGlobal('fetch', fetch);
});
afterEach(() => {
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

test('exports canonical observations without folding restatements, currencies or estimates', async () => {
  fetch.mockResolvedValue(
    Response.json({ success: true, data: usageExportFixture() }),
  );
  const result = await fetchUsageExport(
    scope.apiBase,
    { ...input, pageSize: 2 },
    { requestScope: scope },
  );
  expect(result.observations.map((row) => row.globalSequence)).toEqual([3, 7]);
  expect(
    result.observations
      .flatMap((row) => row.receipts)
      .map((item) => item.reportedCost),
  ).toEqual([
    { amount: 0.12, currency: 'EUR' },
    { amount: 0.15, currency: 'EUR' },
    undefined,
  ]);
  expect(result.observations[1].receipts[1]).toMatchObject({
    outputTokens: 0,
    estimatedCost: {
      amount: 0.004,
      currency: 'USD',
      pricingSnapshotId: 'catalog-1',
    },
    pricing: { status: 'partial', pricingSnapshotSource: 'catalog' },
  });
  expect(result.observations[0].receipts[0].occurredAt).toBe(
    '2026-09-30T23:59:00.000Z',
  );
  expect(result.coverage.state).toBe('unknown');
  expect(
    new URL(String(fetch.mock.calls[0][0])).searchParams.get('pageSize'),
  ).toBe('2');
});

test('accepts a continuation only within its captured epoch, watermark and committed order', async () => {
  const next = usageExportFixture();
  next.observations = [{ globalSequence: 9, receipts: [] }];
  delete next.nextCursor;
  fetch.mockResolvedValue(Response.json({ success: true, data: next }));
  const result = await fetchUsageExport(
    scope.apiBase,
    {
      ...input,
      cursor: 'opaque_next',
      snapshot: {
        streamEpoch: 'epoch-a',
        highWater: 9,
        afterGlobalSequence: 7,
      },
    },
    { requestScope: scope },
  );
  expect(result.observations).toEqual([{ globalSequence: 9, receipts: [] }]);
  expect(result.nextCursor).toBeUndefined();
});

test.each([
  [
    'source',
    (page: ReturnType<typeof usageExportFixture>) => {
      page.stationId = 'station-b';
    },
  ],
  [
    'scope',
    (page: ReturnType<typeof usageExportFixture>) => {
      page.scope = 'personal-account';
    },
  ],
  [
    'window',
    (page: ReturnType<typeof usageExportFixture>) => {
      page.window.from = '2026-09-01';
    },
  ],
  [
    'watermark',
    (page: ReturnType<typeof usageExportFixture>) => {
      page.highWater = 6;
    },
  ],
  [
    'order',
    (page: ReturnType<typeof usageExportFixture>) => {
      page.observations.reverse();
    },
  ],
  [
    'receipt source',
    (page: ReturnType<typeof usageExportFixture>) => {
      page.observations[0].receipts[0].stationId = 'station-b';
    },
  ],
  [
    'money',
    (page: ReturnType<typeof usageExportFixture>) => {
      page.observations[0].receipts[0].reportedCost!.amount = -1;
    },
  ],
])(
  'refuses a %s mismatch at the real fetcher boundary',
  async (_name, mutate) => {
    const data = usageExportFixture();
    mutate(data);
    fetch.mockResolvedValue(Response.json({ success: true, data }));
    await expect(
      fetchUsageExport(scope.apiBase, input, { requestScope: scope }),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  },
);

test.each(['epoch', 'watermark', 'replay'] as const)(
  'refuses continuation %s drift',
  async (kind) => {
    const data = usageExportFixture();
    data.observations = [
      { globalSequence: kind === 'replay' ? 7 : 9, receipts: [] },
    ];
    delete data.nextCursor;
    if (kind === 'epoch') data.streamEpoch = 'restored-home';
    if (kind === 'watermark') data.highWater = 10;
    fetch.mockResolvedValue(Response.json({ success: true, data }));
    await expect(
      fetchUsageExport(
        scope.apiBase,
        {
          ...input,
          cursor: 'opaque_next',
          snapshot: {
            streamEpoch: 'epoch-a',
            highWater: 9,
            afterGlobalSequence: 7,
          },
        },
        { requestScope: scope },
      ),
    ).rejects.toThrow();
  },
);

test.each([
  { schemaVersion: 2 },
  { coverage: { state: 'complete', reason: 'assumed' } },
  {
    observations: [{ globalSequence: 3, receipts: [{ id: 'not-a-receipt' }] }],
  },
])('refuses unsupported or malformed canonical facts', async (changes) => {
  fetch.mockResolvedValue(
    Response.json({
      success: true,
      data: { ...usageExportFixture(), ...changes },
    }),
  );
  await expect(
    fetchUsageExport(scope.apiBase, input, { requestScope: scope }),
  ).rejects.toThrow('invalid or unsupported');
});

test.each([
  { from: '2026-02-30' },
  { from: '2025-01-01' },
  { pageSize: 101 },
  { cursor: 'opaque_next' },
])('invalid export inputs fail before dispatch', async (changes) => {
  await expect(
    fetchUsageExport(
      scope.apiBase,
      { ...input, ...changes },
      { requestScope: scope },
    ),
  ).rejects.toThrow('Invalid usage export request');
  expect(fetch).not.toHaveBeenCalled();
});

test('requires matching host authority rather than unscoped or other-origin credentials', async () => {
  await expect(
    fetchUsageExport('https://other.example.test', input, {
      requestScope: scope,
    }),
  ).rejects.toBeInstanceOf(StationRequestAuthorityError);
  setClientCredentialResolver(() => ({ origin: scope.apiBase }));
  await expect(
    fetchUsageExport(scope.apiBase, input, { requestScope: scope }),
  ).rejects.toBeInstanceOf(StationRequestAuthorityError);
  expect(fetch).not.toHaveBeenCalled();
});

test.each([403, 503])(
  'retains HTTP %s refusal status and code',
  async (status) => {
    fetch.mockResolvedValue(
      Response.json(
        { error: { code: 'usage_export_unavailable' } },
        { status },
      ),
    );
    await expect(
      fetchUsageExport(scope.apiBase, input, { requestScope: scope }),
    ).rejects.toMatchObject({ status, code: 'usage_export_unavailable' });
  },
);

test('lost authority during the real bounded body read rejects the waiting caller', async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let read!: () => void;
  const reading = new Promise<void>((resolve) => {
    read = resolve;
  });
  fetch.mockResolvedValue(
    new Response(
      new ReadableStream<Uint8Array>(
        {
          start(controller) {
            stream = controller;
          },
          pull() {
            read();
          },
        },
        { highWaterMark: 0 },
      ),
    ),
  );
  const answer = fetchUsageExport(scope.apiBase, input, {
    requestScope: scope,
  });
  const rejected = expect(answer).rejects.toBeInstanceOf(
    StationRequestAuthorityError,
  );
  await reading;
  current = false;
  stream.enqueue(
    new TextEncoder().encode(
      JSON.stringify({ success: true, data: usageExportFixture() }),
    ),
  );
  stream.close();
  await rejected;
  expect(fetch).toHaveBeenCalledOnce();
});

test.each([undefined, '2026-09-30T23:59:59.999Z', '2026-10-12T00:00:00.000Z'])(
  'exported receipts require an observation clock within the selected window: %s',
  async (observedAt) => {
    const data = usageExportFixture();
    data.observations[0].receipts[0].observedAt = observedAt;
    fetch.mockResolvedValue(Response.json({ success: true, data }));
    await expect(
      fetchUsageExport(scope.apiBase, input, { requestScope: scope }),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  },
);

test('the export body budget rejects oversized data instead of returning a partial page', async () => {
  fetch.mockResolvedValue(new Response(' '.repeat(2 * 1024 * 1024 + 1)));
  await expect(
    fetchUsageExport(scope.apiBase, input, { requestScope: scope }),
  ).rejects.toThrow('byte limit');
});
