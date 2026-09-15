import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * #2140: three components used to paint colour literals through `style={}`,
 * where the theme cascade cannot reach. Every literal was a DARK value, so the
 * light theme rendered them unchanged against a white panel -- 1.5-2.5:1 for
 * text rungs whose floor is 4.5:1, 2.2-2.7:1 for fills whose floor is 3:1.
 *
 * The fix moved each family into a theme token with a measured rung per theme.
 * This pins the MEASUREMENT, not the pigment: any hex can sit in these tokens,
 * as long as it clears its floor against every backdrop it lands on. A pixel
 * pin would fail on a legitimate palette change; this fails only when a rung
 * stops being readable -- which is exactly the regression that shipped.
 *
 * Backdrops are the resolved `--k-*` values from @kontourai/ui, which is what
 * `--bg-primary` / `--bg-secondary` alias to in each theme. They are read from
 * the vendored token file rather than transcribed, so a palette bump upstream
 * re-measures here instead of silently invalidating the numbers.
 */

const CSS_PATH = path.resolve(import.meta.dirname, '..', 'index.css');
const VENDOR_TOKENS = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'node_modules',
  '@kontourai',
  'ui',
  'tokens',
  'tokens.css',
);

/** WCAG 1.4.3 for text; 1.4.11 for graphical objects and UI components. */
const TEXT_FLOOR = 4.5;
const GRAPHIC_FLOOR = 3;

/** The families #2140 introduced, and the floor each is rendered against. */
const FAMILIES: Array<{ token: string; floor: number; renders: string }> = [
  ...[1, 2, 3, 4, 5, 6].map((n) => ({
    token: `--series-${n}`,
    floor: GRAPHIC_FLOOR,
    renders: 'chart fill',
  })),
  { token: '--meter-low', floor: GRAPHIC_FLOOR, renders: 'meter fill' },
  { token: '--meter-mid', floor: GRAPHIC_FLOOR, renders: 'meter fill' },
  { token: '--meter-high', floor: GRAPHIC_FLOOR, renders: 'meter fill' },
  { token: '--syntax-keyword', floor: TEXT_FLOOR, renders: 'text' },
  { token: '--syntax-number', floor: TEXT_FLOOR, renders: 'text' },
  { token: '--syntax-string', floor: TEXT_FLOOR, renders: 'text' },
];

const ROOT_MATCHING =
  /(^|,)\s*(:root(?![\w-])(?![^,]*\s)|\[data-theme="dark"\])/;
const BARE_LIGHT = /(^|,)\s*\[data-theme="light"\]\s*(,|$)/;

/**
 * Collects every `--token: value;` declared in blocks whose selector matches
 * `selector`, later declarations winning -- the cascade's own rule, and the
 * same line-scanning approach `theme-token-cascade.test.ts` uses, because
 * index.css keeps one selector list per line for its theme blocks.
 */
function declarations(css: string, selector: RegExp): Map<string, string> {
  const tokens = new Map<string, string>();
  // Comments are stripped BEFORE the line scan. The accumulate-until-`;`
  // loop below otherwise starts on a multi-line comment, keeps appending
  // until the first declaration's `;`, and hands the regex a string that
  // begins with `/*` -- so the declaration immediately after any comment
  // is silently swallowed. Every rung this test measures sits under a
  // comment explaining its measurement, which made the scan miss exactly
  // the tokens it exists to check.
  const lines = css.replace(/\/\*[\s\S]*?\*\//g, '').split('\n');
  let index = 0;
  while (index < lines.length) {
    const parts: string[] = [];
    let cursor = index;
    while (cursor < lines.length) {
      const text = lines[cursor].trim();
      if (text === '') break;
      parts.push(text);
      if (text.endsWith('{')) break;
      if (!text.endsWith(',')) break;
      cursor += 1;
    }
    const joined = parts.join(' ');
    if (joined.endsWith('{') && !joined.startsWith('@')) {
      const matches = selector.test(joined.slice(0, -1).trim());
      let body = cursor + 1;
      while (body < lines.length && !lines[body].trim().startsWith('}')) {
        let text = lines[body];
        while (!text.includes(';') && body + 1 < lines.length) {
          body += 1;
          if (lines[body].trim().startsWith('}')) break;
          text += ` ${lines[body].trim()}`;
        }
        const declaration = /^\s*(--[\w-]+)\s*:\s*(.+?);/.exec(text);
        if (matches && declaration)
          tokens.set(declaration[1], declaration[2].trim());
        body += 1;
      }
      index = body + 1;
      continue;
    }
    index += 1;
  }
  return tokens;
}

/** Follows `var(--x)` one hop at a time within the same theme, bounded. */
function resolveHex(
  value: string,
  scope: Map<string, string>,
  depth = 0,
): string | null {
  const direct = /^#([0-9a-f]{6})\b/i.exec(value.trim());
  if (direct) return `#${direct[1].toLowerCase()}`;
  const reference = /^var\((--[\w-]+)\)/.exec(value.trim());
  if (!reference || depth > 4) return null;
  const next = scope.get(reference[1]);
  return next === undefined ? null : resolveHex(next, scope, depth + 1);
}

function luminance(hex: string): number {
  const channel = (index: number) => {
    const c = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const css = readFileSync(CSS_PATH, 'utf8');
const vendor = readFileSync(VENDOR_TOKENS, 'utf8');

/**
 * `color-mix(in srgb, A p%, B)` on two opaque hex colours, so a backdrop that
 * index.css DERIVES can be measured instead of transcribed. `resolveHex`
 * follows `var()` hops but cannot evaluate a mix, which is why the selected
 * line below is computed here from the two vendored inputs it mixes.
 */
function mix(a: string, pct: number, b: string): string {
  const channel = (hex: string, i: number) =>
    Number.parseInt(hex.slice(i, i + 2), 16);
  const t = pct / 100;
  return `#${[1, 3, 5]
    .map((i) =>
      Math.round(channel(a, i) * t + channel(b, i) * (1 - t))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/**
 * Backdrops per theme: the `--k-bg` / `--k-panel` pairs from the vendored
 * token file. The light pair sits in its own `[data-theme="light"]` block
 * there too, so the same scan applies.
 *
 * Plus `--bg-selected`, which FilePreviewPane paints under the requested
 * line and which is `color-mix(in srgb, var(--k-brand) 14%, var(--k-bg))`
 * in both themes. On light the brand is a DARK teal, so that tint is darker
 * than the page (#d5e3dc vs #f5f4ef) and every rung loses about 0.9 there —
 * github-light's keyword clears the page at 4.86 and fails this line at
 * 4.04. A page-only measurement passes a value that fails in use, on the one
 * line the user has just asked to look at. The 14 is pinned as a literal
 * rather than parsed so a change to the tint reds the assertion below rather
 * than silently re-basing the measurement.
 */
const SELECTED_LINE_TINT = 14;
const themes = [
  {
    name: 'dark',
    rungs: declarations(css, ROOT_MATCHING),
    backdrops: (() => {
      const k = declarations(vendor, /^:root$/);
      return {
        '--bg-primary': k.get('--k-bg'),
        '--bg-secondary': k.get('--k-panel'),
        '--bg-selected': mix(
          k.get('--k-brand') as string,
          SELECTED_LINE_TINT,
          k.get('--k-bg') as string,
        ),
      };
    })(),
  },
  {
    name: 'light',
    rungs: declarations(css, BARE_LIGHT),
    backdrops: (() => {
      const k = declarations(vendor, BARE_LIGHT);
      return {
        '--bg-primary': k.get('--k-bg'),
        '--bg-secondary': k.get('--k-panel'),
        '--bg-selected': mix(
          k.get('--k-brand') as string,
          SELECTED_LINE_TINT,
          k.get('--k-bg') as string,
        ),
      };
    })(),
  },
] as const;

describe('theme rungs clear their contrast floor on every backdrop (#2140)', () => {
  test('the selected-line tint modelled here is the one index.css declares', () => {
    for (const theme of themes) {
      expect(
        theme.rungs.get('--bg-selected'),
        `${theme.name} --bg-selected`,
      ).toBe(
        `color-mix(in srgb, var(--k-brand) ${SELECTED_LINE_TINT}%, var(--k-bg))`,
      );
    }
  });

  test('the scan found the theme blocks and the vendored backdrops', () => {
    // Guards the guard: a parser that stopped matching would make every
    // assertion below pass over an empty map.
    for (const theme of themes) {
      expect(theme.rungs.size, `${theme.name} rungs`).toBeGreaterThan(20);
      for (const [name, hex] of Object.entries(theme.backdrops)) {
        expect(hex, `${theme.name} ${name}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
    // And the families under test are actually declared in BOTH themes: a
    // token missing from light would fall through to the dark value, which is
    // precisely the defect, and would otherwise read here as "nothing to check".
    for (const theme of themes) {
      for (const family of FAMILIES) {
        expect(
          theme.rungs.has(family.token),
          `${family.token} must be declared in the ${theme.name} block`,
        ).toBe(true);
      }
    }
  });

  for (const theme of themes) {
    for (const family of FAMILIES) {
      for (const [backdropName, backdropHex] of Object.entries(
        theme.backdrops,
      )) {
        test(`${theme.name}: ${family.token} as ${family.renders} on ${backdropName} >= ${family.floor}:1`, () => {
          const value = theme.rungs.get(family.token) as string;
          const hex = resolveHex(value, theme.rungs);
          expect(
            hex,
            `${family.token} in ${theme.name} resolves to "${value}", which is not a hex colour reachable within this theme`,
          ).not.toBeNull();
          const ratio = contrast(hex as string, backdropHex as string);
          expect(
            ratio,
            `${family.token} (${hex}) on ${backdropName} (${backdropHex}) measures ${ratio.toFixed(2)}:1 in ${theme.name}; the ${family.renders} floor is ${family.floor}:1`,
          ).toBeGreaterThanOrEqual(family.floor);
        });
      }
    }
  }
});
