#!/usr/bin/env node
/**
 * Assembles a Tauri v2 static updater manifest (`latest.json`) for exactly
 * one platform target.
 *
 * One nightly ship writes a manifest naming only the platform it just built
 * — it never merges with a previously published manifest, because carrying
 * a stale `platforms` entry forward would offer an update the new signing
 * key or build never produced.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const PUB_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const HTTPS_URL_PATTERN = /^https:\/\/\S+$/;

function fail(message) {
  throw new Error(`Invalid Tauri updater manifest: ${message}`);
}

/**
 * `releaseTag` is required and the `url` MUST resolve under that exact tag's
 * download path. Without this, the asset name, the `--release-tag` the
 * notarization step signed under, and this manifest's `url` are three
 * independent literals that a workflow edit can drift apart silently — a
 * manifest can point at a real, reachable, correctly-signed asset that
 * simply lives under the WRONG release, and every check here would still
 * pass.
 *
 * @param {{
 *   version: string,
 *   notes?: string,
 *   pubDate: string,
 *   platform: string,
 *   signature: string,
 *   url: string,
 *   releaseTag: string,
 * }} input
 * @returns {{
 *   version: string,
 *   notes: string,
 *   pub_date: string,
 *   platforms: Record<string, { signature: string, url: string }>,
 * }}
 */
export function createUpdaterManifest({
  version,
  notes = '',
  pubDate,
  platform,
  signature,
  url,
  releaseTag,
}) {
  if (typeof version !== 'string' || version.trim().length === 0) {
    fail('version must be non-empty');
  }
  if (typeof notes !== 'string') {
    fail('notes must be a string');
  }
  if (typeof pubDate !== 'string' || !PUB_DATE_PATTERN.test(pubDate)) {
    fail('pub_date must be an ISO-8601 UTC timestamp');
  }
  if (typeof platform !== 'string' || platform.trim().length === 0) {
    fail('platform must be non-empty');
  }
  if (typeof signature !== 'string' || signature.trim().length === 0) {
    fail('signature must be non-empty');
  }
  if (typeof url !== 'string' || !HTTPS_URL_PATTERN.test(url)) {
    fail('url must be an https URL');
  }
  if (typeof releaseTag !== 'string' || releaseTag.trim().length === 0) {
    fail('releaseTag must be non-empty');
  }
  if (!url.includes(`/download/${releaseTag}/`)) {
    fail(
      `url must be a release-asset download URL under releaseTag ${JSON.stringify(releaseTag)} (expected "/download/${releaseTag}/" in the url); the asset name, --release-tag, and --url must all name the same release`,
    );
  }
  return {
    version,
    notes,
    pub_date: pubDate,
    platforms: { [platform]: { signature: signature.trim(), url } },
  };
}

/**
 * Reads a Tauri signer `.sig` file, converting a missing/unreadable file
 * into this library's own teaching-message form instead of a raw ENOENT —
 * the caller is always a workflow step, and "file not found" alone does not
 * say which flag or prior step produced the missing path.
 */
export function readUpdaterSignatureFile(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    fail(
      `could not read --signature-file ${JSON.stringify(path)} (${error.code ?? error.message}); the notarize/sign step must produce this file before the manifest step runs`,
    );
  }
}

/** Refuses a flag value that is itself another flag: `--url --output x.json`
 * silently swallowing `--output` (with `url` becoming `x.json`'s value on
 * the NEXT lookup) is a missing-argument bug, not a valid invocation. */
function option(name, args) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const version = option('version', args);
  const pubDate = option('pub-date', args);
  const platform = option('platform', args);
  const signatureFile = option('signature-file', args);
  const url = option('url', args);
  const releaseTag = option('release-tag', args);
  const outputPath = option('output', args);
  if (
    !version ||
    !pubDate ||
    !platform ||
    !signatureFile ||
    !url ||
    !releaseTag ||
    !outputPath
  ) {
    throw new Error(
      'Usage: tauri-updater-manifest.mjs --version <semver> --pub-date <ISO-8601> --platform <darwin-aarch64> --signature-file <path> --url <https-url> --release-tag <tag> --output <path> [--notes <text>]',
    );
  }
  const manifest = createUpdaterManifest({
    version,
    notes: option('notes', args) ?? '',
    pubDate,
    platform,
    signature: readUpdaterSignatureFile(signatureFile),
    url,
    releaseTag,
  });
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Updater manifest ${manifest.version} (${platform}) -> ${url}`);
}
