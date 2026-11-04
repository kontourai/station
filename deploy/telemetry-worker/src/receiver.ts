// The Lite receiver's state: one SQLite-backed Durable Object owns every
// source, ping, salt, marginal and publication, which gives the Worker the
// same single-writer semantics the Node receiver gets from running one
// process. Each request runs its SQL synchronously inside one
// `transactionSync`, so a refused write leaves nothing behind.
//
// Everything a sender or an operator can observe (validation, normalization,
// marginal values, daily keys, publication cells, cursors and response
// shapes) comes from the Node receiver's lite-core.ts. This file holds only
// the SQLite adapter, the alarm schedule and the Worker-to-object protocol.
//
// Like the push gateway's ledger, the class answers plain fetch requests
// (a small JSON protocol) rather than RPC, so it needs no
// `cloudflare:workers` import and runs under Node's SQLite for tests.
import { randomBytes } from 'node:crypto';
import { BrokerError } from '../../../packages/telemetry-broker/src/broker-error.ts';
import {
  addUtcDays,
  admitLiteObservation,
  brokerErrorStatus,
  dailyClientKeys,
  exactLiteView,
  finalizationFailureCode,
  isoWeekStart,
  LITE_EXACT_ROW_LIMIT,
  LITE_PAGE_CELLS,
  LITE_PUBLISHER_CATALOG_LIMIT,
  LITE_SOURCE_LIMIT,
  LiteDailyBudget,
  type LiteFinalizationFailure,
  parseLiteSource,
  parsePublicationCursor,
  publicationCursorSigner,
  publicationPage,
  publishedWeekCells,
  utcDay,
  verifyPublicationCursor,
} from '../../../packages/telemetry-broker/src/lite-core.ts';
import { PUBLIC_FIELDS } from '../../../packages/telemetry-broker/src/public-domain.ts';

type Binding = string | number | null;
type Row = Record<string, unknown>;

/** The subset of a Durable Object's `ctx.storage` the receiver uses. */
export interface ReceiverStorage {
  sql: {
    exec(query: string, ...bindings: Binding[]): { toArray(): Row[] };
    /** Bytes the object's database occupies. */
    readonly databaseSize: number;
  };
  transactionSync<T>(operation: () => T): T;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}

export interface ReceiverLimits {
  /** Retained Lite rows (pings plus feedback). */
  maxRows: number;
  /** Database bytes; ingestion and provisioning refuse at or above it. */
  maxBytes: number;
  /** UTC days kept, including today. */
  retentionDays: number;
}

export const DEFAULT_LIMITS: ReceiverLimits = {
  maxRows: 1_000_000,
  maxBytes: 1_073_741_824,
  retentionDays: 90,
};

const SCHEMA_VERSION = 1;
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS lite_schema (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS lite_sources (
    id TEXT PRIMARY KEY, publisher TEXT NOT NULL, channel TEXT NOT NULL,
    registry_ids TEXT NOT NULL, release_versions TEXT NOT NULL,
    version_policy TEXT NOT NULL CHECK (version_policy IN ('catalog','semver')),
    enabled INTEGER NOT NULL DEFAULT 1)`,
  // `day` is the UTC arrival day. `client_hash` and `contributions` exist
  // only until the day is finalized; erasure sets both to NULL.
  `CREATE TABLE IF NOT EXISTS lite_pings (
    source_id TEXT NOT NULL REFERENCES lite_sources(id), event_id TEXT NOT NULL,
    day TEXT NOT NULL, ping TEXT NOT NULL, client_hash TEXT, contributions TEXT,
    PRIMARY KEY (source_id, event_id))`,
  `CREATE INDEX IF NOT EXISTS lite_pings_day ON lite_pings (day)`,
  `CREATE TABLE IF NOT EXISTS lite_feedback (
    source_id TEXT NOT NULL REFERENCES lite_sources(id), publisher TEXT NOT NULL,
    action TEXT NOT NULL, reason TEXT NOT NULL, day TEXT NOT NULL, client_hash TEXT,
    UNIQUE (day, publisher, action, client_hash))`,
  `CREATE INDEX IF NOT EXISTS lite_feedback_day ON lite_feedback (day)`,
  `CREATE TABLE IF NOT EXISTS lite_marginals (
    day TEXT NOT NULL, publisher TEXT NOT NULL, dimension TEXT NOT NULL, value TEXT NOT NULL,
    pings INTEGER NOT NULL CHECK (pings > 0), clients INTEGER NOT NULL CHECK (clients > 0),
    PRIMARY KEY (day, publisher, dimension, value))`,
  // One random salt per UTC arrival day. Deleted as soon as the day closes:
  // without it nobody, including the operator, can recompute a client key.
  `CREATE TABLE IF NOT EXISTS lite_salts (day TEXT PRIMARY KEY, salt TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS lite_noise_key (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), secret TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS lite_capacity (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), rows INTEGER NOT NULL CHECK (rows >= 0))`,
  `CREATE TABLE IF NOT EXISTS lite_publications (week TEXT NOT NULL, publisher TEXT NOT NULL, PRIMARY KEY (week, publisher))`,
  `CREATE TABLE IF NOT EXISTS lite_published (
    week TEXT NOT NULL, publisher TEXT NOT NULL, dimension TEXT NOT NULL, value TEXT NOT NULL,
    estimate INTEGER NOT NULL CHECK (estimate >= 0), PRIMARY KEY (week, publisher, dimension, value))`,
  `CREATE TABLE IF NOT EXISTS lite_finalization_failures (
    period TEXT NOT NULL, publisher TEXT NOT NULL, stage TEXT NOT NULL, code TEXT NOT NULL)`,
];

const one = (rows: Row[]) => rows[0];
const text = (value: unknown) => String(value);
const integer = (value: unknown) => Number(value ?? 0);

/** The receiver's logic over SQL, independent of the Durable Object runtime. */
export class LiteReceiverStore {
  private readonly budget = new LiteDailyBudget();
  private invalidClientIpHeaders = 0;

  constructor(
    private readonly storage: ReceiverStorage,
    readonly limits: ReceiverLimits = DEFAULT_LIMITS,
  ) {
    storage.transactionSync(() => {
      for (const statement of SCHEMA) this.exec(statement);
      const schema = one(this.exec(`SELECT version FROM lite_schema`));
      if (!schema)
        this.exec(`INSERT INTO lite_schema VALUES (1, ?)`, SCHEMA_VERSION);
      else if (integer(schema.version) !== SCHEMA_VERSION)
        throw new BrokerError('schema_incompatible');
      this.exec(
        `INSERT OR IGNORE INTO lite_noise_key VALUES (1, ?)`,
        randomBytes(32).toString('hex'),
      );
      this.exec(`INSERT OR IGNORE INTO lite_capacity VALUES (1, 0)`);
    });
  }

  private exec(query: string, ...bindings: Binding[]): Row[] {
    return this.storage.sql.exec(query, ...bindings).toArray();
  }

  private assertStorageRoom(): void {
    if (this.storage.sql.databaseSize >= this.limits.maxBytes)
      throw new BrokerError('storage_limit');
  }

  private noiseKey(): Buffer {
    return Buffer.from(
      text(one(this.exec(`SELECT secret FROM lite_noise_key`))?.secret),
      'hex',
    );
  }

  /**
   * Today's salt, created on the day's first arrival. Any other day's salt
   * is deleted in the same step, so a closed day's salt is gone by the
   * next day's first request even if the maintenance alarm has not run.
   */
  private saltFor(day: string): Buffer {
    const existing = one(
      this.exec(`SELECT salt FROM lite_salts WHERE day = ?`, day),
    );
    if (existing) return Buffer.from(text(existing.salt), 'hex');
    const salt = randomBytes(32);
    this.storage.transactionSync(() => {
      this.exec(`DELETE FROM lite_salts WHERE day <> ?`, day);
      this.exec(
        `INSERT INTO lite_salts VALUES (?, ?)`,
        day,
        salt.toString('hex'),
      );
    });
    return salt;
  }

  private addRows(delta: number): void {
    if (delta > 0) {
      const capacity = one(this.exec(`SELECT rows FROM lite_capacity`));
      if (integer(capacity?.rows) + delta > this.limits.maxRows)
        throw new BrokerError('storage_limit');
    }
    this.exec(`UPDATE lite_capacity SET rows = max(0, rows + ?)`, delta);
  }

  /**
   * `POST /v1/lite/:source`. `address` is the transient client address; only
   * its two daily HMACs are used, and only the contributor HMAC is stored.
   */
  ingest(
    sourceId: string,
    body: unknown,
    address: string,
    addressValid: boolean,
    now: number,
  ): { status: number; body: unknown; headers?: Record<string, string> } {
    if (!addressValid)
      this.invalidClientIpHeaders = Math.min(
        Number.MAX_SAFE_INTEGER,
        this.invalidClientIpHeaders + 1,
      );
    const day = utcDay(now);
    // The salt commits on its own: a refused body must not roll it back,
    // or the day's next request would key the same network differently.
    const keys = dailyClientKeys(this.saltFor(day), address);
    if (!this.budget.admit(day, keys.rate))
      return {
        status: 429,
        body: { error: 'lite_rate_limit' },
        headers: { 'Retry-After': '86400' },
      };
    return this.storage.transactionSync(() => {
      this.assertStorageRoom();
      const source = one(
        this.exec(
          `SELECT publisher, channel, registry_ids, release_versions, version_policy
           FROM lite_sources WHERE id = ? AND enabled = 1`,
          sourceId,
        ),
      );
      if (!source) throw new BrokerError('source_unauthorized');
      const observation = admitLiteObservation(body, {
        publisher: text(source.publisher) as never,
        channel: text(source.channel),
        registryIds: JSON.parse(text(source.registry_ids)),
        releaseVersions: JSON.parse(text(source.release_versions)),
        versionPolicy:
          source.version_policy === 'semver' ? 'semver' : 'catalog',
      });
      if (observation.kind === 'feedback') {
        // The first feedback per publisher/action/day/network wins, across
        // source aliases and changed reasons; retries answer the same 202.
        const inserted = this.exec(
          `INSERT INTO lite_feedback VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING RETURNING 1`,
          sourceId,
          observation.feedback.publisher,
          observation.feedback.action,
          observation.feedback.reason,
          day,
          keys.contributor,
        );
        if (inserted.length) this.addRows(1);
        return { status: 202, body: { accepted: true } };
      }
      const prior = one(
        this.exec(
          `SELECT ping FROM lite_pings WHERE source_id = ? AND event_id = ?`,
          sourceId,
          observation.ping.event_id,
        ),
      );
      if (prior) {
        if (prior.ping !== observation.json)
          throw new BrokerError('event_conflict');
        return { status: 202, body: { accepted: true } };
      }
      this.addRows(1);
      this.exec(
        `INSERT INTO lite_pings VALUES (?, ?, ?, ?, ?, ?)`,
        sourceId,
        observation.ping.event_id,
        day,
        observation.json,
        keys.contributor,
        JSON.stringify(observation.contributions),
      );
      return { status: 202, body: { accepted: true } };
    });
  }

  createSource(value: unknown): void {
    const source = parseLiteSource(value);
    this.storage.transactionSync(() => {
      this.assertStorageRoom();
      const existing = this.exec(
        `SELECT registry_ids, release_versions FROM lite_sources WHERE publisher = ?`,
        source.publisher,
      );
      const versions = new Set(source.releaseVersions);
      const ids = new Set(source.registryIds);
      for (const row of existing) {
        for (const v of JSON.parse(text(row.release_versions))) versions.add(v);
        for (const v of JSON.parse(text(row.registry_ids))) ids.add(v);
      }
      if (
        versions.size > LITE_PUBLISHER_CATALOG_LIMIT ||
        ids.size > LITE_PUBLISHER_CATALOG_LIMIT
      )
        throw new BrokerError('invalid_source');
      if (
        integer(one(this.exec(`SELECT count(*) AS n FROM lite_sources`))?.n) >=
        LITE_SOURCE_LIMIT
      )
        throw new BrokerError('storage_limit');
      const inserted = this.exec(
        `INSERT INTO lite_sources VALUES (?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT DO NOTHING RETURNING 1`,
        source.id,
        source.publisher,
        source.channel,
        JSON.stringify(source.registryIds),
        JSON.stringify(source.releaseVersions),
        source.versionPolicy,
      );
      if (!inserted.length) throw new BrokerError('source_conflict');
    });
  }

  revokeSource(id: string): boolean {
    return (
      this.exec(
        `UPDATE lite_sources SET enabled = 0 WHERE id = ? AND enabled = 1 RETURNING 1`,
        id,
      ).length === 1
    );
  }

  /**
   * The maintenance pass the alarm runs: erase closed days' salts, finalize
   * closed days, erase their contributor hashes, publish closed weeks and
   * apply retention. Each publisher/day and publisher/week commits on its
   * own, so one failure never blocks the others; failures are recorded as
   * content-free codes for the operator view.
   */
  maintain(now: number): void {
    const today = utcDay(now);
    const failures: LiteFinalizationFailure[] = [];
    this.exec(`DELETE FROM lite_salts WHERE day < ?`, today);
    const pending = this.exec(
      `SELECT DISTINCT p.day AS day, s.publisher AS publisher
       FROM lite_pings p JOIN lite_sources s ON s.id = p.source_id
       WHERE p.day < ? AND p.client_hash IS NOT NULL ORDER BY day, publisher`,
      today,
    );
    for (const job of pending) {
      const day = text(job.day);
      const publisher = text(job.publisher);
      try {
        this.storage.transactionSync(() => this.finalizeDay(day, publisher));
      } catch (error) {
        failures.push({
          period: day,
          publisher,
          stage: 'daily',
          code: finalizationFailureCode(error),
        });
      }
    }
    this.exec(
      `UPDATE lite_feedback SET client_hash = NULL WHERE day < ? AND client_hash IS NOT NULL`,
      today,
    );
    this.publishWeeks(today, failures);
    this.retain(today);
    this.storage.transactionSync(() => {
      this.exec(`DELETE FROM lite_finalization_failures`);
      for (const failure of failures.slice(0, 100))
        this.exec(
          `INSERT INTO lite_finalization_failures VALUES (?, ?, ?, ?)`,
          failure.period,
          failure.publisher,
          failure.stage,
          failure.code,
        );
    });
    this.omittedFailures = Math.max(0, failures.length - 100);
  }
  private omittedFailures = 0;

  /** Exact marginals for one closed publisher/day, then erasure of its keys. */
  private finalizeDay(day: string, publisher: string): void {
    this.exec(
      `INSERT OR REPLACE INTO lite_marginals
       SELECT p.day, s.publisher, d.key, v.value, count(*), count(DISTINCT p.client_hash)
       FROM lite_pings p JOIN lite_sources s ON s.id = p.source_id,
         json_each(p.contributions) d, json_each(d.value) v
       WHERE p.day = ? AND s.publisher = ? AND p.client_hash IS NOT NULL
       GROUP BY d.key, v.value`,
      day,
      publisher,
    );
    this.exec(
      `UPDATE lite_pings SET client_hash = NULL, contributions = NULL
       WHERE day = ? AND client_hash IS NOT NULL
       AND source_id IN (SELECT id FROM lite_sources WHERE publisher = ?)`,
      day,
      publisher,
    );
  }

  /**
   * Publishes each of the last four closed ISO weeks once per publisher, after
   * every day in it is finalized. A publication is immutable: its marker is
   * claimed in the same transaction as its cells and never rewritten.
   */
  private publishWeeks(
    today: string,
    failures: LiteFinalizationFailure[],
  ): void {
    const current = isoWeekStart(today);
    const publishers = this.exec(
      `SELECT DISTINCT publisher FROM lite_sources ORDER BY publisher`,
    ).map((row) => text(row.publisher));
    for (let offset = 28; offset >= 7; offset -= 7) {
      const week = addUtcDays(current, -offset);
      const end = addUtcDays(week, 7);
      for (const publisher of publishers) {
        try {
          this.storage.transactionSync(() => {
            if (
              one(
                this.exec(
                  `SELECT 1 FROM lite_publications WHERE week = ? AND publisher = ?`,
                  week,
                  publisher,
                ),
              )
            )
              return;
            const unfinished = one(
              this.exec(
                `SELECT 1 FROM lite_pings p JOIN lite_sources s ON s.id = p.source_id
                 WHERE s.publisher = ? AND p.day >= ? AND p.day < ? AND p.client_hash IS NOT NULL LIMIT 1`,
                publisher,
                week,
                end,
              ),
            );
            if (unfinished) return;
            this.exec(
              `INSERT INTO lite_publications VALUES (?, ?)`,
              week,
              publisher,
            );
            // Catalogs are operator configuration, never observed values.
            const catalogs = this.exec(
              `SELECT registry_ids, release_versions, version_policy
               FROM lite_sources WHERE publisher = ? ORDER BY id`,
              publisher,
            ).map((row) => ({
              registry_ids: JSON.parse(text(row.registry_ids)) as string[],
              release_versions: JSON.parse(
                text(row.release_versions),
              ) as string[],
              version_policy: text(row.version_policy),
            }));
            const totals = new Map(
              this.exec(
                `SELECT dimension, value, sum(clients) AS clients FROM lite_marginals
                 WHERE publisher = ? AND day >= ? AND day < ?
                 AND dimension IN (SELECT value FROM json_each(?))
                 GROUP BY dimension, value`,
                publisher,
                week,
                end,
                JSON.stringify(PUBLIC_FIELDS),
              ).map((row) => [
                JSON.stringify([text(row.dimension), text(row.value)]),
                integer(row.clients),
              ]),
            );
            for (const cell of publishedWeekCells(
              this.noiseKey(),
              publisher,
              week,
              catalogs,
              totals,
            ))
              this.exec(
                `INSERT INTO lite_published VALUES (?, ?, ?, ?, ?)`,
                week,
                publisher,
                cell.dimension,
                cell.value,
                cell.estimate,
              );
          });
        } catch (error) {
          failures.push({
            period: week,
            publisher,
            stage: 'weekly',
            code: finalizationFailureCode(error),
          });
        }
      }
    }
  }

  /** Keeps `retentionDays` UTC days including today, in bounded batches. */
  private retain(today: string): void {
    const cutoff = addUtcDays(today, -(this.limits.retentionDays - 1));
    for (const table of ['lite_pings', 'lite_feedback'] as const) {
      for (;;) {
        const deleted = this.storage.transactionSync(() => {
          const count = this.exec(
            `DELETE FROM ${table} WHERE rowid IN
             (SELECT rowid FROM ${table} WHERE day < ? LIMIT 2000) RETURNING 1`,
            cutoff,
          ).length;
          this.addRows(-count);
          return count;
        });
        if (!deleted) break;
      }
    }
  }

  publicAggregates(cursor: string | undefined, now: number) {
    const today = utcDay(now);
    const current = isoWeekStart(today);
    const from = addUtcDays(current, -28);
    const publisher = 'kontour';
    const after = parsePublicationCursor(cursor);
    const sign = publicationCursorSigner(this.noiseKey(), publisher);
    verifyPublicationCursor(cursor, sign);
    const rows = this.exec(
      `SELECT week, dimension, value, estimate FROM lite_published
       WHERE publisher = ? AND week >= ? AND week < ?
       AND (? IS NULL OR (week, dimension, value) > (?, ?, ?))
       ORDER BY week, dimension, value LIMIT ${LITE_PAGE_CELLS + 1}`,
      publisher,
      from,
      current,
      after?.[0] ?? null,
      after?.[0] ?? null,
      after?.[1] ?? null,
      after?.[2] ?? null,
    ).map((row) => ({
      week: text(row.week),
      dimension: text(row.dimension),
      value: text(row.value),
      estimate: row.estimate,
    }));
    const bound = one(
      this.exec(
        `SELECT coalesce(max(n), 0) AS n FROM (SELECT count(*) AS n FROM lite_published
         WHERE publisher = ? AND week >= ? AND week < ? GROUP BY week)`,
        publisher,
        from,
        current,
      ),
    );
    return publicationPage({
      publisher,
      databaseDay: today,
      rows,
      maximumCoordinates: integer(bound?.n),
      sign,
    });
  }

  exact(period: 'daily' | 'weekly', now: number) {
    const today = utcDay(now);
    const weekly = period === 'weekly';
    const periodOf = weekly
      ? `date(day, '-' || ((cast(strftime('%w', day) AS INTEGER) + 6) % 7) || ' days')`
      : 'day';
    const from = weekly
      ? addUtcDays(isoWeekStart(today), -28)
      : addUtcDays(today, -30);
    const to = weekly ? isoWeekStart(today) : today;
    const marginals = this.exec(
      `SELECT ${periodOf} AS period, publisher, dimension, value,
       cast(sum(pings) AS TEXT) AS pings, cast(sum(clients) AS TEXT) AS contributors
       FROM lite_marginals WHERE day >= ? AND day < ?
       GROUP BY 1, publisher, dimension, value ORDER BY 1, publisher, dimension, value
       LIMIT ${LITE_EXACT_ROW_LIMIT + 1}`,
      from,
      to,
    );
    const feedback = this.exec(
      `SELECT ${periodOf} AS period, publisher, action, reason, cast(count(*) AS TEXT) AS count
       FROM lite_feedback WHERE day >= ?
       GROUP BY 1, publisher, action, reason ORDER BY 1, publisher, action, reason
       LIMIT ${LITE_EXACT_ROW_LIMIT + 1}`,
      addUtcDays(today, -(this.limits.retentionDays - 1)),
    );
    return exactLiteView({
      period,
      marginals,
      feedback,
      retentionDays: this.limits.retentionDays,
      failures: this.exec(
        `SELECT period, publisher, stage, code FROM lite_finalization_failures`,
      ) as unknown as LiteFinalizationFailure[],
      omittedFailures: this.omittedFailures,
      lifetime: 'latest-maintenance-pass',
    });
  }

  /**
   * The owner dashboard's data: exact pings per day for every dimension and
   * value, from the first day of the month three months back through today.
   * Closed, finalized days come from the marginals; days still holding
   * contributor keys (today, or a closed day the alarm has not finalized
   * yet) are counted live from raw pings. A ping is in exactly one of the
   * two, because finalization writes marginals and erases its key in one
   * transaction. Pings approximate active installs: one per install per day.
   */
  insights(now: number) {
    const today = utcDay(now);
    const monthStart = `${today.slice(0, 7)}-01`;
    const start = new Date(`${monthStart}T00:00:00Z`);
    start.setUTCMonth(start.getUTCMonth() - 3);
    const from = utcDay(start.getTime());
    const days: string[] = [];
    for (let day = from; day <= today; day = addUtcDays(day, 1)) days.push(day);
    const index = new Map(days.map((day, i) => [day, i]));
    const dimensions: Record<string, Record<string, number[]>> = {};
    const add = (
      day: string,
      dimension: string,
      value: string,
      pings: number,
    ) => {
      const i = index.get(day);
      if (i === undefined) return;
      dimensions[dimension] ??= {};
      dimensions[dimension][value] ??= days.map(() => 0);
      dimensions[dimension][value][i] += pings;
    };
    for (const row of this.exec(
      `SELECT day, dimension, value, sum(pings) AS pings FROM lite_marginals
       WHERE day >= ? GROUP BY day, dimension, value`,
      from,
    ))
      add(
        text(row.day),
        text(row.dimension),
        text(row.value),
        integer(row.pings),
      );
    const live = this.exec(
      `SELECT p.day AS day, d.key AS dimension, v.value AS value, count(*) AS pings
       FROM lite_pings p, json_each(p.contributions) d, json_each(d.value) v
       WHERE p.day >= ? AND p.client_hash IS NOT NULL GROUP BY 1, 2, 3`,
      from,
    );
    for (const row of live)
      add(
        text(row.day),
        text(row.dimension),
        text(row.value),
        integer(row.pings),
      );
    // `channel` is single-valued and always present: its values sum to the
    // day's pings.
    const totals = days.map((_, i) =>
      Object.values(dimensions.channel ?? {}).reduce(
        (sum, series) => sum + series[i],
        0,
      ),
    );
    return {
      scope: 'operator-insights',
      unit: 'pings',
      today,
      days,
      provisionalDays: [...new Set(live.map((row) => text(row.day)))].sort(),
      totals,
      dimensions,
      feedback: this.exec(
        `SELECT day, action, reason, count(*) AS count FROM lite_feedback
         WHERE day >= ? GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
        from,
      ).map((row) => ({
        day: text(row.day),
        action: text(row.action),
        reason: text(row.reason),
        count: integer(row.count),
      })),
    };
  }

  storageState() {
    return {
      state: 'ready',
      scope: 'durable-object-sqlite-v1',
      databaseBytes: this.storage.sql.databaseSize,
      maxBytes: this.limits.maxBytes,
      rows: integer(one(this.exec(`SELECT rows FROM lite_capacity`))?.rows),
      maxRows: this.limits.maxRows,
      retentionDays: this.limits.retentionDays,
    };
  }

  diagnostics() {
    return { invalidClientIpHeaders: this.invalidClientIpHeaders };
  }
}

/** One maintenance pass per UTC hour; midnight is an hour boundary. */
export const nextMaintenance = (now: number) =>
  Math.floor(now / 3_600_000) * 3_600_000 + 3_600_000 + 5_000;

export type ReceiverOperation =
  | {
      op: 'ingest';
      source: string;
      body: unknown;
      address: string;
      addressValid: boolean;
    }
  | { op: 'createSource'; source: unknown }
  | { op: 'revokeSource'; id: string }
  | { op: 'publicAggregates'; cursor?: string }
  | { op: 'exact'; period: 'daily' | 'weekly' }
  | { op: 'insights' }
  | { op: 'storage' }
  | { op: 'diagnostics' };

/**
 * The Durable Object. Only the receiver Worker reaches it (a namespace
 * binding, never a route), so the protocol carries no authentication; the
 * Worker authenticates operators before forwarding their operations.
 */
export class LiteReceiver {
  private readonly store: LiteReceiverStore;
  private alarmChecked = false;

  constructor(
    private readonly ctx: { storage: ReceiverStorage },
    env?: Partial<
      Record<'LITE_MAX_ROWS' | 'LITE_MAX_BYTES' | 'LITE_RETENTION_DAYS', string>
    >,
  ) {
    this.store = new LiteReceiverStore(ctx.storage, limitsFrom(env));
  }

  async fetch(request: Request): Promise<Response> {
    if (!this.alarmChecked) {
      this.alarmChecked = true;
      if ((await this.ctx.storage.getAlarm()) === null)
        await this.ctx.storage.setAlarm(nextMaintenance(Date.now()));
    }
    const operation = (await request
      .json()
      .catch(() => null)) as ReceiverOperation | null;
    try {
      const now = Date.now();
      switch (operation?.op) {
        case 'ingest': {
          const result = this.store.ingest(
            String(operation.source),
            operation.body,
            String(operation.address),
            operation.addressValid === true,
            now,
          );
          return Response.json(result.body, {
            status: result.status,
            headers: result.headers,
          });
        }
        case 'createSource':
          this.store.createSource(operation.source);
          return Response.json({ created: true }, { status: 201 });
        case 'revokeSource':
          return Response.json({
            revoked: this.store.revokeSource(String(operation.id)),
          });
        case 'publicAggregates':
          return Response.json(
            this.store.publicAggregates(
              typeof operation.cursor === 'string'
                ? operation.cursor
                : undefined,
              now,
            ),
          );
        case 'exact':
          return Response.json(
            this.store.exact(
              operation.period === 'weekly' ? 'weekly' : 'daily',
              now,
            ),
          );
        case 'insights':
          return Response.json(this.store.insights(now));
        case 'storage':
          return Response.json(this.store.storageState());
        case 'diagnostics':
          return Response.json(this.store.diagnostics());
        default:
          return Response.json({ error: 'invalid_operation' }, { status: 400 });
      }
    } catch (error) {
      // Never a storage message: those can carry contributor or rejected data.
      if (error instanceof BrokerError)
        return Response.json(
          { error: error.code },
          { status: brokerErrorStatus(error.code) },
        );
      return Response.json({ error: 'storage_unavailable' }, { status: 503 });
    }
  }

  /** The hourly maintenance pass; always reschedules itself. */
  async alarm(): Promise<void> {
    try {
      this.store.maintain(Date.now());
    } finally {
      await this.ctx.storage.setAlarm(nextMaintenance(Date.now()));
    }
  }
}

function limitsFrom(
  env?: Partial<
    Record<'LITE_MAX_ROWS' | 'LITE_MAX_BYTES' | 'LITE_RETENTION_DAYS', string>
  >,
): ReceiverLimits {
  const read = (
    value: string | undefined,
    fallback: number,
    min: number,
    max: number,
  ) => {
    if (value === undefined || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
      throw new Error('Invalid Lite receiver limit configuration');
    return parsed;
  };
  return {
    maxRows: read(env?.LITE_MAX_ROWS, DEFAULT_LIMITS.maxRows, 1, 100_000_000),
    maxBytes: read(
      env?.LITE_MAX_BYTES,
      DEFAULT_LIMITS.maxBytes,
      1,
      10 * 2 ** 30,
    ),
    retentionDays: read(
      env?.LITE_RETENTION_DAYS,
      DEFAULT_LIMITS.retentionDays,
      1,
      90,
    ),
  };
}

/** The subset of a Durable Object namespace binding the Worker uses. */
export interface ReceiverNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

/** One receiver for the whole Worker, addressed by a fixed name. */
export function callReceiver(
  namespace: ReceiverNamespace,
  operation: ReceiverOperation,
): Promise<Response> {
  return namespace.get(namespace.idFromName('lite-receiver')).fetch(
    new Request('https://lite-receiver/', {
      method: 'POST',
      body: JSON.stringify(operation),
    }),
  );
}
