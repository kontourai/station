#!/usr/bin/env node
/**
 * Assembles a Tauri v2 static updater manifest (`latest.json`) from the
 * platform targets produced by one release.
 *
 * One nightly ship writes a manifest naming only the platform it just built
 * — it never merges with a previously published manifest, because carrying
 * a stale `platforms` entry forward would offer an update the new signing
 * key or build never produced.
 */

import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const PUB_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const HTTPS_URL_PATTERN = /^https:\/\/\S+$/;
const RELEASE_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview\.([1-9]\d*))?$/;
const PLATFORM_ASSET_TOKENS = Object.freeze({
  'darwin-aarch64': ['macos', 'aarch64'],
  'darwin-x86_64': ['macos', 'x86_64'],
  'windows-x86_64': ['windows', 'x86_64'],
  'linux-x86_64': ['linux', 'x86_64'],
});

function fail(message) {
  throw new Error(`Invalid Tauri updater manifest: ${message}`);
}

function assetNameFromUrl(url) {
  try {
    return basename(new URL(url).pathname);
  } catch {
    fail(`manifest asset url is invalid: ${JSON.stringify(url)}`);
  }
}

export function assertUpdaterAssetMatchesPlatform(platform, assetName) {
  const tokens = PLATFORM_ASSET_TOKENS[platform];
  if (!tokens)
    fail(`platform ${JSON.stringify(platform)} has no asset identity contract`);
  for (const token of tokens) {
    const tokenPattern = new RegExp(
      `(?:^|[-_.])${token.replaceAll('_', '\\_')}(?=[-_.]|$)`,
    );
    if (!tokenPattern.test(assetName))
      fail(
        `asset ${JSON.stringify(assetName)} does not encode platform ${JSON.stringify(platform)} token ${JSON.stringify(token)}`,
      );
  }
}

function assertUpdaterSignatureFileMatchesAsset(platform, signaturePath, url) {
  const signatureName = basename(signaturePath);
  const assetName = assetNameFromUrl(url);
  assertUpdaterAssetMatchesPlatform(platform, signatureName);
  if (signatureName !== `${assetName}.sig`)
    fail(
      `--signature-file ${JSON.stringify(signatureName)} does not match updater asset ${JSON.stringify(assetName)} for platform ${JSON.stringify(platform)}`,
    );
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
  return createUpdaterManifestForPlatforms({
    version,
    notes,
    pubDate,
    releaseTag,
    platforms: [{ platform, signature, url }],
  });
}

/**
 * @param {{
 *   version: string,
 *   notes?: string,
 *   pubDate: string,
 *   releaseTag: string,
 *   platforms: Array<{ platform: string, signature: string, url: string }>,
 * }} input
 */
export function createUpdaterManifestForPlatforms({
  version,
  notes = '',
  pubDate,
  releaseTag,
  platforms,
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
  if (typeof releaseTag !== 'string' || releaseTag.trim().length === 0) {
    fail('releaseTag must be non-empty');
  }
  if (!Array.isArray(platforms) || platforms.length === 0)
    fail('platforms must contain at least one entry');

  const entries = {};
  for (const { platform, signature, url } of platforms) {
    if (typeof platform !== 'string' || platform.trim().length === 0)
      fail('platform must be non-empty');
    if (Object.hasOwn(entries, platform))
      fail(`platform ${JSON.stringify(platform)} is duplicated`);
    if (typeof signature !== 'string' || signature.trim().length === 0)
      fail('signature must be non-empty');
    if (typeof url !== 'string' || !HTTPS_URL_PATTERN.test(url))
      fail('url must be an https URL');
    if (!url.includes(`/download/${releaseTag}/`)) {
      fail(
        `url must be a release-asset download URL under releaseTag ${JSON.stringify(releaseTag)} (expected "/download/${releaseTag}/" in the url); the asset name, --release-tag, and --url must all name the same release`,
      );
    }
    assertUpdaterAssetMatchesPlatform(platform, assetNameFromUrl(url));
    entries[platform] = { signature: signature.trim(), url };
  }
  return {
    version,
    notes,
    pub_date: pubDate,
    platforms: entries,
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

export function assertUpdaterAssetFile(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0)
      fail(
        `--asset-file ${JSON.stringify(path)} must be a non-empty regular file`,
      );
  } catch (error) {
    if (error.message?.startsWith('Invalid Tauri updater manifest:'))
      throw error;
    fail(
      `could not read --asset-file ${JSON.stringify(path)} (${error.code ?? error.message}); the desktop build must produce this updater archive before the manifest step runs`,
    );
  }
}

export function verifyUpdaterManifestAssets({
  manifestPath,
  assetsDir,
  releaseTag,
}) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(
      `could not read manifest ${JSON.stringify(manifestPath)} (${error.code ?? error.message})`,
    );
  }
  if (!manifest?.platforms || typeof manifest.platforms !== 'object')
    fail('manifest platforms must be an object');
  const entries = Object.entries(manifest.platforms);
  if (entries.length === 0) fail('manifest platforms must not be empty');
  for (const [platform, entry] of entries) {
    const url = entry?.url;
    if (typeof url !== 'string' || !url.includes(`/download/${releaseTag}/`))
      fail(
        `manifest asset url must be under releaseTag ${JSON.stringify(releaseTag)}`,
      );
    const assetName = assetNameFromUrl(url);
    assertUpdaterAssetMatchesPlatform(platform, assetName);
    assertUpdaterAssetFile(join(assetsDir, assetName));
    const signature = entry?.signature;
    if (typeof signature !== 'string' || signature.trim().length === 0)
      fail(
        `manifest signature for platform ${JSON.stringify(platform)} is empty`,
      );
    const signaturePath = join(assetsDir, `${assetName}.sig`);
    const publishedSignature = readUpdaterSignatureFile(signaturePath).trim();
    if (signature.trim() !== publishedSignature)
      fail(
        `manifest signature for platform ${JSON.stringify(platform)} does not match ${JSON.stringify(basename(signaturePath))}`,
      );
  }
}

function releaseVersionParts(version) {
  const match =
    typeof version === 'string' ? RELEASE_VERSION_PATTERN.exec(version) : null;
  if (!match)
    fail(
      `version ${JSON.stringify(version)} is not a stable or preview release version`,
    );
  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    match[4] === undefined ? Number.POSITIVE_INFINITY : Number(match[4]),
  ];
}

function readManifestVersion(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8')).version;
  } catch (error) {
    fail(
      `could not read ${label} manifest ${JSON.stringify(path)} (${error.code ?? error.message})`,
    );
  }
}

export function assertUpdaterManifestNotRegressing({
  candidatePath,
  currentPath,
  allowRegression = false,
}) {
  const candidate = readManifestVersion(candidatePath, 'candidate');
  const current = readManifestVersion(currentPath, 'current');
  const candidateParts = releaseVersionParts(candidate);
  const currentParts = releaseVersionParts(current);
  const comparison = candidateParts.findIndex(
    (value, index) => value !== currentParts[index],
  );
  const regresses =
    comparison !== -1 && candidateParts[comparison] < currentParts[comparison];
  if (regresses && !allowRegression)
    fail(
      `candidate version ${candidate} is older than current version ${current}; use the protected break-glass repair only after owner review`,
    );
  return { candidate, current, regresses };
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

function options(name, args) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== `--${name}`) continue;
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--'))
      throw new Error(`--${name} requires a value`);
    values.push(value);
  }
  return values;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.includes('--assert-not-regressing')) {
    const candidatePath = option('candidate-manifest', args);
    const currentPath = option('current-manifest', args);
    if (!candidatePath || !currentPath)
      throw new Error(
        'Usage: tauri-updater-manifest.mjs --assert-not-regressing --candidate-manifest <latest.json> --current-manifest <latest.json> [--allow-regression]',
      );
    const result = assertUpdaterManifestNotRegressing({
      candidatePath,
      currentPath,
      allowRegression: args.includes('--allow-regression'),
    });
    console.log(
      `Updater pointer ${result.current} -> ${result.candidate}${result.regresses ? ' (protected break-glass regression)' : ''}`,
    );
    process.exit(0);
  }
  if (args.includes('--verify')) {
    const manifestPath = option('manifest', args);
    const assetsDir = option('assets-dir', args);
    const releaseTag = option('release-tag', args);
    if (!manifestPath || !assetsDir || !releaseTag)
      throw new Error(
        'Usage: tauri-updater-manifest.mjs --verify --manifest <latest.json> --assets-dir <path> --release-tag <tag>',
      );
    verifyUpdaterManifestAssets({ manifestPath, assetsDir, releaseTag });
    console.log(`Verified updater manifest assets for ${releaseTag}`);
    process.exit(0);
  }
  const version = option('version', args);
  const pubDate = option('pub-date', args);
  const platforms = options('platform', args);
  const signatureFiles = options('signature-file', args);
  const urls = options('url', args);
  const assetFiles = options('asset-file', args);
  const releaseTag = option('release-tag', args);
  const outputPath = option('output', args);
  if (
    !version ||
    !pubDate ||
    platforms.length === 0 ||
    !releaseTag ||
    !outputPath
  ) {
    throw new Error(
      'Usage: tauri-updater-manifest.mjs --version <semver> --pub-date <ISO-8601> --platform <darwin-aarch64> --signature-file <path> --url <https-url> --release-tag <tag> --output <path> [--notes <text>]',
    );
  }
  if (
    signatureFiles.length !== platforms.length ||
    urls.length !== platforms.length ||
    (assetFiles.length > 0 && assetFiles.length !== platforms.length)
  )
    throw new Error(
      'Each --platform requires one --signature-file and --url, and when used one --asset-file',
    );
  const entries = platforms.map((platform, index) => {
    if (assetFiles[index]) assertUpdaterAssetFile(assetFiles[index]);
    assertUpdaterSignatureFileMatchesAsset(
      platform,
      signatureFiles[index],
      urls[index],
    );
    return {
      platform,
      signature: readUpdaterSignatureFile(signatureFiles[index]),
      url: urls[index],
    };
  });
  const manifest = createUpdaterManifestForPlatforms({
    version,
    notes: option('notes', args) ?? '',
    pubDate,
    releaseTag,
    platforms: entries,
  });
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `Updater manifest ${manifest.version} (${platforms.join(', ')}) -> ${outputPath}`,
  );
}
