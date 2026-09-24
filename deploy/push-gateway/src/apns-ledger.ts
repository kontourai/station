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
// finds it unrecorded: it marks it, and deletes it only if a later run still
// finds it unrecorded and marked.

import type { ApnsSender } from './apns.ts';
import type { ApnsEnvironment } from './apns-request.ts';
import { bodyHash } from './station-auth.ts';

/** Eight hours of activity plus four of dismissal. */
export const LEDGER_TTL_SECONDS = 12 * 60 * 60;
/** Longer than the gap between sweeps, so a mark survives to the next run. */
const SUSPECT_TTL_SECONDS = 60 * 60;
/** Per run: each delete is a subrequest to Apple and one to KV. */
export const MAX_SWEEP_DELETES = 200;
const MAX_SWEEP_MARKS = 500;
const ENVIRONMENTS: readonly ApnsEnvironment[] = ['sandbox', 'production'];

/** The subset of a Workers KV namespace the ledger uses. */
export interface LedgerStore {
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; cursor?: string }): Promise<{
    keys: Array<{ name: string }>;
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

/** Every channel id under a prefix; throws if KV cannot list completely. */
async function listIds(
  store: LedgerStore,
  prefix: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await store.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const { name } of page.keys) ids.add(name.slice(prefix.length));
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
  skipped: string[];
}

export async function sweepChannels(input: {
  store: LedgerStore;
  sender: ApnsSender;
  bundles: readonly string[];
  maxDeletes?: number;
}): Promise<SweepReport> {
  const { store, sender, bundles } = input;
  const maxDeletes = input.maxDeletes ?? MAX_SWEEP_DELETES;
  const report: SweepReport = {
    listed: 0,
    kept: 0,
    marked: 0,
    deleted: 0,
    failed: 0,
    deferred: 0,
    skipped: [],
  };
  for (const bundleId of bundles) {
    for (const environment of ENVIRONMENTS) {
      const label = `${environment}:${bundleId}`;
      const listed = await sender.listChannels(bundleId, environment);
      if (!listed) {
        report.skipped.push(label);
        continue;
      }
      // If the ledger cannot be read completely, this throws and the run
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
        if (!suspects.has(channelId)) {
          if (report.marked >= MAX_SWEEP_MARKS) {
            report.deferred += 1;
            continue;
          }
          await store.put(suspectKey(channel), '1', {
            expirationTtl: SUSPECT_TTL_SECONDS,
          });
          report.marked += 1;
          continue;
        }
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
    }
  }
  return report;
}
