#!/usr/bin/env node
/**
 * Allocate one Android version code for the Nightly workflow.
 *
 * The caller is responsible for immediately creating the emitted immutable
 * `reservation_tag` before starting a build. This script remains hermetic: the
 * workflow supplies `git ls-remote` output, so tests can prove allocation
 * without network access or release credentials.
 */
import { appendFileSync } from 'node:fs';
import { invokedDirectly } from './lib/module-entry.mjs';
import {
  allocateNightlyVersionCode,
  parseNightlyVersionCodeReservations,
} from './lib/nightly-build-identity.mjs';

export function allocateFromEnvironment(env = process.env) {
  const date = new Date(env.NIGHTLY_NOW ?? '');
  const reservedVersionCodes = parseNightlyVersionCodeReservations(
    env.NIGHTLY_RESERVED_TAGS ?? '',
  );
  return allocateNightlyVersionCode({
    date,
    requestedBuild: env.NIGHTLY_REQUESTED_BUILD,
    reservedVersionCodes,
  });
}

export function githubOutput(allocation) {
  return [
    `build=${allocation.build}`,
    `version_code=${allocation.versionCode}`,
    `reservation_tag=${allocation.reservationTag.slice('refs/tags/'.length)}`,
  ].join('\n');
}

export function githubOutputWithDate(allocation, date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime()))
    throw new Error('nightly identity requires a valid Date');
  return [`date=${date.toISOString()}`, githubOutput(allocation)].join('\n');
}

function main() {
  if (!process.env.GITHUB_OUTPUT)
    throw new Error(
      'GITHUB_OUTPUT is required for nightly version-code allocation',
    );
  const date = new Date(process.env.NIGHTLY_NOW ?? '');
  const allocation = allocateFromEnvironment();
  const output = githubOutputWithDate(allocation, date);
  appendFileSync(process.env.GITHUB_OUTPUT, `${output}\n`);
  process.stdout.write(`${output}\n`);
}

if (invokedDirectly(import.meta.url)) main();
