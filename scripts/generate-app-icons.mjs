#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
/**
 * Generate every Station app-icon surface from the approved brand artwork,
 * `assets/brand/reference.jpg` — the topographic Station mark: a cream
 * contour-map tile carved by a river that reads as an S, with a gold compass
 * rose, floating over a light-blue base layer on deep navy.
 *
 * Masters rendered here (committed):
 *   assets/brand/icon-1024.png        — rounded-corner alpha; macOS bakes its
 *                                       icon shape in, so the desktop set
 *                                       (icns/ico/pngs) comes from this
 *   assets/brand/icon-square-1024.png — full-bleed opaque; iOS rejects alpha
 *                                       in App Store icons and Android/Windows
 *                                       launchers apply their own masks, so
 *                                       those sets come from this
 *   src-ui/public/favicon.png         — 192x192 diamond mark cut out of the
 *                                       navy background (in-app surfaces
 *                                       render it over chrome;
 *                                       dev-build-identity.test.ts requires
 *                                       real transparency)
 *
 * Platform fan-out (also run by this script, via `tauri icon`):
 *   src-desktop/icons/{icon.icns,icon.ico,icon.png,32x32,64x64,128x128*}
 *                                     — from the rounded master
 *   src-desktop/icons/{Square*,StoreLogo}.png, gen/apple AppIcon set,
 *   gen/android app/src/main mipmaps  — from the square master
 *   gen/android app/src/debug mipmaps — from the square master hue-rotated
 *                                       DEV_HUE_ROTATION degrees: the "Station
 *                                       Dev" launcher identity. The in-app dev
 *                                       tint (index.css, is-dev-build) applies
 *                                       the same rotation to the favicon, so
 *                                       mark and launcher agree by
 *                                       construction.
 *
 * Run: node scripts/generate-app-icons.mjs
 * Requires: playwright (already a devDependency) for the raster work.
 */
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRAND_DIR = join(ROOT, 'assets', 'brand');
const REFERENCE = join(BRAND_DIR, 'reference.jpg');
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

const ICON_SIZE = 1024;
const ICON_CORNER_RADIUS = 228; // macOS-style rounded square, ~22% of edge
const FAVICON_SIZE = 192;

// Each build variant carries its own shade of the one artwork. The shade is a
// selective hue shift: only the water hues (navy background, river, base
// layer) rotate, while the parchment tile and the gold star/contours keep
// their brand colour — a global CSS hue-rotate was tried first and tinted
// the cream tile green. Degrees are the shift applied to the blue band:
//   release — the artwork as approved (deep navy water)
//   dev     — -175deg: water turns warm amber ("Station Dev" launcher and
//             the in-app favicon-dev.png swap in index.css)
//   beta    — +32deg: water turns indigo, midway from approved stable blue
//             toward nightly violet
//   nightly — +65deg: water turns night-sky violet
export const DEV_HUE_SHIFT = -175;
export const BETA_HUE_SHIFT = 32;
export const NIGHTLY_HUE_SHIFT = 65;

async function renderMasters() {
  const imageDataUrl = `data:image/jpeg;base64,${readFileSync(REFERENCE).toString('base64')}`;

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent('<canvas id="c"></canvas>');

  const results = await page.evaluate(
    async ({
      imageDataUrl,
      ICON_SIZE,
      ICON_CORNER_RADIUS,
      FAVICON_SIZE,
      DEV_HUE_SHIFT,
      BETA_HUE_SHIFT,
      NIGHTLY_HUE_SHIFT,
    }) => {
      const img = new Image();
      img.src = imageDataUrl;
      await img.decode();

      // Rotate only the water hues (the blue band), leaving parchment and
      // gold untouched, with a feathered band edge so nothing posterizes.
      const shiftWaterHue = (canvas, degrees) => {
        const ctx = canvas.getContext('2d');
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = image.data;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i] / 255;
          const g = d[i + 1] / 255;
          const b = d[i + 2] / 255;
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const delta = max - min;
          if (delta === 0) continue;
          let h;
          if (max === r) h = 60 * (((g - b) / delta) % 6);
          else if (max === g) h = 60 * ((b - r) / delta + 2);
          else h = 60 * ((r - g) / delta + 4);
          if (h < 0) h += 360;
          // Blue band with a 25deg feather on each side.
          const BAND_LO = 165;
          const BAND_HI = 275;
          const FEATHER = 25;
          let weight = 0;
          if (h >= BAND_LO && h <= BAND_HI) weight = 1;
          else if (h >= BAND_LO - FEATHER && h < BAND_LO)
            weight = (h - (BAND_LO - FEATHER)) / FEATHER;
          else if (h > BAND_HI && h <= BAND_HI + FEATHER)
            weight = (BAND_HI + FEATHER - h) / FEATHER;
          if (weight === 0) continue;
          const l = (max + min) / 2;
          const sat = delta / (1 - Math.abs(2 * l - 1));
          const nh = (((h + degrees * weight) % 360) + 360) % 360;
          const c = (1 - Math.abs(2 * l - 1)) * sat;
          const x = c * (1 - Math.abs(((nh / 60) % 2) - 1));
          const m = l - c / 2;
          let nr;
          let ng;
          let nb;
          if (nh < 60) [nr, ng, nb] = [c, x, 0];
          else if (nh < 120) [nr, ng, nb] = [x, c, 0];
          else if (nh < 180) [nr, ng, nb] = [0, c, x];
          else if (nh < 240) [nr, ng, nb] = [0, x, c];
          else if (nh < 300) [nr, ng, nb] = [x, 0, c];
          else [nr, ng, nb] = [c, 0, x];
          d[i] = Math.round((nr + m) * 255);
          d[i + 1] = Math.round((ng + m) * 255);
          d[i + 2] = Math.round((nb + m) * 255);
        }
        ctx.putImageData(image, 0, 0);
      };

      const draw = (size, { radius = 0, hueShift = 0 } = {}) => {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, size, size);
        if (hueShift) shiftWaterHue(canvas, hueShift);
        if (radius) {
          ctx.globalCompositeOperation = 'destination-in';
          ctx.beginPath();
          ctx.roundRect(0, 0, size, size, radius);
          ctx.fill();
        }
        return canvas;
      };

      const icon = draw(ICON_SIZE, { radius: ICON_CORNER_RADIUS });
      const square = draw(ICON_SIZE);
      const devSquare = draw(ICON_SIZE, { hueShift: DEV_HUE_SHIFT });
      const dev = draw(ICON_SIZE, {
        radius: ICON_CORNER_RADIUS,
        hueShift: DEV_HUE_SHIFT,
      });
      const beta = draw(ICON_SIZE, {
        radius: ICON_CORNER_RADIUS,
        hueShift: BETA_HUE_SHIFT,
      });
      const betaSquare = draw(ICON_SIZE, { hueShift: BETA_HUE_SHIFT });
      const nightly = draw(ICON_SIZE, {
        radius: ICON_CORNER_RADIUS,
        hueShift: NIGHTLY_HUE_SHIFT,
      });
      const nightlySquare = draw(ICON_SIZE, { hueShift: NIGHTLY_HUE_SHIFT });

      // --- Favicon: cut the diamond mark out of the navy background --------
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const work = document.createElement('canvas');
      work.width = w;
      work.height = h;
      const wctx = work.getContext('2d');
      wctx.drawImage(img, 0, 0);
      const data = wctx.getImageData(0, 0, w, h);
      const px = data.data;

      // Flood fill from the corners. A pixel joins the background when it is
      // close to a corner's navy, or is a dark blue-dominant pixel (the soft
      // drop shadow under the tile). The mark's own boundary — cream, gold,
      // and the much lighter river/base blues — never qualifies, so the fill
      // cannot leak inside.
      const seeds = [
        [0, 0],
        [w - 1, 0],
        [0, h - 1],
        [w - 1, h - 1],
      ];
      const seedColors = seeds.map(([x, y]) => {
        const i = (y * w + x) * 4;
        return [px[i], px[i + 1], px[i + 2]];
      });
      const isBackground = (i) => {
        const r = px[i];
        const g = px[i + 1];
        const b = px[i + 2];
        for (const [sr, sg, sb] of seedColors) {
          const d = (r - sr) ** 2 + (g - sg) ** 2 + (b - sb) ** 2;
          if (d < 60 * 60) return true;
        }
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        return lum < 100 && b > r + 10;
      };

      const visited = new Uint8Array(w * h);
      const queue = [];
      for (const [x, y] of seeds) queue.push(y * w + x);
      while (queue.length) {
        const p = queue.pop();
        if (visited[p]) continue;
        visited[p] = 1;
        if (!isBackground(p * 4)) continue;
        px[p * 4 + 3] = 0;
        const x = p % w;
        const y = (p / w) | 0;
        if (x > 0) queue.push(p - 1);
        if (x < w - 1) queue.push(p + 1);
        if (y > 0) queue.push(p - w);
        if (y < h - 1) queue.push(p + w);
      }
      wctx.putImageData(data, 0, 0);

      // Crop to the mark's bounding box (centered, slightly padded) and
      // downscale — which also feathers the cut edge.
      let minX = w;
      let minY = h;
      let maxX = 0;
      let maxY = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (px[(y * w + x) * 4 + 3] > 0) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      const side = Math.max(maxX - minX, maxY - minY) * 1.04;
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;

      const cropMark = (source) => {
        const canvas = document.createElement('canvas');
        canvas.width = FAVICON_SIZE;
        canvas.height = FAVICON_SIZE;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(
          source,
          cx - side / 2,
          cy - side / 2,
          side,
          side,
          0,
          0,
          FAVICON_SIZE,
          FAVICON_SIZE,
        );
        return canvas;
      };
      const favCanvas = cropMark(work);
      // The dev build swaps this in for the in-app mark (index.css), so the
      // running UI matches the "Station Dev" launcher exactly.
      const devWork = document.createElement('canvas');
      devWork.width = w;
      devWork.height = h;
      devWork.getContext('2d').drawImage(work, 0, 0);
      shiftWaterHue(devWork, DEV_HUE_SHIFT);
      const devFavCanvas = cropMark(devWork);
      const betaWork = document.createElement('canvas');
      betaWork.width = w;
      betaWork.height = h;
      betaWork.getContext('2d').drawImage(work, 0, 0);
      shiftWaterHue(betaWork, BETA_HUE_SHIFT);
      const betaFavCanvas = cropMark(betaWork);
      const nightlyWork = document.createElement('canvas');
      nightlyWork.width = w;
      nightlyWork.height = h;
      nightlyWork.getContext('2d').drawImage(work, 0, 0);
      shiftWaterHue(nightlyWork, NIGHTLY_HUE_SHIFT);
      const nightlyFavCanvas = cropMark(nightlyWork);

      return {
        icon: icon.toDataURL('image/png'),
        square: square.toDataURL('image/png'),
        devSquare: devSquare.toDataURL('image/png'),
        dev: dev.toDataURL('image/png'),
        beta: beta.toDataURL('image/png'),
        betaSquare: betaSquare.toDataURL('image/png'),
        nightly: nightly.toDataURL('image/png'),
        nightlySquare: nightlySquare.toDataURL('image/png'),
        favicon: favCanvas.toDataURL('image/png'),
        devFavicon: devFavCanvas.toDataURL('image/png'),
        betaFavicon: betaFavCanvas.toDataURL('image/png'),
        nightlyFavicon: nightlyFavCanvas.toDataURL('image/png'),
      };
    },
    {
      imageDataUrl,
      ICON_SIZE,
      ICON_CORNER_RADIUS,
      FAVICON_SIZE,
      DEV_HUE_SHIFT,
      BETA_HUE_SHIFT,
      NIGHTLY_HUE_SHIFT,
    },
  );
  await browser.close();

  const save = (dataUrl, path) =>
    writeFileSync(path, Buffer.from(dataUrl.split(',')[1], 'base64'));
  save(results.icon, join(BRAND_DIR, 'icon-1024.png'));
  save(results.square, join(BRAND_DIR, 'icon-square-1024.png'));
  save(results.favicon, join(ROOT, 'src-ui', 'public', 'favicon.png'));
  save(results.devFavicon, join(ROOT, 'src-ui', 'public', 'favicon-dev.png'));
  save(results.betaFavicon, join(ROOT, 'src-ui', 'public', 'favicon-beta.png'));
  save(
    results.nightlyFavicon,
    join(ROOT, 'src-ui', 'public', 'favicon-nightly.png'),
  );

  const variantDir = mkdtempSync(join(tmpdir(), 'station-variant-masters-'));
  const devSquarePath = join(variantDir, 'dev-square.png');
  const devPath = join(variantDir, 'dev.png');
  const betaPath = join(variantDir, 'beta.png');
  const betaSquarePath = join(variantDir, 'beta-square.png');
  const nightlyPath = join(variantDir, 'nightly.png');
  const nightlySquarePath = join(variantDir, 'nightly-square.png');
  save(results.devSquare, devSquarePath);
  save(results.dev, devPath);
  save(results.beta, betaPath);
  save(results.betaSquare, betaSquarePath);
  save(results.nightly, nightlyPath);
  save(results.nightlySquare, nightlySquarePath);
  return {
    variantDir,
    devPath,
    devSquarePath,
    betaPath,
    betaSquarePath,
    nightlyPath,
    nightlySquarePath,
  };
}

function tauriIcon(source, outDir) {
  const args = ['icon', source];
  if (outDir) args.push('-o', outDir);
  execFileSync(join(ROOT, 'node_modules', '.bin', 'tauri'), args, {
    cwd: DESKTOP_DIR,
    stdio: 'pipe',
    windowsHide: true,
  });
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
}

async function main() {
  const {
    variantDir,
    devPath,
    devSquarePath,
    betaPath,
    betaSquarePath,
    nightlyPath,
    nightlySquarePath,
  } = await renderMasters();

  const tempDirs = [variantDir];
  try {
    // Rounded master drives the whole default fan-out first...
    tauriIcon(join(BRAND_DIR, 'icon-1024.png'));

    // ...then the surfaces whose platforms mask or reject alpha themselves
    // are overwritten from the full-bleed square master.
    const squareOut = mkdtempSync(join(tmpdir(), 'station-square-icons-'));
    tempDirs.push(squareOut);
    tauriIcon(join(BRAND_DIR, 'icon-square-1024.png'), squareOut);
    copyInto(squareOut, ICONS_DIR, (name) =>
      /^Square.*Logo\.png$|^StoreLogo\.png$/.test(name),
    );
    copyInto(join(squareOut, 'ios'), APPLE_ICONSET);
    copyAndroidMipmaps(squareOut, ANDROID_RES('main'));

    // Keep a canonical Stable Android source outside generated scaffolding.
    // Channel application copies from these committed sources after `init`.
    copyAndroidMipmaps(squareOut, join(ICONS_DIR, 'stable', 'android'));

    // The Android debug source set is the "Station Dev" launcher identity.
    const devOut = mkdtempSync(join(tmpdir(), 'station-dev-icons-'));
    tempDirs.push(devOut);
    tauriIcon(devSquarePath, devOut);
    copyAndroidMipmaps(devOut, ANDROID_RES('debug'));

    const writeChannelSet = ({ channel, rounded, square }) => {
      const channelDir = join(ICONS_DIR, channel);
      const roundedOut = mkdtempSync(
        join(tmpdir(), `station-${channel}-icons-`),
      );
      tempDirs.push(roundedOut);
      tauriIcon(rounded, roundedOut);
      copyInto(roundedOut, channelDir, (name) =>
        /^(32x32|64x64|128x128|128x128@2x|icon)\.(png|icns|ico)$/.test(name),
      );
      const squareOut = mkdtempSync(join(tmpdir(), `station-${channel}-sq-`));
      tempDirs.push(squareOut);
      tauriIcon(square, squareOut);
      copyAndroidMipmaps(squareOut, join(channelDir, 'android'));
    };

    writeChannelSet({
      channel: 'dev',
      rounded: devPath,
      square: devSquarePath,
    });
    writeChannelSet({
      channel: 'beta',
      rounded: betaPath,
      square: betaSquarePath,
    });

    // The nightly channel's shade, committed under icons/nightly/:
    // tauri.nightly.conf.json points bundle.icon at the desktop set, and the
    // nightly workflow copies the android/ set over gen main/res after
    // `tauri android init`.
    writeChannelSet({
      channel: 'nightly',
      rounded: nightlyPath,
      square: nightlySquarePath,
    });
  } finally {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log(
    'Regenerated: Stable masters/platform sets, Dev/Beta/Nightly desktop + Android sets, iOS Stable set, and favicons',
  );
}

await main();
