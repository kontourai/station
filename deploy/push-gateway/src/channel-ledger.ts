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
// The same object keeps a per-device count of channel-creating starts per UTC
// day: the rate limiters only see a minute, and a device must not create
// channels all day.
//
// Durable Object storage is strongly consistent, so a channel recorded is
// visible to the next read. The only gap is between Apple creating a channel
// and the gateway recording it; Apple's channel list carries no creation
// time, so the ledger remembers when it first saw each unrecorded channel and
// the sweep deletes one only after a ten-minute grace.
//
// The class answers plain fetch requests (a small JSON protocol) rather than
// RPC, so this module needs no `cloudflare:workers` import and runs under
// Node for tests against real SQLite.

/** Eight hours of activity plus four of dismissal. */
export const CHANNEL_LIFETIME_SECONDS = 12 * 60 * 60;
/** How long a channel may stay unrecorded before the sweep deletes it. */
export const UNRECORDED_GRACE_SECONDS = 10 * 60;
/** Channel-creating starts one device may make per UTC day. */
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
  /** SHA-256 of the push-to-start token: counts the device's starts. */
  deviceHash: string;
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
  }

  /** Records a created channel and counts it against its device's day. */
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
    this.sql.exec(
      `INSERT INTO starts VALUES (?, ?, 1)
       ON CONFLICT (device_hash, day) DO UPDATE SET count = count + 1`,
      channel.deviceHash,
      utcDay(channel.createdAt),
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
   * Also purges expired rows, and forgets unrecorded channels Apple no longer
   * lists. One call per scope per sweep.
   */
  triage(
    scope: ChannelScope,
    listed: string[],
    nowSeconds: number,
  ): TriageResult {
    this.purge(nowSeconds);
    const recorded = new Set(
      this.sql
        .exec(
          `SELECT channel_id FROM channels WHERE environment = ? AND bundle_id = ?`,
          scope.environment,
          scope.bundleId,
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

  private purge(nowSeconds: number): void {
    this.sql.exec(
      `DELETE FROM channels WHERE created_at <= ?`,
      nowSeconds - CHANNEL_LIFETIME_SECONDS,
    );
    this.sql.exec(`DELETE FROM starts WHERE day < ?`, utcDay(nowSeconds) - 1);
  }
}

type Operation =
  | { op: 'record'; channel: ChannelRecord }
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
    const operation = (await request.json()) as Operation;
    switch (operation.op) {
      case 'record':
        this.store.record(operation.channel);
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
      default:
        return Response.json({ error: 'unknown operation' }, { status: 400 });
    }
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
