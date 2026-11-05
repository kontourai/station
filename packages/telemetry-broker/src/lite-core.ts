// Storage-independent Lite receiver rules, shared by the Node receiver
// (PostgreSQL, lite-store.ts) and the Cloudflare Worker receiver
// (deploy/telemetry-worker, one SQLite Durable Object). Each storage adapter
// owns only its SQL, transactions and clocks; everything a sender or an
// operator can observe on the wire is decided here, so the two receivers
// cannot drift apart. Keep this module free of storage, process and network
// access: the Worker bundles it under `nodejs_compat`, which supplies the
// synchronous `node:crypto` HMAC used below.
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  STATION_DAILY_FIELDS,
  type StationDailyPing,
  TELEMETRY_CHANNELS,
  type TelemetryFeedback,
  type TelemetryPublisherId,
} from '@kontourai/station-contracts/product-telemetry';
import {
  parseStationDailyPing,
  parseTelemetryFeedback,
} from '@kontourai/station-shared/product-telemetry';
import { BrokerError } from './broker-error.js';
import { noisyCount } from './noisy-count.js';
import {
  PUBLIC_COUNT_EPSILON,
  PUBLIC_FIELDS,
  PUBLIC_SENSITIVITY,
  publicDomain,
} from './public-domain.js';

/** Lite request bodies, including streaming bodies, are capped at 16 KiB. */
export const LITE_BODY_LIMIT_BYTES = 16384;
/** Attempts one daily network key may make per UTC day. */
const LITE_DAILY_ATTEMPTS = 60;
/** Exact operator views refuse rather than truncate past this many rows. */
export const LITE_EXACT_ROW_LIMIT = 10000;
/** Public and publisher pages carry at most this many cells. */
export const LITE_PAGE_CELLS = 200;

export function brokerErrorStatus(code: BrokerError['code']): number {
  if (code === 'source_unauthorized') return 401;
  if (code === 'event_conflict' || code === 'source_conflict') return 409;
  if (code === 'storage_limit') return 507;
  // A well-formed request the receiver cannot take in its current state;
  // repeating it unchanged is refused again, so it is not a transient 5xx.
  // 409 stays reserved for a changed payload under a retained event ID.
  if (code === 'query_limit' || code === 'day_closed') return 422;
  if (
    code === 'invalid_cursor' ||
    code === 'invalid_source' ||
    code === 'invalid_daily_ping'
  )
    return 400;
  return 503;
}

// ---------------------------------------------------------------------------
// Client addresses and daily keys

const IPV4 =
  /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * 4, 6 or 0 for anything that is not one bare address (lists, ports,
 * brackets). Like Node's `net.isIP`, an IPv6 address may carry a zone ID
 * (`fe80::1%eth0`); callers that must refuse zones check for `%` themselves.
 */
export function ipFamily(address: string): 0 | 4 | 6 {
  if (IPV4.test(address)) return 4;
  return withoutZone(address) === undefined ? 0 : 6;
}

/** The IPv6 address without its zone ID, or undefined when it is not one. */
function withoutZone(address: string): string | undefined {
  const at = address.indexOf('%');
  const bare = at < 0 ? address : address.slice(0, at);
  if (at >= 0 && !/^[0-9A-Za-z.:-]+$/.test(address.slice(at + 1))) return;
  if (!bare.includes(':') || !/^[0-9A-Fa-f:.]+$/.test(bare)) return;
  try {
    new URL(`http://[${bare}]/`);
    return bare;
  } catch {
    return;
  }
}

/**
 * The address grouping a daily key covers: IPv4 addresses as they are, IPv6
 * by prefix (/64 for attempt budgets, /48 for distinct contributors).
 * IPv4-mapped IPv6 addresses group with their IPv4 address.
 */
export function networkKey(address: string, prefix: 48 | 64): string {
  if (IPV4.test(address)) return address;
  const bare = withoutZone(address);
  if (bare === undefined) return 'unavailable';
  // The URL parser canonicalizes the address: lower case, an embedded dotted
  // IPv4 tail rewritten as two hex words, and at most one `::`.
  const canonical = new URL(`http://[${bare}]/`).hostname.slice(1, -1);
  const [left, right] = canonical.split('::');
  const start = left ? left.split(':') : [];
  const end = right ? right.split(':') : [];
  const full =
    right === undefined
      ? start
      : [...start, ...Array(8 - start.length - end.length).fill('0'), ...end];
  const numbers = full.map((word) => parseInt(word, 16));
  if (numbers.slice(0, 5).every((n) => n === 0) && numbers[5] === 65535)
    return [
      numbers[6] >> 8,
      numbers[6] & 255,
      numbers[7] >> 8,
      numbers[7] & 255,
    ].join('.');
  return `${numbers
    .slice(0, prefix / 16)
    .map((n) => n.toString(16))
    .join(':')}::/${prefix}`;
}

/**
 * The two daily HMACs derived from one transient address. Only these reach
 * storage or memory; the address itself is never retained. `rate` keys the
 * attempt budget (/64), `contributor` keys distinct-network counts (/48).
 */
export function dailyClientKeys(
  salt: Uint8Array,
  address: string,
): { rate: string; contributor: string } {
  const key = (prefix: 48 | 64) =>
    createHmac('sha256', salt)
      .update(networkKey(address, prefix))
      .digest('hex');
  return { rate: key(64), contributor: key(48) };
}

/**
 * The per-network daily attempt budget: 60 attempts per rate key per UTC day,
 * held in memory with at most 10,000 keys. The least recently used key is
 * evicted at capacity, so new clients stay admissible; eviction can reset an
 * old client's budget but never changes its contributor key.
 */
export class LiteDailyBudget {
  private day = '';
  private readonly clients = new Map<string, number>();

  constructor(
    private readonly limit = LITE_DAILY_ATTEMPTS,
    private readonly capacity = 10000,
  ) {}

  admit(day: string, key: string): boolean {
    if (day !== this.day) {
      this.day = day;
      this.clients.clear();
    }
    const count = this.clients.get(key) ?? 0;
    if (count >= this.limit) return false;
    this.clients.delete(key);
    if (this.clients.size >= this.capacity)
      this.clients.delete(this.clients.keys().next().value as string);
    this.clients.set(key, count + 1);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Sources

interface LiteSourceConfig {
  id: string;
  publisher: TelemetryPublisherId;
  /** The ping channels this source admits; the body names which one. */
  channels: string[];
  registryIds: string[];
  releaseVersions: string[];
  versionPolicy: 'catalog' | 'semver';
}

export function isPublisherId(value: unknown): value is TelemetryPublisherId {
  return (
    typeof value === 'string' &&
    value.length <= 128 &&
    (value === 'kontour' ||
      value === 'operator' ||
      /^publisher:\S{1,118}$/u.test(value))
  );
}

function catalog(
  value: unknown,
  limit: number,
  maxLength: number,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= limit &&
    value.every(
      (v) => typeof v === 'string' && v.length > 0 && v.length <= maxLength,
    ) &&
    new Set(value).size === value.length
  );
}

/** Every channel a daily ping can carry. */
const LITE_CHANNELS: readonly string[] = [...TELEMETRY_CHANNELS, 'unknown'];

/** At most this many distinct versions and registry IDs per publisher. */
export const LITE_PUBLISHER_CATALOG_LIMIT = 1000;
/** At most this many sources (and, separately, publisher keys). */
export const LITE_SOURCE_LIMIT = 10000;

/** The operator's `POST /v1/operator/lite/sources` body. */
export function parseLiteSource(value: unknown): LiteSourceConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BrokerError('invalid_source');
  const v = value as Record<string, unknown>;
  if (
    (Object.keys(v).length !== 5 && Object.keys(v).length !== 6) ||
    Object.keys(v).some(
      (k) =>
        ![
          'id',
          'publisher',
          'channels',
          'registryIds',
          'releaseVersions',
          'versionPolicy',
        ].includes(k),
    ) ||
    typeof v.id !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(v.id) ||
    !isPublisherId(v.publisher) ||
    !catalog(v.channels, LITE_CHANNELS.length, 64) ||
    v.channels.length === 0 ||
    v.channels.some((c) => !LITE_CHANNELS.includes(c)) ||
    !catalog(v.registryIds, 1000, 128) ||
    !catalog(v.releaseVersions, 1000, 64) ||
    (v.versionPolicy !== undefined &&
      v.versionPolicy !== 'catalog' &&
      v.versionPolicy !== 'semver')
  )
    throw new BrokerError('invalid_source');
  return {
    id: v.id,
    publisher: v.publisher,
    channels: v.channels,
    registryIds: v.registryIds,
    releaseVersions: v.releaseVersions,
    versionPolicy: v.versionPolicy ?? 'catalog',
  };
}

// ---------------------------------------------------------------------------
// Observations

type LiteObservation =
  | { kind: 'feedback'; feedback: TelemetryFeedback }
  | {
      kind: 'daily';
      /** Canonical: field order, set order and UUID case normalized. */
      ping: StationDailyPing;
      /** The ping's canonical JSON, compared byte-for-byte on replay. */
      json: string;
      /** The marginal values this ping contributes, per dimension. */
      contributions: Record<string, string[]>;
    };

/**
 * Validates one Lite body against the URL source's configuration with the
 * shared contract parsers. Feedback must name the source's publisher; a daily
 * ping's channel must be one the source lists. The publisher always comes
 * from the source mapping, never the body. Every refusal is the same
 * content-free `invalid_daily_ping`, so no rejected value is echoed.
 */
export function admitLiteObservation(
  value: unknown,
  source: Pick<
    LiteSourceConfig,
    | 'publisher'
    | 'channels'
    | 'registryIds'
    | 'releaseVersions'
    | 'versionPolicy'
  >,
): LiteObservation {
  if (value && typeof value === 'object' && 'action' in value) {
    let feedback: TelemetryFeedback;
    try {
      feedback = parseTelemetryFeedback(value);
    } catch {
      throw new BrokerError('invalid_daily_ping');
    }
    if (feedback.publisher !== source.publisher)
      throw new BrokerError('invalid_daily_ping');
    return { kind: 'feedback', feedback };
  }
  let parsed: StationDailyPing;
  try {
    parsed = parseStationDailyPing(
      value,
      source.registryIds,
      source.versionPolicy === 'semver' ? 'semver' : source.releaseVersions,
    );
  } catch {
    throw new BrokerError('invalid_daily_ping');
  }
  if (!source.channels.includes(parsed.channel))
    throw new BrokerError('invalid_daily_ping');
  const ping = normalizeDailyPing(parsed);
  return {
    kind: 'daily',
    ping,
    json: JSON.stringify(ping),
    contributions: dailyContributions(ping),
  };
}

type DailyFieldRule = { domain: unknown; arrayMax?: number };
const DAILY_RULES: Readonly<Record<string, DailyFieldRule>> =
  STATION_DAILY_FIELDS;
/** Envelope fields: never a marginal dimension. */
const ENVELOPE_FIELDS = new Set(['event', 'event_id']);
// Object set entries (per-engine buckets) are identified by `engine`, the
// same key the shared parser uses to refuse duplicate entries.
const ENTRY_IDENTITY = 'engine';

type SetEntry = string | Record<string, string>;

function canonicalEntry(entry: Record<string, string>): Record<string, string> {
  const keys = Object.keys(entry)
    .filter((key) => key !== ENTRY_IDENTITY)
    .sort();
  return Object.fromEntries(
    [ENTRY_IDENTITY, ...keys].map((key) => [key, entry[key]]),
  );
}

function canonicalSet(entries: SetEntry[]): SetEntry[] {
  if (entries.every((entry) => typeof entry === 'string'))
    return [...entries].sort();
  return entries
    .map((entry) => (typeof entry === 'string' ? entry : canonicalEntry(entry)))
    .sort((a, b) =>
      String(typeof a === 'string' ? a : a[ENTRY_IDENTITY]).localeCompare(
        String(typeof b === 'string' ? b : b[ENTRY_IDENTITY]),
      ),
    );
}

/**
 * Field order follows STATION_DAILY_FIELDS, sets are sorted, object entries
 * keep only their own keys in a fixed order and UUIDs are lower case, so a
 * reordered retry is the same ping. Optional fields stay absent when absent.
 * A field added to STATION_DAILY_FIELDS needs no change here.
 */
function normalizeDailyPing(ping: StationDailyPing): StationDailyPing {
  const source: Readonly<Record<string, unknown>> = ping;
  const out: Record<string, unknown> = {};
  for (const [field, rule] of Object.entries(DAILY_RULES)) {
    if (!Object.hasOwn(source, field)) continue;
    const value = source[field];
    out[field] =
      rule.domain === 'uuid-v4'
        ? String(value).toLowerCase()
        : Array.isArray(value)
          ? canonicalSet(value as SetEntry[])
          : value;
  }
  return out as StationDailyPing;
}

const bucketCount = (count: number) =>
  count === 0
    ? '0'
    : count === 1
      ? '1'
      : count <= 5
        ? '2-5'
        : count <= 20
          ? '6-20'
          : '21+';

/** `codex:2-3`: the entry's identity, then its other values in key order. */
function entryValue(entry: SetEntry): string {
  if (typeof entry === 'string') return entry;
  return Object.values(canonicalEntry(entry)).map(String).join(':');
}

/**
 * The marginal values one ping contributes, per STATION_DAILY_FIELDS
 * dimension: counters as buckets (`0`, `1`, `2-5`, `6-20`, `21+`), sets as
 * their members (an empty set as `none`), per-engine entries as
 * `engine:bucket`, scalars as text. An absent optional field contributes no
 * dimension. A field added to the contract flows through without edits here;
 * public release stays limited to PUBLIC_FIELDS.
 */
function dailyContributions(ping: StationDailyPing): Record<string, string[]> {
  const source: Readonly<Record<string, unknown>> = ping;
  const out: Record<string, string[]> = Object.create(null);
  for (const field of Object.keys(DAILY_RULES)) {
    if (ENVELOPE_FIELDS.has(field) || !Object.hasOwn(source, field)) continue;
    const value = source[field];
    out[field] =
      typeof value === 'number'
        ? [bucketCount(value)]
        : Array.isArray(value)
          ? value.length
            ? (value as SetEntry[]).map(entryValue)
            : ['none']
          : [String(value)];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Weekly publication

interface LitePublicationCatalog {
  registry_ids: string[];
  release_versions: string[];
  version_policy?: string;
  channels: string[];
}

/**
 * Every cell of one publisher/week's fixed public domain with its noisy
 * estimate, including true zeros. `totals` maps `JSON.stringify([dimension,
 * value])` to the week's summed daily distinct contributors. The seed never
 * includes the count, so a published week must never be released again.
 */
export function publishedWeekCells(
  secret: Buffer,
  publisher: string,
  week: string,
  catalogs: LitePublicationCatalog[],
  totals: Map<string, number>,
): { dimension: string; value: string; estimate: number }[] {
  return publicDomain(catalogs).map(([dimension, value]) => ({
    dimension,
    value,
    estimate: noisyCount(
      secret,
      publisher,
      week,
      dimension,
      value,
      totals.get(JSON.stringify([dimension, value])) ?? 0,
    ),
  }));
}

/** A bounded keyset position: `[week, dimension, value]`. */
export function parsePublicationCursor(
  cursor?: string,
): [string, string, string] | undefined {
  if (cursor === undefined) return;
  try {
    if (
      cursor.length > 1024 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor)
    )
      throw new Error();
    const v: unknown = JSON.parse(
      Buffer.from(cursor.split('.')[0], 'base64url').toString(),
    );
    if (
      !Array.isArray(v) ||
      v.length !== 3 ||
      !v.every((x) => typeof x === 'string') ||
      !/^\d{4}-\d{2}-\d{2}$/.test(v[0]) ||
      !Number.isFinite(Date.parse(v[0])) ||
      v[0].startsWith('0000') ||
      new Date(v[0]).toISOString().slice(0, 10) !== v[0] ||
      new Date(v[0]).getUTCDay() !== 1 ||
      !PUBLIC_FIELDS.includes(v[1]) ||
      v[2].length > 128
    )
      throw new Error();
    return [v[0], v[1], v[2]];
  } catch {
    throw new BrokerError('invalid_cursor');
  }
}

/** Cursors are HMAC-authenticated with the noise key and scoped to a publisher. */
export function publicationCursorSigner(secret: Buffer, publisher: string) {
  return (payload: string) =>
    createHmac('sha256', secret)
      .update(JSON.stringify(['station-lite-cursor-v1', publisher, payload]))
      .digest();
}

export function verifyPublicationCursor(
  cursor: string | undefined,
  sign: (payload: string) => Buffer,
): void {
  if (!cursor) return;
  const [payload, signature] = cursor.split('.');
  const supplied = Buffer.from(signature, 'base64url');
  if (
    supplied.length !== 32 ||
    supplied.toString('base64url') !== signature ||
    !timingSafeEqual(sign(payload), supplied)
  )
    throw new BrokerError('invalid_cursor');
}

/** The public/publisher aggregates response for one page of stored cells. */
export function publicationPage(input: {
  publisher: string;
  databaseDay: string;
  /** Up to LITE_PAGE_CELLS + 1 rows in keyset order; the extra one signals more. */
  rows: { week: string; dimension: string; value: string; estimate: unknown }[];
  maximumCoordinates: number;
  sign: (payload: string) => Buffer;
}) {
  const cells = input.rows.slice(0, LITE_PAGE_CELLS).map((row) => ({
    week: row.week,
    dimension: row.dimension,
    value: row.value,
    estimate: Number(row.estimate),
  }));
  const last = cells.at(-1);
  return {
    scope: 'weekly-fixed-domain-marginals',
    publisher: input.publisher,
    privacyUnit: 'distinct-daily-network-key-per-value',
    countUnit: 'network-days',
    databaseDay: input.databaseDay,
    epsilonPerCount: PUBLIC_COUNT_EPSILON,
    epsilonPerAddedPing: PUBLIC_SENSITIVITY * PUBLIC_COUNT_EPSILON,
    maximumPublicCoordinatesPerWeek: input.maximumCoordinates,
    maximumNetworkWeekEpsilon:
      7 * input.maximumCoordinates * PUBLIC_COUNT_EPSILON,
    weekBasis: 'ISO-8601-UTC-receiver-arrival',
    deliveryCoverage: 'unknown',
    cells,
    nextCursor:
      input.rows.length > LITE_PAGE_CELLS && last
        ? (() => {
            const payload = Buffer.from(
              JSON.stringify([last.week, last.dimension, last.value]),
            ).toString('base64url');
            return `${payload}.${input.sign(payload).toString('base64url')}`;
          })()
        : null,
  };
}

// ---------------------------------------------------------------------------
// Exact operator view

export interface LiteFinalizationFailure {
  period: string;
  publisher: string;
  stage: 'daily' | 'weekly';
  code: string;
}

/** A content-free failure code: never a storage message, which can carry data. */
export function finalizationFailureCode(error: unknown): string {
  return error instanceof BrokerError
    ? error.code
    : error &&
        typeof error === 'object' &&
        'code' in error &&
        typeof error.code === 'string' &&
        /^[0-9A-Z]{5}$/.test(error.code)
      ? error.code
      : 'job_failed';
}

export function exactLiteView(input: {
  period: 'daily' | 'weekly';
  marginals: unknown[];
  feedback: unknown[];
  retentionDays: number;
  failures: LiteFinalizationFailure[];
  omittedFailures: number;
  lifetime: string;
}) {
  if (
    input.marginals.length > LITE_EXACT_ROW_LIMIT ||
    input.feedback.length > LITE_EXACT_ROW_LIMIT
  )
    throw new BrokerError('query_limit');
  return {
    feedback: input.feedback,
    feedbackWindow: `retained-${input.retentionDays}-UTC-days-including-current`,
    scope: 'operator-exact-marginals',
    finalizationDiagnostics: {
      failures: [...input.failures],
      omittedFailures: input.omittedFailures,
      lifetime: input.lifetime,
    },
    period: input.period,
    contributorUnit:
      input.period === 'daily'
        ? 'distinct-daily-network-keys'
        : 'sum-of-distinct-daily-network-keys',
    window:
      input.period === 'daily'
        ? 'last-30-closed-UTC-days'
        : 'last-4-closed-ISO-weeks',
    marginals: input.marginals,
  };
}

// ---------------------------------------------------------------------------
// UTC calendar

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function addUtcDays(day: string, days: number): string {
  return utcDay(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000);
}

/** The Monday that starts `day`'s ISO week. */
export function isoWeekStart(day: string): string {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return addUtcDays(day, -((weekday + 6) % 7));
}
