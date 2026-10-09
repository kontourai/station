#!/usr/bin/env node
/**
 * Decides whether a green Main qualification run publishes a Nightly from its
 * own, just-qualified commit.
 *
 * `main-qualification.yml` calls `nightly.yml` from inside the qualification
 * run so that the run's triggering commit — the one every attestation,
 * provenance record, and cohort verifier binds to — is the qualified commit
 * by construction. Main pushes and the hourly fallback qualify immutable
 * candidates; delivery has a separate lease and configurable minimum cadence.
 * Terminal failed delivery producers permit bounded native recovery while live
 * or unknown reservations remain held.
 *
 * Markers, all durable and all maintained by the Nightly legs themselves:
 * - the deploy ledger on `origin/main` (`docs/reference/deploy-ledger.json`):
 *   a native row (`nightly-android`, `nightly-desktop`) is written only after
 *   the attested final cohort receipt verified that platform as published.
 *   Only native rows count: this entry point cannot publish the CLI (npm
 *   trusted publishing matches the top-level workflow, which is
 *   `main-qualification.yml`), so a CLI-only row must not suppress a native
 *   cohort the scheduled Nightly failed to ship;
 * - the native version-code reservation tags
 *   (`refs/tags/nightly-version-code/<code>`), which `nightly-native-stage.yml`
 *   creates at this source before it builds anything. A reservation without
 *   a ledger row means a Nightly at this source failed or is still running.
 *
 * Skip when a native row names this source (or the source it reduces to once
 * generated ledger commit-backs are peeled), when a reservation names this
 * source, or when the newest native row is younger than
 * MIN_PUBLICATION_INTERVAL_MS. Every input is validated and a malformed one
 * throws: a decision must never run on a guess.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { invokedDirectly } from './lib/module-entry.mjs';
import { assertLedgerEntries } from './lib/nightly-cohort-decision.mjs';
import {
  DEFAULT_LEDGER_REF,
  readLedgerFromGit,
} from './nightly-cohort-decide.mjs';
import {
  inspectCommitFromGit,
  normalizeDeployLedgerHead,
} from './normalize-deploy-ledger-head.mjs';
import {
  publicationInterval,
  reservationRecovery,
} from './release-pipeline.mjs';

/** Default minimum native publication interval; operators may configure 1–168 hours. */
export const MIN_PUBLICATION_INTERVAL_MS = 6 * 60 * 60 * 1000;

const NATIVE_LEDGER_CHANNELS = Object.freeze([
  'nightly-android',
  'nightly-desktop',
]);

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
// The exact line `git ls-remote --refs <remote> 'refs/tags/nightly-version-code/*'`
// prints for a lightweight reservation tag.
const RESERVATION_LINE =
  /^([0-9a-f]{40})\trefs\/tags\/nightly-version-code\/([1-9][0-9]*)$/;

function assertSha(value, name) {
  if (typeof value !== 'string' || !SHA_PATTERN.test(value))
    throw new Error(`${name} must be a 40-character lowercase hexadecimal SHA`);
}

/** Reservation tag lines as `{ sha, code }`; any other line fails closed. */
export function parseReservationRefs(text) {
  if (typeof text !== 'string')
    throw new Error('reservation refs must be text');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const match = RESERVATION_LINE.exec(line);
      if (!match) throw new Error(`unrecognised reservation ref line: ${line}`);
      return { sha: match[1], code: match[2] };
    });
}

/** Native ledger rows, newest first, each with a validated timestamp. */
function nativeShips(ledgerEntries) {
  assertLedgerEntries(ledgerEntries);
  return ledgerEntries
    .filter((entry) => NATIVE_LEDGER_CHANNELS.includes(entry.channel))
    .map((entry) => {
      if (
        typeof entry.timestampUtc !== 'string' ||
        !TIMESTAMP_PATTERN.test(entry.timestampUtc) ||
        Number.isNaN(Date.parse(entry.timestampUtc))
      )
        throw new Error(
          `deploy ledger ${entry.channel} row at ${entry.sha} has a malformed timestampUtc: ${String(entry.timestampUtc)}`,
        );
      return { ...entry, at: Date.parse(entry.timestampUtc) };
    })
    .sort((a, b) => b.at - a.at);
}

/**
 * @param {object} input
 * @param {string} input.sourceSha The qualified commit (the run's event SHA).
 * @param {string} input.candidateSha `sourceSha` with generated ledger
 *   commit-backs peeled, stopping at the newest native ship.
 * @param {unknown} input.ledgerEntries The parsed deploy ledger.
 * @param {string} input.reservationRefs `git ls-remote --refs` output.
 * @param {Date} input.now
 * @returns {{ publish: boolean, reason: string }}
 */
export function decideQualifiedNightly({
  sourceSha,
  candidateSha,
  ledgerEntries,
  reservationRefs,
  now,
  intervalMs = MIN_PUBLICATION_INTERVAL_MS,
  recovery = { recover: false },
  sourceCandidates = {},
}) {
  assertSha(sourceSha, 'source SHA');
  assertSha(candidateSha, 'candidate SHA');
  if (!(now instanceof Date) || Number.isNaN(now.getTime()))
    throw new Error('now must be a valid Date');
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 3_600_000 ||
    intervalMs > 168 * 3_600_000
  )
    throw new Error('invalid minimum publication interval');
  const ships = nativeShips(ledgerEntries);
  const reservations = parseReservationRefs(reservationRefs);

  const sourceShips = ships.filter(
    (ship) =>
      ship.sha === sourceSha ||
      ship.sha === candidateSha ||
      sourceCandidates[ship.channel] === ship.sha,
  );
  const complete = NATIVE_LEDGER_CHANNELS.every((channel) =>
    sourceShips.some((ship) => ship.channel === channel),
  );
  const shipped = sourceShips[0];
  if (complete)
    return {
      publish: false,
      reason: `already published: the deploy ledger records ${shipped.channel} ${shipped.version} at ${shipped.sha}`,
    };
  const reserved = reservations.find(
    (reservation) =>
      reservation.sha === sourceSha || reservation.sha === candidateSha,
  );
  if (reserved && !recovery.recover)
    return {
      publish: false,
      reason: `already attempted: refs/tags/nightly-version-code/${reserved.code} reserves ${reserved.sha} without a native ledger row, so a Nightly at this source failed or is still running; retry by dispatching Nightly`,
    };
  if (recovery.recover) return { publish: true, reason: recovery.reason };
  const newest = ships[0];
  if (newest) {
    const age = now.getTime() - newest.at;
    if (age < intervalMs)
      return {
        publish: false,
        reason: `published recently: ${newest.channel} ${newest.version} at ${newest.sha} was recorded ${newest.timestampUtc}, less than ${intervalMs / 3_600_000}h ago`,
      };
  }
  return {
    publish: true,
    reason: newest
      ? `no native Nightly in the last ${intervalMs / 3_600_000}h (newest: ${newest.channel} at ${newest.sha}, ${newest.timestampUtc}) and none at this source`
      : 'no native Nightly has been recorded',
  };
}

const FLAGS = new Map([
  ['--source-sha', 'sourceSha'],
  ['--reservation-refs', 'reservationRefsPath'],
  ['--ledger-ref', 'ledgerRef'],
  ['--repo-root', 'repoRoot'],
]);

function usage() {
  return [
    'usage: node scripts/nightly-qualification-decide.mjs \\',
    '         --source-sha <40-hex> --reservation-refs <git-ls-remote-output-file> \\',
    '         [--ledger-ref <git-ref>] [--repo-root <path>]',
    '',
    'Writes publish=<true|false> to $GITHUB_OUTPUT and the reason to',
    '$GITHUB_STEP_SUMMARY (both also printed).',
  ].join('\n');
}

function parseArgs(argv) {
  const options = { ledgerRef: DEFAULT_LEDGER_REF, repoRoot: process.cwd() };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!FLAGS.has(flag) || value === undefined || seen.has(flag)) return null;
    seen.add(flag);
    options[FLAGS.get(flag)] = value;
  }
  if (!seen.has('--source-sha') || !seen.has('--reservation-refs')) return null;
  return options;
}

export async function main(
  argv,
  {
    readLedger = readLedgerFromGit,
    inspectCommit = inspectCommitFromGit,
    now = new Date(),
    env = process.env,
  } = {},
) {
  const options = parseArgs(argv);
  if (options === null) {
    console.error(usage());
    return 1;
  }
  let decision;
  try {
    assertSha(options.sourceSha, 'source SHA');
    const ledgerEntries = readLedger(options.repoRoot, options.ledgerRef);
    const newest = nativeShips(ledgerEntries)[0];
    const commits = new Map();
    const inspect = (sha) => {
      if (!commits.has(sha))
        commits.set(sha, inspectCommit(options.repoRoot, sha));
      return commits.get(sha);
    };
    const candidateSha = normalizeDeployLedgerHead(
      options.sourceSha,
      inspect,
      newest?.sha ?? '',
    );
    const sourceCandidates = Object.fromEntries(
      NATIVE_LEDGER_CHANNELS.map((channel) => {
        const last = nativeShips(ledgerEntries).find(
          (row) => row.channel === channel,
        );
        return [
          channel,
          normalizeDeployLedgerHead(
            options.sourceSha,
            inspect,
            last?.sha || '',
          ),
        ];
      }),
    );
    let recovery = { recover: false };
    const reserved = parseReservationRefs(
      readFileSync(options.reservationRefsPath, 'utf8'),
    ).find(
      (entry) => entry.sha === options.sourceSha || entry.sha === candidateSha,
    );
    if (reserved && env.GITHUB_REPOSITORY && env.GH_TOKEN) {
      recovery = await reservationRecovery(reserved.sha, env);
    }
    decision = decideQualifiedNightly({
      sourceSha: options.sourceSha,
      candidateSha,
      ledgerEntries,
      reservationRefs: readFileSync(options.reservationRefsPath, 'utf8'),
      now,
      intervalMs: publicationInterval(env),
      recovery,
      sourceCandidates,
    });
  } catch (error) {
    console.error(`::error::${error.message}`);
    return 1;
  }
  const line = `publish=${decision.publish}`;
  process.stdout.write(`${line}\n${decision.reason}\n`);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Qualified Nightly for \`${options.sourceSha}\`: ${decision.publish ? 'publish' : 'skip'} — ${decision.reason}\n`,
    );
  return 0;
}

if (invokedDirectly(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
