import { createHash, randomUUID } from 'node:crypto';
import {
  canonicalUsageExportJson as canonical,
  type PrivateUsageGroupBy,
  type PrivateUsageReceiptPage,
  parseUsageExportPage,
} from '@kontourai/station-contracts/usage-export';
import type { UsageReceipt } from '@kontourai/station-contracts/usage-rollup';
import { reconcileUsageReceiptObservations } from '@kontourai/station-shared/usage-rollup';
import type { PrivateUsageSqlClient } from './private-usage-store.js';
import { readPrivateUsageSummary } from './private-usage-summary.js';

export const PRIVATE_RECEIPT_INDEX_SCHEMA = `
ALTER TABLE station_private_usage.vaults ADD COLUMN data_revision bigint NOT NULL DEFAULT 0;
CREATE TABLE station_private_usage.receipt_indexes(vault_id text PRIMARY KEY REFERENCES station_private_usage.vaults(id),index_id uuid NOT NULL,context text NOT NULL,after_sequence bigint NOT NULL,receipt_count bigint NOT NULL,expires_at timestamptz NOT NULL);
CREATE TABLE station_private_usage.current_receipts(vault_id text NOT NULL REFERENCES station_private_usage.vaults(id),receipt_id text NOT NULL,body jsonb NOT NULL,PRIMARY KEY(vault_id,receipt_id));
`;
export class PrivateReceiptIndexError extends Error {
  constructor(readonly code: 'conflict' | 'capacity' | 'schema_unavailable') {
    super(code);
  }
}
/** One bounded derivation step. Partial indexes never return receipt rows. */
export async function readPrivateReceiptIndex(
  client: PrivateUsageSqlClient,
  input: {
    vaultId: string;
    stationId: string;
    scope: 'individual' | 'personal-account';
    epoch: string;
    dataRevision: string;
    checkpointRevision: number;
    sourceRevision: number;
    from: string;
    to: string;
    highWater: number;
    retentionDays: number;
    expiresAt: string;
    indexId?: string;
    after?: string;
    mode?: 'receipts' | 'summary';
    groupBy?: PrivateUsageGroupBy;
    summaryId?: string;
    provider?: string;
    model?: string;
    accountKey?: string;
  },
): Promise<PrivateUsageReceiptPage> {
  const context = createHash('sha256')
    .update(
      canonical({
        epoch: input.epoch,
        dataRevision: input.dataRevision,
        checkpointRevision: input.checkpointRevision,
        sourceRevision: input.sourceRevision,
        from: input.from,
        to: input.to,
        highWater: input.highWater,
      }),
    )
    .digest('hex');
  const old = await client.query<{
    index_id: string;
    context: string;
    after_sequence: string;
    receipt_count: string;
    expires_at: string;
    expired: boolean;
  }>(
    `SELECT index_id::text,context,after_sequence::text,receipt_count::text,expires_at::text,expires_at<=clock_timestamp() AS expired FROM station_private_usage.receipt_indexes WHERE vault_id=$1 AND ${input.indexId ? 'index_id=$2::uuid' : 'context=$2'} FOR UPDATE`,
    [input.vaultId, input.indexId ?? context],
  );
  let state = old.rows[0];
  if (input.indexId && !state) throw new PrivateReceiptIndexError('conflict');
  if (state) {
    const count = await client.query<{ total: string }>(
      'SELECT COUNT(*)::text AS total FROM station_private_usage.current_receipts WHERE vault_id=$1 AND index_id=$2',
      [input.vaultId, state.index_id],
    );
    if (count.rows[0].total !== state.receipt_count)
      throw new PrivateReceiptIndexError('schema_unavailable');
  }
  if (
    input.indexId &&
    (!state ||
      state.index_id !== input.indexId ||
      state.context !== context ||
      state.expired)
  )
    throw new PrivateReceiptIndexError('conflict');
  if (!state || state.context !== context || state.expired) {
    if (state)
      await client.query(
        'DELETE FROM station_private_usage.receipt_indexes WHERE vault_id=$1 AND index_id=$2',
        [input.vaultId, state.index_id],
      );
    const retained = await client.query<{ index_id: string }>(
      'SELECT index_id::text FROM station_private_usage.receipt_indexes WHERE vault_id=$1 ORDER BY used_at,index_id',
      [input.vaultId],
    );
    if (retained.rows.length >= 4)
      await client.query(
        'DELETE FROM station_private_usage.receipt_indexes WHERE vault_id=$1 AND index_id=$2',
        [input.vaultId, retained.rows[0].index_id],
      );
    const expiry = await client.query<{ expires_at: string }>(
      `SELECT LEAST($4::timestamptz,COALESCE(MIN(stored_at+($3::integer*interval '1 day')),$4::timestamptz))::text AS expires_at FROM station_private_usage.observations WHERE vault_id=$1 AND global_sequence<=$2 AND stored_at>=clock_timestamp()-($3::integer*interval '1 day')`,
      [input.vaultId, input.highWater, input.retentionDays, input.expiresAt],
    );
    state = {
      index_id: randomUUID(),
      context,
      after_sequence: '0',
      receipt_count: '0',
      expires_at: expiry.rows[0].expires_at,
      expired: false,
    };
    await client.query(
      `INSERT INTO station_private_usage.receipt_indexes(vault_id,index_id,context,after_sequence,receipt_count,expires_at) VALUES($1,$2,$3,0,0,$4::timestamptz)`,
      [input.vaultId, state.index_id, context, state.expires_at],
    );
  }
  let after = Number(state.after_sequence),
    total = Number(state.receipt_count);
  if (
    !Number.isSafeInteger(after) ||
    after < 0 ||
    after > input.highWater ||
    !Number.isSafeInteger(total) ||
    total < 0
  )
    throw new PrivateReceiptIndexError('schema_unavailable');
  if (after < input.highWater) {
    const raw = await client.query<{
      global_sequence: string;
      digest: string;
      body: { globalSequence: number; receipts: UsageReceipt[] };
    }>(
      `SELECT global_sequence::text,digest,body FROM station_private_usage.observations AS o
      WHERE vault_id=$1 AND global_sequence>$2 AND global_sequence<=$3 AND stored_at>=clock_timestamp()-($4::integer*interval '1 day')
      ORDER BY o.global_sequence LIMIT 101`,
      [input.vaultId, after, input.highWater, input.retentionDays],
    );
    const selected = raw.rows.slice(0, 100),
      more = raw.rows.length > 100;
    for (const row of selected) {
      if (
        row.body.globalSequence !== Number(row.global_sequence) ||
        createHash('sha256').update(canonical(row.body)).digest('hex') !==
          row.digest
      )
        throw new PrivateReceiptIndexError('schema_unavailable');
    }
    const page = parseUsageExportPage(
      {
        schemaVersion: 1,
        stationId: input.stationId,
        streamEpoch: input.epoch,
        highWater: input.highWater,
        scope: input.scope,
        window: {
          from: '0001-01-01',
          to: '9999-12-31',
          clock: 'station-observed-utc',
        },
        observations: selected.map((row) => row.body),
        ...(more ? { nextCursor: 'next_index' } : {}),
        coverage: {
          state: 'unknown',
          reason:
            'retained-observations-do-not-prove-provider-or-deletion-coverage',
        },
      },
      {
        from: '0001-01-01',
        to: '9999-12-31',
        scope: input.scope,
        expectedStationId: input.stationId,
        pageSize: 100,
        cursor: 'index',
        snapshot: {
          streamEpoch: input.epoch,
          highWater: input.highWater,
          afterGlobalSequence: after,
        },
      },
    );
    for (const observation of page.observations)
      for (const receipt of observation.receipts) {
        if (
          !receipt.observedAt ||
          receipt.observedAt < `${input.from}T00:00:00.000Z` ||
          receipt.observedAt > `${input.to}T23:59:59.999Z`
        )
          continue;
        const previous = await client.query<{ body: UsageReceipt }>(
          'SELECT body FROM station_private_usage.current_receipts WHERE vault_id=$1 AND index_id=$2 AND receipt_id=$3',
          [input.vaultId, state.index_id, receipt.id],
        );
        const prior = previous.rows[0]?.body;
        if (
          prior &&
          (prior.stationId !== receipt.stationId ||
            prior.threadId !== receipt.threadId ||
            prior.provider !== receipt.provider ||
            (prior.sourceSequence !== undefined &&
            receipt.sourceSequence !== undefined
              ? receipt.sourceSequence < prior.sourceSequence
              : (receipt.observedAt ?? '') < (prior.observedAt ?? '')))
        )
          throw new PrivateReceiptIndexError('conflict');
        const reconciled = reconcileUsageReceiptObservations(
          prior ? [prior, receipt] : [receipt],
        ).get(receipt.id);
        if (!reconciled)
          throw new PrivateReceiptIndexError('schema_unavailable');
        await client.query(
          `INSERT INTO station_private_usage.current_receipts(vault_id,index_id,receipt_id,body) VALUES($1,$2,$3,$4::jsonb)
        ON CONFLICT(vault_id,index_id,receipt_id) DO UPDATE SET body=$4::jsonb`,
          [
            input.vaultId,
            state.index_id,
            receipt.id,
            JSON.stringify(reconciled),
          ],
        );
        if (!prior) total++;
      }
    after = more ? Number(selected.at(-1)?.global_sequence) : input.highWater;
    await client.query(
      'UPDATE station_private_usage.receipt_indexes SET after_sequence=$2,receipt_count=$3 WHERE vault_id=$1 AND index_id=$4',
      [input.vaultId, after, total, state.index_id],
    );
  }
  await client.query(
    'UPDATE station_private_usage.receipt_indexes SET used_at=clock_timestamp() WHERE vault_id=$1 AND index_id=$2',
    [input.vaultId, state.index_id],
  );
  const result: PrivateUsageReceiptPage = {
    protocol: 'station-private-usage-receipts/v1',
    validUntil: new Date(state.expires_at).toISOString(),
    indexId: state.index_id,
    phase: after === input.highWater ? 'ready' : 'indexing',
    afterGlobalSequence: after,
    highWater: input.highWater,
    sourceAuthority: 'not-verified-by-storage',
    coverage: 'retained-observations-only',
    receipts: [],
  };
  if (result.phase === 'ready' && input.mode === 'summary') {
    const summary = await readPrivateUsageSummary(client, {
      ...input,
      indexId: state.index_id,
      groupBy: input.groupBy ?? 'provider',
    });
    result.summary = summary.summary;
    if (summary.nextAfter) result.nextAfter = summary.nextAfter;
  } else if (result.phase === 'ready') {
    const rows = await client.query<{ receipt_id: string; body: UsageReceipt }>(
      `SELECT receipt_id,body FROM station_private_usage.current_receipts WHERE vault_id=$1 AND index_id=$2 AND receipt_id COLLATE "C">$3 COLLATE "C" AND ($4::text IS NULL OR body->>'provider'=$4) AND ($5::text IS NULL OR body->>'model'=$5) AND ($6::text IS NULL OR body->>'accountKey'=$6) ORDER BY receipt_id COLLATE "C" LIMIT 101`,
      [
        input.vaultId,
        state.index_id,
        input.after ?? '',
        input.provider ?? null,
        input.model ?? null,
        input.accountKey ?? null,
      ],
    );
    result.receipts = rows.rows.slice(0, 100).map((row) => row.body);
    if (rows.rows.length > 100) result.nextAfter = rows.rows[99].receipt_id;
  }
  return result;
}
