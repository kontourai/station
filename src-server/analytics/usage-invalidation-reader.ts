import { createHash } from 'node:crypto';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import type {
  UsageInvalidationPage,
  UsageInvalidationRequest,
} from '@kontourai/station-contracts/usage-export';
import type { EventStore } from '../services/orchestration/event-store.js';
import {
  UsageExportRejected,
  usageExportOwnerIds,
} from './usage-export-reader.js';

interface Cursor {
  version: 1;
  context: string;
  epoch: string;
  highWater: number;
  after: number;
}
function decode(value: string | undefined): Cursor | undefined {
  if (value === undefined) return undefined;
  try {
    if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value))
      throw new Error();
    const parsed: unknown = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    );
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(',') !==
        'after,context,epoch,highWater,version' ||
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
      throw new Error();
    return {
      version: 1,
      context: parsed.context,
      epoch: parsed.epoch,
      highWater: parsed.highWater,
      after: parsed.after,
    };
  } catch {
    throw new UsageExportRejected('invalid_usage_export', 400);
  }
}

/** Historical, append-only invalidations under the same current source authority as facts. */
export function readAuthorizedUsageInvalidations(input: {
  store: Pick<
    EventStore,
    | 'readUsageExportInvalidations'
    | 'usageExportJournalState'
    | 'usageExportEpoch'
  >;
  authority: SessionReadAuthority;
  stationId: string;
  request: UsageInvalidationRequest;
  authorizationContext: string;
  personalOwnerIds: () => readonly string[] | undefined;
}): {
  page: UsageInvalidationPage;
  sourceRevision: number;
  assertCurrent(): void;
} {
  const { request, store, authority } = input;
  const limit = request.pageSize ?? 100;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (request.after !== undefined &&
      (!Number.isSafeInteger(request.after) || request.after < 0)) ||
    (request.streamEpoch !== undefined &&
      (!request.streamEpoch.length || request.streamEpoch.length > 200)) ||
    (request.cursor !== undefined &&
      (request.after !== undefined || request.streamEpoch !== undefined)) ||
    ((request.after ?? 0) > 0 && request.streamEpoch === undefined)
  )
    throw new UsageExportRejected('invalid_usage_export', 400);
  const owners = () =>
    usageExportOwnerIds(authority, request.scope, input.personalOwnerIds);
  const ownerIds = owners();
  const tenant =
    authority.mode === 'hosted' ? authority.tenantExecutionContext : undefined;
  if (authority.mode === 'hosted' && !tenant)
    throw new UsageExportRejected('usage_export_authority_changed', 403);

  const context = createHash('sha256')
    .update(
      JSON.stringify([
        'usage-invalidations/v1',
        input.stationId,
        authority.userId,
        authority.mode,
        authority.tenantExecutionContext?.tenantId ?? null,
        request.scope,
        ownerIds,
        input.authorizationContext,
      ]),
    )
    .digest('hex');
  const cursor = decode(request.cursor);
  if (cursor && cursor.context !== context)
    throw new UsageExportRejected('usage_export_authority_changed', 403);
  const after = cursor?.after ?? request.after ?? 0;
  let selected: ReturnType<EventStore['readUsageExportInvalidations']>;
  try {
    selected = store.readUsageExportInvalidations({
      ownerUserIds: ownerIds,
      ...(tenant ? { tenantId: tenant.tenantId } : {}),
      after,
      limit,
      ...(cursor
        ? { highWater: cursor.highWater, streamEpoch: cursor.epoch }
        : request.streamEpoch !== undefined
          ? { streamEpoch: request.streamEpoch }
          : {}),
    });
  } catch {
    throw new UsageExportRejected('usage_export_unavailable', 503);
  }
  if (selected.kind === 'gap')
    throw new UsageExportRejected('usage_export_history_gap', 410);
  if (selected.kind !== 'page')
    throw new UsageExportRejected('usage_export_authority_changed', 403);
  const snapshot = selected;
  const last = snapshot.rows.at(-1)?.revision;
  const nextAfter =
    snapshot.hasMore && last !== undefined ? last : snapshot.highWater;
  const next: Cursor | undefined = snapshot.hasMore
    ? {
        version: 1,
        context,
        epoch: snapshot.streamEpoch,
        highWater: snapshot.highWater,
        after: nextAfter,
      }
    : undefined;
  return {
    sourceRevision: snapshot.highWater,
    page: {
      protocol: 'station-usage-invalidations/v1',
      stationId: input.stationId,
      scope: request.scope,
      streamEpoch: snapshot.streamEpoch,
      highWater: snapshot.highWater,
      retainedAfter: snapshot.retainedAfter,
      nextAfter,
      invalidations: snapshot.rows,
      ...(next
        ? {
            nextCursor: Buffer.from(JSON.stringify(next)).toString('base64url'),
          }
        : {}),
      coverage: 'retained-invalidations-only',
    },
    assertCurrent() {
      if (JSON.stringify(owners()) !== JSON.stringify(ownerIds))
        throw new UsageExportRejected('usage_export_authority_changed', 403);
      let state: ReturnType<EventStore['usageExportJournalState']>;
      try {
        state = store.usageExportJournalState();
      } catch {
        throw new UsageExportRejected('usage_export_unavailable', 503);
      }
      if (
        store.usageExportEpoch() !== snapshot.streamEpoch ||
        state.revision < snapshot.highWater
      )
        throw new UsageExportRejected('usage_export_authority_changed', 403);
      if (state.retainedAfter > after)
        throw new UsageExportRejected('usage_export_history_gap', 410);
    },
  };
}
