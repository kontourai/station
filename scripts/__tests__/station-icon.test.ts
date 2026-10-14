import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { ANDROID_CHANNEL_IDENTITY } from '../apply-android-channel-icons.mjs';
import {
  iconSourceDigests,
  manifestOutputPaths,
  startupMarkGeometryModule,
} from '../generate-app-icons.mjs';
import {
  CHANNEL_PALETTES,
  ICON_TARGETS,
  startupMarkGeometry,
  stationIconSvg,
} from '../lib/station-icon.mjs';

const root = resolve(import.meta.dirname, '../..');

// Station's brand purple in light and dark themes (#7c3aed is 262deg, #966aff
// 258deg). A channel identity this close to it reads as the brand rather
// than as a release channel, which is what the old violet nightly did.
const BRAND_PURPLES = ['#7c3aed', '#966aff'];
const MIN_HUE_DISTANCE = 30;

function hsl(hex: string) {
  const [r, g, b] = [1, 3, 5].map(
    (i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255,
  );
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return { h: Number.NaN, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h =
    max === r
      ? 60 * (((g - b) / d) % 6)
      : max === g
        ? 60 * ((b - r) / d + 2)
        : 60 * ((r - g) / d + 4);
  return { h: (h + 360) % 360, s, l };
}
const hueDistance = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};
// Android colour resources are #AARRGGBB.
const rgb = (color: string) =>
  color.length === 9 ? `#${color.slice(3)}` : color;

describe('channel colours stay clear of the brand purple', () => {
  const purpleHues = BRAND_PURPLES.map((hex) => hsl(hex).h);
  // Pin the reference hues independently of the conversion under test.
  it('measures the brand purples where they are', () => {
    expect(Math.round(purpleHues[0])).toBe(262);
    expect(Math.round(purpleHues[1])).toBe(258);
  });

  const colours = Object.entries(CHANNEL_PALETTES).flatMap(
    ([channel, palette]) => [
      ...Object.entries(palette).map(([key, hex]) => ({
        channel,
        source: `icon ${key}`,
        hex,
      })),
      {
        channel,
        source: 'android accent',
        hex: rgb(
          ANDROID_CHANNEL_IDENTITY[
            channel as keyof typeof ANDROID_CHANNEL_IDENTITY
          ].accent,
        ),
      },
      {
        channel,
        source: 'android launcher background',
        hex: rgb(
          ANDROID_CHANNEL_IDENTITY[
            channel as keyof typeof ANDROID_CHANNEL_IDENTITY
          ].splashBackground,
        ),
      },
    ],
  );

  it('covers every channel, icon palette entry and Android colour', () => {
    expect(Object.keys(CHANNEL_PALETTES).sort()).toEqual([
      'beta',
      'dev',
      'nightly',
      'stable',
    ]);
    expect(colours).toHaveLength(4 * (13 + 2));
  });

  it.each(colours.filter(({ hex }) => hsl(hex).s > 0))(
    '$channel $source $hex is at least 30deg from the brand purple',
    ({ hex }) => {
      const { h } = hsl(hex);
      for (const purple of purpleHues)
        expect(hueDistance(h, purple)).toBeGreaterThanOrEqual(MIN_HUE_DISTANCE);
    },
  );
});

describe('the vector icon source', () => {
  const manifest = JSON.parse(
    readFileSync(
      resolve(root, 'assets/brand/station-icon-manifest.json'),
      'utf8',
    ),
  ) as { svg: Record<string, string>; outputs: Record<string, string> };

  // The manifest was written by the run that produced the committed rasters.
  // Rebuilding the SVG here, in a fresh process, and matching its digest is
  // the determinism check, and it fails when the source changes without a
  // regeneration.
  it('builds exactly the SVG the committed icons were rendered from', () => {
    const svgKeys = Object.keys(manifest.svg).sort();
    expect(svgKeys).toHaveLength(4 * ICON_TARGETS.length);
    expect(iconSourceDigests()).toEqual(manifest.svg);
  });

  it.each(Object.entries(manifest.outputs))(
    'commits %s as that regeneration wrote it',
    (path, digest) => {
      expect(
        createHash('sha256')
          .update(readFileSync(resolve(root, path)))
          .digest('hex'),
      ).toBe(digest);
    },
  );

  it('records every committed file the generator writes, fan-out included', () => {
    const paths = manifestOutputPaths();
    expect(Object.keys(manifest.outputs).sort()).toEqual(paths);
    // Pin the fan-out's reach independently of the listing under test.
    for (const expected of [
      'src-desktop/icons/icon.ico',
      'src-desktop/icons/icon.icns',
      'src-desktop/icons/nightly/32x32.png',
      'src-desktop/icons/beta/android/mipmap-xxxhdpi/ic_launcher_foreground.png',
      'src-desktop/icons/nightly/ios/AppIcon-512@2x.png',
      'src-desktop/gen/apple/Assets.xcassets/AppIcon.appiconset/AppIcon-60x60@3x.png',
      'src-desktop/gen/android/app/src/debug/res/mipmap-mdpi/ic_launcher.png',
    ])
      expect(paths).toContain(expected);
    expect(paths.some((path) => path.includes('tray-'))).toBe(false);
  });

  it('draws each channel in its own water colour only', () => {
    const stable = stationIconSvg('stable', 'square');
    const nightly = stationIconSvg('nightly', 'square');
    expect(stable).toContain(CHANNEL_PALETTES.stable.water);
    expect(nightly).toContain(CHANNEL_PALETTES.nightly.water);
    expect(nightly).not.toContain(CHANNEL_PALETTES.stable.water);
  });

  it('refuses an unknown channel or target', () => {
    expect(() => stationIconSvg('canary', 'square')).toThrow(/channel/);
    expect(() => stationIconSvg('stable', 'round')).toThrow(/target/);
  });
});

describe('startup animation geometry', () => {
  it('is the committed generated module, so mark and animation agree', () => {
    expect(
      readFileSync(
        resolve(root, 'src-ui/src/lib/startup-mark-geometry.ts'),
        'utf8',
      ),
    ).toBe(startupMarkGeometryModule());
  });

  const rgb = (hex: string) =>
    [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));

  // The animation paints its falling drop and track in the colour it samples
  // from the mark here. The river is a vertical water/waterLow gradient and
  // the sample sits mid-tile, so it must read as their midpoint; the base
  // layer, bank or parchment are 70+ away in RGB.
  it.each([
    ['stable', 'favicon.png'],
    ['beta', 'favicon-beta.png'],
    ['nightly', 'favicon-nightly.png'],
    ['dev', 'favicon-dev.png'],
  ] as const)(
    'samples river water from the committed %s mark',
    (channel, file) => {
      const png = PNG.sync.read(
        readFileSync(resolve(root, 'src-ui/public', file)),
      );
      const size = 187;
      const {
        water: [x, y],
      } = startupMarkGeometry(size);
      const px = Math.round((x * png.width) / size);
      const py = Math.round((y * png.height) / size);
      const i = (py * png.width + px) * 4;
      expect(png.data[i + 3]).toBe(255);
      const palette = CHANNEL_PALETTES[channel];
      const river = rgb(palette.water).map(
        (value, k) => (value + rgb(palette.waterLow)[k]) / 2,
      );
      const sampled = [0, 1, 2].map((k) => png.data[i + k]);
      expect(
        Math.hypot(...sampled.map((value, k) => value - river[k])),
      ).toBeLessThan(10);
    },
  );
});
