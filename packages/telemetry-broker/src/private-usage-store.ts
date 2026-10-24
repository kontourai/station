import { createHash, randomUUID } from 'node:crypto';
import {
  canonicalUsageExportJson as canonical,
  type PrivateUsageCheckpoint,
  type PrivateUsageCommitReceipt,
  type PrivateUsageInvalidationCheckpoint,
  type PrivateUsageInvalidationReceipt,
  parsePrivateUsageCommit,
  parsePrivateUsageInvalidations,
  parsePrivateUsageReceiptQuery,
} from '@kontourai/station-contracts/usage-export';
import type { QueryResultRow } from 'pg';
import {
  PRIVATE_RECEIPT_INDEX_SCHEMA,
  PrivateReceiptIndexError,
  readPrivateReceiptIndex,
} from './private-receipt-index.js';

export interface PrivateUsageSqlClient {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}
export class PrivateUsageError extends Error {
  constructor(
    readonly code:
      | 'unauthorized'
      | 'invalid_commit'
      | 'conflict'
      | 'capacity'
      | 'schema_unavailable'
      | 'expired',
  ) {
    super(`private_usage_${code}`);
  }
}
const SCHEMA = `
CREATE TABLE station_private_usage.migrations(version integer PRIMARY KEY,digest text NOT NULL);
CREATE TABLE station_private_usage.identity(singleton boolean PRIMARY KEY CHECK(singleton),epoch uuid NOT NULL);
CREATE TABLE station_private_usage.capacity(singleton boolean PRIMARY KEY CHECK(singleton),observations bigint NOT NULL CHECK(observations>=0),vaults integer NOT NULL CHECK(vaults>=0));
INSERT INTO station_private_usage.capacity VALUES(true,0,0);
CREATE TABLE station_private_usage.vaults(id text PRIMARY KEY,binding jsonb,epoch text,revoked boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE station_private_usage.checkpoints(vault_id text NOT NULL REFERENCES station_private_usage.vaults(id),window_from text NOT NULL,window_to text NOT NULL,revision bigint NOT NULL,body jsonb NOT NULL,PRIMARY KEY(vault_id,window_from,window_to));
CREATE TABLE station_private_usage.observations(vault_id text NOT NULL REFERENCES station_private_usage.vaults(id),epoch text NOT NULL,global_sequence bigint NOT NULL,digest text NOT NULL,body jsonb NOT NULL,source_revision bigint NOT NULL,stored_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(vault_id,epoch,global_sequence));
CREATE TABLE station_private_usage.commits(vault_id text NOT NULL REFERENCES station_private_usage.vaults(id),operation_id uuid NOT NULL,window_from text NOT NULL,window_to text NOT NULL,checkpoint_revision bigint NOT NULL,digest text NOT NULL,receipt jsonb NOT NULL,stored_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(vault_id,operation_id));
`;
const INVALIDATION_SCHEMA = `
ALTER TABLE station_private_usage.vaults ADD COLUMN invalidation_baseline bigint;
ALTER TABLE station_private_usage.vaults ADD COLUMN journal jsonb;
UPDATE station_private_usage.vaults SET invalidation_baseline=0,journal=jsonb_build_object('after',0,'streamEpoch',epoch,'highWater',0) WHERE binding IS NOT NULL;
CREATE TABLE station_private_usage.invalidation_commits(vault_id text NOT NULL REFERENCES station_private_usage.vaults(id),operation_id uuid NOT NULL,digest text NOT NULL,after_revision bigint NOT NULL,receipt jsonb NOT NULL,PRIMARY KEY(vault_id,operation_id));
`;
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const SCHEMA_DIGEST = digest(SCHEMA);
const INVALIDATION_DIGEST = digest(INVALIDATION_SCHEMA);
const RECEIPT_INDEX_DIGEST = digest(PRIVATE_RECEIPT_INDEX_SCHEMA);
const primaryKeys: Record<string, string> = {
  migrations: 'PRIMARY KEY (version)',
  receipt_indexes: 'PRIMARY KEY (vault_id)',
  current_receipts: 'PRIMARY KEY (vault_id, receipt_id)',
  identity: 'PRIMARY KEY (singleton)',
  invalidation_commits: 'PRIMARY KEY (vault_id, operation_id)',
  capacity: 'PRIMARY KEY (singleton)',
  vaults: 'PRIMARY KEY (id)',
  checkpoints: 'PRIMARY KEY (vault_id, window_from, window_to)',
  observations: 'PRIMARY KEY (vault_id, epoch, global_sequence)',
  commits: 'PRIMARY KEY (vault_id, operation_id)',
};
export async function assertPrivateUsageSchema(client: PrivateUsageSqlClient) {
  await client.query(
    'LOCK TABLE station_private_usage.migrations,station_private_usage.identity,station_private_usage.capacity,station_private_usage.vaults,station_private_usage.checkpoints,station_private_usage.observations,station_private_usage.commits,station_private_usage.invalidation_commits,station_private_usage.receipt_indexes,station_private_usage.current_receipts IN ACCESS SHARE MODE',
  );
  const migration = await client.query<{ version: number; digest: string }>(
    'SELECT version,digest FROM station_private_usage.migrations ORDER BY version',
  );
  if (
    migration.rows.length !== 3 ||
    migration.rows[0].version !== 1 ||
    migration.rows[0].digest !== SCHEMA_DIGEST ||
    migration.rows[1].version !== 2 ||
    migration.rows[1].digest !== INVALIDATION_DIGEST ||
    migration.rows[2].version !== 3 ||
    migration.rows[2].digest !== RECEIPT_INDEX_DIGEST
  )
    throw new PrivateUsageError('schema_unavailable');
  const keys = await client.query<{ name: string; definition: string }>(
    `SELECT c.relname AS name,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='station_private_usage' AND k.contype='p'`,
  );
  if (
    keys.rows.length !== Object.keys(primaryKeys).length ||
    keys.rows.some((row) => primaryKeys[row.name] !== row.definition)
  )
    throw new PrivateUsageError('schema_unavailable');
  const identity = await client.query<{ epoch: string }>(
    'SELECT epoch::text AS epoch FROM station_private_usage.identity',
  );
  if (
    identity.rows.length !== 1 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      identity.rows[0].epoch,
    )
  )
    throw new PrivateUsageError('schema_unavailable');
  const capacity = await client.query<{
    observations: string;
    vaults: number;
    actual_observations: string;
    actual_vaults: number;
  }>(
    'SELECT observations::text AS observations,vaults,(SELECT COUNT(*)::text FROM station_private_usage.observations) AS actual_observations,(SELECT COUNT(*)::integer FROM station_private_usage.vaults) AS actual_vaults FROM station_private_usage.capacity',
  );
  if (
    capacity.rows.length !== 1 ||
    !Number.isSafeInteger(Number(capacity.rows[0].observations)) ||
    Number(capacity.rows[0].observations) < 0 ||
    !Number.isInteger(capacity.rows[0].vaults) ||
    capacity.rows[0].vaults < 0 ||
    capacity.rows[0].observations !== capacity.rows[0].actual_observations ||
    capacity.rows[0].vaults !== capacity.rows[0].actual_vaults
  )
    throw new PrivateUsageError('schema_unavailable');
}
export async function migratePrivateUsage(client: PrivateUsageSqlClient) {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('station.private.usage.migration'))",
  );
  const existing = await client.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='station_private_usage'",
  );
  if (existing.rows.length === 0) {
    await client.query('CREATE SCHEMA IF NOT EXISTS station_private_usage');
    await client.query(SCHEMA);
    await client.query(
      'INSERT INTO station_private_usage.identity VALUES(true,$1)',
      [randomUUID()],
    );
    await client.query(
      'INSERT INTO station_private_usage.migrations VALUES(1,$1)',
      [SCHEMA_DIGEST],
    );
  }
  const versions = await client.query<{ version: number; digest: string }>(
    'SELECT version,digest FROM station_private_usage.migrations ORDER BY version',
  );
  if (
    versions.rows.length === 1 &&
    versions.rows[0].version === 1 &&
    versions.rows[0].digest === SCHEMA_DIGEST
  ) {
    await client.query(INVALIDATION_SCHEMA);
    await client.query(
      'INSERT INTO station_private_usage.migrations VALUES(2,$1)',
      [INVALIDATION_DIGEST],
    );
  }
  const indexed = await client.query<{ version: number; digest: string }>(
    'SELECT version,digest FROM station_private_usage.migrations ORDER BY version',
  );
  if (
    indexed.rows.length === 2 &&
    indexed.rows[0].version === 1 &&
    indexed.rows[0].digest === SCHEMA_DIGEST &&
    indexed.rows[1].version === 2 &&
    indexed.rows[1].digest === INVALIDATION_DIGEST
  ) {
    await client.query(PRIVATE_RECEIPT_INDEX_SCHEMA);
    await client.query(
      'INSERT INTO station_private_usage.migrations VALUES(3,$1)',
      [RECEIPT_INDEX_DIGEST],
    );
  }
  await assertPrivateUsageSchema(client);
}
export class PrivateUsageRepository {
  constructor(
    private readonly transaction: <T>(
      operation: (client: PrivateUsageSqlClient) => Promise<T>,
    ) => Promise<T>,
    private readonly maxObservations = 1_000_000,
    private readonly maxBytes = 1_073_741_824,
  ) {}
  private vaultId(key: string) {
    if (!/^stai_[A-Za-z0-9_-]{43}$/.test(key))
      throw new PrivateUsageError('unauthorized');
    return digest(key);
  }
  private async journalState(
    client: PrivateUsageSqlClient,
    id: string,
    epoch: string,
    value: PrivateUsageInvalidationCheckpoint | null,
    baseline: string | null,
  ): Promise<PrivateUsageInvalidationCheckpoint> {
    if (
      !value ||
      baseline === null ||
      !Number.isSafeInteger(value.after) ||
      value.after < Number(baseline) ||
      !Number.isSafeInteger(value.highWater) ||
      value.highWater < value.after ||
      value.streamEpoch !== epoch ||
      (value.nextCursor !== undefined &&
        (!value.nextCursor.length || value.nextCursor.length > 2048))
    )
      throw new PrivateUsageError('schema_unavailable');
    const latest = await client.query<{
      receipt: PrivateUsageInvalidationReceipt;
    }>(
      'SELECT receipt FROM station_private_usage.invalidation_commits WHERE vault_id=$1 ORDER BY after_revision DESC LIMIT 1',
      [id],
    );
    if (
      latest.rows[0]
        ? canonical(latest.rows[0].receipt.checkpoint) !== canonical(value)
        : value.after !== Number(baseline) ||
          value.highWater !== Number(baseline) ||
          value.nextCursor !== undefined
    )
      throw new PrivateUsageError('schema_unavailable');
    return value;
  }
  async applyInvalidations(
    key: string,
    raw: unknown,
  ): Promise<PrivateUsageInvalidationReceipt> {
    const id = this.vaultId(key);
    let input: ReturnType<typeof parsePrivateUsageInvalidations>;
    try {
      input = parsePrivateUsageInvalidations(raw);
    } catch {
      throw new PrivateUsageError('invalid_commit');
    }
    const contentDigest = digest(canonical(input));
    return this.transaction(async (client) => {
      await assertPrivateUsageSchema(client);
      await client.query(
        'SELECT singleton FROM station_private_usage.capacity WHERE singleton=true FOR UPDATE',
      );
      const v = await client.query<{
        binding: ReturnType<typeof parsePrivateUsageCommit>['binding'] | null;
        epoch: string;
        journal: PrivateUsageInvalidationCheckpoint | null;
        invalidation_baseline: string | null;
        revoked: boolean;
      }>(
        'SELECT binding,epoch,journal,invalidation_baseline::text,revoked FROM station_private_usage.vaults WHERE id=$1 FOR UPDATE',
        [id],
      );
      const vault = v.rows[0];
      if (!vault || vault.revoked) throw new PrivateUsageError('unauthorized');
      const identity = await client.query<{ epoch: string }>(
        'SELECT epoch::text AS epoch FROM station_private_usage.identity WHERE singleton=true',
      );
      if (input.expectedReceiverEpoch !== identity.rows[0].epoch)
        throw new PrivateUsageError('conflict');
      const prior = await client.query<{
        digest: string;
        receipt: PrivateUsageInvalidationReceipt;
      }>(
        'SELECT digest,receipt FROM station_private_usage.invalidation_commits WHERE vault_id=$1 AND operation_id=$2',
        [id, input.operationId],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].digest !== contentDigest)
          throw new PrivateUsageError('conflict');
        return prior.rows[0].receipt;
      }
      if (!vault.binding) throw new PrivateUsageError('conflict');
      const journal = await this.journalState(
        client,
        id,
        vault.epoch,
        vault.journal,
        vault.invalidation_baseline,
      );
      if (
        input.expectedAfter !== journal.after ||
        input.page.stationId !== vault.binding.sourceStationId ||
        input.page.scope !== vault.binding.scope ||
        input.page.streamEpoch !== vault.epoch ||
        (journal.nextCursor !== undefined &&
          input.page.highWater !== journal.highWater)
      )
        throw new PrivateUsageError('conflict');
      const total = await client.query<{ total: string }>(
        'SELECT COUNT(*)::text AS total FROM station_private_usage.invalidation_commits WHERE vault_id=$1',
        [id],
      );
      if (Number(total.rows[0].total) >= 10000)
        throw new PrivateUsageError('capacity');
      const size = await client.query<{ bytes: string }>(
        'SELECT pg_database_size(current_database())::text AS bytes',
      );
      if (Number(size.rows[0].bytes) > this.maxBytes)
        throw new PrivateUsageError('capacity');
      let removed = 0;
      const refreshThreads = new Set<string>();
      for (const invalidation of input.page.invalidations) {
        if (invalidation.reason === 'scope-entered') {
          refreshThreads.add(invalidation.threadId);
          continue;
        }
        const result = await client.query(
          `DELETE FROM station_private_usage.observations o WHERE vault_id=$1 AND source_revision<$2 AND
          (EXISTS(SELECT 1 FROM jsonb_array_elements(o.body->'receipts') r WHERE r->>'threadId'=$3)
          OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(o.body->'receipts') r WHERE r ? 'threadId'))`,
          [id, invalidation.revision, invalidation.threadId],
        );
        removed += result.rowCount ?? 0;
      }
      await client.query(
        'UPDATE station_private_usage.capacity SET observations=observations-$1 WHERE singleton=true',
        [removed],
      );
      if (removed > 0) await this.invalidateReceiptIndex(client, id);
      const checkpoint: PrivateUsageInvalidationCheckpoint = {
        after: input.page.nextAfter,
        streamEpoch: vault.epoch,
        highWater: input.page.highWater,
        ...(input.page.nextCursor ? { nextCursor: input.page.nextCursor } : {}),
      };
      await client.query(
        'UPDATE station_private_usage.vaults SET journal=$2::jsonb WHERE id=$1',
        [id, JSON.stringify(checkpoint)],
      );
      const time = await client.query<{ now: string }>(
        'SELECT to_char(clock_timestamp() AT TIME ZONE \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\') AS now',
      );
      const receipt: PrivateUsageInvalidationReceipt = {
        protocol: 'station-private-usage-invalidation-receipt/v1',
        operationId: input.operationId,
        receiverEpoch: identity.rows[0].epoch,
        checkpoint,
        removed,
        refreshThreads: [...refreshThreads],
        storedAt: time.rows[0].now,
      };
      await client.query(
        'INSERT INTO station_private_usage.invalidation_commits(vault_id,operation_id,digest,after_revision,receipt) VALUES($1,$2,$3,$4,$5::jsonb)',
        [
          id,
          input.operationId,
          contentDigest,
          checkpoint.after,
          JSON.stringify(receipt),
        ],
      );
      return receipt;
    });
  }
  async invalidationReceipt(key: string, operationId: string) {
    const id = this.vaultId(key);
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        operationId,
      )
    )
      throw new PrivateUsageError('invalid_commit');
    return this.transaction(async (client) => {
      await assertPrivateUsageSchema(client);
      const row = await client.query<{
        receipt: PrivateUsageInvalidationReceipt;
      }>(
        'SELECT c.receipt FROM station_private_usage.invalidation_commits c JOIN station_private_usage.vaults v ON v.id=c.vault_id WHERE c.vault_id=$1 AND c.operation_id=$2 AND NOT v.revoked',
        [id, operationId],
      );
      return row.rows[0]?.receipt ?? null;
    });
  }
  async provision(credentialHash: string) {
    if (!/^[a-f0-9]{64}$/.test(credentialHash))
      throw new PrivateUsageError('invalid_commit');
    return this.transaction(async (client) => {
      await assertPrivateUsageSchema(client);
      const capacity = await client.query<{ vaults: number }>(
        'SELECT vaults FROM station_private_usage.capacity WHERE singleton=true FOR UPDATE',
      );
      const identity = await client.query<{ epoch: string }>(
        'SELECT epoch::text AS epoch FROM station_private_usage.identity WHERE singleton=true',
      );
      const receiverEpoch = identity.rows[0].epoch;
      const existing = await client.query<{ revoked: boolean }>(
        'SELECT revoked FROM station_private_usage.vaults WHERE id=$1',
        [credentialHash],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].revoked) throw new PrivateUsageError('conflict');
        return { created: false, receiverEpoch };
      }
      if (capacity.rows[0].vaults >= 1000)
        throw new PrivateUsageError('capacity');
      await client.query(
        'INSERT INTO station_private_usage.vaults(id) VALUES($1)',
        [credentialHash],
      );
      await client.query(
        'UPDATE station_private_usage.capacity SET vaults=vaults+1 WHERE singleton=true',
      );
      return { created: true, receiverEpoch };
    });
  }
  async commit(key: string, raw: unknown): Promise<PrivateUsageCommitReceipt> {
    const id = this.vaultId(key);
    let input: ReturnType<typeof parsePrivateUsageCommit>;
    try {
      input = parsePrivateUsageCommit(raw);
    } catch {
      throw new PrivateUsageError('invalid_commit');
    }
    const contentDigest = digest(canonical(input));
    return this.transaction(async (client) => {
      await assertPrivateUsageSchema(client);
      await client.query(
        'SELECT singleton FROM station_private_usage.capacity WHERE singleton=true FOR UPDATE',
      );
      const previous = await client.query<{
        digest: string;
        receipt: PrivateUsageCommitReceipt;
      }>(
        'SELECT digest,receipt FROM station_private_usage.commits WHERE vault_id=$1 AND operation_id=$2',
        [id, input.operationId],
      );
      const vault = await client.query<{
        binding: unknown;
        epoch: string;
        revoked: boolean;
        journal: PrivateUsageInvalidationCheckpoint | null;
        invalidation_baseline: string | null;
      }>(
        'SELECT binding,epoch,revoked,journal,invalidation_baseline::text FROM station_private_usage.vaults WHERE id=$1 FOR UPDATE',
        [id],
      );
      if (!vault.rows[0] || vault.rows[0].revoked)
        throw new PrivateUsageError('unauthorized');
      const identity = await client.query<{ epoch: string }>(
        'SELECT epoch::text AS epoch FROM station_private_usage.identity WHERE singleton=true',
      );
      const receiverEpoch = identity.rows[0].epoch;
      if (input.expectedReceiverEpoch !== receiverEpoch)
        throw new PrivateUsageError('conflict');

      if (previous.rows[0]) {
        if (previous.rows[0].digest !== contentDigest)
          throw new PrivateUsageError('conflict');
        return previous.rows[0].receipt;
      }
      if (vault.rows[0].binding !== null) {
        const journal = await this.journalState(
          client,
          id,
          vault.rows[0].epoch,
          vault.rows[0].journal,
          vault.rows[0].invalidation_baseline,
        );
        if (input.sourceRevision < journal.after)
          throw new PrivateUsageError('conflict');
      }
      if (Date.parse(input.binding.expiresAt) <= Date.now())
        throw new PrivateUsageError('expired');
      if (
        vault.rows[0].binding !== null &&
        (canonical(vault.rows[0].binding) !== canonical(input.binding) ||
          vault.rows[0].epoch !== input.page.streamEpoch)
      )
        throw new PrivateUsageError('conflict');
      const checkpoint = await client.query<{
        body: PrivateUsageCheckpoint;
        revision: string;
      }>(
        'SELECT body,revision::text AS revision FROM station_private_usage.checkpoints WHERE vault_id=$1 AND window_from=$2 AND window_to=$3 FOR UPDATE',
        [id, input.query.from, input.query.to],
      );
      const old = checkpoint.rows[0]?.body;
      const witness = await client.query<{ revision: string }>(
        'SELECT COALESCE(MAX(checkpoint_revision),0)::text AS revision FROM station_private_usage.commits WHERE vault_id=$1 AND window_from=$2 AND window_to=$3',
        [id, input.query.from, input.query.to],
      );
      if (
        (!old && witness.rows[0].revision !== '0') ||
        (old &&
          (String(old.revision) !== checkpoint.rows[0].revision ||
            checkpoint.rows[0].revision !== witness.rows[0].revision ||
            old.receiverEpoch !== receiverEpoch))
      )
        throw new PrivateUsageError('schema_unavailable');

      if ((old?.revision ?? 0) !== input.expectedCheckpoint)
        throw new PrivateUsageError('conflict');
      if (
        old &&
        (input.page.highWater < old.highWater ||
          input.sourceRevision < old.sourceRevision)
      )
        throw new PrivateUsageError('conflict');
      if (old && !old.completeThroughHighWater && !input.restartSnapshot) {
        if (
          input.query.cursor !== old.nextCursor ||
          input.query.snapshot?.streamEpoch !== old.streamEpoch ||
          input.query.snapshot.highWater !== old.highWater ||
          input.query.snapshot.afterGlobalSequence !==
            old.afterGlobalSequence ||
          input.sourceRevision !== old.sourceRevision
        )
          throw new PrivateUsageError('conflict');
      } else if (input.query.cursor !== undefined)
        throw new PrivateUsageError('conflict');
      if (vault.rows[0].binding === null) {
        await client.query(
          'UPDATE station_private_usage.vaults SET binding=$2::jsonb,epoch=$3,invalidation_baseline=$4,journal=$5::jsonb WHERE id=$1',
          [
            id,
            JSON.stringify(input.binding),
            input.page.streamEpoch,
            input.sourceRevision,
            JSON.stringify({
              after: input.sourceRevision,
              streamEpoch: input.page.streamEpoch,
              highWater: input.sourceRevision,
            }),
          ],
        );
      }
      const commits = await client.query<{ total: string }>(
        'SELECT COUNT(*)::text AS total FROM station_private_usage.commits WHERE vault_id=$1',
        [id],
      );
      if (Number(commits.rows[0]?.total) >= 10000)
        throw new PrivateUsageError('capacity');
      const size = await client.query<{ bytes: string }>(
        'SELECT pg_database_size(current_database())::text AS bytes',
      );
      if (Number(size.rows[0]?.bytes) > this.maxBytes)
        throw new PrivateUsageError('capacity');
      let inserted = 0,
        alreadyPresent = 0;
      for (const observation of input.page.observations) {
        const body = canonical(observation);
        const observationDigest = digest(body);
        const existing = await client.query<{ digest: string }>(
          'SELECT digest FROM station_private_usage.observations WHERE vault_id=$1 AND epoch=$2 AND global_sequence=$3',
          [id, input.page.streamEpoch, observation.globalSequence],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].digest !== observationDigest)
            throw new PrivateUsageError('conflict');
          alreadyPresent++;
          await client.query(
            'UPDATE station_private_usage.observations SET source_revision=GREATEST(source_revision,$4) WHERE vault_id=$1 AND epoch=$2 AND global_sequence=$3',
            [
              id,
              input.page.streamEpoch,
              observation.globalSequence,
              input.sourceRevision,
            ],
          );
        } else {
          await client.query(
            'INSERT INTO station_private_usage.observations(vault_id,epoch,global_sequence,digest,body,source_revision) VALUES($1,$2,$3,$4,$5::jsonb,$6)',
            [
              id,
              input.page.streamEpoch,
              observation.globalSequence,
              observationDigest,
              JSON.stringify(observation),
              input.sourceRevision,
            ],
          );
          inserted++;
        }
      }
      if (inserted > 0) await this.invalidateReceiptIndex(client, id);
      const capacity = await client.query<{ observations: string }>(
        'SELECT observations::text AS observations FROM station_private_usage.capacity WHERE singleton=true',
      );
      if (
        !capacity.rows[0] ||
        Number(capacity.rows[0].observations) + inserted > this.maxObservations
      )
        throw new PrivateUsageError('capacity');
      await client.query(
        'UPDATE station_private_usage.capacity SET observations=observations+$1 WHERE singleton=true',
        [inserted],
      );
      const last = input.page.nextCursor
        ? (input.page.observations.at(-1)?.globalSequence ?? 0)
        : input.page.highWater;
      const next: PrivateUsageCheckpoint = {
        receiverEpoch,
        revision: input.expectedCheckpoint + 1,
        streamEpoch: input.page.streamEpoch,
        highWater: input.page.highWater,
        afterGlobalSequence: last,
        ...(input.page.nextCursor ? { nextCursor: input.page.nextCursor } : {}),
        sourceRevision: input.sourceRevision,
        completeThroughHighWater: input.page.nextCursor === undefined,
      };
      await client.query(
        'INSERT INTO station_private_usage.checkpoints(vault_id,window_from,window_to,revision,body) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(vault_id,window_from,window_to) DO UPDATE SET revision=excluded.revision,body=excluded.body',
        [
          id,
          input.query.from,
          input.query.to,
          next.revision,
          JSON.stringify(next),
        ],
      );
      const time = await client.query<{ now: string }>(
        'SELECT to_char(clock_timestamp() AT TIME ZONE \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\') AS now',
      );
      const receipt: PrivateUsageCommitReceipt = {
        protocol: 'station-private-usage-commit-receipt/v1',
        operationId: input.operationId,
        checkpoint: next,
        inserted,
        alreadyPresent,
        storedAt: time.rows[0].now,
      };
      await client.query(
        'INSERT INTO station_private_usage.commits(vault_id,operation_id,window_from,window_to,checkpoint_revision,digest,receipt) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
        [
          id,
          input.operationId,
          input.query.from,
          input.query.to,
          next.revision,
          contentDigest,
          JSON.stringify(receipt),
        ],
      );
      return receipt;
    });
  }
  private async checkpointState(
    client: PrivateUsageSqlClient,
    id: string,
    from: string,
    to: string,
  ) {
    const vault = await client.query<{
      revoked: boolean;
      epoch: string | null;
      journal: PrivateUsageInvalidationCheckpoint | null;
      invalidation_baseline: string | null;
    }>(
      'SELECT revoked,epoch,journal,invalidation_baseline::text FROM station_private_usage.vaults WHERE id=$1',
      [id],
    );
    if (!vault.rows[0] || vault.rows[0].revoked)
      throw new PrivateUsageError('unauthorized');
    const r = await client.query<{
      body: PrivateUsageCheckpoint;
      revision: string;
    }>(
      'SELECT body,revision::text AS revision FROM station_private_usage.checkpoints WHERE vault_id=$1 AND window_from=$2 AND window_to=$3',
      [id, from, to],
    );
    const identity = await client.query<{ epoch: string }>(
      'SELECT epoch::text AS epoch FROM station_private_usage.identity WHERE singleton=true',
    );
    const witness = await client.query<{ revision: string }>(
      'SELECT COALESCE(MAX(checkpoint_revision),0)::text AS revision FROM station_private_usage.commits WHERE vault_id=$1 AND window_from=$2 AND window_to=$3',
      [id, from, to],
    );
    const checkpoint = r.rows[0]?.body;
    if (
      (!checkpoint && witness.rows[0].revision !== '0') ||
      (checkpoint &&
        (String(checkpoint.revision) !== r.rows[0].revision ||
          r.rows[0].revision !== witness.rows[0].revision ||
          checkpoint.receiverEpoch !== identity.rows[0].epoch))
    )
      throw new PrivateUsageError('schema_unavailable');
    const value = vault.rows[0];
    const journal =
      value.epoch === null
        ? null
        : await this.journalState(
            client,
            id,
            value.epoch,
            value.journal,
            value.invalidation_baseline,
          );
    return {
      receiverEpoch: identity.rows[0].epoch,
      checkpoint: checkpoint ?? null,
      journal,
    };
  }
  async checkpoint(key: string, from: string, to: string) {
    const id = this.vaultId(key);
    return this.transaction(async (client) => {
      await assertPrivateUsageSchema(client);
      return this.checkpointState(client, id, from, to);
    });
  }
  private async invalidateReceiptIndex(
    client: PrivateUsageSqlClient,
    id: string,
  ) {
    await client.query(
      'DELETE FROM station_private_usage.current_receipts WHERE vault_id=$1',
      [id],
    );
    await client.query(
      'DELETE FROM station_private_usage.receipt_indexes WHERE vault_id=$1',
      [id],
    );
    await client.query(
      'UPDATE station_private_usage.vaults SET data_revision=data_revision+1 WHERE id=$1',
      [id],
    );
  }
  async queryReceipts(key: string, raw: unknown) {
    const id = this.vaultId(key);
    let input: ReturnType<typeof parsePrivateUsageReceiptQuery>;
    try {
      input = parsePrivateUsageReceiptQuery(raw);
    } catch {
      throw new PrivateUsageError('invalid_commit');
    }
    return this.transaction(async (client) => {
      await assertPrivateUsageSchema(client);
      await client.query(
        'SELECT singleton FROM station_private_usage.capacity WHERE singleton=true FOR UPDATE',
      );
      const state = await this.checkpointState(
        client,
        id,
        input.from,
        input.to,
      );
      const cp = state.checkpoint;
      if (
        !cp ||
        state.receiverEpoch !== input.expectedReceiverEpoch ||
        cp.revision !== input.expectedCheckpoint ||
        !cp.completeThroughHighWater ||
        cp.highWater !== input.expectedHighWater ||
        cp.sourceRevision !== input.expectedSourceRevision ||
        state.journal?.after !== input.expectedSourceRevision ||
        state.journal.nextCursor
      )
        throw new PrivateUsageError('conflict');
      const vault = await client.query<{
        binding: ReturnType<typeof parsePrivateUsageCommit>['binding'];
        epoch: string;
        data_revision: string;
      }>(
        'SELECT binding,epoch,data_revision::text FROM station_private_usage.vaults WHERE id=$1',
        [id],
      );
      const v = vault.rows[0];
      if (!v?.binding || Date.parse(v.binding.expiresAt) <= Date.now())
        throw new PrivateUsageError('expired');
      const size = await client.query<{ bytes: string }>(
        'SELECT pg_database_size(current_database())::text AS bytes',
      );
      if (Number(size.rows[0].bytes) > this.maxBytes)
        throw new PrivateUsageError('capacity');
      try {
        return await readPrivateReceiptIndex(client, {
          vaultId: id,
          stationId: v.binding.sourceStationId,
          scope: v.binding.scope,
          epoch: v.epoch,
          dataRevision: v.data_revision,
          checkpointRevision: cp.revision,
          sourceRevision: input.expectedSourceRevision,
          from: input.from,
          to: input.to,
          highWater: input.expectedHighWater,
          expiresAt: v.binding.expiresAt,
          retentionDays:
            v.binding.retention.mode === 'retained-copy'
              ? v.binding.retention.days
              : 90,
          ...(input.indexId ? { indexId: input.indexId } : {}),
          ...(input.after ? { after: input.after } : {}),
        });
      } catch (error) {
        if (error instanceof PrivateReceiptIndexError)
          throw new PrivateUsageError(error.code);
        throw error;
      }
    });
  }
  async observations(key: string, after: number, highWater?: number) {
    const id = this.vaultId(key);
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      (highWater !== undefined &&
        (!Number.isSafeInteger(highWater) || highWater < after))
    )
      throw new PrivateUsageError('invalid_commit');
    return this.transaction(async (client) => {
      await assertPrivateUsageSchema(client);
      const v = await client.query<{
        binding: ReturnType<typeof parsePrivateUsageCommit>['binding'] | null;
        epoch: string;
        revoked: boolean;
      }>(
        'SELECT binding,epoch,revoked FROM station_private_usage.vaults WHERE id=$1',
        [id],
      );
      const vault = v.rows[0];
      if (!vault || vault.revoked) throw new PrivateUsageError('unauthorized');
      if (!vault.binding) throw new PrivateUsageError('conflict');
      if (
        vault.binding.retention.mode === 'live-mirror' &&
        Date.parse(vault.binding.expiresAt) <= Date.now()
      )
        throw new PrivateUsageError('expired');
      const days =
        vault.binding.retention.mode === 'retained-copy'
          ? vault.binding.retention.days
          : 90;
      const head = await client.query<{ head: string }>(
        'SELECT COALESCE(MAX(global_sequence),0)::text AS head FROM station_private_usage.observations WHERE vault_id=$1',
        [id],
      );
      const through = highWater ?? Number(head.rows[0].head);
      if (through > Number(head.rows[0].head) || after > through)
        throw new PrivateUsageError('conflict');
      const rows = await client.query<{
        global_sequence: string;
        source_revision: string;
        body: unknown;
      }>(
        `SELECT global_sequence::text,source_revision::text,body FROM station_private_usage.observations AS o
        WHERE vault_id=$1 AND global_sequence>$2 AND global_sequence<=$3 AND stored_at>=clock_timestamp()-($4::integer*interval '1 day')
        ORDER BY o.global_sequence LIMIT 101`,
        [id, after, through, days],
      );
      const selected = rows.rows.slice(0, 100);
      return {
        protocol: 'station-private-usage-observations/v1' as const,
        sourceAuthority: 'not-verified-by-storage' as const,
        coverage: 'retained-observations-only' as const,
        retentionDays: days,
        streamEpoch: vault.epoch,
        highWater: through,
        observations: selected.map((row) => ({
          globalSequence: Number(row.global_sequence),
          sourceRevision: Number(row.source_revision),
          observation: row.body,
        })),
        nextAfter:
          rows.rows.length > 100
            ? Number(selected.at(-1)?.global_sequence)
            : through,
        hasMore: rows.rows.length > 100,
      };
    });
  }
  async revoke(key: string) {
    const id = this.vaultId(key);
    return this.transaction(async (client) => {
      await assertPrivateUsageSchema(client);
      await client.query(
        'SELECT singleton FROM station_private_usage.capacity WHERE singleton=true FOR UPDATE',
      );
      const vault = await client.query(
        'UPDATE station_private_usage.vaults SET revoked=true WHERE id=$1 RETURNING id',
        [id],
      );
      if (!vault.rowCount) throw new PrivateUsageError('unauthorized');
      const removed = await client.query(
        'DELETE FROM station_private_usage.observations WHERE vault_id=$1',
        [id],
      );
      await this.invalidateReceiptIndex(client, id);
      await client.query(
        'DELETE FROM station_private_usage.checkpoints WHERE vault_id=$1',
        [id],
      );
      await client.query(
        'DELETE FROM station_private_usage.commits WHERE vault_id=$1',
        [id],
      );
      await client.query(
        'DELETE FROM station_private_usage.invalidation_commits WHERE vault_id=$1',
        [id],
      );
      await client.query(
        'UPDATE station_private_usage.capacity SET observations=observations-$1 WHERE singleton=true',
        [removed.rowCount ?? 0],
      );
      return { revoked: true as const };
    });
  }
  async prune() {
    return this.transaction(async (client) => {
      await assertPrivateUsageSchema(client);
      await client.query(
        'SELECT singleton FROM station_private_usage.capacity WHERE singleton=true FOR UPDATE',
      );
      const removed =
        await client.query(`DELETE FROM station_private_usage.observations o USING station_private_usage.vaults v
        WHERE o.vault_id=v.id AND (v.revoked OR
          (v.binding->'retention'->>'mode'='live-mirror' AND (v.binding->>'expiresAt')::timestamptz<=clock_timestamp()) OR
          o.stored_at<clock_timestamp()-(CASE WHEN v.binding->'retention'->>'mode'='retained-copy' THEN (v.binding->'retention'->>'days')::integer ELSE 90 END)*interval '1 day') RETURNING o.vault_id`);
      await client.query(
        'UPDATE station_private_usage.capacity SET observations=observations-$1 WHERE singleton=true',
        [removed.rowCount ?? 0],
      );
      for (const id of new Set(removed.rows.map((row) => String(row.vault_id))))
        await this.invalidateReceiptIndex(client, id);
      return removed.rowCount ?? 0;
    });
  }
  async receipt(key: string, operationId: string) {
    const id = this.vaultId(key);
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        operationId,
      )
    )
      throw new PrivateUsageError('invalid_commit');
    return this.transaction(async (client) => {
      await assertPrivateUsageSchema(client);
      const r = await client.query<{ receipt: PrivateUsageCommitReceipt }>(
        'SELECT c.receipt FROM station_private_usage.commits c JOIN station_private_usage.vaults v ON v.id=c.vault_id WHERE c.vault_id=$1 AND c.operation_id=$2 AND NOT v.revoked',
        [id, operationId],
      );
      return r.rows[0]?.receipt ?? null;
    });
  }
}
