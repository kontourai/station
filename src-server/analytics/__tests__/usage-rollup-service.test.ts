import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { UsageReceiptSource } from '../usage-rollup-service.js';
import {
  RemoteStationUsageReceiptSource,
  UsageRollupService,
} from '../usage-rollup-service.js';

const request = { from: '2026-08-01', to: '2026-08-30' } as const;
const authority = sessionReadAuthorityFromRequest(
  'usage-reader',
  undefined,
  undefined,
);

describe('UsageRollupService (station#4135)', () => {
  afterEach(() => vi.useRealTimers());

  test('converts a peer read failure into offline coverage while retaining local receipts', async () => {
    const local: UsageReceiptSource = {
      stationId: 'local',
      read: async () => ({
        receipts: [
          {
            id: 'r',
            stationId: 'local',
            provider: 'claude',
            inputTokens: 4,
            observedAt: '2026-08-10T00:00:00.000Z',
            pricing: { status: 'unpriced' as const },
          },
        ],
        coverage: { stationId: 'local', state: 'complete', window: request },
      }),
    };
    const down: UsageReceiptSource = {
      stationId: 'peer',
      read: async () => {
        throw new Error('connection refused');
      },
    };
    const result = await new UsageRollupService([local, down]).read(
      request,
      authority,
    );
    expect(result.rows[0]?.inputTokens).toBe(4);
    expect(result.coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stationId: 'peer', state: 'offline' }),
      ]),
    );
  });

  test('requires the narrow read authority and rejects unbounded source sets', async () => {
    const source: UsageReceiptSource = {
      stationId: 'local',
      read: async () => ({
        receipts: [],
        coverage: { stationId: 'local', state: 'complete', window: request },
      }),
    };
    expect(
      () =>
        new UsageRollupService([
          source,
          { ...source, stationId: 'two' },
          { ...source, stationId: 'three' },
          { ...source, stationId: 'four' },
        ]),
    ).toThrow(/1-3/);
    await expect(
      new UsageRollupService([source]).read(request, {
        canReadUsageRollup: false,
      } as any),
    ).rejects.toThrow(/denied/);
  });

  test('turns an abort-ignoring peer into stale coverage at the fixed deadline', async () => {
    vi.useFakeTimers();
    const hanging: UsageReceiptSource = {
      stationId: 'peer-hanging',
      read: async () => new Promise(() => undefined),
    };
    const pending = new UsageRollupService([hanging]).read(request, authority);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toMatchObject({
      coverage: [
        expect.objectContaining({ state: 'stale', reason: 'deadline' }),
      ],
    });
  });

  test('uses the configured bearer only after an exact Station handshake and folds a remote replay once', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const source = new RemoteStationUsageReceiptSource(
      'peer-a',
      'https://peer.example.test',
      'peer-bearer-credential-0123456789abcdef',
      'orchestration:read',
      async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).includes('.well-known')) {
          return new Response(
            JSON.stringify({
              schemaVersion: 1,
              environmentId: 'peer-a',
              authentication: { scheme: 'bearer', protocolVersion: 1 },
              transports: { http: 1, sse: 1, websocket: 1 },
              compatibility: {
                serverVersion: 'test',
                protocolVersion: 1,
                minClientProtocol: 1,
              },
            }),
          );
        }
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              receipts: [
                {
                  id: 'same-receipt',
                  stationId: 'peer-a',
                  provider: 'claude',
                  inputTokens: 9,
                  observedAt: '2026-08-20T00:00:00.000Z',
                },
                {
                  id: 'same-receipt',
                  stationId: 'peer-a',
                  provider: 'claude',
                  inputTokens: 9,
                  observedAt: '2026-08-20T00:00:00.000Z',
                },
              ],
              coverage: [
                { stationId: 'peer-a', state: 'complete', window: request },
              ],
            },
          }),
        );
      },
    );
    const result = await new UsageRollupService([source]).read(
      request,
      authority,
    );
    expect(result.rows[0]).toMatchObject({ inputTokens: 9, receiptCount: 1 });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.init?.headers).toEqual({
      Authorization: 'Bearer peer-bearer-credential-0123456789abcdef',
    });
    expect(calls[1]?.url).toContain('localOnly=1');
  });

  test('keeps cursors source-owned and rejects a malformed or mismatched peer body', async () => {
    const local: UsageReceiptSource = {
      stationId: 'local',
      read: async (input) => ({
        receipts: [
          {
            id: 'local',
            stationId: 'local',
            provider: 'claude',
            observedAt: '2026-08-10T00:00:00.000Z',
            pricing: { status: 'unpriced' as const },
          },
        ],
        coverage: { stationId: 'local', state: 'complete', window: request },
        nextCursor: input.cursor ? undefined : 'local-next',
      }),
    };
    const first = await new UsageRollupService([local]).read(
      request,
      authority,
    );
    expect(first.nextCursor).toBeTruthy();
    await new UsageRollupService([local]).read(
      { ...request, cursor: first.nextCursor },
      authority,
    );

    const remote = new RemoteStationUsageReceiptSource(
      'peer-a',
      'https://peer.example.test',
      'credential',
      'orchestration:read',
      async (url) =>
        String(url).includes('.well-known')
          ? new Response(
              JSON.stringify({
                schemaVersion: 1,
                environmentId: 'peer-a',
                authentication: { scheme: 'bearer', protocolVersion: 1 },
                transports: { http: 1, sse: 1, websocket: 1 },
                compatibility: {
                  serverVersion: 'test',
                  protocolVersion: 1,
                  minClientProtocol: 1,
                },
              }),
            )
          : new Response(
              JSON.stringify({
                success: true,
                data: {
                  receipts: [
                    { id: 'bad', stationId: 'other', provider: 'claude' },
                  ],
                  coverage: [],
                },
              }),
            ),
    );
    await expect(
      remote.read(request, authority, new AbortController().signal),
    ).rejects.toThrow(/mismatched/);
  });

  test('marks exhausted sources and never replays their first page while totals remain stable', async () => {
    const calls: Array<{ cursor?: string; drilldown?: boolean }> = [];
    const source: UsageReceiptSource = {
      stationId: 'local',
      read: async (input) => {
        calls.push({ cursor: input.cursor, drilldown: input.drilldown });
        return {
          aggregateReceipts: [
            {
              id: 'one',
              stationId: 'local',
              provider: 'claude',
              inputTokens: 1,
              observedAt: '2026-08-10T00:00:00.000Z',
              pricing: { status: 'unpriced' as const },
            },
            {
              id: 'two',
              stationId: 'local',
              provider: 'claude',
              inputTokens: 2,
              observedAt: '2026-08-11T00:00:00.000Z',
              pricing: { status: 'unpriced' as const },
            },
          ],
          receipts: input.cursor
            ? [
                {
                  id: 'two',
                  stationId: 'local',
                  provider: 'claude',
                  observedAt: '2026-08-11T00:00:00.000Z',
                  pricing: { status: 'unpriced' as const },
                },
              ]
            : [
                {
                  id: 'one',
                  stationId: 'local',
                  provider: 'claude',
                  observedAt: '2026-08-10T00:00:00.000Z',
                  pricing: { status: 'unpriced' as const },
                },
              ],
          coverage: { stationId: 'local', state: 'complete', window: request },
          ...(input.cursor ? {} : { nextCursor: 'two' }),
        };
      },
    };
    const service = new UsageRollupService([source]);
    const first = await service.read(request, authority);
    const second = await service.read(
      { ...request, cursor: first.nextCursor },
      authority,
    );
    expect(first.rows[0]?.inputTokens).toBe(3);
    expect(second.rows[0]?.inputTokens).toBe(3);
    expect(second.receipts.map((item) => item.id)).toEqual(['two']);
    expect(second.nextCursor).toBeUndefined();
    await service.read({ ...request, cursor: first.nextCursor }, authority);
    expect(calls.at(-1)).toEqual({ cursor: 'two', drilldown: true });
  });

  test('discloses globally capped aggregate material by source instead of silently folding the earliest 500', async () => {
    const source = (stationId: string): UsageReceiptSource => ({
      stationId,
      read: async () => {
        const aggregateReceipts = Array.from({ length: 200 }, (_, index) => ({
          id: `${stationId}-${String(index).padStart(3, '0')}`,
          stationId,
          provider: 'claude',
          inputTokens: 1,
          observedAt: '2026-08-10T00:00:00.000Z',
          pricing: { status: 'unpriced' as const },
        }));
        return {
          receipts: aggregateReceipts,
          aggregateReceipts,
          coverage: { stationId, state: 'complete' as const, window: request },
        };
      },
    });
    const result = await new UsageRollupService([
      source('source-a'),
      source('source-b'),
      source('source-c'),
    ]).read({ ...request, groupBy: 'station' }, authority);

    expect(
      result.rows.reduce((total, row) => total + (row.inputTokens ?? 0), 0),
    ).toBe(500);
    expect(result.coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stationId: 'source-c',
          state: 'partial',
          reason: 'aggregate receipt cap reached',
          droppedReceiptCount: 100,
          droppedReceiptWindow: request,
        }),
      ]),
    );
    expect(
      result.coverage.some((coverage) => coverage.state === 'complete'),
    ).toBe(true);
    expect(
      result.coverage.every((coverage) => coverage.state === 'complete'),
    ).toBe(false);
  });

  test('does not disclose an aggregate cap when cross-source replacements deduplicate below it', async () => {
    const source = (
      stationId: string,
      observedAt: string,
    ): UsageReceiptSource => ({
      stationId,
      read: async () => {
        const aggregateReceipts = Array.from({ length: 300 }, (_, index) => ({
          id: `shared-${String(index).padStart(3, '0')}`,
          stationId,
          provider: 'claude',
          inputTokens: stationId === 'source-b' ? 2 : 1,
          observedAt,
          pricing: { status: 'unpriced' as const },
        }));
        return {
          receipts: aggregateReceipts,
          aggregateReceipts,
          coverage: { stationId, state: 'complete' as const, window: request },
        };
      },
    });
    const result = await new UsageRollupService([
      source('source-a', '2026-08-10T00:00:00.000Z'),
      source('source-b', '2026-08-11T00:00:00.000Z'),
    ]).read(request, authority);

    expect(result.rows[0]).toMatchObject({
      inputTokens: 600,
      receiptCount: 300,
    });
    expect(result.coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stationId: 'source-a', state: 'complete' }),
        expect.objectContaining({ stationId: 'source-b', state: 'complete' }),
      ]),
    );
    expect(
      result.coverage.some(
        (coverage) => coverage.reason === 'aggregate receipt cap reached',
      ),
    ).toBe(false);
  });

  test('rejects a hostile peer body larger than its streaming byte cap and invalid nested coverage', async () => {
    const source = new RemoteStationUsageReceiptSource(
      'peer-a',
      'https://peer.example.test',
      'credential',
      'orchestration:read',
      async (url) =>
        String(url).includes('.well-known')
          ? new Response(
              JSON.stringify({
                schemaVersion: 1,
                environmentId: 'peer-a',
                authentication: { scheme: 'bearer', protocolVersion: 1 },
                transports: { http: 1, sse: 1, websocket: 1 },
                compatibility: {
                  serverVersion: 'test',
                  protocolVersion: 1,
                  minClientProtocol: 1,
                },
              }),
            )
          : new Response(
              JSON.stringify({
                success: true,
                data: {
                  receipts: [],
                  coverage: [
                    {
                      stationId: 'peer-a',
                      state: 'complete',
                      window: request,
                      providers: [
                        {
                          provider: 'claude',
                          state: 'complete',
                          window: { from: 'wrong', to: request.to },
                        },
                      ],
                    },
                  ],
                },
              }),
            ),
    );
    await expect(
      source.read(request, authority, new AbortController().signal),
    ).rejects.toThrow(/provider coverage/);
    const oversized = new RemoteStationUsageReceiptSource(
      'peer-a',
      'https://peer.example.test',
      'credential',
      'orchestration:read',
      async (url) =>
        String(url).includes('.well-known')
          ? new Response(
              JSON.stringify({
                schemaVersion: 1,
                environmentId: 'peer-a',
                authentication: { scheme: 'bearer', protocolVersion: 1 },
                transports: { http: 1, sse: 1, websocket: 1 },
                compatibility: {
                  serverVersion: 'test',
                  protocolVersion: 1,
                  minClientProtocol: 1,
                },
              }),
            )
          : new Response('x'.repeat(512 * 1024 + 1)),
    );
    await expect(
      oversized.read(request, authority, new AbortController().signal),
    ).rejects.toThrow(/byte limit/);
  });
});
