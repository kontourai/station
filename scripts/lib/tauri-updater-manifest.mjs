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
 * @param {{
 *   version: string,
 *   notes?: string,
 *   pubDate: string,
 *   platform: string,
 *   signature: string,
 *   url: string,
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
  return {
    version,
    notes,
    pub_date: pubDate,
    platforms: { [platform]: { signature: signature.trim(), url } },
  };
}

function option(name, args) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const version = option('version', args);
  const pubDate = option('pub-date', args);
  const platform = option('platform', args);
  const signatureFile = option('signature-file', args);
  const url = option('url', args);
  const outputPath = option('output', args);
  if (
    !version ||
    !pubDate ||
    !platform ||
    !signatureFile ||
    !url ||
    !outputPath
  ) {
    throw new Error(
      'Usage: tauri-updater-manifest.mjs --version <semver> --pub-date <ISO-8601> --platform <darwin-aarch64> --signature-file <path> --url <https-url> --output <path> [--notes <text>]',
    );
  }
  const manifest = createUpdaterManifest({
    version,
    notes: option('notes', args) ?? '',
    pubDate,
    platform,
    signature: readFileSync(signatureFile, 'utf8'),
    url,
  });
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Updater manifest ${manifest.version} (${platform}) -> ${url}`);
}
