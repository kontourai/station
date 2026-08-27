/**
 * `station --version` / `-v` / `version`.
 *
 * Prints the CLI package version plus the build provenance the lifecycle
 * commands already record (`readBuildManifest` — the sha/branch/timestamp
 * written when the instance was built), rather than inventing a second,
 * competing notion of "what is running".
 */

import { readFileSync } from 'node:fs';
import { bundleInfo } from '../distribution.js';

export function readCliVersion(): string {
  // The published bundle carries its version in the build banner. The
  // package.json walk below is relative to this file's location in `src/`, and
  // the bundle collapses that layout away — a build-time constant cannot end
  // up reading some other package's manifest.
  const bundle = bundleInfo();
  if (bundle) return bundle.version;
  try {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
    ) as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function versionText(): string {
  const bundle = bundleInfo();
  if (bundle) {
    return `station ${bundle.version}\n  ${bundle.channel} ${bundle.sourceSha}\n`;
  }
  // A source checkout is development even when a nearby backend build
  // manifest has a non-prerelease version. Backend STATION_CHANNEL is not CLI
  // artifact provenance and must not relabel this command as Stable.
  return `station ${readCliVersion()}\n  development source checkout\n`;
}
