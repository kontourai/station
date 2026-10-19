#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
/**
 * Generate every Station app-icon surface from the vector icon source,
 * `scripts/lib/station-icon.mjs`: a square topographic map tile carved by the
 * canonical River S, contours offset from the river, a gold compass and a
 * stacked base layer, drawn as SVG for each release channel. Each channel has
 * an explicit water palette (stable blue, beta green, nightly rose, dev
 * amber); parchment and gold are the same in all of them.
 *
 * Masters rendered here (committed):
 *   assets/brand/icon-1024.png        — Stable on the macOS icon grid (824
 *                                       body, drop shadow, alpha outside it);
 *                                       only the .icns comes from this
 *   assets/brand/icon-square-1024.png — Stable full-bleed opaque square; iOS
 *                                       rejects alpha in App Store icons and
 *                                       Android/Windows launchers apply their
 *                                       own masks, so those sets come from
 *                                       this
 *   src-ui/public/favicon{,-dev,-beta,-nightly}.png
 *                                     — 192x192 tile cut out on transparency
 *                                       per channel (in-app surfaces render it
 *                                       over chrome; dev-build-identity.test.ts
 *                                       requires real transparency). The web
 *                                       startup splash, the iOS launch screen
 *                                       and the Android launch window show it
 *                                       too.
 *   src-ui/src/lib/startup-mark-geometry.ts
 *                                     — where the startup animation finds the
 *                                       river in that mark, derived from the
 *                                       same geometry so the two cannot drift
 *   src-desktop/ios/StationAgentActivity/.../StationAppIcon@{1,2,3}x.png
 *                                     — the iOS Live Activity icon, the Stable
 *                                       square at 32/64/96px (SwiftUI masks it)
 *   src-desktop/plugins/agent-activity/android/.../agent_activity_mark.xml
 *                                     — the monochrome Android status-bar mark
 *   assets/brand/station-icon-manifest.json
 *                                     — sha256 of every source SVG and every
 *                                       committed file above and below;
 *                                       station-icon.test.ts
 *                                       holds the committed files to it
 *
 * Platform fan-out (also run by this script, via `tauri icon`):
 *   src-desktop/icons/{icon.ico,icon.png,32x32,64x64,128x128*} and each
 *   channel's                         — from the desktop master: rounded, no
 *                                       grid inset or shadow, artwork
 *                                       enlarged, for Windows, Linux and the
 *                                       tray at 16-32px
 *   src-desktop/icons/icon.icns and each channel's
 *                                     — from the macOS-grid master. Every `.icns`
 *                                       is rewritten into canonical member
 *                                       order on the way out (lib/icns.mjs):
 *                                       tauri's icns writer emits the same
 *                                       members in a per-process random
 *                                       sequence, so without that the four
 *                                       committed icns churned on every run
 *                                       (#1797).
 *   src-desktop/icons/{Square*,StoreLogo}.png, gen/apple AppIcon set
 *                                     — from the square master
 *   gen/android app/src/main mipmaps, src-desktop/icons/<channel>/android
 *                                     — from each channel's Android master:
 *                                       the square with the tile scaled into
 *                                       the adaptive-icon safe zone, since
 *                                       launchers and the Android 12 splash
 *                                       mask the foreground well inside its
 *                                       edges
 *   src-desktop/icons/<channel>/ios/AppIcon-*.png (stable, beta, nightly, dev)
 *                                     — from each channel's square master:
 *                                       the committed iOS asset-catalog sets.
 *                                       `tauri ios init` regenerates
 *                                       gen/apple's AppIcon.appiconset with
 *                                       Tauri's DEFAULT icons (#1776), so
 *                                       ios-channel-icons.mjs copies the
 *                                       channel's set over it after every
 *                                       init. The committed gen/apple catalog
 *                                       is the stable set; post-init resource
 *                                       staging restores the selected channel.
 *                                       Dev's set is for local simulators,
 *                                       not store delivery. tauri-cli is byte-deterministic
 *                                       here: two runs on one master agree.
 *   gen/android app/src/debug mipmaps — from the dev Android master: the
 *                                       "Station Dev" launcher identity. The
 *                                       in-app dev mark (favicon-dev.png,
 *                                       swapped in by index.css under
 *                                       is-dev-build) is drawn with the same
 *                                       palette, so mark and launcher agree by
 *                                       construction.
 *
 * Run: node scripts/generate-app-icons.mjs
 * Requires: playwright (already a devDependency) to rasterize the SVG.
 */
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertOpaqueIosPngs,
  IOS_ICON_CHANNELS,
} from './ios-channel-icons.mjs';
import { writeAndroidThemedIcon } from './lib/android-themed-icon.mjs';
import { execFileSyncBounded } from './lib/bounded-capture.mjs';
import { canonicalizeIcns } from './lib/icns.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';
import {
  CHANNEL_PALETTES,
  ICON_TARGETS,
  startupMarkGeometry,
  stationIconSvg,
  statusBarMarkPathData,
} from './lib/station-icon.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRAND_DIR = join(ROOT, 'assets', 'brand');
const DESKTOP_DIR = join(ROOT, 'src-desktop');
const ICONS_DIR = join(DESKTOP_DIR, 'icons');
const APPLE_ICONSET = join(
  DESKTOP_DIR,
  'gen',
  'apple',
  'Assets.xcassets',
  'AppIcon.appiconset',
);
const ANDROID_RES = (sourceSet) =>
  join(DESKTOP_DIR, 'gen', 'android', 'app', 'src', sourceSet, 'res');

/** Includes the local development simulator, without enabling Dev delivery. */
export const IOS_ICON_SET_CHANNELS = IOS_ICON_CHANNELS;
export const iosIconSetDir = (channel) => join(ICONS_DIR, channel, 'ios');
const ICON_CHANNELS = Object.keys(CHANNEL_PALETTES);
const LIVE_ACTIVITY_ICON_DIR = join(
  DESKTOP_DIR,
  'ios',
  'StationAgentActivity',
  'Assets.xcassets',
  'StationAppIcon.imageset',
);
const LIVE_ACTIVITY_ICON_SCALES = [1, 2, 3];
const STARTUP_MARK_GEOMETRY = join(
  ROOT,
  'src-ui',
  'src',
  'lib',
  'startup-mark-geometry.ts',
);
const STATUS_BAR_MARK = join(
  DESKTOP_DIR,
  'plugins',
  'agent-activity',
  'android',
  'src',
  'main',
  'res',
  'drawable',
  'agent_activity_mark.xml',
);

const ICON_SIZE = 1024;
const FAVICON_SIZE = 192;
// The startup animation draws the mark into a square of this many pixels.
const STARTUP_MARK_SIZE = 187;

/** Rasterize SVG documents in Chromium; one PNG buffer per request. */
async function rasterize(requests) {
  // Imported here so the exported fan-out helpers can be tested without
  // Playwright's Chromium.
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const results = await page.evaluate(async (requests) => {
      const out = [];
      for (const { svg, size } of requests) {
        const img = new Image();
        img.src = `data:image/svg+xml;base64,${btoa(svg)}`;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, size, size);
        out.push(canvas.toDataURL('image/png'));
      }
      return out;
    }, requests);
    return results.map((url) => Buffer.from(url.split(',')[1], 'base64'));
  } finally {
    await browser.close();
  }
}

export function startupMarkGeometryModule() {
  const { guide, water, lip } = startupMarkGeometry(STARTUP_MARK_SIZE);
  return `// Generated by scripts/generate-app-icons.mjs from scripts/lib/station-icon.mjs.
// Do not edit: regenerate the icons instead. Coordinates are pixels of the
// ${STARTUP_MARK_SIZE}px square the startup animation draws the mark into.

export const STARTUP_MARK_SIZE = ${STARTUP_MARK_SIZE};
/** The river centreline across the tile face: the flow guide. */
export const STARTUP_MARK_RIVER =
  '${guide}';
/** A point mid-river, where the water colour is sampled. */
export const STARTUP_MARK_WATER = [${water.join(', ')}] as const;
/** The bottom of the notch the river carves in the tile edge. */
export const STARTUP_MARK_LIP = [${lip.join(', ')}] as const;
`;
}

async function renderMasters() {
  // Stable's macOS and square masters are committed (ROUNDED_MASTER and
  // icon-square-1024.png); the other channels' masters live in a temp dir
  // for the fan-out. The square master feeds the release and Dev simulator
  // iOS catalogs.
  const masters = ICON_CHANNELS.flatMap((channel) => [
    ...(channel === 'stable' ? [] : [{ channel, target: 'macos' }]),
    ...(channel !== 'stable' && IOS_ICON_SET_CHANNELS.includes(channel)
      ? [{ channel, target: 'square' }]
      : []),
    { channel, target: 'desktop' },
    { channel, target: 'android' },
  ]).map((master) => ({ ...master, size: ICON_SIZE }));
  const requests = [
    {
      channel: 'stable',
      target: 'macos',
      size: ICON_SIZE,
      path: ROUNDED_MASTER,
    },
    {
      channel: 'stable',
      target: 'square',
      size: ICON_SIZE,
      path: join(BRAND_DIR, 'icon-square-1024.png'),
    },
    ...ICON_CHANNELS.map((channel) => ({
      channel,
      target: 'mark',
      size: FAVICON_SIZE,
      path: join(
        ROOT,
        'src-ui',
        'public',
        channel === 'stable' ? 'favicon.png' : `favicon-${channel}.png`,
      ),
    })),
    // The iOS Live Activity draws this beside the agent status; SwiftUI
    // applies the rounded mask, so it is the opaque square.
    ...LIVE_ACTIVITY_ICON_SCALES.map((scale) => ({
      channel: 'stable',
      target: 'square',
      size: 32 * scale,
      path: join(LIVE_ACTIVITY_ICON_DIR, `StationAppIcon@${scale}x.png`),
    })),
  ];
  const variantDir = mkdtempSync(join(tmpdir(), 'station-variant-masters-'));
  const paths = {};
  for (const master of masters) {
    const key = `${master.channel}-${master.target}`;
    paths[key] = join(variantDir, `${key}.png`);
    requests.push({ ...master, path: paths[key] });
  }
  const pngs = await rasterize(
    requests.map(({ channel, target, size }) => ({
      svg: stationIconSvg(channel, target),
      size,
    })),
  );
  requests.forEach(({ path }, index) => writeFileSync(path, pngs[index]));
  writeFileSync(STARTUP_MARK_GEOMETRY, startupMarkGeometryModule());
  writeFileSync(STATUS_BAR_MARK, statusBarMarkXml());
  return { variantDir, paths };
}

/** The Android status-bar mark resource, from the same river geometry. */
function statusBarMarkXml() {
  return `<!-- Status-bar mark for agent activity: Station's square map tile with the
     S-shaped river of the app icon cut through it. Generated by
     scripts/generate-app-icons.mjs from scripts/lib/station-icon.mjs; do not
     edit. Monochrome, so it renders at the same visual weight as other apps'
     icons. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp"
    android:viewportWidth="24" android:viewportHeight="24">
    <path android:fillColor="#FFFFFFFF" android:fillType="evenOdd"
        android:pathData="${statusBarMarkPathData()}" />
</vector>
`;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * The icon manifest: the sha256 of every SVG the source builds and of every
 * committed file this script writes, directly or through the `tauri icon`
 * fan-out. It ties the committed rasters to the vector source: a source edit
 * without a regeneration changes an SVG digest, and a stale or hand-edited
 * output changes an output digest. Both runs of the generator are
 * byte-identical, which is what makes the fan-out pinnable.
 */
export function iconSourceDigests() {
  const svg = {};
  for (const channel of ICON_CHANNELS)
    for (const target of ICON_TARGETS)
      svg[`${channel}-${target}`] = sha256(stationIconSvg(channel, target));
  return svg;
}
const DIRECT_OUTPUTS = [
  'assets/brand/icon-1024.png',
  'assets/brand/icon-square-1024.png',
  'src-ui/public/favicon.png',
  'src-ui/public/favicon-beta.png',
  'src-ui/public/favicon-nightly.png',
  'src-ui/public/favicon-dev.png',
  'src-ui/src/lib/startup-mark-geometry.ts',
  'src-desktop/plugins/agent-activity/android/src/main/res/drawable/agent_activity_mark.xml',
  'src-desktop/ios/StationAgentActivity/Assets.xcassets/StationAppIcon.imageset/StationAppIcon@1x.png',
  'src-desktop/ios/StationAgentActivity/Assets.xcassets/StationAppIcon.imageset/StationAppIcon@2x.png',
  'src-desktop/ios/StationAgentActivity/Assets.xcassets/StationAppIcon.imageset/StationAppIcon@3x.png',
];
// The fan-out destinations. Tray state icons and the README share
// src-desktop/icons but are not generated here.
const FAN_OUT_ROOTS = [
  'src-desktop/icons',
  'src-desktop/gen/apple/Assets.xcassets/AppIcon.appiconset',
  'src-desktop/gen/android/app/src/main/res',
  'src-desktop/gen/android/app/src/debug/res',
];
const isFanOutOutput = (path) =>
  path.startsWith('src-desktop/gen/android/')
    ? /\/res\/mipmap-[^/]+\/[^/]+$/.test(path) ||
      path.endsWith('/res/drawable/station_launcher_monochrome.xml')
    : !/\/(tray-[^/]+|README\.md)$/.test(path);

/** Every committed file the manifest pins, as repository-relative paths. */
export function manifestOutputPaths(root = ROOT) {
  const tracked = execFileSyncBounded(
    'git',
    ['ls-files', '-z', '--', ...FAN_OUT_ROOTS],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  )
    .split('\0')
    .filter(Boolean)
    .filter(isFanOutOutput);
  if (tracked.length === 0)
    throw new Error('git ls-files found no committed icon fan-out');
  return [...DIRECT_OUTPUTS, ...tracked].sort();
}
const ICON_MANIFEST = join(BRAND_DIR, 'station-icon-manifest.json');
function writeManifest() {
  const outputs = {};
  for (const path of manifestOutputPaths())
    outputs[path] = sha256(readFileSync(join(ROOT, path)));
  writeFileSync(
    ICON_MANIFEST,
    `${JSON.stringify({ svg: iconSourceDigests(), outputs }, null, 2)}\n`,
  );
}

/**
 * Run the pinned `tauri icon` fan-out, then rewrite the `.icns` it emits into
 * canonical member order.
 *
 * Everything else `tauri icon` writes is byte-identical across runs; the
 * `.icns` is not, because its writer walks a Rust `HashMap` and emits the
 * same members in a different sequence every process (#1797). The
 * canonicalization is a lossless permutation of members the writer already
 * produced -- see `lib/icns.mjs` for why that is the safe normalization and
 * `iconutil` is not. It happens here rather than at each destination so that
 * every icns this script emits is canonical by construction, including the
 * ones only a channel copy consumes.
 */
function tauriIcon(source, outDir) {
  const args = ['icon', source];
  if (outDir) args.push('-o', outDir);
  execFileSync(join(ROOT, 'node_modules', '.bin', 'tauri'), args, {
    cwd: DESKTOP_DIR,
    stdio: 'pipe',
    windowsHide: true,
  });
  const icns = join(outDir ?? ICONS_DIR, 'icon.icns');
  writeFileSync(icns, canonicalizeIcns(readFileSync(icns)));
}

/**
 * Fan a rounded master out to `outDir` and return the `.icns` bytes that run
 * emitted. Exported so the byte-stability test reaches the real `tauri icon`
 * seam -- the one that is not deterministic on its own -- rather than a
 * fixture of what it once wrote.
 */
export function readDesktopIcns(roundedMaster, outDir) {
  tauriIcon(roundedMaster, outDir);
  return readFileSync(join(outDir, 'icon.icns'));
}

/** The rounded master the committed `src-desktop/icons/icon.icns` comes from. */
export const ROUNDED_MASTER = join(BRAND_DIR, 'icon-1024.png');

/**
 * Fan an opaque square master out to an iOS asset-catalog set: the exact
 * AppIcon-*.png filenames Tauri's Contents.json template references. Stale
 * PNGs in the destination are removed first so the set is exactly the
 * fan-out. Every emitted PNG must be fully opaque (App Store rule, and the
 * delivery's CgBI pixel comparison is only lossless at alpha 255), so a
 * rounded or otherwise translucent master is refused here rather than after
 * a signed build. Exported so the byte-stability test reaches the real
 * `tauri icon` seam without rendering the masters.
 */
export function writeIosIconSet(squareMaster, destinationDir) {
  const outDir = mkdtempSync(join(tmpdir(), 'station-ios-set-'));
  try {
    tauriIcon(squareMaster, outDir);
    mkdirSync(destinationDir, { recursive: true });
    for (const name of readdirSync(destinationDir)) {
      if (name.endsWith('.png')) unlinkSync(join(destinationDir, name));
    }
    copyInto(join(outDir, 'ios'), destinationDir, (name) =>
      name.endsWith('.png'),
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
  assertOpaqueIosPngs(destinationDir);
  return readdirSync(destinationDir)
    .filter((name) => name.endsWith('.png'))
    .sort();
}

const copyInto = (fromDir, toDir, filter = () => true) => {
  mkdirSync(toDir, { recursive: true });
  for (const entry of readdirSync(fromDir, { withFileTypes: true })) {
    if (!filter(entry.name)) continue;
    const from = join(fromDir, entry.name);
    const to = join(toDir, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true });
      copyInto(from, to);
    } else {
      copyFileSync(from, to);
    }
  }
};

/** Copy a tauri-icon output tree's Android mipmaps into a res/ source set. */
function copyAndroidMipmaps(outDir, resDir) {
  const androidOut = join(outDir, 'android');
  for (const density of readdirSync(androidOut)) {
    if (!density.startsWith('mipmap-')) continue;
    copyInto(join(androidOut, density), join(resDir, density));
  }
  writeAndroidThemedIcon(resDir);
}

async function main() {
  const { variantDir, paths } = await renderMasters();

  const tempDirs = [variantDir];
  try {
    const copyIosSet = (squareOutDir, destinationDir) => {
      mkdirSync(destinationDir, { recursive: true });
      for (const name of readdirSync(destinationDir)) {
        if (name.endsWith('.png')) unlinkSync(join(destinationDir, name));
      }
      copyInto(join(squareOutDir, 'ios'), destinationDir, (name) =>
        name.endsWith('.png'),
      );
      assertOpaqueIosPngs(destinationDir);
    };

    // The desktop master drives the whole default fan-out first (ico, the
    // Linux/tray PNGs); the icns is then replaced from the macOS-grid
    // master, the one surface that wants the grid inset and shadow...
    tauriIcon(paths['stable-desktop']);
    const icnsOut = (master) => {
      const outDir = mkdtempSync(join(tmpdir(), 'station-icns-'));
      tempDirs.push(outDir);
      tauriIcon(master, outDir);
      return join(outDir, 'icon.icns');
    };
    copyFileSync(icnsOut(ROUNDED_MASTER), join(ICONS_DIR, 'icon.icns'));

    // ...then the surfaces whose platforms mask or reject alpha themselves
    // are overwritten from the full-bleed square master.
    const squareOut = mkdtempSync(join(tmpdir(), 'station-square-icons-'));
    tempDirs.push(squareOut);
    tauriIcon(join(BRAND_DIR, 'icon-square-1024.png'), squareOut);
    copyInto(squareOut, ICONS_DIR, (name) =>
      /^Square.*Logo\.png$|^StoreLogo\.png$/.test(name),
    );
    copyInto(join(squareOut, 'ios'), APPLE_ICONSET);
    // The tracked seed is Stable; post-init staging restores the selected
    // channel from the corresponding committed square fan-out.
    copyIosSet(squareOut, iosIconSetDir('stable'));

    // Android launchers come from each channel's adaptive-safe master. Keep
    // a canonical Stable Android source outside generated scaffolding:
    // channel application copies from these committed sources after `init`.
    const androidOut = (channel) => {
      const outDir = mkdtempSync(join(tmpdir(), `station-${channel}-android-`));
      tempDirs.push(outDir);
      tauriIcon(paths[`${channel}-android`], outDir);
      return outDir;
    };
    const stableAndroid = androidOut('stable');
    copyAndroidMipmaps(stableAndroid, ANDROID_RES('main'));
    copyAndroidMipmaps(stableAndroid, join(ICONS_DIR, 'stable', 'android'));

    // The Android debug source set is the "Station Dev" launcher identity.
    const devAndroid = androidOut('dev');
    copyAndroidMipmaps(devAndroid, ANDROID_RES('debug'));

    const writeChannelSet = ({ channel, rounded, square }) => {
      const channelDir = join(ICONS_DIR, channel);
      const desktopOut = mkdtempSync(
        join(tmpdir(), `station-${channel}-icons-`),
      );
      tempDirs.push(desktopOut);
      tauriIcon(paths[`${channel}-desktop`], desktopOut);
      copyInto(desktopOut, channelDir, (name) =>
        /^(32x32|64x64|128x128|128x128@2x|icon)\.(png|ico)$/.test(name),
      );
      copyFileSync(icnsOut(rounded), join(channelDir, 'icon.icns'));
      copyAndroidMipmaps(
        channel === 'dev' ? devAndroid : androidOut(channel),
        join(channelDir, 'android'),
      );
      if (IOS_ICON_SET_CHANNELS.includes(channel)) {
        const squareOut = mkdtempSync(join(tmpdir(), `station-${channel}-sq-`));
        tempDirs.push(squareOut);
        tauriIcon(square, squareOut);
        copyIosSet(squareOut, iosIconSetDir(channel));
      }
    };

    writeChannelSet({
      channel: 'dev',
      rounded: paths['dev-macos'],
      square: paths['dev-square'],
    });
    writeChannelSet({
      channel: 'beta',
      rounded: paths['beta-macos'],
      square: paths['beta-square'],
    });

    // The nightly channel's shade, committed under icons/nightly/:
    // tauri.nightly.conf.json points bundle.icon at the desktop set, and the
    // nightly workflow copies the android/ set over gen main/res after
    // `tauri android init`.
    writeChannelSet({
      channel: 'nightly',
      rounded: paths['nightly-macos'],
      square: paths['nightly-square'],
    });
    writeManifest();
  } finally {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log(
    'Regenerated: Stable masters/platform sets, Dev/Beta/Nightly desktop + Android sets, Stable/Beta/Nightly/Dev iOS sets, favicons and the startup mark geometry',
  );
}

if (invokedDirectly(import.meta.url)) await main();
