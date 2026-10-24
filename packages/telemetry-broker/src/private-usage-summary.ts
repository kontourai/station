import { createHash, randomUUID } from 'node:crypto';
import {
  canonicalUsageExportJson as canonical,
  type PrivateUsageGroupBy,
  type PrivateUsageSummary,
  parseUsageSummaryRows,
} from '@kontourai/station-contracts/usage-export';
import type {
  UsageReceipt,
  UsageRollupRow,
} from '@kontourai/station-contracts/usage-rollup';
import { UsageReceiptRowAccumulator } from '@kontourai/station-shared/usage-rollup';
import type { PrivateUsageSqlClient } from './private-usage-store.js';

/** Derived caches can be rebuilt; canonical observations, grants and receipts are preserved. */
export const PRIVATE_USAGE_SUMMARY_SCHEMA = `
DELETE FROM station_private_usage.current_receipts;
DELETE FROM station_private_usage.receipt_indexes;
ALTER TABLE station_private_usage.receipt_indexes DROP CONSTRAINT receipt_indexes_pkey;
ALTER TABLE station_private_usage.receipt_indexes ADD PRIMARY KEY(vault_id,index_id);
ALTER TABLE station_private_usage.receipt_indexes ADD COLUMN used_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE station_private_usage.current_receipts ADD COLUMN index_id uuid NOT NULL;
ALTER TABLE station_private_usage.current_receipts DROP CONSTRAINT current_receipts_pkey;
ALTER TABLE station_private_usage.current_receipts ADD PRIMARY KEY(vault_id,index_id,receipt_id);
ALTER TABLE station_private_usage.current_receipts ADD FOREIGN KEY(vault_id,index_id) REFERENCES station_private_usage.receipt_indexes(vault_id,index_id) ON DELETE CASCADE;
CREATE TABLE station_private_usage.receipt_summaries(vault_id text NOT NULL,index_id uuid NOT NULL,context text NOT NULL,body jsonb NOT NULL,PRIMARY KEY(vault_id,index_id,context),FOREIGN KEY(vault_id,index_id) REFERENCES station_private_usage.receipt_indexes(vault_id,index_id) ON DELETE CASCADE);
`;
export class PrivateUsageSummaryError extends Error {
  constructor(readonly code: 'conflict' | 'capacity' | 'schema_unavailable') {
    super(code);
  }
}
interface SummaryState {
  id: string;
  context: string;
  groupBy: PrivateUsageGroupBy;
  after: string | null;
  scanned: number;
  complete: boolean;
  rows: UsageRollupRow[];
}
function stateShape(value: unknown): value is SummaryState {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('id' in value) ||
    !('context' in value) ||
    !('groupBy' in value) ||
    !('after' in value) ||
    !('scanned' in value) ||
    !('complete' in value) ||
    !('rows' in value) ||
    Object.keys(value).sort().join(',') !==
      'after,complete,context,groupBy,id,rows,scanned' ||
    typeof value.id !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value.id,
    ) ||
    typeof value.context !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.context) ||
    typeof value.groupBy !== 'string' ||
    !['provider', 'model', 'station', 'day'].includes(value.groupBy) ||
    (value.after !== null &&
      (typeof value.after !== 'string' || !value.after.length)) ||
    typeof value.scanned !== 'number' ||
    !Number.isSafeInteger(value.scanned) ||
    value.scanned < 0 ||
    typeof value.complete !== 'boolean'
  )
    return false;
  try {
    const rows = parseUsageSummaryRows(value.rows);
    return (
      new Set(rows.map((row) => row.key)).size === rows.length &&
      rows.every((row) => row.key.startsWith(`${value.groupBy}:`)) &&
      rows.reduce((sum, row) => sum + row.receiptCount, 0) === value.scanned
    );
  } catch {
    return false;
  }
}
export async function readPrivateUsageSummary(
  client: PrivateUsageSqlClient,
  input: {
    vaultId: string;
    indexId: string;
    groupBy: PrivateUsageGroupBy;
    summaryId?: string;
    provider?: string;
    model?: string;
    accountKey?: string;
    after?: string;
  },
): Promise<{ summary: PrivateUsageSummary; nextAfter?: string }> {
  const context = createHash('sha256')
    .update(
      canonical({
        indexId: input.indexId,
        groupBy: input.groupBy,
        provider: input.provider,
        model: input.model,
        accountKey: input.accountKey,
      }),
    )
    .digest('hex');
  const previous = await client.query<{ body: unknown }>(
    'SELECT body FROM station_private_usage.receipt_summaries WHERE vault_id=$1 AND index_id=$2 AND context=$3 FOR UPDATE',
    [input.vaultId, input.indexId, context],
  );
  const raw = previous.rows[0]?.body;
  if (raw !== undefined && !stateShape(raw))
    throw new PrivateUsageSummaryError('schema_unavailable');
  let state = stateShape(raw) ? raw : undefined;
  if (input.summaryId && (!state || state.id !== input.summaryId))
    throw new PrivateUsageSummaryError('conflict');
  if (!state) {
    const count = await client.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM station_private_usage.receipt_summaries WHERE vault_id=$1 AND index_id=$2',
      [input.vaultId, input.indexId],
    );
    if (Number(count.rows[0].count) >= 8)
      throw new PrivateUsageSummaryError('capacity');
    state = {
      id: randomUUID(),
      context,
      groupBy: input.groupBy,
      after: null,
      scanned: 0,
      complete: false,
      rows: [],
    };
  }
  if (state.context !== context || state.groupBy !== input.groupBy)
    throw new PrivateUsageSummaryError('schema_unavailable');
  const filters = `vault_id=$1 AND index_id=$2 AND ($3::text IS NULL OR body->>'provider'=$3) AND ($4::text IS NULL OR body->>'model'=$4) AND ($5::text IS NULL OR body->>'accountKey'=$5)`;
  const values = [
    input.vaultId,
    input.indexId,
    input.provider ?? null,
    input.model ?? null,
    input.accountKey ?? null,
    state.after,
  ];
  const witness = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM station_private_usage.current_receipts WHERE ${filters} AND $6::text IS NOT NULL AND receipt_id COLLATE "C"<=$6::text COLLATE "C"`,
    values,
  );
  if (Number(witness.rows[0].count) !== state.scanned)
    throw new PrivateUsageSummaryError('schema_unavailable');
  if (!state.complete) {
    const page = await client.query<{ receipt_id: string; body: UsageReceipt }>(
      `SELECT receipt_id,body FROM station_private_usage.current_receipts WHERE ${filters} AND ($6::text IS NULL OR receipt_id COLLATE "C">$6::text COLLATE "C") ORDER BY receipt_id COLLATE "C" LIMIT 1001`,
      values,
    );
    const selected = page.rows.slice(0, 1000);
    const accumulator = new UsageReceiptRowAccumulator(
      input.groupBy,
      state.rows,
    );
    for (const row of selected) accumulator.add(row.body);
    const rows = accumulator.snapshot();
    try {
      parseUsageSummaryRows(rows);
    } catch {
      throw new PrivateUsageSummaryError('capacity');
    }
    state = {
      ...state,
      after: selected.at(-1)?.receipt_id ?? state.after,
      scanned: state.scanned + selected.length,
      complete: page.rows.length <= 1000,
      rows,
    };
    if (Buffer.byteLength(canonical(state)) > 1024 * 1024)
      throw new PrivateUsageSummaryError('capacity');
    await client.query(
      `INSERT INTO station_private_usage.receipt_summaries VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(vault_id,index_id,context) DO UPDATE SET body=$4::jsonb`,
      [input.vaultId, input.indexId, context, JSON.stringify(state)],
    );
  }
  const rows = state.complete
    ? state.rows
        .filter((row) => input.after === undefined || row.key > input.after)
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    : [];
  return {
    summary: {
      id: state.id,
      groupBy: state.groupBy,
      phase: state.complete ? 'ready' : 'aggregating',
      scanned: state.scanned,
      rows: rows.slice(0, 100),
    },
    ...(rows.length > 100 ? { nextAfter: rows[99].key } : {}),
  };
}
