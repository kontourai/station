#!/usr/bin/env node
/**
 * iOS channel app icons: apply the committed per-channel asset set to the
 * generated Xcode catalog, and prove the catalog (and the shipped bundle)
 * derive from it.
 *
 * `tauri ios init` regenerates gen/apple/Assets.xcassets/AppIcon.appiconset
 * from Tauri's template with Tauri's own default PNGs — the yellow/cyan Tauri
 * logo — because the repo has no `icons/ios/` set for it to copy. The
 * TestFlight workflow deletes gen/apple before every init, so without this
 * step a delivery ships the default icon (#1776, Nightly 34196525973).
 *
 * The committed sets live at src-desktop/icons/<channel>/ios/AppIcon-*.png
 * (scripts/generate-app-icons.mjs emits them from the opaque square master;
 * iOS rejects alpha). Their filenames are exactly the ones the template's
 * Contents.json references, so applying a set is a byte copy over the catalog.
 *
 * Every verdict here is computed, never recorded: `verify` compares the
 * catalog to the set file by file and the shipped bundle icon to the set
 * pixel by pixel, and throws on the first mismatch. The receipt fields it
 * writes are the outcome of those comparisons.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { iosTestFlightChannel } from './ios-testflight-channel.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const IOS_APP_ICON_CATALOG =
  'src-desktop/gen/apple/Assets.xcassets/AppIcon.appiconset';

/** The catalog entry Xcode also copies loose into the .app (iPhone @2x). */
export const SHIPPED_IOS_APP_ICON = {
  bundleFile: 'AppIcon60x60@2x.png',
  setFile: 'AppIcon-60x60@2x.png',
};

const PNG_NAME = /\.png$/;

function fail(message) {
  throw new Error(`iOS channel icons: ${message}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function catalogDir(root) {
  return join(root, IOS_APP_ICON_CATALOG);
}

function channelSetDir(channel, root) {
  return join(root, 'src-desktop', iosTestFlightChannel(channel).iosIconSet);
}

/** Filenames the catalog's Contents.json references, deduplicated, sorted. */
export function catalogFilenames(catalog) {
  const contentsPath = join(catalog, 'Contents.json');
  if (!existsSync(contentsPath))
    fail(`${contentsPath} is missing; run \`tauri ios init\` first`);
  const contents = JSON.parse(readFileSync(contentsPath, 'utf8'));
  const names = new Set();
  for (const image of contents.images ?? []) {
    if (typeof image.filename !== 'string' || !PNG_NAME.test(image.filename))
      fail(`Contents.json names a non-PNG image: ${JSON.stringify(image)}`);
    names.add(image.filename);
  }
  if (names.size === 0) fail('Contents.json references no images');
  return [...names].sort();
}

/** Every PNG in a committed channel set, sorted. */
export function channelSetFilenames(setDir) {
  if (!existsSync(setDir)) fail(`channel icon set ${setDir} does not exist`);
  return readdirSync(setDir)
    .filter((name) => PNG_NAME.test(name))
    .sort();
}

/**
 * Digest over the whole set: sorted filename + bytes, so a renamed, added,
 * or altered file changes it.
 */
export function channelSetDigest(setDir) {
  const hash = createHash('sha256');
  for (const name of channelSetFilenames(setDir)) {
    hash.update(name);
    hash.update('\0');
    hash.update(readFileSync(join(setDir, name)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * Every pixel of every PNG in an iOS set must be fully opaque. App Store
 * icons reject alpha, and the shipped-icon pixel comparison below depends on
 * it: Apple's CgBI re-encode premultiplies alpha, which is lossless only at
 * alpha 255 (a rounded-corner master drifts by hundreds of bytes at 120px).
 * Decoded with pngjs (pure JS) so generation and unit tests can both run it.
 * Returns the offending filenames; `assertOpaqueIosPngs` throws on any.
 */
export function translucentIosPngs(setDir) {
  const offending = [];
  for (const name of channelSetFilenames(setDir)) {
    const { data } = PNG.sync.read(readFileSync(join(setDir, name)));
    for (let at = 3; at < data.length; at += 4) {
      if (data[at] !== 255) {
        offending.push(name);
        break;
      }
    }
  }
  return offending;
}

export function assertOpaqueIosPngs(setDir) {
  const offending = translucentIosPngs(setDir);
  if (offending.length > 0)
    fail(
      `${offending.join(', ')} in ${setDir} carry alpha below 255; iOS icon sets must come from the opaque square master`,
    );
}

/**
 * Replace the freshly initialized catalog's PNGs with the channel's committed
 * set. Fails closed when the set lacks a file Contents.json references, or
 * when any file the catalog already held survives (i.e. the committed set IS
 * the template — the exact defect this exists to prevent).
 */
export function applyIosChannelIcons(channel, { root = ROOT } = {}) {
  const catalog = catalogDir(root);
  const setDir = channelSetDir(channel, root);
  const required = catalogFilenames(catalog);
  const available = new Set(channelSetFilenames(setDir));
  const missing = required.filter((name) => !available.has(name));
  if (missing.length > 0)
    fail(
      `${setDir} lacks ${missing.join(', ')} referenced by ${join(catalog, 'Contents.json')}`,
    );

  // What the catalog holds before the copy is what `tauri ios init` just
  // wrote (the workflow pins apply to the line after init). No set file may
  // equal its pre-apply counterpart: a set that shares bytes with the template
  // IS the template. A catalog that already holds the set is refused for the
  // same reason — this step has no way to tell the two apart, and nothing
  // needs to apply twice without an init in between.
  const before = new Map();
  for (const name of readdirSync(catalog)) {
    if (PNG_NAME.test(name))
      before.set(name, sha256(readFileSync(join(catalog, name))));
  }
  const survivors = required.filter(
    (name) => before.get(name) === sha256(readFileSync(join(setDir, name))),
  );
  if (survivors.length > 0)
    fail(
      `${survivors.join(', ')} in ${setDir} are byte-identical to what the catalog already holds; apply expects the catalog \`tauri ios init\` just wrote, and a ${channel} set equal to it is Tauri's default icon`,
    );
  for (const name of before.keys()) unlinkSync(join(catalog, name));
  for (const name of available) {
    copyFileSync(join(setDir, name), join(catalog, name));
  }
  return { catalog, iconSet: setDir, files: required };
}

/**
 * Prove the catalog is the channel set: every file Contents.json references
 * exists in both and is byte-identical. Returns the derived receipt fields.
 */
export function verifyIosChannelIcons(channel, { root = ROOT } = {}) {
  const catalog = catalogDir(root);
  const setDir = channelSetDir(channel, root);
  const files = catalogFilenames(catalog);
  const mismatched = [];
  for (const name of files) {
    const inSet = join(setDir, name);
    const inCatalog = join(catalog, name);
    if (!existsSync(inSet) || !existsSync(inCatalog)) {
      mismatched.push(name);
      continue;
    }
    if (!readFileSync(inSet).equals(readFileSync(inCatalog)))
      mismatched.push(name);
  }
  if (mismatched.length > 0)
    fail(
      `catalog ${catalog} does not match the ${channel} set ${setDir}: ${mismatched.join(', ')}`,
    );
  return {
    iconSet: iosTestFlightChannel(channel).iosIconSet,
    iconSetFiles: files,
    iconSetSha256: channelSetDigest(setDir),
    catalogMatchesChannelSet: true,
  };
}

function run(command, args) {
  return execFileSync(command, args, { stdio: 'pipe', windowsHide: true });
}

/**
 * Prove the icon Xcode placed in the .app is the channel's, pixel for pixel.
 *
 * Xcode's archive path re-encodes the loose AppIcon60x60@2x.png as CgBI
 * (premultiplied BGRA, Apple's private PNG variant), so bytes never match the
 * source. `pngcrush -revert-iphone-optimizations` restores a standard PNG,
 * and `sips` decodes both that and the set file to uncompressed BMP; the
 * BMPs compare equal exactly when every pixel does. Premultiplication is
 * lossless only for opaque pixels, which is why the sets come from the
 * square master. macOS only (xcrun, sips).
 *
 * @param {string} channel
 * @param {{ appDir: string; root?: string; tempDir?: string }} options
 */
export function verifyShippedIosAppIcon(
  channel,
  { appDir, root = ROOT, tempDir } = {},
) {
  if (typeof appDir !== 'string' || appDir.length === 0)
    fail('--app <Payload/*.app> is required');
  const shipped = join(appDir, SHIPPED_IOS_APP_ICON.bundleFile);
  if (!existsSync(shipped))
    fail(`${shipped} is missing; the bundle ships no app icon`);
  const expected = join(
    channelSetDir(channel, root),
    SHIPPED_IOS_APP_ICON.setFile,
  );
  if (!existsSync(expected)) fail(`${expected} is missing`);

  const work =
    tempDir ?? mkdtempSync(join(tmpdir(), 'station-ios-shipped-icon-'));
  try {
    const reverted = join(work, 'shipped.png');
    run('xcrun', [
      '--sdk',
      'iphoneos',
      'pngcrush',
      '-revert-iphone-optimizations',
      '-q',
      shipped,
      reverted,
    ]);
    const shippedBmp = join(work, 'shipped.bmp');
    const expectedBmp = join(work, 'expected.bmp');
    run('sips', ['-s', 'format', 'bmp', reverted, '--out', shippedBmp]);
    run('sips', ['-s', 'format', 'bmp', expected, '--out', expectedBmp]);
    const shippedPixels = readFileSync(shippedBmp);
    if (!shippedPixels.equals(readFileSync(expectedBmp)))
      fail(
        `${shipped} pixels differ from ${expected}; the bundle does not carry the ${channel} icon`,
      );
    return {
      shippedIcon: SHIPPED_IOS_APP_ICON.bundleFile,
      shippedIconSha256: sha256(readFileSync(shipped)),
      shippedIconPixelsMatchChannelSet: true,
    };
  } finally {
    if (!tempDir) rmSync(work, { recursive: true, force: true });
  }
}

function option(args, name) {
  const at = args.indexOf(`--${name}`);
  return at < 0 ? undefined : args[at + 1];
}

function main(args) {
  const [command, channel] = args;
  if (command === 'apply') {
    if (args.length !== 2) fail('usage: apply <channel>');
    const { files } = applyIosChannelIcons(channel);
    process.stdout.write(
      `Applied the ${channel} iOS icon set to the catalog (${files.length} files)\n`,
    );
    return;
  }
  if (command === 'verify') {
    const appDir = option(args, 'app');
    const receiptPath = option(args, 'receipt');
    if (!appDir || !receiptPath || args.length !== 6)
      fail('usage: verify <channel> --app <Payload/*.app> --receipt <path>');
    const receipt = existsSync(receiptPath)
      ? JSON.parse(readFileSync(receiptPath, 'utf8'))
      : {};
    if (receipt.channel !== undefined && receipt.channel !== channel)
      fail(`${receiptPath} belongs to channel ${receipt.channel}`);
    Object.assign(
      receipt,
      { channel },
      verifyIosChannelIcons(channel),
      verifyShippedIosAppIcon(channel, { appDir }),
    );
    mkdirSync(dirname(receiptPath), { recursive: true });
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      mode: 0o600,
    });
    process.stdout.write(
      `Verified the ${channel} iOS icon set in the catalog and the shipped bundle\n`,
    );
    return;
  }
  fail(
    'usage: apply <channel> | verify <channel> --app <dir> --receipt <path>',
  );
}

function isMainModule() {
  try {
    return (
      process.argv[1] &&
      realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
