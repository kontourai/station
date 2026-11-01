/**
 * Terminal fonts. Prompt themes use Nerd Font icons from the Private Use
 * Area; a symbols-only face renders them without a local install. It loads
 * lazily, with the first terminal, and only covers icon code points.
 */

const SYMBOLS_FAMILY = 'Station Terminal Symbols';

export const TERMINAL_FONT_FAMILY = [
  "'MesloLGS NF'",
  "'JetBrainsMono Nerd Font'",
  "'Cascadia Mono'",
  "'SF Mono'",
  'Menlo',
  'Consolas',
  "'DejaVu Sans Mono'",
  `'${SYMBOLS_FAMILY}'`,
  'monospace',
].join(', ');

/** Nerd Font icon ranges (Private Use Area plus Powerline extras). */
const SYMBOL_RANGES =
  'U+23FB-23FE, U+2665, U+26A1, U+2B58, U+E000-F8FF, U+F0000-FFFFD';

let loading: Promise<boolean> | null = null;

/** Loads the symbols face once per page. Resolves false when unavailable. */
export function loadSymbolsFont(
  url: URL | string = new URL(
    './vendor/nerd-symbols/SymbolsNerdFontMono-Regular.woff2',
    import.meta.url,
  ),
): Promise<boolean> {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined')
    return Promise.resolve(false);
  loading ??= (async () => {
    try {
      const face = new FontFace(
        SYMBOLS_FAMILY,
        `url(${String(url)}) format('woff2')`,
        {
          unicodeRange: SYMBOL_RANGES,
          display: 'block',
        },
      );
      // Canvas text never triggers a font download; load explicitly.
      await face.load();
      document.fonts.add(face);
      return true;
    } catch {
      return false;
    }
  })();
  return loading;
}
