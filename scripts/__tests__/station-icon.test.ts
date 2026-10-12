import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { ANDROID_CHANNEL_IDENTITY } from '../apply-android-channel-icons.mjs';
import { startupMarkGeometryModule } from '../generate-app-icons.mjs';
import {
  CHANNEL_PALETTES,
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
  it('emits the same SVG text on every build', () => {
    for (const channel of Object.keys(CHANNEL_PALETTES))
      for (const target of ['macos', 'square', 'android', 'mark'])
        expect(stationIconSvg(channel, target)).toBe(
          stationIconSvg(channel, target),
        );
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

  // The animation samples its water colour from the mark at this point; a
  // point on the parchment would paint the drop and track cream.
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
      const sampled = `#${[0, 1, 2].map((k) => png.data[i + k].toString(16).padStart(2, '0')).join('')}`;
      expect(png.data[i + 3]).toBe(255);
      const water = hsl(CHANNEL_PALETTES[channel].water);
      expect(hueDistance(hsl(sampled).h, water.h)).toBeLessThan(15);
      expect(hsl(sampled).s).toBeGreaterThan(0.3);
    },
  );
});
