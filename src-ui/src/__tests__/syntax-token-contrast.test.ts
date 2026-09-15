import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { contrastRatio, relativeLuminance } from '../utils/color-contrast';

/**
 * The source-preview syntax rungs (`--syntax-keyword` / `--syntax-number` /
 * `--syntax-string`, consumed by `FilePreviewPane`) measured against WCAG AA
 * in BOTH themes, on both surfaces they land on.
 *
 * These replaced three GitHub-dark literals (`#ff7b72`, `#79c0ff`, `#a5d6ff`)
 * that were written into the pane as constants and therefore rendered in the
 * light theme too — at 2.29, 1.77 and 1.40 : 1 on the light page. The string
 * colour was close to invisible. Nothing measured it: the token was not a
 * token, so the contrast gates that read `index.css` never saw it, and the
 * pane's own tests assert structure, not colour.
 *
 * Reads the tokens out of `index.css` rather than restating them here, in the
 * `identicon-contrast.test.ts` shape: an edit to the value is caught by THIS
 * test instead of by the next person to open a file in light mode.
 *
 * Two backdrops per theme, because the pane paints a highlighted line
 * (`--bg-selected`, a 14% brand tint over the page) and that is the tinted
 * case archive#1167 established as the one a page-only measurement misses.
 * The page and tint values are resolved here from the same `--k-*` inputs the
 * stylesheet mixes, so a change to the brand tint moves this measurement too.
 */

const cssPath = path.resolve(__dirname, '../index.css');
const css = readFileSync(cssPath, 'utf-8');

const vendorTokensPath = path.resolve(
  __dirname,
  '../../../node_modules/@kontourai/ui/tokens/tokens.css',
);
const vendorTokens = readFileSync(vendorTokensPath, 'utf-8');

function block(source: string, selector: RegExp): string {
  const match = source.match(selector);
  if (!match) {
    throw new Error(
      `syntax-token-contrast.test.ts: could not locate a block matching ${selector} — has the theme block been renamed or restructured?`,
    );
  }
  return match[1];
}

function hex(body: string, name: string): string {
  const match = body.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\b`));
  if (!match) {
    throw new Error(
      `syntax-token-contrast.test.ts: ${name} is not a six-digit hex literal in this block — the measurement below needs a literal it can resolve`,
    );
  }
  return match[1];
}

function rgb(value: string): [number, number, number] {
  const n = Number.parseInt(value.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `color-mix(in srgb, A p%, B)` on two opaque sRGB colours. */
function mix(a: string, pct: number, b: string): [number, number, number] {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  const t = pct / 100;
  return [
    Math.round(ar * t + br * (1 - t)),
    Math.round(ag * t + bg * (1 - t)),
    Math.round(ab * t + bb * (1 - t)),
  ];
}

/**
 * Every top-level block for one theme, joined. `index.css` declares the dark
 * theme across TWO blocks (`:root, [data-theme="dark"]` for the chrome, then
 * a second `[data-theme="dark"]` that must precede the light block for the
 * cascade to work — see archive#1062 there), and the syntax rungs and
 * `--bg-selected` live in different ones. A single-block match found the
 * rungs and missed the tint, which is how the first draft of this file
 * failed to start.
 */
function themeBlocks(source: string, theme: 'dark' | 'light'): string {
  const bodies = [
    ...source.matchAll(
      new RegExp(`\\[data-theme="${theme}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`, 'g'),
    ),
  ].map((match) => match[1]);
  if (bodies.length === 0) {
    throw new Error(
      `syntax-token-contrast.test.ts: no [data-theme="${theme}"] block in index.css — has the theme block been renamed or restructured?`,
    );
  }
  return bodies.join('\n');
}

// The vendor package supplies the `--k-*` inputs both themes mix their
// surfaces from.
const darkApp = themeBlocks(css, 'dark');
const lightApp = themeBlocks(css, 'light');
const darkVendor = block(vendorTokens, /:root\s*\{([\s\S]*?)\n\}/);
const lightVendor = block(
  vendorTokens,
  /\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/,
);

const THEMES = {
  dark: { app: darkApp, vendor: darkVendor },
  light: { app: lightApp, vendor: lightVendor },
} as const;

const RUNGS = [
  '--syntax-keyword',
  '--syntax-number',
  '--syntax-string',
] as const;
const WCAG_AA_NORMAL_TEXT = 4.5;

describe('source-preview syntax rungs clear AA in both themes', () => {
  test('sanity: every rung is a resolvable literal in every theme (an empty match would make the ratios below vacuously pass)', () => {
    for (const theme of Object.values(THEMES)) {
      for (const rung of RUNGS) {
        expect(hex(theme.app, rung)).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
      expect(hex(theme.vendor, '--k-bg')).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(hex(theme.vendor, '--k-brand')).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  for (const [name, theme] of Object.entries(THEMES)) {
    const page = rgb(hex(theme.vendor, '--k-bg'));
    // `--bg-selected: color-mix(in srgb, var(--k-brand) 14%, var(--k-bg))`.
    // Pinned as a literal 14 so a change to the tint in `index.css` reds this
    // line rather than silently re-basing the measurement.
    const selectedTint = 14;
    expect(theme.app).toContain(
      `--bg-selected: color-mix(in srgb, var(--k-brand) ${selectedTint}%, var(--k-bg))`,
    );
    const selected = mix(
      hex(theme.vendor, '--k-brand'),
      selectedTint,
      hex(theme.vendor, '--k-bg'),
    );

    for (const rung of RUNGS) {
      test(`${name}: ${rung} on the page and on a highlighted line`, () => {
        const fg = relativeLuminance(...rgb(hex(theme.app, rung)));
        expect(
          contrastRatio(fg, relativeLuminance(...page)),
          `${rung} on the ${name} page`,
        ).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
        expect(
          contrastRatio(fg, relativeLuminance(...selected)),
          `${rung} on the ${name} highlighted line (--bg-selected)`,
        ).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
      });
    }
  }

  test('the pane consumes the tokens rather than a literal that would escape this gate', () => {
    const pane = readFileSync(
      path.resolve(__dirname, '../workspace-panes/FilePreviewPane.tsx'),
      'utf-8',
    );
    for (const rung of RUNGS) {
      expect(pane).toContain(`var(${rung})`);
    }
    // The three literals this replaced. Their return would put an unmeasured
    // colour back in front of light-theme users with every test still green.
    expect(pane).not.toMatch(/#ff7b72|#79c0ff|#a5d6ff/i);
  });
});
