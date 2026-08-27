/**
 * Shared harness for a browser-backed check that needs the REAL, cascade-
 * resolved app stylesheet — not a hand-picked excerpt — composed with one
 * component's own CSS file, fed to a real Chromium page.
 *
 * Extracted from `BannerHost.touch-target.test.tsx` (station#3453) when
 * `NotificationContainer.touch-target.test.tsx` (station#3513) needed the
 * identical machinery: `assertNoImportsSurvive`, `chromiumIsInstalled`, and
 * `playwrightBrowsersDirectory` were byte-identical copies, and
 * `resolveCssImports` differed only by an accidentally-dropped comment. A
 * third caller copying this again is the sweep-shape risk this file exists
 * to close.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

// Match `scripts/run-e2e-suite.mjs`'s convention: this repo installs
// Playwright browsers per-worktree (`node_modules/playwright-core/.local-
// browsers`), not into Playwright's own global cache, to keep every
// worktree's E2E runs pinned to the exact browser build declared here. Force
// the same default BEFORE any caller's `chromium.launch()` reads it — this
// runs once, at import time, so it is set before either caller's `beforeAll`
// — so this module's own `chromiumIsInstalled` check (which already treats
// unset the same as '0') can never disagree with what actually gets
// launched — an unset env var here would otherwise let a global Chromium
// install paper over a worktree with none.
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
}

const requireFromHere = createRequire(import.meta.url);

export function playwrightBrowsersDirectory(rootDir: string): string {
  const configured = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (configured && configured !== '0') return resolve(rootDir, configured);
  return join(rootDir, 'node_modules', 'playwright-core', '.local-browsers');
}

export function chromiumIsInstalled(rootDir: string): boolean {
  const browsersDir = playwrightBrowsersDirectory(rootDir);
  if (!existsSync(browsersDir)) return false;
  const installed = readdirSync(browsersDir).filter((entry) =>
    existsSync(join(browsersDir, entry, 'INSTALLATION_COMPLETE')),
  );
  return installed.some((entry) => /^chromium-\d/.test(entry));
}

/**
 * Recursively inlines BOTH `@import` forms CSS allows — `@import url(...)`
 * and the bare-string `@import "...";` — so the real cascade, custom
 * properties and all, is what Chromium parses, rather than an approximation
 * that happens to agree on the handful of literal values a caller might
 * assume were the whole story. `node_modules/@kontourai/ui/tokens/index.css`
 * (the Console Kit token layer's own entry point) uses the bare-string form
 * exclusively for its three imports (fonts, tokens, themes) — a regex
 * matching only `url(...)` resolves the FILE via Node's package resolution
 * (so this function believes it succeeded) but then leaves those three
 * `@import` lines untouched inside the inlined text, silently dropping the
 * entire `--k-*` design-system layer and vendor fonts from the page.
 * Chromium drops an unrecognized/misplaced `@import` as an invalid at-rule
 * with no console error, so there is no signal short of measuring — which is
 * exactly why `assertNoImportsSurvive` below exists: a caller's "fully
 * resolved" claim is enforced, not just asserted in prose.
 *
 * Relative specifiers (`./tokens.css`) resolve against the importing file's
 * own directory; bare specifiers (`@kontourai/ui/tokens`) resolve through
 * Node's package resolution (`exports` map and all), exactly what the real
 * bundler does. A `seen` guard keyed by absolute path prevents both a true
 * cycle and redundant re-inclusion of a file two different import paths both
 * reach (e.g. `@kontourai/ui/tokens` pulls in the same package's
 * `fonts.css` that `index.css` also imports directly).
 */
export function resolveCssImports(
  filePath: string,
  seen: Set<string> = new Set(),
): string {
  const absolutePath = resolve(filePath);
  if (seen.has(absolutePath)) return '';
  seen.add(absolutePath);
  const raw = readFileSync(absolutePath, 'utf8');
  const importDir = dirname(absolutePath);
  return raw.replace(
    /@import\s+(?:url\((["']?)([^"')]+)\1\)|(["'])([^"']+)\3)\s*;/g,
    (
      _match,
      _urlQuote,
      urlSpecifier: string | undefined,
      _bareQuote,
      bareSpecifier: string | undefined,
    ) => {
      const specifier = urlSpecifier ?? bareSpecifier;
      if (!specifier) return ''; // Unreachable: the alternation always captures one form.
      const resolvedPath = specifier.startsWith('.')
        ? resolve(importDir, specifier)
        : requireFromHere.resolve(specifier);
      return resolveCssImports(resolvedPath, seen);
    },
  );
}

/**
 * Turns "every `@import` is resolved" into a proven property of the composed
 * CSS instead of an aspiration about the regex. Run on the FULL composition
 * (a caller's app stylesheet + its component's own CSS, after all recursive
 * inlining), so it also catches a future import FORM `resolveCssImports`'s
 * regex does not yet handle — the failure names the exact surviving
 * `@import` line so the fix is extending that function, not squinting at a
 * silently-thinner cascade.
 */
export function assertNoImportsSurvive(css: string): void {
  const survivor = /@import\b[^;]*;/.exec(css);
  if (survivor) {
    throw new Error(
      `resolveCssImports left an unresolved @import in the composed CSS: ` +
        `${JSON.stringify(survivor[0])}. Either its specifier failed to ` +
        `resolve or this is an @import form the regex in ` +
        `resolveCssImports() does not match — extend that function rather ` +
        `than let Chromium silently parse a partial cascade.`,
    );
  }
}
