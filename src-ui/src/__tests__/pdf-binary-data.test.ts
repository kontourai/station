import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { BundledPdfBinaryDataFactory } from '../components/pdf/pdf-binary-data';

const fetchSpy = vi.fn();

beforeEach(() => {
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BundledPdfBinaryDataFactory', () => {
  test.each([
    ['cMapUrl', 'UniJIS-UCS2-H.bcmap'],
    ['standardFontDataUrl', 'FoxitSymbol.pfb'],
    ['wasmUrl', 'openjpeg.wasm'],
    ['wasmUrl', 'jbig2.wasm'],
  ])('serves %s %s from a bundled asset URL', async (kind, filename) => {
    const factory = new BundledPdfBinaryDataFactory();

    const data = await factory.fetch({ kind, filename });

    expect(Array.from(data)).toEqual([1, 2, 3]);
    const [url] = fetchSpy.mock.calls[0];
    const stem = filename.slice(0, filename.lastIndexOf('.'));
    expect(String(url)).toContain(stem);
    // Never inlined: the app CSP refuses fetch('data:…').
    expect(String(url).startsWith('data:')).toBe(false);
  });

  test.each([
    ['cMapUrl', 'Nope-H.bcmap'],
    ['wasmUrl', 'openjpeg_nowasm_fallback.js'],
    ['iccUrl', 'CGATS001Compat-v2-micro.icc'],
  ])('refuses %s %s without fetching anything', async (kind, filename) => {
    const factory = new BundledPdfBinaryDataFactory();

    await expect(factory.fetch({ kind, filename })).rejects.toThrow(
      /No bundled PDF/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('reports an asset that did not load instead of handing pdf.js an error page', async () => {
    fetchSpy.mockResolvedValue(new Response('missing', { status: 404 }));
    const factory = new BundledPdfBinaryDataFactory();

    await expect(
      factory.fetch({ kind: 'cMapUrl', filename: 'UniJIS-UCS2-H.bcmap' }),
    ).rejects.toThrow(/did not load/);
  });
});
