import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The toolbar pads itself down by the top safe-area inset
 * (`.app-toolbar { padding-top: var(--safe-top) }`), so the space it occupies
 * is the inset plus its nominal height — not the height alone.
 *
 * Every fixed or absolute overlay that anchors below the toolbar, and every
 * calculation of what is left of the viewport underneath it, has to use the
 * occupied space. Offsetting by `--app-toolbar-height` on its own lands them
 * `--safe-top` too high. On desktop the inset is 0 so the bug is invisible;
 * on an edge-to-edge Android webview it put the coding-surface tabs and the
 * chat dock *above* the header instead of below it.
 */

const UI_SRC = join(__dirname, '..');

function read(relativePath: string): string {
  return readFileSync(join(UI_SRC, relativePath), 'utf-8');
}

/**
 * JavaScript reads this geometry too, and `getPropertyValue` on a custom
 * property returns raw token text — so a `calc(...)` token parses to NaN.
 * Those call sites must measure the toolbar instead of reading the token,
 * which the CSS-shaped assertion below cannot see.
 */
// archive#4460: `dock.maximize` and the dock's own toolbar-height measurement
// moved into the shared `useDockShellChrome`. #928 moves `dock.toggle` again,
// into app chrome, while this remains the one geometry owner.
const JS_CONSUMERS = ['hooks/useDockShellChrome.ts'];

const CONSUMERS = ['index.css', 'components/chat-dock/ChatDock.tsx'];

describe('toolbar geometry accounts for the top safe-area inset', () => {
  it('derives the occupied height from the inset plus the nominal height', () => {
    const css = read('index.css');
    expect(css).toContain(
      '--app-toolbar-total-height: calc(var(--safe-top) + var(--app-toolbar-height));',
    );
  });

  it('keeps the toolbar padded by the inset that the token accounts for', () => {
    // If the toolbar stops padding itself down, the token is overstating the
    // occupied space and every offset below it drifts the other way.
    expect(read('index.css')).toMatch(
      /\.app-toolbar\s*\{[^}]*padding-top:\s*var\(--safe-top\)/,
    );
  });

  it.each(CONSUMERS)(
    '%s offsets by the occupied height, never the bare height',
    (relativePath) => {
      const source = read(relativePath);
      const bare = [...source.matchAll(/var\(--app-toolbar-height\)/g)];
      // The token's own definition is the sole legitimate reference.
      const allowed = source.includes(
        '--app-toolbar-total-height: calc(var(--safe-top) + var(--app-toolbar-height));',
      )
        ? 1
        : 0;
      expect(bare.length).toBe(allowed);
    },
  );

  it.each(JS_CONSUMERS)('%s measures the toolbar, not the token', (path) => {
    const source = read(path);
    expect(source).toContain('readToolbarHeight');
    // Reading the raw token back in JS is what silently under-measured by the
    // safe-area inset on an edge-to-edge webview.
    expect(source).not.toContain(
      "getPropertyValue(\n            '--app-toolbar",
    );
    expect(source).not.toMatch(/getPropertyValue\(\s*'--app-toolbar-height'/);
  });

  it('measures the rendered toolbar rather than summing tokens when it can', () => {
    const helper = read('lib/toolbarGeometry.ts');
    expect(helper).toContain('getBoundingClientRect');
    // The token fallback must still account for the inset.
    expect(helper).toContain('--safe-top');
  });

  it('keeps header snap actions delegated to the measured dock owner', () => {
    const header = read('components/chat-dock/ChatDockHeader.tsx');
    expect(header).toContain('onDockSnap');
    expect(header).not.toContain('setDockHeight');
  });

  it('keeps expanded region geometry below the app toolbar', () => {
    const shell = read('components/chat-dock/DockShell.tsx');
    const css = read('index.css');
    expect(shell).toContain(
      'var(--chat-visual-viewport-height) - var(--app-toolbar-total-height)',
    );
    expect(css).toContain('var(--app-toolbar-total-height)');
    expect(css).toContain(
      'var(--chat-visual-viewport-top) +\n      var(--app-toolbar-total-height)',
    );
  });

  it('anchors the notification popover to the toolbar rather than a literal', () => {
    const css = read('components/notifications/NotificationHistory.css');
    expect(css).toContain('var(--app-toolbar-total-height)');
    // A hardcoded offset is what put this popover over the header on mobile.
    // `\btop:` alone would also match `margin-top:`, which is legitimate here.
    expect(css).not.toMatch(
      /\.notification-history\s*\{[^}]*[;{]\s*top:\s*\d+px/,
    );
  });

  it('keeps the header navigation menu above the fixed mobile chrome', () => {
    // The toolbar creates no stacking context, so its navigation menu
    // competes directly with the maximized dock (--layer-sticky + 1).
    // Both sides now speak the token scale: the menu sits at navigation,
    // whose order above the dock is pinned by layer-tokens.test.ts, and the
    // backdrop sits exactly one below its own menu or it swallows the menu's
    // clicks.
    const menu = read('components/chat/chat.css');
    expect(menu).toMatch(
      /\.app-toolbar__overflow-menu\s*\{[^}]*z-index:\s*var\(--layer-navigation\)/,
    );

    const backdrop = read('components/header/OverflowMenu.tsx');
    expect(backdrop).toContain("zIndex: 'calc(var(--layer-navigation) - 1)'");
  });
});
