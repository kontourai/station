import { contrastRatio } from '@kontourai/ui/contrast';
import { describe, expect, test } from 'vitest';
import {
  COLOR_THEME_ADJUSTMENTS,
  COLOR_THEME_CHANNELS,
  COLOR_THEME_FAMILIES,
  type ColorThemeAccentValue,
  type ColorThemeFamily,
  type ColorThemeFlavor,
} from '../lib/color-theme-catalog';

/**
 * Rates every family × flavor × accent (and the per-flavor channel brands)
 * the way `@kontourai/ui`'s check:contrast and `validateBrandOverride` rate a
 * theme, plus Station's own rules (lib/branding-theme.ts
 * STATION_SURFACE_TEXT_RULES, and the functional-colour floors index.css
 * documents for its literals). Ratios come from the package's own
 * `contrastRatio`, so this and the shared validator cannot disagree on the
 * arithmetic.
 *
 * The catalog writes a contrast fix as `[adjusted, official]`; the second
 * block proves each one was needed (the official value fails the same rule)
 * and kept the official hue, which is what "adjust lightness only" means.
 */

const TEXT = 4.5;
const NON_TEXT = 3;

/** `color-mix(in srgb, a weight, b)` on #rrggbb, as index.css mixes. */
function mix(a: string, b: string, weight: number): string {
  const channels = (hex: string) =>
    [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const [x, y] = [channels(a), channels(b)];
  return `#${x
    .map((c, i) =>
      Math.round(c * weight + y[i] * (1 - weight))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

interface Rule {
  foreground: string;
  value: string;
  background: string;
  surface: string;
  minimum: number;
}

/** Every pair a flavor renders with one accent selected. */
function rules(
  flavor: ColorThemeFlavor,
  accent: ColorThemeAccentValue,
): Rule[] {
  const r = flavor.roles;
  const v = flavor.variables;
  const out: Rule[] = [];
  const rate = (
    foreground: string,
    value: string,
    surfaces: Record<string, string>,
    minimum: number,
  ) => {
    for (const [surface, background] of Object.entries(surfaces))
      out.push({ foreground, value, background, surface, minimum });
  };
  const page = { '--k-bg': r['--k-bg'] };
  const pagePanel = { ...page, '--k-panel': r['--k-panel'] };
  const all = { ...pagePanel, '--k-panel-raised': r['--k-panel-raised'] };

  // Text ramp: AA on all three surfaces (DESIGN.md "Colors").
  for (const role of ['--k-text', '--k-text-muted', '--k-text-faint'] as const)
    rate(role, r[role], all, TEXT);
  // Brand slot (validateBrandOverride's BRAND_SLOT_PAIRS).
  rate('--k-brand', accent.brand, all, TEXT);
  rate(
    '--k-brand-contrast',
    accent.contrast,
    { '--k-brand': accent.brand },
    TEXT,
  );
  rate(
    '--k-action-contrast',
    accent.contrast,
    { '--k-action': accent.brand },
    TEXT,
  );
  rate('--k-action', accent.brand, { '--k-panel': r['--k-panel'] }, NON_TEXT);
  rate('--k-focus', accent.brand, pagePanel, NON_TEXT);
  // Station: the action fill is painted as link and accent text.
  rate('--k-action (as text)', accent.brand, pagePanel, TEXT);
  // Status tones as text, and status-contrast text on each filled tone.
  for (const tone of [
    '--k-positive',
    '--k-caution',
    '--k-negative',
    '--k-active',
  ] as const) {
    rate(tone, r[tone], pagePanel, TEXT);
    rate(
      '--k-status-contrast',
      r['--k-status-contrast'],
      { [tone]: r[tone] },
      TEXT,
    );
  }
  // Status text on its own tint and on a 15% self-tint over the page (index.css).
  for (const name of ['error', 'success', 'warning'] as const) {
    const text = v[`--${name}-text`];
    rate(
      `--${name}-text`,
      text,
      {
        ...all,
        [`--${name}-bg`]: v[`--${name}-bg`],
        '15% self-tint': mix(text, r['--k-bg'], 0.15),
      },
      TEXT,
    );
  }
  // Fills, bars, chart series and event accents: non-text 3:1.
  for (const property of [
    '--warning-primary',
    '--health-success',
    '--health-error',
    '--health-warning',
    '--event-agent-start',
    '--event-agent-complete',
    '--event-tool-call',
    '--event-tool-result',
    '--event-agent-health',
    '--event-planning',
    '--event-reasoning',
    '--series-1',
    '--series-2',
    '--series-3',
    '--series-4',
    '--series-5',
    '--series-6',
    '--meter-low',
    '--meter-mid',
    '--meter-high',
  ] as const)
    rate(property, v[property], all, NON_TEXT);
  // Source-preview syntax is text on the page, the panel and the requested
  // line, which index.css paints with --bg-selected (14% brand into the
  // page). In a channel build the brand there is the channel's.
  const selected = Object.fromEntries([
    ['--bg-selected', mix(accent.brand, r['--k-bg'], 0.14)],
    ...COLOR_THEME_CHANNELS.map((channel) => [
      `--bg-selected (${channel})`,
      mix(flavor.channels[channel].brand, r['--k-bg'], 0.14),
    ]),
  ]);
  for (const property of [
    '--syntax-keyword',
    '--syntax-number',
    '--syntax-string',
    '--syntax-function',
    '--syntax-tag',
    '--syntax-variable',
  ] as const)
    rate(property, v[property], { ...pagePanel, ...selected }, TEXT);
  // The yellow chip: black text on the solid fill, the text token on its tint.
  rate(
    '--text-on-accent-yellow',
    '#000000',
    { '--accent-yellow': v['--accent-yellow'] },
    TEXT,
  );
  rate(
    '--accent-yellow-text',
    v['--accent-yellow-text'],
    {
      'chip on page': mix(v['--accent-yellow'], r['--k-bg'], 0.12),
      'chip on panel': mix(v['--accent-yellow'], r['--k-panel'], 0.12),
    },
    TEXT,
  );
  // Inactive text is exempt from 1.4.3; Station keeps it legible at 3:1.
  rate(
    '--text-disabled',
    v['--text-disabled'],
    { '--k-bg': r['--k-bg'], '--k-panel-raised': r['--k-panel-raised'] },
    NON_TEXT,
  );
  // Placeholder text is content: AA on the input, raised panel and hover.
  rate(
    '--text-subtle',
    v['--text-subtle'],
    {
      '--k-bg': r['--k-bg'],
      '--k-panel-raised': r['--k-panel-raised'],
      '--bg-hover': mix(r['--k-text'], r['--k-bg'], 0.05),
    },
    TEXT,
  );
  return out;
}

function failures(label: string, rated: Rule[]): string[] {
  return rated.flatMap((rule) => {
    const ratio = contrastRatio(rule.value, rule.background);
    return ratio < rule.minimum
      ? [
          `${label}: ${rule.foreground} ${rule.value} on ${rule.surface} ${rule.background} = ${ratio.toFixed(2)}:1 (needs ${rule.minimum}:1)`,
        ]
      : [];
  });
}

/** Every pair for a flavor: each accent, and each channel brand on its own. */
function flavorFailures(
  family: ColorThemeFamily,
  flavor: ColorThemeFlavor,
): string[] {
  const out: string[] = [];
  for (const { id } of family.accents)
    out.push(
      ...failures(
        `${family.id}/${flavor.id} accent ${id}`,
        rules(flavor, flavor.accents[id]),
      ),
    );
  for (const channel of COLOR_THEME_CHANNELS) {
    const brand = flavor.channels[channel];
    const r = flavor.roles;
    out.push(
      ...failures(`${family.id}/${flavor.id} ${channel} channel`, [
        ...(['--k-bg', '--k-panel', '--k-panel-raised'] as const).map(
          (surface) => ({
            foreground: '--k-brand',
            value: brand.brand,
            background: r[surface],
            surface,
            minimum: TEXT,
          }),
        ),
        {
          foreground: '--k-brand-contrast',
          value: brand.contrast,
          background: brand.brand,
          surface: '--k-brand',
          minimum: TEXT,
        },
      ]),
    );
  }
  return out;
}

const FLAVORS = COLOR_THEME_FAMILIES.flatMap((family) =>
  [family.light, ...family.dark].map((flavor) => ({ family, flavor })),
);

describe('color theme contrast', () => {
  test('the catalog has the families, flavors and accents the decision names', () => {
    // Written out, not derived, so a family silently dropping out of the
    // catalog (and so out of the rating below) fails here.
    expect(
      FLAVORS.map(({ family, flavor }) => `${family.id}/${flavor.id}`),
    ).toEqual([
      'catppuccin/latte',
      'catppuccin/frappe',
      'catppuccin/macchiato',
      'catppuccin/mocha',
      'rose-pine/dawn',
      'rose-pine/main',
      'rose-pine/moon',
      'gruvbox/light',
      'gruvbox/dark',
      'nord/snow-storm',
      'nord/polar-night',
      'tokyo-night/day',
      'tokyo-night/night',
      'tokyo-night/storm',
    ]);
    const catppuccin = COLOR_THEME_FAMILIES.find((f) => f.id === 'catppuccin');
    expect(catppuccin?.accents.map((a) => a.id)).toEqual([
      'rosewater',
      'flamingo',
      'pink',
      'mauve',
      'red',
      'maroon',
      'peach',
      'yellow',
      'green',
      'teal',
      'sky',
      'sapphire',
      'blue',
      'lavender',
    ]);
    expect(catppuccin?.defaultDarkFlavor).toBe('mocha');
    expect(catppuccin?.defaultAccent).toBe('mauve');
    // Every flavor defines every accent of its family, so a stored accent
    // resolves in light and dark alike.
    for (const { family, flavor } of FLAVORS)
      expect(Object.keys(flavor.accents).sort()).toEqual(
        family.accents.map((a) => a.id).sort(),
      );
  });

  test.each(
    FLAVORS.map(
      ({ family, flavor }) =>
        [`${family.id}/${flavor.id}`, family, flavor] as const,
    ),
  )(
    '%s meets every contrast rule with every accent',
    (_label, family, flavor) => {
      expect(flavorFailures(family, flavor)).toEqual([]);
    },
  );
});

/** OKLCH hue in degrees (Björn Ottosson's OKLab). */
function oklch(hex: string): { chroma: number; hue: number } {
  const lin = (c: number) => {
    const x = c / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [1, 3, 5].map((i) =>
    lin(Number.parseInt(hex.slice(i, i + 2), 16)),
  );
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return {
    chroma: Math.hypot(a, bb),
    hue: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360,
  };
}

/** The flavor with one slot put back to its official value. */
function withOfficial(
  flavor: ColorThemeFlavor,
  slot: string,
  official: string,
): ColorThemeFlavor {
  const [kind, id] = slot.split(':');
  if (kind === 'accent' || kind === 'channel') {
    const key = kind === 'accent' ? 'accents' : 'channels';
    const pairs: Record<string, ColorThemeAccentValue> = flavor[key];
    return {
      ...flavor,
      [key]: { ...pairs, [id!]: { ...pairs[id!]!, brand: official } },
    };
  }
  return slot in flavor.roles
    ? { ...flavor, roles: { ...flavor.roles, [slot]: official } }
    : { ...flavor, variables: { ...flavor.variables, [slot]: official } };
}

describe('color theme adjustments', () => {
  test('there are adjustments to check', () => {
    // Without this the two tests below pass over an empty list.
    expect(COLOR_THEME_ADJUSTMENTS.length).toBeGreaterThan(100);
  });

  test.each(
    COLOR_THEME_ADJUSTMENTS.map(
      (a) => [`${a.family}/${a.flavor} ${a.slot}`, a] as const,
    ),
  )('%s was needed and kept its hue', (_label, adjustment) => {
    const family = COLOR_THEME_FAMILIES.find(
      (f) => f.id === adjustment.family,
    )!;
    const flavor = [family.light, ...family.dark].find(
      (f) => f.id === adjustment.flavor,
    )!;
    // Needed: the official value fails a rule the adjusted one passes.
    const before = flavorFailures(family, flavor);
    const official = flavorFailures(
      family,
      withOfficial(flavor, adjustment.slot, adjustment.official),
    );
    expect(before).toEqual([]);
    expect(official.length).toBeGreaterThan(0);
    // Hue kept. Near-grey colours have no stable hue, and sRGB rounding moves
    // a low-chroma hue by a few degrees, so only chromatic colours are held.
    const from = oklch(adjustment.official);
    const to = oklch(adjustment.value);
    if (from.chroma > 0.03) {
      const delta = Math.abs(from.hue - to.hue);
      expect(Math.min(delta, 360 - delta)).toBeLessThan(2);
    }
  });
});
