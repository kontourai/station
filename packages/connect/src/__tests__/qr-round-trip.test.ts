/**
 * QR round-trip test: encode a URL with the same `qrcode` package
 * `QRDisplay` uses, then decode it back with the same `jsqr` package
 * `QRScanner` uses. Validates the encode → decode contract without needing
 * a real camera or a real `<canvas>` element.
 *
 * station#3423: this suite previously imported `canvas` (node-canvas, a
 * native build) with a comment telling the reader to install it as a dev
 * dependency — it never was, in any package.json in this repo, so the
 * suite could not execute as written. `vitest.config.ts` in this package
 * additionally `exclude`d this file outright ("skip if node-canvas isn't
 * installed"), so it was collected zero times, not skipped-with-a-reason —
 * a suite that reads as coverage while proving nothing.
 *
 * Rewritten against a pure-JS path instead of adding a native dependency:
 * `qrcode`'s public `QRCode.create(text, opts)` returns the QR module
 * bitmap with no canvas involved at all (browser or node-canvas) — it's
 * the same encoding step `QRDisplay`'s `QRCode.toCanvas` calls internally
 * before handing modules to a canvas 2D context for rasterization. This
 * file does that last rasterization step itself (module → RGBA pixel
 * block), importing `QR_COLOR`/`QR_MARGIN` from the component's own
 * `qr-render-options.ts` rather than hand-copying the literals, so the two
 * cannot silently drift — a round-trip test built against colors/margin
 * that merely *happen* to match `QRDisplay` today would silently start
 * testing a different QR code than production renders the moment either
 * copy changed (station#3423 review LOW). `jsQR` — already pure JS,
 * decodes raw pixel arrays, no DOM — has the same shape of input
 * QRDisplay/QRScanner produce and consume in production. No new
 * dependency, runs on every platform and in CI.
 *
 * Error-correction level is the one QR option this file does not import
 * from a shared constant: neither `QRDisplay`'s `QRCode.toCanvas` call nor
 * this file's `QRCode.create` call passes `errorCorrectionLevel`, so both
 * get the SAME `qrcode` package default ('M', asserted below) rather than
 * two copies of a chosen value that could drift independently.
 */
import jsQR from 'jsqr';
import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import { QR_COLOR, QR_MARGIN } from '../react/qr-render-options';

interface QrModules {
  size: number;
  data: Uint8Array | number[];
}

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

const DARK_RGB = hexToRgb(QR_COLOR.dark);
const LIGHT_RGB = hexToRgb(QR_COLOR.light);

/**
 * Rasterizes a `qrcode` module bitmap into an RGBA `Uint8ClampedArray`
 * `jsQR` can decode — the same dark/light module → pixel-block mapping a
 * canvas 2D context performs for `QRCode.toCanvas`, done here without a
 * canvas so the test has no native/browser dependency.
 */
function rasterizeModules(
  modules: QrModules,
  { targetWidth, margin }: { targetWidth: number; margin: number },
): { data: Uint8ClampedArray; width: number; height: number } {
  const { size } = modules;
  const scale = Math.max(1, Math.floor(targetWidth / (size + margin * 2)));
  const dim = (size + margin * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = LIGHT_RGB[0];
    data[i + 1] = LIGHT_RGB[1];
    data[i + 2] = LIGHT_RGB[2];
    data[i + 3] = 255;
  }

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const isDark = modules.data[row * size + col];
      if (!isDark) continue;
      const px0 = (col + margin) * scale;
      const py0 = (row + margin) * scale;
      for (let dy = 0; dy < scale; dy++) {
        const rowOffset = (py0 + dy) * dim;
        for (let dx = 0; dx < scale; dx++) {
          const idx = (rowOffset + px0 + dx) * 4;
          data[idx] = DARK_RGB[0];
          data[idx + 1] = DARK_RGB[1];
          data[idx + 2] = DARK_RGB[2];
          data[idx + 3] = 255;
        }
      }
    }
  }
  return { data, width: dim, height: dim };
}

function encodeAndDecode(url: string, targetWidth = 256, margin = QR_MARGIN) {
  // `margin` (the quiet zone) is a rendering concern, not part of
  // `QRCode.create`'s encoding options — it only matters to
  // `rasterizeModules` below, which is standing in for the canvas
  // rasterizer `QRCode.toCanvas`/`ctx.putImageData` would otherwise do.
  const qr = QRCode.create(url);
  const image = rasterizeModules(qr.modules, { targetWidth, margin });
  return jsQR(image.data, image.width, image.height);
}

describe('QR encode → decode round-trip', () => {
  const TEST_URL = 'http://192.168.1.42:3141';

  it('encodes a server URL and jsqr reads it back exactly', () => {
    const result = encodeAndDecode(TEST_URL);
    expect(result).not.toBeNull();
    expect(result!.data).toBe(TEST_URL);
  });

  it('handles URLs with paths and query strings', () => {
    const url = 'http://192.168.1.1:3141/api/system/status?check=1';
    const result = encodeAndDecode(url);
    expect(result?.data).toBe(url);
  });

  it('handles localhost URLs', () => {
    const url = 'http://localhost:3141';
    const result = encodeAndDecode(url);
    expect(result?.data).toBe(url);
  });

  it('smaller rendered size (120px) still produces a scannable QR', () => {
    const result = encodeAndDecode(TEST_URL, 120, 1);
    expect(result?.data).toBe(TEST_URL);
  });

  it('uses the same error-correction level as QRDisplay (neither passes errorCorrectionLevel, so both take the qrcode package default: M)', () => {
    const defaultLevel = QRCode.create(TEST_URL).errorCorrectionLevel;
    const explicitM = QRCode.create(TEST_URL, {
      errorCorrectionLevel: 'M',
    }).errorCorrectionLevel;
    expect(defaultLevel).toEqual(explicitM);
  });
});
