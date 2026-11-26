#!/usr/bin/env node
/**
 * Reads the Nightly CLI provider receipt for the native record job.
 *
 * Every deploy-ledger push to main discards the merge groups in flight, so a
 * Nightly that ships the native cohort records its npm row in the same commit
 * as the Android and desktop rows. `nightly-cli` publishes and verifies the
 * package, then uploads `provider-receipts/nightly-cli.json` as this run's
 * `nightly-cli-provider-receipt-<run id>` artifact; the cohort's record job
 * downloads that artifact.
 *
 * The receipt is a pointer, not the authority. This module accepts it only
 * when it names the CLI package, this run's own version (the Nightly CLI
 * version ends in `.<run id>`, see nightlyCliVersion), and the exact source
 * the record job was handed, and when it carries the moment the registry
 * provenance was verified. The record job then re-reads the registry
 * `gitHead` for that version (verify-npm-registry-provenance.mjs) before it
 * offers the row. Any refusal leaves the row to `record-cli-ledger` in
 * nightly.yml, which records it alone from `nightly-cli`'s job outputs.
 *
 * Usage: node scripts/lib/nightly-cli-ledger-handoff.mjs <receipt.json> <source-sha> <run-id>
 * Prints `<version>\t<verifiedAt>`; exits 1 with the reason otherwise.
 */

import { readFileSync } from 'node:fs';
import { FUTURE_TIMESTAMP_SKEW_MS } from '../deploy-ledger.mjs';
import { invokedDirectly } from './module-entry.mjs';

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]*$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const CLI_PACKAGE = '@kontourai/station-cli';
/** nightlyCliVersion's exact shape: `<MAJOR.MINOR.PATCH>-nightly.<YYYYMMDD>.<run id>`. */
const NIGHTLY_CLI_VERSION_PREFIX =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-nightly\.\d{8}\./;

/**
 * @param {unknown} receipt The parsed receipt.
 * @param {{ sourceSha: string, runId: string, now?: number }} binding
 *   `now` is the record job's clock: a `verifiedAt` the appender would refuse
 *   as future is refused here, before it can fail the combined commit.
 * @returns {{ version: string, verifiedAt: string }}
 */
export function readNightlyCliHandoff(
  receipt,
  { sourceSha, runId, now = Date.now() },
) {
  if (!SHA_PATTERN.test(sourceSha ?? '')) {
    throw new Error('source sha must be 40 lowercase hex characters');
  }
  if (!RUN_ID_PATTERN.test(runId ?? '')) {
    throw new Error('run id must be a positive decimal number');
  }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error('receipt must be a JSON object');
  }
  const failures = [];
  if (receipt.schemaVersion !== 1) failures.push('schemaVersion is not 1');
  if (receipt.kind !== 'station.npm-publish-receipt')
    failures.push('kind is not station.npm-publish-receipt');
  if (receipt.package !== CLI_PACKAGE)
    failures.push(`package is not ${CLI_PACKAGE}`);
  if (receipt.sourceSha !== sourceSha)
    failures.push('sourceSha is not the source this job records');
  if (receipt.registryGitHead !== sourceSha)
    failures.push('registryGitHead is not the source this job records');
  if (
    typeof receipt.version !== 'string' ||
    !NIGHTLY_CLI_VERSION_PREFIX.test(receipt.version) ||
    receipt.version.replace(NIGHTLY_CLI_VERSION_PREFIX, '') !== runId
  )
    failures.push(`version is not a Nightly CLI version of run ${runId}`);
  if (
    typeof receipt.verifiedAt !== 'string' ||
    !TIMESTAMP_PATTERN.test(receipt.verifiedAt) ||
    Number.isNaN(Date.parse(receipt.verifiedAt))
  )
    failures.push('verifiedAt is not an ISO 8601 UTC second');
  else if (Date.parse(receipt.verifiedAt) > now + FUTURE_TIMESTAMP_SKEW_MS)
    failures.push('verifiedAt is in the future');
  if (failures.length > 0) {
    throw new Error(`refusing the CLI receipt: ${failures.join('; ')}`);
  }
  return { version: receipt.version, verifiedAt: receipt.verifiedAt };
}

function main(argv) {
  if (argv.length !== 3) {
    console.error(
      'usage: node scripts/lib/nightly-cli-ledger-handoff.mjs <receipt.json> <source-sha> <run-id>',
    );
    return 1;
  }
  const [receiptPath, sourceSha, runId] = argv;
  try {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    const { version, verifiedAt } = readNightlyCliHandoff(receipt, {
      sourceSha,
      runId,
    });
    process.stdout.write(`${version}\t${verifiedAt}\n`);
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (invokedDirectly(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
