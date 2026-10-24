import { createHash } from 'node:crypto';
import {
  isSessionReadAuthority,
  type SessionReadAuthority,
} from '@kontourai/station-contracts/tenancy';
import type {
  UsageExportPage,
  UsageExportRequest,
} from '@kontourai/station-contracts/usage-export';
import type { EventStore } from '../services/orchestration/event-store.js';
import { usageReceiptsForEventRow } from '../services/orchestration/session-transcript-reads.js';

export class UsageExportRejected extends Error {
  constructor(
    readonly code:
      | 'invalid_usage_export'
      | 'usage_export_authority_changed'
      | 'usage_export_unavailable',
    readonly status: 400 | 403 | 503,
  ) {
    super(code);
    this.name = 'UsageExportRejected';
  }
}

interface Continuation {
  version: 1;
  context: string;
  epoch: string;
  highWater: number;
  after: number;
}

function validDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
  );
}

function continuation(value: string | undefined): Continuation | undefined {
  if (value === undefined) return undefined;
  if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new UsageExportRejected('invalid_usage_export', 400);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new UsageExportRejected('invalid_usage_export', 400);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new UsageExportRejected('invalid_usage_export', 400);
  const fields = Object.keys(parsed).sort().join(',');
  if (
    fields !== 'after,context,epoch,highWater,version' ||
    !('version' in parsed) ||
    parsed.version !== 1 ||
    !('context' in parsed) ||
    typeof parsed.context !== 'string' ||
    !/^[a-f0-9]{64}$/.test(parsed.context) ||
    !('epoch' in parsed) ||
    typeof parsed.epoch !== 'string' ||
    parsed.epoch.length < 1 ||
    parsed.epoch.length > 200 ||
    !('highWater' in parsed) ||
    typeof parsed.highWater !== 'number' ||
    !Number.isSafeInteger(parsed.highWater) ||
    parsed.highWater < 0 ||
    !('after' in parsed) ||
    typeof parsed.after !== 'number' ||
    !Number.isSafeInteger(parsed.after) ||
    parsed.after < 0 ||
    parsed.after > parsed.highWater
  )
    throw new UsageExportRejected('invalid_usage_export', 400);
  return {
    version: 1,
    context: parsed.context,
    epoch: parsed.epoch,
    highWater: parsed.highWater,
    after: parsed.after,
  };
}

/** One owner-selection policy for retained exports and enrollment proposals. */
export function usageExportOwnerIds(
  authority: SessionReadAuthority,
  scope: UsageExportRequest['scope'],
  personalOwnerIds: () => readonly string[] | undefined,
): string[] {
  if (
    !isSessionReadAuthority(authority) ||
    (authority.mode === 'hosted' && !authority.tenantExecutionContext)
  )
    throw new UsageExportRejected('usage_export_authority_changed', 403);
  if (scope === 'individual') return [authority.userId];
  if (scope !== 'personal-account' || authority.mode === 'hosted')
    throw new UsageExportRejected('invalid_usage_export', 400);
  const members = personalOwnerIds();
  if (!members?.includes(authority.userId))
    throw new UsageExportRejected('usage_export_authority_changed', 403);
  return [...new Set(members)].sort();
}

export function readAuthorizedUsageExport(input: {
  store: Pick<
    EventStore,
    'readUsageReceiptExportPage' | 'streamEpoch' | 'headGlobalSequence'
  >;
  authority: SessionReadAuthority;
  stationId: string;
  request: UsageExportRequest;
  /** Domain-specific grant generation, derived by its authenticator; never a caller identity field. */
  authorizationContext?: string;
  /** The existing SessionAuthorization owner policy, re-read at release. */
  personalOwnerIds: () => readonly string[] | undefined;
}): { page: UsageExportPage; assertCurrent(): void } {
  const { store, authority, stationId, request } = input;
  if (
    !isSessionReadAuthority(authority) ||
    (authority.mode === 'hosted' && !authority.tenantExecutionContext)
  )
    throw new UsageExportRejected('usage_export_authority_changed', 403);
  const limit = request.pageSize ?? 100;
  if (
    !validDay(request.from) ||
    !validDay(request.to) ||
    request.from > request.to ||
    Date.parse(request.to) - Date.parse(request.from) > 365 * 86400000 ||
    !['individual', 'personal-account'].includes(request.scope) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (authority.mode === 'hosted' && request.scope === 'personal-account')
  )
    throw new UsageExportRejected('invalid_usage_export', 400);
  const owners = () =>
    usageExportOwnerIds(authority, request.scope, input.personalOwnerIds);
  const ownerIds = owners();
  if (!ownerIds.includes(authority.userId))
    throw new UsageExportRejected('usage_export_authority_changed', 403);
  const context = createHash('sha256')
    .update(
      JSON.stringify([
        stationId,
        authority.userId,
        authority.mode,
        authority.tenantExecutionContext?.tenantId ?? null,
        request.scope,
        ownerIds,
        request.from,
        request.to,
        ...(input.authorizationContext ? [input.authorizationContext] : []),
      ]),
    )
    .digest('hex');
  const cursor = continuation(request.cursor);
  if (cursor && cursor.context !== context)
    throw new UsageExportRejected('usage_export_authority_changed', 403);
  let selected: ReturnType<EventStore['readUsageReceiptExportPage']>;
  try {
    selected = store.readUsageReceiptExportPage({
      ownerUserIds: ownerIds,
      ...(authority.mode === 'hosted'
        ? { tenantId: authority.tenantExecutionContext!.tenantId }
        : {}),
      from: request.from,
      to: request.to,
      after: cursor?.after ?? 0,
      limit,
      ...(cursor
        ? { highWater: cursor.highWater, streamEpoch: cursor.epoch }
        : {}),
    });
  } catch {
    throw new UsageExportRejected('usage_export_unavailable', 503);
  }
  const last = selected.rows.at(-1)?.globalSequence;
  const next: Continuation | undefined =
    selected.hasMore && last !== undefined
      ? {
          version: 1,
          context,
          epoch: selected.streamEpoch,
          highWater: selected.highWater,
          after: last,
        }
      : undefined;
  return {
    page: {
      schemaVersion: 1,
      stationId,
      streamEpoch: selected.streamEpoch,
      highWater: selected.highWater,
      scope: request.scope,
      window: {
        from: request.from,
        to: request.to,
        clock: 'station-observed-utc',
      },
      observations: selected.rows.map((row) => ({
        globalSequence: row.globalSequence,
        receipts: usageReceiptsForEventRow(row.usage, stationId),
      })),
      ...(next
        ? {
            nextCursor: Buffer.from(JSON.stringify(next)).toString('base64url'),
          }
        : {}),
      coverage: {
        state: 'unknown',
        reason:
          'retained-observations-do-not-prove-provider-or-deletion-coverage',
      },
    },
    assertCurrent() {
      if (
        JSON.stringify(owners()) !== JSON.stringify(ownerIds) ||
        store.streamEpoch() !== selected.streamEpoch ||
        store.headGlobalSequence() < selected.highWater
      )
        throw new UsageExportRejected('usage_export_authority_changed', 403);
    },
  };
}
