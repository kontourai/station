// A ledger of the broadcast channels this gateway created, and the sweep that
// deletes every channel Apple holds that the ledger does not.
//
// Apple lets an app hold a finite number of channels per environment and
// never expires them, so any channel nobody deletes is quota lost for good: a
// Station that never deletes, a start whose compensating delete failed, a
// bad deploy. Each channel is recorded in Workers KV the moment Apple creates
// it, for as long as it can legitimately be in use (an activity lasts at most
// eight hours and stays dismissible for four more), and the scheduled sweep
// reclaims whatever is left. So every leak heals within about 13 hours.
//
// KV is eventually consistent (a fresh write can take about a minute to be
// visible elsewhere), so the sweep never deletes a channel the first time it
// finds it unrecorded: it marks it with the time, and deletes it only when a
// later run still finds it unrecorded at least ten minutes after the mark.
//
// The sweep manages only the scopes (environment + bundle) it is told to.
// Within a swept scope every channel must come from this gateway and this
// ledger: one created by `wrangler dev`, a staging deploy or a manual test
// would be deleted. Development and testing belong on unswept scopes.

import type { ApnsSender } from './apns.ts';
import type { ApnsEnvironment } from './apns-request.ts';
import { bodyHash } from './station-auth.ts';

/** Eight hours of activity plus four of dismissal. */
export const LEDGER_TTL_SECONDS = 12 * 60 * 60;
/** Longer than the gap between sweeps, so a mark survives to the next run. */
const SUSPECT_TTL_SECONDS = 60 * 60;
/** How long a channel must stay unrecorded after its mark to be deleted. */
export const MIN_MARK_AGE_SECONDS = 10 * 60;
/** Per run: each delete is a subrequest to Apple and one to KV. */
export const MAX_SWEEP_DELETES = 200;
export const MAX_SWEEP_MARKS = 500;

/** The subset of a Workers KV namespace the ledger uses. */
export interface LedgerStore {
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number; metadata?: unknown },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; cursor?: string }): Promise<{
    keys: Array<{ name: string; metadata?: unknown }>;
    list_complete: boolean;
    cursor?: string;
  }>;
}

export interface LedgerChannel {
  bundleId: string;
  environment: ApnsEnvironment;
  channelId: string;
}

const scope = (bundleId: string, environment: ApnsEnvironment) =>
  `${environment}:${bundleId}:`;
const ledgerKey = (channel: LedgerChannel) =>
  `ch:${scope(channel.bundleId, channel.environment)}${channel.channelId}`;
const suspectKey = (channel: LedgerChannel) =>
  `suspect:${scope(channel.bundleId, channel.environment)}${channel.channelId}`;

export async function recordChannel(
  store: LedgerStore,
  channel: LedgerChannel,
  stationKey: string,
  nowSeconds: number,
): Promise<void> {
  await store.put(
    ledgerKey(channel),
    JSON.stringify({
      createdAt: nowSeconds,
      bundleId: channel.bundleId,
      environment: channel.environment,
      // Enough to attribute abuse to a key without storing the key itself.
      stationKeyHash: await bodyHash(new TextEncoder().encode(stationKey)),
    }),
    { expirationTtl: LEDGER_TTL_SECONDS },
  );
}

/** Best effort: an entry left behind only delays a sweep by its TTL. */
export async function forgetChannel(
  store: LedgerStore,
  channel: LedgerChannel,
): Promise<void> {
  await store.delete(ledgerKey(channel)).catch(() => {
    console.error('apns channel ledger delete failed');
  });
}

/**
 * Every channel id under a prefix, with its metadata; throws if KV cannot
 * list completely.
 */
async function listIds(
  store: LedgerStore,
  prefix: string,
): Promise<Map<string, unknown>> {
  const ids = new Map<string, unknown>();
  let cursor: string | undefined;
  for (;;) {
    const page = await store.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const { name, metadata } of page.keys)
      ids.set(name.slice(prefix.length), metadata);
    if (page.list_complete) return ids;
    if (!page.cursor) throw new Error('KV list ended without a cursor');
    cursor = page.cursor;
  }
}

export interface SweepReport {
  listed: number;
  kept: number;
  marked: number;
  deleted: number;
  failed: number;
  /** Unrecorded channels left for the next run because a cap was reached. */
  deferred: number;
  /** Scopes whose channels or ledger could not be read: nothing deleted. */
  skipped: string[];
}

export interface SweepScope {
  environment: ApnsEnvironment;
  bundleId: string;
}

/**
 * Reads `SWEEP_SCOPES` (`<environment>:<bundle>`, comma-separated). Entries
 * naming an unknown environment or a bundle the gateway does not serve are
 * dropped and logged; nothing is swept by default.
 */
export function parseSweepScopes(
  raw: string | undefined,
  allowedBundles: readonly string[],
): SweepScope[] {
  const scopes: SweepScope[] = [];
  for (const entry of (raw ?? '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(':');
    const environment = trimmed.slice(0, separator);
    const bundleId = trimmed.slice(separator + 1);
    if (
      separator < 0 ||
      (environment !== 'production' && environment !== 'sandbox') ||
      !allowedBundles.includes(bundleId)
    ) {
      console.error(`apns sweep scope ignored: ${trimmed.slice(0, 128)}`);
      continue;
    }
    scopes.push({ environment, bundleId });
  }
  return scopes;
}

const markedAtOf = (metadata: unknown): number | null => {
  const value = (metadata as { markedAt?: unknown } | null)?.markedAt;
  return typeof value === 'number' ? value : null;
};

export async function sweepChannels(input: {
  store: LedgerStore;
  sender: ApnsSender;
  scopes: readonly SweepScope[];
  nowSeconds: number;
  maxDeletes?: number;
  maxMarks?: number;
}): Promise<SweepReport> {
  const { store, sender, scopes, nowSeconds } = input;
  const maxDeletes = input.maxDeletes ?? MAX_SWEEP_DELETES;
  const maxMarks = input.maxMarks ?? MAX_SWEEP_MARKS;
  const report: SweepReport = {
    listed: 0,
    kept: 0,
    marked: 0,
    deleted: 0,
    failed: 0,
    deferred: 0,
    skipped: [],
  };
  for (const { bundleId, environment } of scopes) {
    const label = `${environment}:${bundleId}`;
    // One scope failing (Apple, KV) must not stop the others.
    try {
      const listed = await sender.listChannels(bundleId, environment);
      if (!listed) {
        report.skipped.push(label);
        continue;
      }
      // If the ledger cannot be read completely, this throws and the scope
      // deletes nothing: an unreadable ledger must never look empty.
      const ledgered = await listIds(
        store,
        `ch:${scope(bundleId, environment)}`,
      );
      const suspects = await listIds(
        store,
        `suspect:${scope(bundleId, environment)}`,
      );
      report.listed += listed.length;
      for (const channelId of listed) {
        const channel = { bundleId, environment, channelId };
        if (ledgered.has(channelId)) {
          report.kept += 1;
          continue;
        }
        const markedAt = markedAtOf(suspects.get(channelId));
        if (markedAt === null) {
          if (report.marked >= maxMarks) {
            report.deferred += 1;
            continue;
          }
          await store.put(suspectKey(channel), '', {
            expirationTtl: SUSPECT_TTL_SECONDS,
            metadata: { markedAt: nowSeconds },
          });
          report.marked += 1;
          continue;
        }
        // Too recent: a ledger write may still be on its way.
        if (nowSeconds - markedAt < MIN_MARK_AGE_SECONDS) continue;
        if (report.deleted + report.failed >= maxDeletes) {
          report.deferred += 1;
          continue;
        }
        const outcome = await sender.deleteChannel(
          bundleId,
          environment,
          channelId,
        );
        if (outcome.kind === 'deleted') {
          report.deleted += 1;
          await store.delete(suspectKey(channel)).catch(() => {});
        } else {
          report.failed += 1;
        }
      }
    } catch (error) {
      console.error(
        `apns channel sweep skipped ${label}:`,
        error instanceof Error ? error.message : 'unknown error',
      );
      report.skipped.push(label);
    }
  }
  return report;
}
