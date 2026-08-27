import {
  PAIRING_SCOPE_ORCHESTRATION_READ,
  PUBLIC_STATION_HANDSHAKE_PATH,
  pairingScopeIncludes,
  parsePublicStationHandshake,
} from '@kontourai/station-contracts/environment-security';
import {
  isSessionReadAuthority,
  type SessionReadAuthority,
} from '@kontourai/station-contracts/tenancy';
import type {
  UsageCoverage,
  UsageReceipt,
  UsageRollup,
} from '@kontourai/station-contracts/usage-rollup';
import {
  foldUsageReceipts,
  USAGE_ROLLUP_MAX_PAGE_SIZE,
} from '@kontourai/station-shared/usage-rollup';

export const USAGE_ROLLUP_MAX_SOURCES = 3;
export const USAGE_ROLLUP_SOURCE_DEADLINE_MS = 3_000;

export interface UsageRollupRequest {
  from: string;
  to: string;
  groupBy?: 'provider' | 'model' | 'station' | 'conversation' | 'task' | 'day';
  cursor?: string;
  pageSize?: number;
  /** Aggregate-only reads retain totals while an exhausted drilldown is skipped. */
  drilldown?: boolean;
  /** Internal paired-Station transfer; never enabled by a normal route read. */
  includeAggregate?: boolean;
}

/** An already authenticated, scope-bound read capability; never a tenant id. */
export type UsageRollupReadAuthority = SessionReadAuthority;

export interface UsageReceiptSource {
  readonly stationId: string;
  read(
    request: UsageRollupRequest,
    authority: UsageRollupReadAuthority,
    signal: AbortSignal,
  ): Promise<{
    receipts: readonly UsageReceipt[];
    /** Full bounded-window material; may be larger than the receipt page. */
    aggregateReceipts?: readonly UsageReceipt[];
    coverage: UsageCoverage;
    nextCursor?: string;
  }>;
}

function sourceFailure(
  source: UsageReceiptSource,
  request: UsageRollupRequest,
  reason: string,
): UsageCoverage {
  return {
    stationId: source.stationId,
    state: reason === 'deadline' ? 'stale' : 'offline',
    reason,
    window: { from: request.from, to: request.to },
  };
}

/**
 * Deep read module for the usage page. Source adapters receive a capability,
 * bounded deadline, and no aggregation state; peer failure becomes visible
 * coverage rather than failing the local answer or inventing a zero.
 */
export class UsageRollupService {
  constructor(
    private readonly sources: readonly UsageReceiptSource[],
    private readonly unqueriedCoverage: readonly UsageCoverage[] = [],
  ) {
    if (sources.length === 0 || sources.length > USAGE_ROLLUP_MAX_SOURCES) {
      throw new Error(
        `Usage rollup requires 1-${USAGE_ROLLUP_MAX_SOURCES} sources`,
      );
    }
    if (
      new Set(sources.map((source) => source.stationId)).size !== sources.length
    ) {
      throw new Error('Usage rollup source identities must be unique');
    }
  }

  async read(
    request: UsageRollupRequest,
    authority: UsageRollupReadAuthority,
  ): Promise<UsageRollup> {
    if (!isSessionReadAuthority(authority)) {
      throw new Error('Usage rollup read denied');
    }
    const pageSize = Math.min(
      Math.max(request.pageSize ?? 50, 1),
      USAGE_ROLLUP_MAX_PAGE_SIZE,
    );
    const sourceCursors = decodeRollupCursor(request.cursor);
    const results = await Promise.all(
      this.sources.map(async (source) => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          // AbortSignal is cooperative. Race it with the deadline as well so
          // a buggy peer adapter that ignores abort cannot hold this bounded
          // read open or fan out into an unbounded wait.
          const result = await Promise.race([
            source.read(
              {
                ...request,
                cursor: sourceCursors[source.stationId]?.cursor,
                pageSize,
                drilldown: !sourceCursors[source.stationId]?.exhausted,
              },
              authority,
              controller.signal,
            ),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                controller.abort();
                reject(new Error('deadline'));
              }, USAGE_ROLLUP_SOURCE_DEADLINE_MS);
            }),
          ]);
          return sourceCursors[source.stationId]?.exhausted
            ? { ...result, receipts: [] }
            : result;
        } catch (error) {
          return {
            receipts: [],
            coverage: sourceFailure(
              source,
              request,
              controller.signal.aborted
                ? 'deadline'
                : error instanceof Error
                  ? error.message.slice(0, 120)
                  : 'unavailable',
            ),
          };
        } finally {
          if (timer) clearTimeout(timer);
        }
      }),
    );
    const result = foldUsageReceipts({
      ...request,
      pageSize,
      receipts: results.flatMap((result) => result.receipts),
      aggregateReceipts: results.flatMap(
        (result) => result.aggregateReceipts ?? result.receipts,
      ),
      coverage: [
        ...results.map((result) => result.coverage),
        ...this.unqueriedCoverage,
      ],
    });
    const next = Object.fromEntries(
      results.map((result, index) => {
        const stationId = this.sources[index]!.stationId;
        const prior = sourceCursors[stationId];
        return [
          stationId,
          result.nextCursor
            ? { cursor: result.nextCursor, exhausted: false }
            : { cursor: prior?.cursor, exhausted: true },
        ];
      }),
    );
    const hasRemaining = Object.values(next).some((value) => !value.exhausted);
    return {
      ...result,
      ...(request.includeAggregate
        ? {
            aggregateReceipts: results.flatMap(
              (item) => item.aggregateReceipts ?? item.receipts,
            ),
          }
        : {}),
      // The public route must not expose source-transfer material. The remote
      // adapter asks the route for it explicitly, but callers never do.
      ...(hasRemaining ? { nextCursor: encodeRollupCursor(next) } : {}),
    };
  }
}

/**
 * Bounded remote Station adapter. The capability handshake is mandatory: a
 * random HTTP endpoint never becomes a usage source just because it replied.
 */
export class RemoteStationUsageReceiptSource implements UsageReceiptSource {
  constructor(
    readonly stationId: string,
    private readonly apiBase: string,
    private readonly credential: string,
    private readonly grantedScope: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async read(
    request: UsageRollupRequest,
    _authority: UsageRollupReadAuthority,
    signal: AbortSignal,
  ) {
    if (
      !pairingScopeIncludes(this.grantedScope, PAIRING_SCOPE_ORCHESTRATION_READ)
    ) {
      throw new Error('peer credential lacks orchestration:read');
    }
    const headers = { Authorization: `Bearer ${this.credential}` };
    const handshake = await this.fetchImpl(
      `${this.apiBase}${PUBLIC_STATION_HANDSHAKE_PATH}`,
      {
        signal,
      },
    );
    if (!handshake.ok) throw new Error('handshake rejected');
    const identity = parsePublicStationHandshake(
      await parseBoundedJson(handshake, 64 * 1024),
    );
    if (!identity || identity.environmentId !== this.stationId) {
      throw new Error('handshake environment mismatch');
    }
    const params = new URLSearchParams({
      from: request.from,
      to: request.to,
      // A peer rollup is a leaf read. Without this guard A -> B -> C could
      // turn one user request into recursive peer fanout.
      localOnly: '1',
      pageSize: String(
        Math.min(request.pageSize ?? 50, USAGE_ROLLUP_MAX_PAGE_SIZE),
      ),
    });
    if (request.groupBy) params.set('groupBy', request.groupBy);
    if (request.cursor) params.set('cursor', request.cursor);
    if (request.drilldown === false) params.set('drilldown', '0');
    params.set('includeAggregate', '1');
    const response = await this.fetchImpl(
      `${this.apiBase}/api/analytics/usage-rollup?${params}`,
      { signal, headers },
    );
    if (!response.ok) throw new Error(`usage read failed (${response.status})`);
    const body = parseUsageRollupBody(
      await parseBoundedJson(response, 512 * 1024),
      this.stationId,
      request,
    );
    const peerCoverage = body.coverage.find(
      (item) => item.stationId === this.stationId,
    ) ?? {
      stationId: this.stationId,
      state: 'partial' as const,
      reason: 'peer did not identify its coverage',
      window: { from: request.from, to: request.to },
    };
    // A peer that understands the drilldown route but not the separate
    // aggregate transfer cannot substantiate a full-window total. Its page is
    // still useful evidence, but the coverage must say it is incomplete.
    const coverage: UsageCoverage =
      body.aggregateReceipts === undefined
        ? {
            ...peerCoverage,
            state: 'partial',
            reason: 'peer did not provide bounded aggregate material',
          }
        : peerCoverage;
    return {
      receipts: body.receipts,
      coverage,
      ...(body.aggregateReceipts
        ? { aggregateReceipts: body.aggregateReceipts }
        : {}),
      ...(request.drilldown !== false && body.nextCursor
        ? { nextCursor: body.nextCursor }
        : {}),
    };
  }
}

type SourceCursor = { cursor?: string; exhausted: boolean };

function encodeRollupCursor(source: Record<string, SourceCursor>): string {
  return Buffer.from(JSON.stringify({ version: 2, source })).toString(
    'base64url',
  );
}

function decodeRollupCursor(
  cursor: string | undefined,
): Record<string, SourceCursor> {
  if (!cursor || cursor.length > 4096) return {};
  try {
    const value = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    if (
      (value.version !== 1 && value.version !== 2) ||
      !value.source ||
      typeof value.source !== 'object' ||
      Array.isArray(value.source)
    )
      return {};
    return Object.fromEntries(
      Object.entries(value.source).flatMap(([stationId, raw]) => {
        if (typeof stationId !== 'string') return [];
        if (typeof raw === 'string' && raw.length <= 1024)
          return [[stationId, { cursor: raw, exhausted: false }]];
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
        const item = raw as Record<string, unknown>;
        if (typeof item.exhausted !== 'boolean') return [];
        if (
          item.cursor !== undefined &&
          (typeof item.cursor !== 'string' || item.cursor.length > 1024)
        )
          return [];
        return [
          [
            stationId,
            {
              ...(typeof item.cursor === 'string'
                ? { cursor: item.cursor }
                : {}),
              exhausted: item.exhausted,
            },
          ],
        ];
      }),
    );
  } catch {
    return {};
  }
}

async function parseBoundedJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('peer response has no body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error('peer response exceeds byte limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks));
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('peer response is not JSON');
  }
}

function parseUsageRollupBody(
  value: unknown,
  stationId: string,
  request: Pick<UsageRollupRequest, 'from' | 'to'>,
): {
  receipts: UsageReceipt[];
  coverage: UsageCoverage[];
  aggregateReceipts?: UsageReceipt[];
  nextCursor?: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('malformed usage rollup response');
  const data = (value as Record<string, unknown>).data;
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error('malformed usage rollup response');
  const record = data as Record<string, unknown>;
  if (!Array.isArray(record.receipts) || !Array.isArray(record.coverage))
    throw new Error('malformed usage rollup response');
  if (
    record.receipts.length > USAGE_ROLLUP_MAX_PAGE_SIZE ||
    record.coverage.length > 4
  )
    throw new Error('peer response exceeds item limit');
  const receipts = record.receipts.map((receipt) =>
    parseReceipt(receipt, stationId),
  );
  const coverage = record.coverage.map((item) =>
    parseCoverage(item, stationId, request),
  );
  const aggregateReceipts =
    record.aggregateReceipts === undefined
      ? undefined
      : Array.isArray(record.aggregateReceipts) &&
          record.aggregateReceipts.length <= 500
        ? record.aggregateReceipts.map((receipt) =>
            parseReceipt(receipt, stationId),
          )
        : (() => {
            throw new Error('malformed aggregate receipts');
          })();
  const nextCursor = record.nextCursor;
  if (
    nextCursor !== undefined &&
    (typeof nextCursor !== 'string' || nextCursor.length > 4096)
  )
    throw new Error('malformed peer cursor');
  return {
    receipts,
    coverage,
    ...(aggregateReceipts ? { aggregateReceipts } : {}),
    ...(typeof nextCursor === 'string' ? { nextCursor } : {}),
  };
}

function parseReceipt(value: unknown, stationId: string): UsageReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('malformed usage receipt');
  const receipt = value as Record<string, unknown>;
  if (
    typeof receipt.id !== 'string' ||
    typeof receipt.stationId !== 'string' ||
    receipt.stationId !== stationId ||
    typeof receipt.provider !== 'string' ||
    receipt.id.length === 0 ||
    receipt.provider.length === 0 ||
    !validIsoDate(receipt.observedAt) ||
    !validIsoDate(receipt.occurredAt)
  )
    throw new Error('mismatched usage receipt');
  for (const key of [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
  ])
    if (
      receipt[key] !== undefined &&
      (typeof receipt[key] !== 'number' ||
        !Number.isFinite(receipt[key]) ||
        receipt[key] < 0)
    )
      throw new Error('invalid usage amount');
  if (
    receipt.reportedCost !== undefined &&
    (!receipt.reportedCost ||
      typeof receipt.reportedCost !== 'object' ||
      !Number.isFinite((receipt.reportedCost as any).amount) ||
      (receipt.reportedCost as any).amount < 0 ||
      typeof (receipt.reportedCost as any).currency !== 'string' ||
      !(receipt.reportedCost as any).currency.trim())
  )
    throw new Error('invalid usage cost');
  if (
    receipt.estimatedCost !== undefined &&
    (!receipt.estimatedCost ||
      typeof receipt.estimatedCost !== 'object' ||
      !Number.isFinite((receipt.estimatedCost as any).amount) ||
      (receipt.estimatedCost as any).amount < 0 ||
      typeof (receipt.estimatedCost as any).currency !== 'string' ||
      typeof (receipt.estimatedCost as any).pricingSnapshotId !== 'string' ||
      !(receipt.estimatedCost as any).currency.trim() ||
      !(receipt.estimatedCost as any).pricingSnapshotId.trim())
  )
    throw new Error('invalid usage estimate');
  const estimatedCost = receipt.estimatedCost as
    | UsageReceipt['estimatedCost']
    | undefined;
  const pricing = receipt.pricing;
  if (
    pricing !== undefined &&
    (!pricing ||
      typeof pricing !== 'object' ||
      !['priced', 'partial', 'unpriced'].includes(
        String((pricing as Record<string, unknown>).status),
      ))
  )
    throw new Error('invalid usage pricing provenance');
  const parsedPricing =
    pricing === undefined
      ? { status: 'unpriced' as const }
      : (pricing as UsageReceipt['pricing']);
  if (
    (parsedPricing.pricingSnapshotId !== undefined &&
      !nonEmptyString(parsedPricing.pricingSnapshotId)) ||
    (parsedPricing.pricingSnapshotCapturedAt !== undefined &&
      !validIsoDate(parsedPricing.pricingSnapshotCapturedAt)) ||
    (parsedPricing.provider !== undefined &&
      !nonEmptyString(parsedPricing.provider)) ||
    (parsedPricing.model !== undefined &&
      !nonEmptyString(parsedPricing.model)) ||
    (parsedPricing.currency !== undefined &&
      !nonEmptyString(parsedPricing.currency))
  )
    throw new Error('invalid usage pricing provenance');
  if (parsedPricing.status === 'priced') {
    if (
      parsedPricing.provider !== receipt.provider ||
      parsedPricing.model !== receipt.model ||
      typeof parsedPricing.currency !== 'string' ||
      typeof parsedPricing.pricingSnapshotId !== 'string' ||
      typeof parsedPricing.pricingSnapshotCapturedAt !== 'string' ||
      !estimatedCost ||
      estimatedCost.currency !== parsedPricing.currency ||
      estimatedCost.pricingSnapshotId !== parsedPricing.pricingSnapshotId ||
      estimatedCost.pricingSnapshotObservedAt !==
        parsedPricing.pricingSnapshotCapturedAt
    )
      throw new Error('mismatched usage pricing provenance');
  }
  if (parsedPricing.status === 'unpriced' && estimatedCost !== undefined)
    throw new Error('unpriced usage receipt cannot carry an estimate');
  // Older paired Stations cannot make a current row appear priced. Preserve
  // their omission as an explicit unpriced receipt instead of trusting a
  // caller-side catalog lookup.
  for (const key of ['model', 'threadId', 'turnId', 'conversationId', 'taskId'])
    if (receipt[key] !== undefined && typeof receipt[key] !== 'string')
      throw new Error('invalid usage receipt field');
  return {
    ...(receipt as unknown as Omit<UsageReceipt, 'pricing'>),
    pricing: parsedPricing,
  };
}

function parseCoverage(
  value: unknown,
  stationId: string,
  request: Pick<UsageRollupRequest, 'from' | 'to'>,
): UsageCoverage {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('malformed usage coverage');
  const coverage = value as Record<string, unknown>;
  if (
    coverage.stationId !== stationId ||
    !['complete', 'partial', 'offline', 'stale', 'unknown'].includes(
      String(coverage.state),
    )
  )
    throw new Error('mismatched usage coverage');
  if (
    !coverage.window ||
    typeof coverage.window !== 'object' ||
    Array.isArray(coverage.window) ||
    !sameWindow(coverage.window as Record<string, unknown>, request)
  )
    throw new Error('mismatched usage coverage window');
  validateCoverageDetails(coverage);
  if (
    coverage.droppedReceiptWindow !== undefined &&
    (!coverage.droppedReceiptWindow ||
      typeof coverage.droppedReceiptWindow !== 'object' ||
      Array.isArray(coverage.droppedReceiptWindow) ||
      !sameWindow(
        coverage.droppedReceiptWindow as Record<string, unknown>,
        request,
      ))
  ) {
    throw new Error('invalid usage coverage dropped receipt window');
  }
  if (coverage.providers !== undefined) {
    if (!Array.isArray(coverage.providers) || coverage.providers.length > 32)
      throw new Error('invalid provider coverage');
    for (const provider of coverage.providers) {
      if (!provider || typeof provider !== 'object' || Array.isArray(provider))
        throw new Error('invalid provider coverage');
      const item = provider as Record<string, unknown>;
      if (
        typeof item.provider !== 'string' ||
        !item.provider ||
        !['complete', 'partial', 'offline', 'stale', 'unknown'].includes(
          String(item.state),
        ) ||
        !item.window ||
        typeof item.window !== 'object' ||
        Array.isArray(item.window) ||
        !sameWindow(item.window as Record<string, unknown>, request)
      )
        throw new Error('invalid provider coverage');
      validateCoverageDetails(item);
    }
  }
  return coverage as unknown as UsageCoverage;
}

function validIsoDate(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' && Number.isFinite(Date.parse(value)))
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateCoverageDetails(coverage: Record<string, unknown>): void {
  if (coverage.reason !== undefined && typeof coverage.reason !== 'string')
    throw new Error('invalid usage coverage reason');
  for (const key of ['observedTurnCount', 'usageReportedTurnCount'])
    if (
      coverage[key] !== undefined &&
      (!Number.isSafeInteger(coverage[key]) || (coverage[key] as number) < 0)
    )
      throw new Error('invalid usage coverage count');
  if (
    coverage.droppedReceiptCount !== undefined &&
    (!Number.isSafeInteger(coverage.droppedReceiptCount) ||
      (coverage.droppedReceiptCount as number) < 1)
  )
    throw new Error('invalid usage coverage dropped receipt count');
  if (
    !validIsoDate(coverage.observedAt) ||
    !validIsoDate(coverage.observedThrough)
  )
    throw new Error('invalid usage coverage date');
  if (
    coverage.freshness !== undefined &&
    !['fresh', 'stale', 'unknown'].includes(String(coverage.freshness))
  )
    throw new Error('invalid usage coverage freshness');
}

function sameWindow(
  window: Record<string, unknown>,
  request: Pick<UsageRollupRequest, 'from' | 'to'>,
): boolean {
  // The caller's requested bounds are carried on every source response; a
  // peer may not widen or substitute a different date window.
  return window.from === request.from && window.to === request.to;
}
