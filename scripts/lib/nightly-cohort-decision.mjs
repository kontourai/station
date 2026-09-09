/**
 * Decide whether the native Nightly cohort needs to build for a source SHA.
 *
 * The rolling markers (`refs/tags/nightly` for Android, `refs/tags/nightly-desktop`
 * for macOS) say where each platform LAST PUBLISHED. They do not say whether
 * that publish was verified: under the per-platform cohort (#1774) the macOS
 * job moves `nightly-desktop` before its claim step, so a night whose macOS
 * claim failed leaves the marker at HEAD with the release served but
 * unverified and unledgered. Deciding from marker position alone then reads
 * that night as "shipped" and never rebuilds it (#1780).
 *
 * The deploy ledger is the evidence: `record-native-completion` writes a row
 * for a platform only when the attested final receipt verified it as
 * published. So a marker at HEAD counts as shipped only when the ledger holds
 * a row for that platform's channel at the marker's SHA. The row is the
 * evidence, not its `gateResult` text — a row written during a `partial`
 * night still means THIS platform was verified (the other platform is the
 * one the receipt could not verify), so it counts.
 *
 * Pure: every input is a value, so the rule is unit-testable without git or
 * a workflow. `scripts/nightly-cohort-decide.mjs` is the thin CLI.
 */

import { DEPLOY_LEDGER_CHANNELS } from '../deploy-ledger.mjs';

const SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * One row per native platform the cohort ships: the platform name the
 * receipt uses, the rolling marker ref, and the ledger channel whose row is
 * the evidence that the marker's SHA was verified as published.
 */
export const NATIVE_COHORT_PLATFORMS = Object.freeze([
  Object.freeze({
    platform: 'android',
    marker: 'refs/tags/nightly',
    channel: 'nightly-android',
  }),
  Object.freeze({
    platform: 'macos',
    marker: 'refs/tags/nightly-desktop',
    channel: 'nightly-desktop',
  }),
]);

export const NO_COHORT_NEEDED = 'No native cohort is needed for this source.';

function assertSha(value, name) {
  if (typeof value !== 'string' || !SHA_PATTERN.test(value)) {
    throw new Error(`${name} must be a 40-character lowercase hexadecimal SHA`);
  }
}

function assertMarkerSha(value, name) {
  // Empty is the explicit bootstrap marker (the tag does not exist yet);
  // anything else must be a real SHA.
  if (value === '') return;
  assertSha(value, name);
}

/**
 * The ledger is an input we did not produce in this run, so it is validated
 * before it decides anything: a document that is not an array, or an entry
 * whose channel or sha is not one the ledger writer could have produced,
 * fails closed rather than reading as "no row".
 */
export function assertLedgerEntries(ledgerEntries) {
  if (!Array.isArray(ledgerEntries)) {
    throw new Error('deploy ledger must be a JSON array of entries');
  }
  ledgerEntries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`deploy ledger entry ${index} must be an object`);
    }
    if (
      typeof entry.channel !== 'string' ||
      !DEPLOY_LEDGER_CHANNELS.includes(entry.channel)
    ) {
      throw new Error(
        `deploy ledger entry ${index} has an unknown channel: ${String(entry.channel)}`,
      );
    }
    if (typeof entry.sha !== 'string' || !SHA_PATTERN.test(entry.sha)) {
      throw new Error(
        `deploy ledger entry ${index} (${entry.channel}) has a malformed sha: ${String(entry.sha)}`,
      );
    }
  });
}

/**
 * Whether the ledger records a verified publish of `channel` from `sha`.
 * Any row is evidence; `gateResult` prose is not consulted (see the header).
 */
export function ledgerRecordsShip(ledgerEntries, channel, sha) {
  return ledgerEntries.some(
    (entry) => entry.channel === channel && entry.sha === sha,
  );
}

/**
 * @param {object} input
 * @param {string} input.headSha The checkout's HEAD (the cohort's source SHA).
 * @param {Record<'android'|'macos', {markerSha: string, candidateSha: string}>} input.platforms
 *   Per platform: the rolling marker's commit (`''` when the tag does not
 *   exist) and the candidate SHA `normalize-deploy-ledger-head.mjs` produced
 *   for that marker — HEAD with generated ledger commits peeled, stopping at
 *   the marker. The marker is "at HEAD" exactly when the two are equal.
 * @param {unknown} input.ledgerEntries `docs/reference/deploy-ledger.json`, parsed.
 * @param {string} [input.rebuildIndex] `inputs.rebuild_index`; non-empty forces a build.
 * @returns {{ build: boolean, reasons: string[] }} `reasons` names every
 *   platform (or the manual request) that requires a build; empty when none does.
 */
export function decideNativeCohort({
  headSha,
  platforms,
  ledgerEntries,
  rebuildIndex = '',
}) {
  assertSha(headSha, 'head SHA');
  if (!platforms || typeof platforms !== 'object') {
    throw new Error('platforms must be an object keyed by platform');
  }
  if (typeof rebuildIndex !== 'string') {
    throw new Error(
      'rebuild index must be a string (empty when not requested)',
    );
  }
  assertLedgerEntries(ledgerEntries);

  const reasons = [];
  for (const { platform, marker, channel } of NATIVE_COHORT_PLATFORMS) {
    const state = platforms[platform];
    if (!state || typeof state !== 'object') {
      throw new Error(`platforms.${platform} is required`);
    }
    const { markerSha, candidateSha } = state;
    assertMarkerSha(markerSha, `${platform} marker SHA`);
    assertSha(candidateSha, `${platform} candidate SHA`);

    if (markerSha === '') {
      reasons.push(`${platform}: ${marker} does not exist yet (bootstrap)`);
      continue;
    }
    if (markerSha !== candidateSha) {
      reasons.push(
        `${platform}: ${marker} is at ${markerSha}, behind source ${candidateSha}`,
      );
      continue;
    }
    if (!ledgerRecordsShip(ledgerEntries, channel, markerSha)) {
      // The marker moved but no verified publish was recorded for it: the
      // build it points at may be served and was never verified (#1780).
      reasons.push(
        `${platform}: marker at HEAD without a ledger row for this source (no ${channel} entry at ${markerSha})`,
      );
    }
  }
  if (rebuildIndex !== '') {
    reasons.push(`manual rebuild requested (rebuild_index=${rebuildIndex})`);
  }
  return { build: reasons.length > 0, reasons };
}
