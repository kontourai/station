import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

/**
 * A development build installs alongside a real one under a near-identical
 * name (`io.kontourai.station.debug`). A distinct launcher icon only helps
 * before launch — once the app is open, the two are indistinguishable unless
 * the running UI itself looks different.
 *
 * Every accent, selection, focus ring and active state derives from
 * `--k-brand`, so retinting that one token under the marker class carries the
 * dev identity through the whole app.
 */

/**
 * Minimal PNG alpha reader: inflate the IDAT stream, undo the per-scanline
 * filters, and count fully transparent pixels. Enough to tell a cut-out from
 * an opaque tile without adding an image dependency to the test suite.
 */
function decodeAlpha(png: Buffer): { transparentRatio: number } {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const bytesPerPixel = 4;

  const idat: Buffer[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('latin1');
    if (type === 'IDAT')
      idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));

  const stride = width * bytesPerPixel;
  const out = Buffer.alloc(height * stride);
  let transparent = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bytesPerPixel ? out[y * stride + x - bytesPerPixel] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const upLeft =
        y > 0 && x >= bytesPerPixel
          ? out[(y - 1) * stride + x - bytesPerPixel]
          : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const dl = Math.abs(p - left);
        const du = Math.abs(p - up);
        const dul = Math.abs(p - upLeft);
        value += dl <= du && dl <= dul ? left : du <= dul ? up : upLeft;
      }
      out[y * stride + x] = value & 0xff;
    }
    for (let x = 3; x < stride; x += bytesPerPixel) {
      if (out[y * stride + x] === 0) transparent += 1;
    }
  }
  return { transparentRatio: transparent / (width * height) };
}

const UI_SRC = join(__dirname, '..');
const read = (relativePath: string) =>
  readFileSync(join(UI_SRC, relativePath), 'utf-8');

describe('the dev build is visually distinct wherever the brand shows', () => {
  it('retints the brand token rather than a single accent', () => {
    const css = read('index.css');
    const rule = css.match(/:root\.is-dev-build[^{]*\{[^}]*\}/)?.[0];
    expect(rule).toBeDefined();
    // Retinting a leaf accent would leave selection, focus and active states
    // on the release colour — the tint has to come from the root token.
    expect(rule).toContain('--k-brand:');
  });

  it('tints both themes, so a light-mode dev build is not left untinted', () => {
    const css = read('index.css');
    expect(css).toMatch(/:root\.is-dev-build\[data-theme="light"\]/);
  });

  it('keeps the dev brand clear of the release brand', () => {
    const css = read('index.css');
    const devBrands = [
      ...css.matchAll(/is-dev-build[^{]*\{[^}]*?--k-brand:\s*(#[0-9a-f]{6})/gi),
    ].map((match) => match[1].toLowerCase());
    expect(devBrands.length).toBeGreaterThanOrEqual(2);
    // The vendor release brand, which the dev tint must not resemble.
    expect(devBrands).not.toContain('#5ce0c6');
    expect(devBrands).not.toContain('#0e7c64');
  });

  it('drives the marker from the host, not a bundle-time guess', () => {
    // The same UI bundle is embedded in both the debug and release APK, so a
    // build-time flag cannot tell them apart — only the native host can.
    const profile = read('platform/PlatformProfileContext.tsx');
    // Matched on the call, not on its line-wrapping: `toggle` (rather than a
    // bare `add`) is the part that carries meaning here, and pinning the
    // formatter's chosen breaks made this fail for a reindent that changed
    // nothing about the behaviour (archive#1079).
    expect(profile).toMatch(/classList\.toggle\(\s*'is-dev-build',/);
    expect(profile).toContain('isDevBuild');
    expect(profile).not.toMatch(/is-dev-build[\s\S]{0,200}import\.meta\.env/);
  });

  it('treats a host that reports nothing as a release build', () => {
    // Absent on older hosts. Defaulting the other way would tint a real
    // install, which is worse than failing to tint a dev one.
    const profile = read('platform/PlatformProfileContext.tsx');
    expect(profile).toContain('report.value.devBuild === true');
  });
});

describe('the dev mark matches the dev launcher icon', () => {
  it('swaps the raster mark, which the brand token cannot reach', () => {
    // Retinting --k-brand colours buttons and chrome but not an <img>, so the
    // dev build showed amber controls beside the release logo. The swapped
    // file is rendered with the same water-hue shift as the dev launcher
    // icon, where a CSS filter could only approximate it.
    const css = read('index.css');
    const rule = css.match(
      /:root\.is-dev-build img\[src="\/favicon\.png"\]\s*\{[^}]*\}/,
    )?.[0];
    expect(rule).toBeDefined();
    expect(rule).toMatch(/content:\s*url\("\/favicon-dev\.png"\)/);
  });

  it('selects by src, so every render site is covered', () => {
    // The same file renders as .app-toolbar__logo, .sidebar__logo,
    // .guided-connect__logo and the SDK's .fs-logo; a class-based rule would
    // miss whichever one was not listed.
    const css = read('index.css');
    expect(css).toContain('img[src="/favicon.png"]');
  });
});

describe('release channels carry their native identity through app chrome', () => {
  it.each([
    ['beta', 'favicon-beta.png'],
    ['nightly', 'favicon-nightly.png'],
  ])('uses the %s channel accent and mark', (channel, favicon) => {
    const css = read('index.css');
    const rule = css.match(
      new RegExp(`:root\\[data-app-channel="${channel}"\\][^{]*\\{[^}]*\\}`),
    )?.[0];
    expect(rule).toContain('--k-brand:');
    expect(css).toContain(`content: url("/${favicon}")`);
  });

  it('projects the host channel without overwriting inline persisted accents', () => {
    const profile = read('platform/PlatformProfileContext.tsx');
    expect(profile).toContain('root.dataset.appChannel');
    // Channel defaults are stylesheet tokens. applyAccentColor writes an
    // explicit persisted choice inline, which outranks these defaults.
    expect(profile).not.toContain("style.setProperty('--k-brand'");
  });
});

describe('the in-app mark carries no background of its own', () => {
  it.each([
    'favicon.png',
    'favicon-dev.png',
    'favicon-beta.png',
    'favicon-nightly.png',
  ])('ships %s with real transparency', async (file) => {
    // The header, sidebar and connect screens render these assets directly
    // over app chrome; an opaque plate behind them reads as a pasted-on
    // tile. favicon-dev.png is what a dev build actually displays, so it
    // is held to the same contract.
    const png = readFileSync(join(UI_SRC, '..', 'public', file));
    expect(png.subarray(1, 4).toString()).toBe('PNG');

    // IHDR colour type 6 is RGBA. Byte 25 of a PNG is the colour type field.
    expect(png[25]).toBe(6);

    // An RGBA image can be fully opaque, so the encoding alone proves
    // nothing. Decode the alpha channel and require a real transparent
    // region: the mark previously sat on an opaque tile and would have
    // passed the check above unchanged.
    const { transparentRatio } = decodeAlpha(png);
    expect(transparentRatio).toBeGreaterThan(0.2);
  });
});
