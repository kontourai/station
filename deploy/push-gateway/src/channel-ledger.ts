// The ledger of broadcast channels this gateway created, kept in one
// SQLite-backed Durable Object (Workers Free includes them; Workers KV's Free
// allowance of 1,000 writes a day does not fit).
//
// Apple lets an app hold a finite number of channels per environment and
// never expires them, so a channel nobody deletes is quota lost for good. Each
// channel is recorded here the moment Apple creates it, and the scheduled
// sweep (apns-sweep.ts) deletes every channel in a swept scope that is not
// recorded. A record counts as live for 12 hours (an activity lasts at most
// eight and stays dismissible for four more); older rows are purged.
//
// The same object keeps a per-device count of accepted starts per UTC day.
// That is not an abuse bound: the device key is a hash of a token the Station
// supplies, so a hostile caller simply varies it (the per-key and global
// limiters bound abuse). It stops an honest Station that has gone wrong from
// starting activity after activity on one phone all day. Only starts Apple
// accepted count, so refusals and the Station's retries never lock a phone
// out. The check and the count are separate requests, so two starts for one
// device racing inside the same moment can both pass and overshoot by one;
// the per-minute device limiter makes that rare, and it is harmless.
//
// Why a Durable Object: correctness. It is a single, strongly consistent
// writer, so a channel recorded is visible to the very next read and a count
// increments atomically. Workers KV is eventually consistent, which leaves a
// window where the sweep could miss a fresh record and delete a live channel,
// and it has no atomic counters. The only gap left is between Apple creating
// a channel and the gateway recording it; Apple's channel list carries no
// creation time, so the ledger remembers when it first saw each unrecorded
// channel and the sweep deletes one only after a ten-minute grace.
//
// The class answers plain fetch requests (a small JSON protocol) rather than
// RPC, so this module needs no `cloudflare:workers` import and runs under
// Node for tests against real SQLite.

/** Eight hours of activity plus four of dismissal. */
export const CHANNEL_LIFETIME_SECONDS = 12 * 60 * 60;
/** How long a channel may stay unrecorded before the sweep deletes it. */
export const UNRECORDED_GRACE_SECONDS = 10 * 60;
/** Accepted starts one device may have per UTC day (runaway guard). */
export const DAILY_STARTS_PER_DEVICE = 6;
/** New unrecorded channels noted per sweep call (row writes). */
const MAX_NEW_UNRECORDED = 1000;

const DAY_SECONDS = 24 * 60 * 60;
const utcDay = (nowSeconds: number) => Math.floor(nowSeconds / DAY_SECONDS);

/** The subset of a Durable Object's `ctx.storage.sql` the ledger uses. */
export interface SqlStorage {
  exec(
    query: string,
    ...bindings: Array<string | number | null>
  ): { toArray(): Array<Record<string, unknown>> };
}

export interface ChannelScope {
  environment: string;
  bundleId: string;
}

export interface ChannelRecord extends ChannelScope {
  channelId: string;
  /** SHA-256 of the signing key's thumbprint: attributes abuse to a key. */
  stationKeyHash: string;
  createdAt: number;
}

export interface TriageResult {
  /** Listed channels the ledger records. */
  recorded: number;
  /** Unrecorded past the grace: the sweep may delete these. */
  due: string[];
  /** Unrecorded and still inside the grace (or newly noticed). */
  waiting: number;
}

/** The ledger's logic over SQL, independent of the Durable Object runtime. */
export class ChannelLedgerStore {
  private readonly sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS channels (
      environment TEXT NOT NULL, bundle_id TEXT NOT NULL, channel_id TEXT NOT NULL,
      station_key_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (environment, bundle_id, channel_id))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS unrecorded (
      environment TEXT NOT NULL, bundle_id TEXT NOT NULL, channel_id TEXT NOT NULL,
      first_seen INTEGER NOT NULL,
      PRIMARY KEY (environment, bundle_id, channel_id))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS starts (
      device_hash TEXT NOT NULL, day INTEGER NOT NULL, count INTEGER NOT NULL,
      PRIMARY KEY (device_hash, day))`);
    // The purge deletes by age; without these it scans every row.
    sql.exec(
      `CREATE INDEX IF NOT EXISTS channels_created_at ON channels (created_at)`,
    );
    sql.exec(`CREATE INDEX IF NOT EXISTS starts_day ON starts (day)`);
  }

  /** Records a created channel, before its start is sent. */
  record(channel: ChannelRecord): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO channels VALUES (?, ?, ?, ?, ?)`,
      channel.environment,
      channel.bundleId,
      channel.channelId,
      channel.stationKeyHash,
      channel.createdAt,
    );
    this.sql.exec(
      `DELETE FROM unrecorded WHERE environment = ? AND bundle_id = ? AND channel_id = ?`,
      channel.environment,
      channel.bundleId,
      channel.channelId,
    );
  }

  /** Counts a start Apple accepted against its device's UTC day. */
  countStart(deviceHash: string, nowSeconds: number): void {
    this.sql.exec(
      `INSERT INTO starts VALUES (?, ?, 1)
       ON CONFLICT (device_hash, day) DO UPDATE SET count = count + 1`,
      deviceHash,
      utcDay(nowSeconds),
    );
  }

  forget(channel: ChannelScope & { channelId: string }): void {
    this.sql.exec(
      `DELETE FROM channels WHERE environment = ? AND bundle_id = ? AND channel_id = ?`,
      channel.environment,
      channel.bundleId,
      channel.channelId,
    );
  }

  startsToday(deviceHash: string, nowSeconds: number): number {
    const [row] = this.sql
      .exec(
        `SELECT count FROM starts WHERE device_hash = ? AND day = ?`,
        deviceHash,
        utcDay(nowSeconds),
      )
      .toArray();
    return typeof row?.count === 'number' ? row.count : 0;
  }

  /**
   * Compares Apple's listing of one scope with the ledger: which listed
   * channels are recorded, and which have stayed unrecorded past the grace.
   * Also forgets unrecorded channels Apple no longer lists. One call per
   * scope per sweep; records past their lifetime do not count even before
   * the purge removes them.
   */
  triage(
    scope: ChannelScope,
    listed: string[],
    nowSeconds: number,
  ): TriageResult {
    const recorded = new Set(
      this.sql
        .exec(
          `SELECT channel_id FROM channels
           WHERE environment = ? AND bundle_id = ? AND created_at > ?`,
          scope.environment,
          scope.bundleId,
          nowSeconds - CHANNEL_LIFETIME_SECONDS,
        )
        .toArray()
        .map((row) => String(row.channel_id)),
    );
    const firstSeen = new Map(
      this.sql
        .exec(
          `SELECT channel_id, first_seen FROM unrecorded WHERE environment = ? AND bundle_id = ?`,
          scope.environment,
          scope.bundleId,
        )
        .toArray()
        .map((row) => [String(row.channel_id), Number(row.first_seen)]),
    );
    const listedSet = new Set(listed);
    for (const channelId of firstSeen.keys()) {
      if (listedSet.has(channelId) && !recorded.has(channelId)) continue;
      this.sql.exec(
        `DELETE FROM unrecorded WHERE environment = ? AND bundle_id = ? AND channel_id = ?`,
        scope.environment,
        scope.bundleId,
        channelId,
      );
    }
    const result: TriageResult = { recorded: 0, due: [], waiting: 0 };
    let noted = 0;
    for (const channelId of listedSet) {
      if (recorded.has(channelId)) {
        result.recorded += 1;
        continue;
      }
      const seen = firstSeen.get(channelId);
      if (seen === undefined) {
        result.waiting += 1;
        if (noted >= MAX_NEW_UNRECORDED) continue;
        noted += 1;
        this.sql.exec(
          `INSERT OR IGNORE INTO unrecorded VALUES (?, ?, ?, ?)`,
          scope.environment,
          scope.bundleId,
          channelId,
          nowSeconds,
        );
      } else if (nowSeconds - seen >= UNRECORDED_GRACE_SECONDS) {
        result.due.push(channelId);
      } else {
        result.waiting += 1;
      }
    }
    return result;
  }

  /** Deletes expired records and old day counts. Once per sweep run. */
  purge(nowSeconds: number): void {
    this.sql.exec(
      `DELETE FROM channels WHERE created_at <= ?`,
      nowSeconds - CHANNEL_LIFETIME_SECONDS,
    );
    this.sql.exec(`DELETE FROM starts WHERE day < ?`, utcDay(nowSeconds) - 1);
  }
}

type Operation =
  | { op: 'record'; channel: ChannelRecord }
  | { op: 'countStart'; deviceHash: string; nowSeconds: number }
  | { op: 'purge'; nowSeconds: number }
  | { op: 'forget'; channel: ChannelScope & { channelId: string } }
  | { op: 'startsToday'; deviceHash: string; nowSeconds: number }
  | {
      op: 'triage';
      scope: ChannelScope;
      listed: string[];
      nowSeconds: number;
    };

/**
 * The Durable Object. Only the gateway Worker can reach it (a namespace
 * binding, never a route), so the protocol needs no authentication.
 */
export class ChannelLedger {
  private readonly store: ChannelLedgerStore;

  constructor(state: { storage: { sql: SqlStorage } }, _env?: unknown) {
    this.store = new ChannelLedgerStore(state.storage.sql);
  }

  async fetch(request: Request): Promise<Response> {
    const operation = parseOperation(await request.json().catch(() => null));
    if (!operation)
      return Response.json({ error: 'invalid operation' }, { status: 400 });
    switch (operation.op) {
      case 'record':
        this.store.record(operation.channel);
        return Response.json({ ok: true });
      case 'countStart':
        this.store.countStart(operation.deviceHash, operation.nowSeconds);
        return Response.json({ ok: true });
      case 'purge':
        this.store.purge(operation.nowSeconds);
        return Response.json({ ok: true });
      case 'forget':
        this.store.forget(operation.channel);
        return Response.json({ ok: true });
      case 'startsToday':
        return Response.json({
          count: this.store.startsToday(
            operation.deviceHash,
            operation.nowSeconds,
          ),
        });
      case 'triage':
        return Response.json(
          this.store.triage(
            operation.scope,
            operation.listed,
            operation.nowSeconds,
          ),
        );
    }
  }
}

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256;
const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const isScope = (value: unknown): value is ChannelScope => {
  const scope = value as ChannelScope | null;
  return (
    !!scope &&
    typeof scope === 'object' &&
    isText(scope.environment) &&
    isText(scope.bundleId)
  );
};
const isChannel = (
  value: unknown,
): value is ChannelScope & { channelId: string } =>
  isScope(value) && isText((value as { channelId?: unknown }).channelId);

/**
 * Checks every field an operation uses. A malformed operation is refused
 * rather than half-applied: a `listed` that is not an array of strings would
 * otherwise read as "Apple lists nothing" and wipe a scope's first sightings.
 */
function parseOperation(value: unknown): Operation | null {
  if (!value || typeof value !== 'object') return null;
  const operation = value as Record<string, unknown>;
  switch (operation.op) {
    case 'record': {
      const channel = operation.channel as ChannelRecord | undefined;
      return isChannel(channel) &&
        isText(channel.stationKeyHash) &&
        isTime(channel.createdAt)
        ? { op: 'record', channel }
        : null;
    }
    case 'forget':
      return isChannel(operation.channel)
        ? { op: 'forget', channel: operation.channel }
        : null;
    case 'countStart':
    case 'startsToday':
      return isText(operation.deviceHash) && isTime(operation.nowSeconds)
        ? {
            op: operation.op,
            deviceHash: operation.deviceHash,
            nowSeconds: operation.nowSeconds,
          }
        : null;
    case 'purge':
      return isTime(operation.nowSeconds)
        ? { op: 'purge', nowSeconds: operation.nowSeconds }
        : null;
    case 'triage':
      return isScope(operation.scope) &&
        Array.isArray(operation.listed) &&
        operation.listed.every(isText) &&
        isTime(operation.nowSeconds)
        ? {
            op: 'triage',
            scope: operation.scope,
            listed: operation.listed as string[],
            nowSeconds: operation.nowSeconds,
          }
        : null;
    default:
      return null;
  }
}

/** The subset of a Durable Object namespace binding the client uses. */
export interface LedgerNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

/** What the gateway and the sweep need from the ledger. Each call is one request. */
export interface Ledger {
  record(channel: ChannelRecord): Promise<void>;
  countStart(deviceHash: string, nowSeconds: number): Promise<void>;
  purge(nowSeconds: number): Promise<void>;
  forget(channel: ChannelScope & { channelId: string }): Promise<void>;
  startsToday(deviceHash: string, nowSeconds: number): Promise<number>;
  triage(
    scope: ChannelScope,
    listed: string[],
    nowSeconds: number,
  ): Promise<TriageResult>;
}

/** One ledger for the whole gateway, addressed by a fixed name. */
export function ledgerClient(namespace: LedgerNamespace): Ledger {
  const call = async (operation: Operation): Promise<unknown> => {
    const stub = namespace.get(namespace.idFromName('channel-ledger'));
    const response = await stub.fetch(
      new Request('https://channel-ledger/', {
        method: 'POST',
        body: JSON.stringify(operation),
      }),
    );
    if (!response.ok)
      throw new Error(`channel ledger answered ${response.status}`);
    return response.json();
  };
  return {
    record: async (channel) => {
      await call({ op: 'record', channel });
    },
    forget: async (channel) => {
      await call({ op: 'forget', channel });
    },
    countStart: async (deviceHash, nowSeconds) => {
      await call({ op: 'countStart', deviceHash, nowSeconds });
    },
    purge: async (nowSeconds) => {
      await call({ op: 'purge', nowSeconds });
    },
    startsToday: async (deviceHash, nowSeconds) =>
      (
        (await call({ op: 'startsToday', deviceHash, nowSeconds })) as {
          count: number;
        }
      ).count,
    triage: async (scope, listed, nowSeconds) =>
      (await call({ op: 'triage', scope, listed, nowSeconds })) as TriageResult,
  };
}
