// The scheduled sweep: deletes every broadcast channel Apple holds in a swept
// scope that the channel ledger (channel-ledger.ts) does not record, once it
// has stayed unrecorded for the ledger's ten-minute grace. So every leak (a
// Station that never deletes, a failed compensating delete, a crash between
// create and record) is reclaimed within about 12 hours and a sweep interval.
//
// The sweep manages only the scopes (environment + bundle) it is told to.
// Within a swept scope every channel must come from this gateway and this
// ledger: one created by `wrangler dev`, a staging deploy or a manual test
// would be deleted. Development and testing belong on unswept scopes.
//
// Workers Free allows 50 subrequests per invocation, and every Apple call
// and every ledger call is one, so a run spends at most a fixed budget and
// leaves the rest for the next run.

import type { ApnsSender } from './apns.ts';
import type { ApnsEnvironment } from './apns-request.ts';
import type { Ledger } from './channel-ledger.ts';

/** Subrequests one sweep run may make (Free allows 50 per invocation). */
export const MAX_SWEEP_SUBREQUESTS = 45;
/** Channel deletes one sweep run may make, within that budget. */
export const MAX_SWEEP_DELETES = 40;

export interface SweepReport {
  listed: number;
  kept: number;
  /** Unrecorded channels still inside the grace. */
  waiting: number;
  deleted: number;
  failed: number;
  /** Due channels (or whole scopes) left for the next run by a cap. */
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

export async function sweepChannels(input: {
  ledger: Ledger;
  sender: ApnsSender;
  scopes: readonly SweepScope[];
  nowSeconds: number;
  maxSubrequests?: number;
  maxDeletes?: number;
}): Promise<SweepReport> {
  const { ledger, sender, scopes, nowSeconds } = input;
  let budget = input.maxSubrequests ?? MAX_SWEEP_SUBREQUESTS;
  let deletesLeft = input.maxDeletes ?? MAX_SWEEP_DELETES;
  const report: SweepReport = {
    listed: 0,
    kept: 0,
    waiting: 0,
    deleted: 0,
    failed: 0,
    deferred: 0,
    skipped: [],
  };
  // Expired records and old day counts, once per run (an indexed delete).
  if (scopes.length > 0 && budget > 0) {
    budget -= 1;
    await ledger.purge(nowSeconds).catch((error: unknown) => {
      console.error(
        'apns channel ledger purge failed:',
        error instanceof Error ? error.message : 'unknown error',
      );
    });
  }
  for (const { bundleId, environment } of scopes) {
    const label = `${environment}:${bundleId}`;
    // Listing and triage are two subrequests; without them a scope is left
    // whole for the next run.
    if (budget < 2) {
      report.deferred += 1;
      continue;
    }
    // One scope failing (Apple, the ledger) must not stop the others.
    try {
      budget -= 1;
      const listed = await sender.listChannels(bundleId, environment);
      if (!listed) {
        report.skipped.push(label);
        continue;
      }
      budget -= 1;
      // If the ledger cannot be read, this throws and the scope deletes
      // nothing: an unreadable ledger must never look empty.
      const triage = await ledger.triage(
        { environment, bundleId },
        listed,
        nowSeconds,
      );
      report.listed += listed.length;
      report.kept += triage.recorded;
      report.waiting += triage.waiting;
      for (const channelId of triage.due) {
        if (budget < 1 || deletesLeft < 1) {
          report.deferred += 1;
          continue;
        }
        budget -= 1;
        deletesLeft -= 1;
        const outcome = await sender.deleteChannel(
          bundleId,
          environment,
          channelId,
        );
        if (outcome.kind === 'deleted') report.deleted += 1;
        else report.failed += 1;
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
