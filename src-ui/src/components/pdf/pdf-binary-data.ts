/**
 * The binary side-files pdf.js asks for while it parses a document: Adobe
 * CMaps (CJK text encodings), the standard Symbol/Dingbats fonts, and the
 * JBIG2/JPEG 2000 image decoders that scanned documents depend on.
 *
 * pdf.js normally fetches these from a base URL plus a fixed filename. The
 * build hashes every asset name, so there is no such base; instead each file
 * is emitted as its own same-origin asset and this table maps the filename
 * pdf.js asks for to the URL Vite gave it. `no-inline` keeps small files from
 * becoming `data:` URLs, which the desktop and mobile CSP refuse to fetch
 * (`connect-src` has no `data:`). Nothing is fetched from the network: an
 * asset URL is this origin, and a file this table does not know is refused.
 *
 * The ICC profiles and the no-wasm JS decoders are deliberately absent. ICC
 * support needs worker-side fetching, which this factory replaces, so ICC
 * colour spaces fall back to their alternate space; the no-wasm decoders are
 * only for engines without WebAssembly, and every engine Station supports
 * has it (`'wasm-unsafe-eval'` is in both CSPs).
 */

type Kind = 'cMapUrl' | 'standardFontDataUrl' | 'wasmUrl';

// Vite reads each glob's options statically, so they are repeated literally.

const cMaps = import.meta.glob<string>(
  '../../../../node_modules/pdfjs-dist/cmaps/*.bcmap',
  { eager: true, query: '?url&no-inline', import: 'default' },
);
const standardFonts = import.meta.glob<string>(
  '../../../../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}',
  { eager: true, query: '?url&no-inline', import: 'default' },
);
const decoders = import.meta.glob<string>(
  '../../../../node_modules/pdfjs-dist/wasm/{jbig2,openjpeg}.wasm',
  { eager: true, query: '?url&no-inline', import: 'default' },
);

function byFilename(files: Record<string, string>): Map<string, string> {
  return new Map(
    Object.entries(files).map(([path, url]) => [
      path.slice(path.lastIndexOf('/') + 1),
      url,
    ]),
  );
}

const tables: Record<Kind, Map<string, string>> = {
  cMapUrl: byFilename(cMaps),
  standardFontDataUrl: byFilename(standardFonts),
  wasmUrl: byFilename(decoders),
};

/** The emitted URL for a pdf.js side-file, or undefined when none is bundled. */
function bundledPdfAssetUrl(
  kind: string,
  filename: string,
): string | undefined {
  return Object.hasOwn(tables, kind)
    ? tables[kind as Kind].get(filename)
    : undefined;
}

/**
 * pdf.js's `BinaryDataFactory` contract: it constructs the class with the
 * base-URL options (unused here) and calls `fetch` from the main thread when
 * `useWorkerFetch` is false.
 */
export class BundledPdfBinaryDataFactory {
  async fetch({
    kind,
    filename,
  }: {
    kind: string;
    filename: string;
  }): Promise<Uint8Array> {
    const url = bundledPdfAssetUrl(kind, filename);
    if (!url) throw new Error(`No bundled PDF ${kind} file named ${filename}`);
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(`Bundled PDF ${kind} file ${filename} did not load`);
    return new Uint8Array(await response.arrayBuffer());
  }
}
