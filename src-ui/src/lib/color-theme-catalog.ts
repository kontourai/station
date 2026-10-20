/**
 * The color-theme catalog: every named palette Station can apply on top of
 * light and dark (docs/decisions/user-color-themes.md). This file is the
 * single source. `color-theme-css.ts` renders it into the checked-in
 * stylesheet `src-ui/src/color-themes.generated.css` and the startup index in
 * `src-ui/public/startup-theme.js`, and `color-themes.ts` resolves a stored
 * selection against it.
 *
 * Each flavor maps its project's published palette onto two layers:
 *
 * - `roles`: the `@kontourai/ui` `--k-*` roles (DESIGN.md "Colors"). Station's
 *   own chrome aliases (`--bg-primary`, `--text-primary`, ...) already derive
 *   from them. Trust-state tokens are left alone: each trust chip paints its
 *   own fill, so its label pair does not depend on these surfaces.
 * - `variables`: Station's literal functional colors in `src-ui/src/index.css`
 *   (status tints, health, events, chart series, meters, source-preview
 *   syntax, the yellow chip, disabled and placeholder text). `--error-fill`,
 *   `--error-dark`, `--accent-acp` and the overlays stay Station's: they are
 *   solid fills under white text or shadows, valid on any surface.
 *
 * `accents` are the family's named accents, per flavor. One accent supplies
 * brand, action and focus (`brand`), with `contrast` as the text on its fill.
 * `channels` are the Dev, Beta and Nightly brand colours for this flavor's
 * surfaces: a channel build keeps its identity on `--k-brand` while the
 * theme owns action and focus (see the decision record).
 *
 * VALUES. Every value is the project's published hex, except where it fails
 * a contrast rule in `__tests__/color-theme-contrast.test.ts` (the thresholds
 * of `@kontourai/ui`'s check:contrast and validateBrandOverride, plus
 * Station's own rules for text on its functional surfaces). Those are
 * written `[adjusted, official]`: the published colour with only its OKLCH
 * lightness moved, just far enough to pass (chroma is reduced only where
 * the lighter or darker colour leaves sRGB; hue is kept). The comment names
 * the palette entry and the lightness change. This is the rule DESIGN.md
 * "Product themes" applies to Station's and Flow's own accents. The test
 * rates every family × flavor × accent and also checks that each
 * adjustment was needed and kept its hue.
 *
 * Unadjusted entries name the palette entry they take. Status tints
 * (`--error-bg`, `--error-border`, ...) are the tone mixed into the panel,
 * as their comments say; that mix is computed once here, not at runtime.
 */

import type { ColorThemeId } from '@kontourai/station-contracts/device-settings';

export type ColorThemeMode = 'dark' | 'light';

/** A published value, or `[adjusted, official]` where contrast forced a change. */
type CatalogColor = string | readonly [adjusted: string, official: string];

export const COLOR_THEME_ROLE_PROPERTIES = [
  '--k-bg',
  '--k-panel',
  '--k-panel-raised',
  '--k-line',
  '--k-line-strong',
  '--k-text',
  '--k-text-muted',
  '--k-text-faint',
  '--k-status-contrast',
  '--k-positive',
  '--k-caution',
  '--k-negative',
  '--k-active',
] as const;

export type ColorThemeRoleProperty =
  (typeof COLOR_THEME_ROLE_PROPERTIES)[number];

export const COLOR_THEME_VARIABLE_PROPERTIES = [
  '--error-bg',
  '--error-border',
  '--error-text',
  '--success-bg',
  '--success-border',
  '--success-text',
  '--warning-bg',
  '--warning-border',
  '--warning-text',
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
  '--syntax-keyword',
  '--syntax-number',
  '--syntax-string',
  '--syntax-function',
  '--syntax-tag',
  '--syntax-variable',
  '--accent-yellow',
  '--accent-yellow-text',
  '--text-disabled',
  '--text-subtle',
] as const;

export type ColorThemeVariableProperty =
  (typeof COLOR_THEME_VARIABLE_PROPERTIES)[number];

export const COLOR_THEME_CHANNELS = ['dev', 'beta', 'nightly'] as const;
export type ColorThemeChannel = (typeof COLOR_THEME_CHANNELS)[number];

interface CatalogPair {
  brand: CatalogColor;
  contrast: string;
}

interface CatalogFlavor {
  id: string;
  label: string;
  mode: ColorThemeMode;
  roles: Record<ColorThemeRoleProperty, CatalogColor>;
  variables: Record<ColorThemeVariableProperty, CatalogColor>;
  accents: Record<string, CatalogPair>;
  channels: Record<ColorThemeChannel, CatalogPair>;
}

interface CatalogFamily {
  id: Exclude<ColorThemeId, 'station'>;
  label: string;
  /** Where the published values come from. */
  source: string;
  defaultDarkFlavor: string;
  defaultAccent: string;
  accents: readonly { id: string; label: string }[];
  light: CatalogFlavor;
  dark: readonly CatalogFlavor[];
}

const CATALOG: readonly CatalogFamily[] = [
  {
    id: 'catppuccin',
    label: 'Catppuccin',
    source: 'https://github.com/catppuccin/palette (palette.json v1.8.0)',
    defaultDarkFlavor: 'mocha',
    defaultAccent: 'mauve',
    accents: [
      { id: 'rosewater', label: 'Rosewater' },
      { id: 'flamingo', label: 'Flamingo' },
      { id: 'pink', label: 'Pink' },
      { id: 'mauve', label: 'Mauve' },
      { id: 'red', label: 'Red' },
      { id: 'maroon', label: 'Maroon' },
      { id: 'peach', label: 'Peach' },
      { id: 'yellow', label: 'Yellow' },
      { id: 'green', label: 'Green' },
      { id: 'teal', label: 'Teal' },
      { id: 'sky', label: 'Sky' },
      { id: 'sapphire', label: 'Sapphire' },
      { id: 'blue', label: 'Blue' },
      { id: 'lavender', label: 'Lavender' },
    ],
    light: {
      id: 'latte',
      label: 'Latte',
      mode: 'light',
      roles: {
        '--k-bg': '#e6e9ef', // mantle
        '--k-panel': '#eff1f5', // base
        '--k-panel-raised': '#dce0e8', // crust
        '--k-line': '#ccd0da', // surface0
        '--k-line-strong': '#bcc0cc', // surface1
        '--k-text': '#4c4f69', // text
        '--k-text-muted': '#5c5f77', // subtext1
        '--k-text-faint': ['#5f6275', '#7c7f93'], // overlay2, L 0.601→0.501
        '--k-status-contrast': '#eff1f5', // base
        '--k-positive': ['#1e7900', '#40a02b'], // green, L 0.625→0.504
        '--k-caution': ['#965c00', '#df8e1d'], // yellow, L 0.714→0.528
        '--k-negative': ['#d10d38', '#d20f39'], // red, L 0.550→0.548
        '--k-active': ['#145deb', '#1e66f5'], // blue, L 0.559→0.531
      },
      variables: {
        '--error-bg': '#eddfe6', // red 8% into base
        '--error-border': '#e8bbc8', // red 24% into base
        '--error-text': ['#b1002c', '#d20f39'], // red, L 0.550→0.481
        '--success-bg': '#e1ebe5', // green 8% into base
        '--success-border': '#c5dec5', // green 24% into base
        '--success-text': ['#196900', '#40a02b'], // green, L 0.625→0.455
        '--warning-bg': '#eee9e4', // yellow 8% into base
        '--warning-border': '#ebd9c1', // yellow 24% into base
        '--warning-text': ['#834f00', '#df8e1d'], // yellow, L 0.714→0.477
        '--warning-primary': ['#db5400', '#fe640b'], // peach, L 0.692→0.617
        '--health-success': ['#309218', '#40a02b'], // green, L 0.625→0.580
        '--health-error': '#d20f39', // red
        '--health-warning': ['#b46f00', '#df8e1d'], // yellow, L 0.714→0.603
        '--event-agent-start': '#1e66f5', // blue
        '--event-agent-complete': '#8839ef', // mauve
        '--event-tool-call': ['#db5400', '#fe640b'], // peach, L 0.692→0.617
        '--event-tool-result': ['#309218', '#40a02b'], // green, L 0.625→0.580
        '--event-agent-health': ['#0088be', '#04a5e5'], // sky, L 0.682→0.592
        '--event-planning': ['#6275e9', '#7287fd'], // lavender, L 0.664→0.606
        '--event-reasoning': ['#c655a9', '#ea76cb'], // pink, L 0.726→0.620
        '--series-1': '#8839ef', // mauve
        '--series-2': ['#b46f00', '#df8e1d'], // yellow, L 0.714→0.603
        '--series-3': ['#309218', '#40a02b'], // green, L 0.625→0.580
        '--series-4': ['#0088be', '#04a5e5'], // sky, L 0.682→0.592
        '--series-5': ['#c655a9', '#ea76cb'], // pink, L 0.726→0.620
        '--series-6': ['#db5400', '#fe640b'], // peach, L 0.692→0.617
        '--meter-low': ['#309218', '#40a02b'], // green, L 0.625→0.580
        '--meter-mid': ['#b46f00', '#df8e1d'], // yellow, L 0.714→0.603
        '--meter-high': '#d20f39', // red
        '--syntax-keyword': ['#771dda', '#8839ef'], // mauve, L 0.555→0.495
        '--syntax-number': ['#9b3900', '#fe640b'], // peach, L 0.692→0.477
        '--syntax-string': ['#186700', '#40a02b'], // green, L 0.625→0.449
        '--syntax-function': ['#004bd6', '#1e66f5'], // blue, L 0.559→0.476
        '--syntax-tag': ['#006368', '#179299'], // teal, L 0.602→0.454
        '--syntax-variable': ['#b4002c', '#e64553'], // maroon, L 0.625→0.487
        '--accent-yellow': '#df8e1d', // yellow
        '--accent-yellow-text': ['#8d5600', '#df8e1d'], // yellow, L 0.714→0.504
        '--text-disabled': ['#7c7f8f', '#9ca0b0'], // overlay0, L 0.708→0.599
        '--text-subtle': ['#5f6275', '#7c7f93'], // overlay2, L 0.601→0.501
      },
      // Brand, action and focus share the accent; contrast is the text on its fill.
      accents: {
        rosewater: { brand: ['#994e3e', '#dc8a78'], contrast: '#eff1f5' }, // rosewater, L 0.714→0.512
        flamingo: { brand: ['#a44548', '#dd7878'], contrast: '#eff1f5' }, // flamingo, L 0.686→0.517
        pink: { brand: ['#a5368b', '#ea76cb'], contrast: '#eff1f5' }, // pink, L 0.726→0.523
        mauve: { brand: ['#8230e7', '#8839ef'], contrast: '#eff1f5' }, // mauve, L 0.555→0.533
        red: { brand: ['#c70033', '#d20f39'], contrast: '#eff1f5' }, // red, L 0.550→0.525
        maroon: { brand: ['#c21b36', '#e64553'], contrast: '#eff1f5' }, // maroon, L 0.625→0.525
        peach: { brand: ['#ad4000', '#fe640b'], contrast: '#eff1f5' }, // peach, L 0.692→0.517
        yellow: { brand: ['#8e5700', '#df8e1d'], contrast: '#eff1f5' }, // yellow, L 0.714→0.507
        green: { brand: ['#1c7300', '#40a02b'], contrast: '#eff1f5' }, // green, L 0.625→0.486
        teal: { brand: ['#006e74', '#179299'], contrast: '#eff1f5' }, // teal, L 0.602→0.490
        sky: { brand: ['#006a95', '#04a5e5'], contrast: '#eff1f5' }, // sky, L 0.682→0.495
        sapphire: { brand: ['#006d7e', '#209fb5'], contrast: '#eff1f5' }, // sapphire, L 0.648→0.491
        blue: { brand: ['#0d57e5', '#1e66f5'], contrast: '#eff1f5' }, // blue, L 0.559→0.514
        lavender: { brand: ['#4957c9', '#7287fd'], contrast: '#eff1f5' }, // lavender, L 0.664→0.511
      },
      channels: {
        dev: { brand: ['#955306', '#98560c'], contrast: '#ffffff' }, // L 0.519→0.510
        beta: { brand: ['#4b55cf', '#4f5bd5'], contrast: '#ffffff' }, // L 0.532→0.513
        nightly: { brand: ['#7936e9', '#7c3aed'], contrast: '#ffffff' }, // L 0.541→0.531
      },
    },
    dark: [
      {
        id: 'frappe',
        label: 'Frappé',
        mode: 'dark',
        roles: {
          '--k-bg': '#292c3c', // mantle
          '--k-panel': '#303446', // base
          '--k-panel-raised': '#414559', // surface0
          '--k-line': '#51576d', // surface1
          '--k-line-strong': '#626880', // surface2
          '--k-text': '#c6d0f5', // text
          '--k-text-muted': '#b5bfe2', // subtext1
          '--k-text-faint': ['#aab2d2', '#949cbb'], // overlay2, L 0.697→0.768
          '--k-status-contrast': '#232634', // crust
          '--k-positive': '#a6d189', // green
          '--k-caution': '#e5c890', // yellow
          '--k-negative': '#e78284', // red
          '--k-active': '#8caaee', // blue
        },
        variables: {
          '--error-bg': '#4d4050', // red 16% into base
          '--error-border': '#6b4d5a', // red 32% into base
          '--error-text': ['#fe9698', '#e78284'], // red, L 0.717→0.782
          '--success-bg': '#434d51', // green 16% into base
          '--success-border': '#56665b', // green 32% into base
          '--success-text': '#a6d189', // green
          '--warning-bg': '#4d4c52', // yellow 16% into base
          '--warning-border': '#6a635e', // yellow 32% into base
          '--warning-text': '#e5c890', // yellow
          '--warning-primary': '#ef9f76', // peach
          '--health-success': '#a6d189', // green
          '--health-error': '#e78284', // red
          '--health-warning': '#e5c890', // yellow
          '--event-agent-start': '#8caaee', // blue
          '--event-agent-complete': '#ca9ee6', // mauve
          '--event-tool-call': '#ef9f76', // peach
          '--event-tool-result': '#a6d189', // green
          '--event-agent-health': '#99d1db', // sky
          '--event-planning': '#babbf1', // lavender
          '--event-reasoning': '#f4b8e4', // pink
          '--series-1': '#ca9ee6', // mauve
          '--series-2': '#e5c890', // yellow
          '--series-3': '#a6d189', // green
          '--series-4': '#99d1db', // sky
          '--series-5': '#f4b8e4', // pink
          '--series-6': '#ef9f76', // peach
          '--meter-low': '#a6d189', // green
          '--meter-mid': '#e5c890', // yellow
          '--meter-high': '#e78284', // red
          '--syntax-keyword': ['#cea2ea', '#ca9ee6'], // mauve, L 0.765→0.777
          '--syntax-number': ['#f0a077', '#ef9f76'], // peach, L 0.773→0.776
          '--syntax-string': '#a6d189', // green
          '--syntax-function': ['#94b2f6', '#8caaee'], // blue, L 0.742→0.767
          '--syntax-tag': '#81c8be', // teal
          '--syntax-variable': ['#ee9da0', '#ea999c'], // maroon, L 0.765→0.777
          '--accent-yellow': '#e5c890', // yellow
          '--accent-yellow-text': '#e5c890', // yellow
          '--text-disabled': ['#8a90ac', '#737994'], // overlay0, L 0.581→0.658
          '--text-subtle': ['#aab2d2', '#949cbb'], // overlay2, L 0.697→0.768
        },
        // Brand, action and focus share the accent; contrast is the text on its fill.
        accents: {
          rosewater: { brand: '#f2d5cf', contrast: '#232634' }, // rosewater
          flamingo: { brand: '#eebebe', contrast: '#232634' }, // flamingo
          pink: { brand: '#f4b8e4', contrast: '#232634' }, // pink
          mauve: { brand: ['#cfa3eb', '#ca9ee6'], contrast: '#232634' }, // mauve, L 0.765→0.780
          red: { brand: ['#fe9698', '#e78284'], contrast: '#232634' }, // red, L 0.717→0.782
          maroon: { brand: ['#ef9ea1', '#ea999c'], contrast: '#232634' }, // maroon, L 0.765→0.780
          peach: { brand: ['#f0a077', '#ef9f76'], contrast: '#232634' }, // peach, L 0.773→0.776
          yellow: { brand: '#e5c890', contrast: '#232634' }, // yellow
          green: { brand: '#a6d189', contrast: '#232634' }, // green
          teal: { brand: '#81c8be', contrast: '#232634' }, // teal
          sky: { brand: '#99d1db', contrast: '#232634' }, // sky
          sapphire: { brand: '#85c1dc', contrast: '#232634' }, // sapphire
          blue: { brand: ['#94b3f7', '#8caaee'], contrast: '#232634' }, // blue, L 0.742→0.770
          lavender: { brand: '#babbf1', contrast: '#232634' }, // lavender
        },
        channels: {
          dev: { brand: ['#f6a048', '#e08b2f'], contrast: '#1b1205' }, // L 0.711→0.777
          beta: { brand: ['#a2aeff', '#7983f4'], contrast: '#06080b' }, // L 0.655→0.773
          nightly: { brand: ['#bba7ff', '#9d7bf8'], contrast: '#06080b' }, // L 0.672→0.779
        },
      },
      {
        id: 'macchiato',
        label: 'Macchiato',
        mode: 'dark',
        roles: {
          '--k-bg': '#1e2030', // mantle
          '--k-panel': '#24273a', // base
          '--k-panel-raised': '#363a4f', // surface0
          '--k-line': '#494d64', // surface1
          '--k-line-strong': '#5b6078', // surface2
          '--k-text': '#cad3f5', // text
          '--k-text-muted': '#b8c0e0', // subtext1
          '--k-text-faint': ['#9da4c1', '#939ab7'], // overlay2, L 0.690→0.723
          '--k-status-contrast': '#181926', // crust
          '--k-positive': '#a6da95', // green
          '--k-caution': '#eed49f', // yellow
          '--k-negative': '#ed8796', // red
          '--k-active': '#8aadf4', // blue
        },
        variables: {
          '--error-bg': '#443649', // red 16% into base
          '--error-border': '#644657', // red 32% into base
          '--error-text': '#ed8796', // red
          '--success-bg': '#394449', // green 16% into base
          '--success-border': '#4e6057', // green 32% into base
          '--success-text': '#a6da95', // green
          '--warning-bg': '#44434a', // yellow 16% into base
          '--warning-border': '#655e5a', // yellow 32% into base
          '--warning-text': '#eed49f', // yellow
          '--warning-primary': '#f5a97f', // peach
          '--health-success': '#a6da95', // green
          '--health-error': '#ed8796', // red
          '--health-warning': '#eed49f', // yellow
          '--event-agent-start': '#8aadf4', // blue
          '--event-agent-complete': '#c6a0f6', // mauve
          '--event-tool-call': '#f5a97f', // peach
          '--event-tool-result': '#a6da95', // green
          '--event-agent-health': '#91d7e3', // sky
          '--event-planning': '#b7bdf8', // lavender
          '--event-reasoning': '#f5bde6', // pink
          '--series-1': '#c6a0f6', // mauve
          '--series-2': '#eed49f', // yellow
          '--series-3': '#a6da95', // green
          '--series-4': '#91d7e3', // sky
          '--series-5': '#f5bde6', // pink
          '--series-6': '#f5a97f', // peach
          '--meter-low': '#a6da95', // green
          '--meter-mid': '#eed49f', // yellow
          '--meter-high': '#ed8796', // red
          '--syntax-keyword': '#c6a0f6', // mauve
          '--syntax-number': '#f5a97f', // peach
          '--syntax-string': '#a6da95', // green
          '--syntax-function': '#8aadf4', // blue
          '--syntax-tag': '#8bd5ca', // teal
          '--syntax-variable': '#ee99a0', // maroon
          '--accent-yellow': '#eed49f', // yellow
          '--accent-yellow-text': '#eed49f', // yellow
          '--text-disabled': ['#7e839e', '#6e738d'], // overlay0, L 0.561→0.615
          '--text-subtle': ['#9da4c1', '#939ab7'], // overlay2, L 0.690→0.723
        },
        // Brand, action and focus share the accent; contrast is the text on its fill.
        accents: {
          rosewater: { brand: '#f4dbd6', contrast: '#181926' }, // rosewater
          flamingo: { brand: '#f0c6c6', contrast: '#181926' }, // flamingo
          pink: { brand: '#f5bde6', contrast: '#181926' }, // pink
          mauve: { brand: '#c6a0f6', contrast: '#181926' }, // mauve
          red: { brand: '#ed8796', contrast: '#181926' }, // red
          maroon: { brand: '#ee99a0', contrast: '#181926' }, // maroon
          peach: { brand: '#f5a97f', contrast: '#181926' }, // peach
          yellow: { brand: '#eed49f', contrast: '#181926' }, // yellow
          green: { brand: '#a6da95', contrast: '#181926' }, // green
          teal: { brand: '#8bd5ca', contrast: '#181926' }, // teal
          sky: { brand: '#91d7e3', contrast: '#181926' }, // sky
          sapphire: { brand: '#7dc4e4', contrast: '#181926' }, // sapphire
          blue: { brand: '#8aadf4', contrast: '#181926' }, // blue
          lavender: { brand: '#b7bdf8', contrast: '#181926' }, // lavender
        },
        channels: {
          dev: { brand: ['#e79137', '#e08b2f'], contrast: '#1b1205' }, // L 0.711→0.731
          beta: { brand: ['#919dff', '#7983f4'], contrast: '#06080b' }, // L 0.655→0.728
          nightly: { brand: ['#ae94ff', '#9d7bf8'], contrast: '#06080b' }, // L 0.672→0.733
        },
      },
      {
        id: 'mocha',
        label: 'Mocha',
        mode: 'dark',
        roles: {
          '--k-bg': '#181825', // mantle
          '--k-panel': '#1e1e2e', // base
          '--k-panel-raised': '#313244', // surface0
          '--k-line': '#45475a', // surface1
          '--k-line-strong': '#585b70', // surface2
          '--k-text': '#cdd6f4', // text
          '--k-text-muted': '#bac2de', // subtext1
          '--k-text-faint': ['#949ab3', '#9399b2'], // overlay2, L 0.687→0.690
          '--k-status-contrast': '#11111b', // crust
          '--k-positive': '#a6e3a1', // green
          '--k-caution': '#f9e2af', // yellow
          '--k-negative': '#f38ba8', // red
          '--k-active': '#89b4fa', // blue
        },
        variables: {
          '--error-bg': '#402f42', // red 16% into base
          '--error-border': '#624155', // red 32% into base
          '--error-text': '#f38ba8', // red
          '--success-bg': '#343e40', // green 16% into base
          '--success-border': '#4a5d53', // green 32% into base
          '--success-text': '#a6e3a1', // green
          '--warning-bg': '#413d43', // yellow 16% into base
          '--warning-border': '#645d57', // yellow 32% into base
          '--warning-text': '#f9e2af', // yellow
          '--warning-primary': '#fab387', // peach
          '--health-success': '#a6e3a1', // green
          '--health-error': '#f38ba8', // red
          '--health-warning': '#f9e2af', // yellow
          '--event-agent-start': '#89b4fa', // blue
          '--event-agent-complete': '#cba6f7', // mauve
          '--event-tool-call': '#fab387', // peach
          '--event-tool-result': '#a6e3a1', // green
          '--event-agent-health': '#89dceb', // sky
          '--event-planning': '#b4befe', // lavender
          '--event-reasoning': '#f5c2e7', // pink
          '--series-1': '#cba6f7', // mauve
          '--series-2': '#f9e2af', // yellow
          '--series-3': '#a6e3a1', // green
          '--series-4': '#89dceb', // sky
          '--series-5': '#f5c2e7', // pink
          '--series-6': '#fab387', // peach
          '--meter-low': '#a6e3a1', // green
          '--meter-mid': '#f9e2af', // yellow
          '--meter-high': '#f38ba8', // red
          '--syntax-keyword': '#cba6f7', // mauve
          '--syntax-number': '#fab387', // peach
          '--syntax-string': '#a6e3a1', // green
          '--syntax-function': '#89b4fa', // blue
          '--syntax-tag': '#94e2d5', // teal
          '--syntax-variable': '#eba0ac', // maroon
          '--accent-yellow': '#f9e2af', // yellow
          '--accent-yellow-text': '#f9e2af', // yellow
          '--text-disabled': ['#777b91', '#6c7086'], // overlay0, L 0.550→0.587
          '--text-subtle': ['#949ab3', '#9399b2'], // overlay2, L 0.687→0.690
        },
        // Brand, action and focus share the accent; contrast is the text on its fill.
        accents: {
          rosewater: { brand: '#f5e0dc', contrast: '#11111b' }, // rosewater
          flamingo: { brand: '#f2cdcd', contrast: '#11111b' }, // flamingo
          pink: { brand: '#f5c2e7', contrast: '#11111b' }, // pink
          mauve: { brand: '#cba6f7', contrast: '#11111b' }, // mauve
          red: { brand: '#f38ba8', contrast: '#11111b' }, // red
          maroon: { brand: '#eba0ac', contrast: '#11111b' }, // maroon
          peach: { brand: '#fab387', contrast: '#11111b' }, // peach
          yellow: { brand: '#f9e2af', contrast: '#11111b' }, // yellow
          green: { brand: '#a6e3a1', contrast: '#11111b' }, // green
          teal: { brand: '#94e2d5', contrast: '#11111b' }, // teal
          sky: { brand: '#89dceb', contrast: '#11111b' }, // sky
          sapphire: { brand: '#74c7ec', contrast: '#11111b' }, // sapphire
          blue: { brand: '#89b4fa', contrast: '#11111b' }, // blue
          lavender: { brand: '#b4befe', contrast: '#11111b' }, // lavender
        },
        channels: {
          dev: { brand: '#e08b2f', contrast: '#1b1205' },
          beta: { brand: ['#8792ff', '#7983f4'], contrast: '#06080b' }, // L 0.655→0.700
          nightly: { brand: ['#a687ff', '#9d7bf8'], contrast: '#06080b' }, // L 0.672→0.704
        },
      },
    ],
  },
  {
    id: 'rose-pine',
    label: 'Rosé Pine',
    source:
      'https://github.com/rose-pine/neovim lua/rose-pine/palette.lua (rosepinetheme.com/palette)',
    defaultDarkFlavor: 'main',
    defaultAccent: 'iris',
    accents: [
      { id: 'love', label: 'Love' },
      { id: 'gold', label: 'Gold' },
      { id: 'rose', label: 'Rose' },
      { id: 'pine', label: 'Pine' },
      { id: 'foam', label: 'Foam' },
      { id: 'iris', label: 'Iris' },
    ],
    light: {
      id: 'dawn',
      label: 'Dawn',
      mode: 'light',
      roles: {
        '--k-bg': '#faf4ed', // base
        '--k-panel': '#fffaf3', // surface
        '--k-panel-raised': '#f2e9e1', // overlay
        '--k-line': '#dfdad9', // highlight_med
        '--k-line-strong': '#cecacd', // highlight_high
        '--k-text': '#464261', // text
        '--k-text-muted': ['#6a6683', '#797593'], // subtle, L 0.577→0.525
        '--k-text-faint': ['#6c6878', '#9893a5'], // muted, L 0.673→0.527
        '--k-status-contrast': '#fffaf3', // surface
        '--k-positive': ['#567771', '#6d8f89'], // leaf, L 0.623→0.542
        '--k-caution': ['#9d6300', '#ea9d34'], // gold, L 0.755→0.550
        '--k-negative': ['#a7576e', '#b4637a'], // love, L 0.599→0.559
        '--k-active': ['#3b7984', '#56949f'], // foam, L 0.629→0.539
      },
      variables: {
        '--error-bg': '#f9eee9', // love 8% into surface
        '--error-border': '#edd6d6', // love 24% into surface
        '--error-text': ['#974a61', '#b4637a'], // love, L 0.599→0.512
        '--success-bg': '#f3f1eb', // leaf 8% into surface
        '--success-border': '#dce0da', // leaf 24% into surface
        '--success-text': ['#486963', '#6d8f89'], // leaf, L 0.623→0.493
        '--warning-bg': '#fdf3e4', // gold 8% into surface
        '--warning-border': '#fae4c5', // gold 24% into surface
        '--warning-text': ['#8a5600', '#ea9d34'], // gold, L 0.755→0.500
        '--warning-primary': ['#c26f6c', '#d7827e'], // rose, L 0.696→0.633
        '--health-success': ['#6c8d88', '#6d8f89'], // leaf, L 0.623→0.617
        '--health-error': '#b4637a', // love
        '--health-warning': ['#bc7700', '#ea9d34'], // gold, L 0.755→0.628
        '--event-agent-start': ['#52909b', '#56949f'], // foam, L 0.629→0.616
        '--event-agent-complete': '#907aa9', // iris
        '--event-tool-call': ['#c26f6c', '#d7827e'], // rose, L 0.696→0.633
        '--event-tool-result': ['#6c8d88', '#6d8f89'], // leaf, L 0.623→0.617
        '--event-agent-health': ['#52909b', '#56949f'], // foam, L 0.629→0.616
        '--event-planning': '#907aa9', // iris
        '--event-reasoning': ['#c26f6c', '#d7827e'], // rose, L 0.696→0.633
        '--series-1': '#907aa9', // iris
        '--series-2': ['#bc7700', '#ea9d34'], // gold, L 0.755→0.628
        '--series-3': ['#6c8d88', '#6d8f89'], // leaf, L 0.623→0.617
        '--series-4': ['#52909b', '#56949f'], // foam, L 0.629→0.616
        '--series-5': ['#c26f6c', '#d7827e'], // rose, L 0.696→0.633
        '--series-6': ['#c26f6c', '#d7827e'], // rose, L 0.696→0.633
        '--meter-low': ['#6c8d88', '#6d8f89'], // leaf, L 0.623→0.617
        '--meter-mid': ['#bc7700', '#ea9d34'], // gold, L 0.755→0.628
        '--meter-high': '#b4637a', // love
        '--syntax-keyword': '#286983', // pine
        '--syntax-number': ['#974a61', '#b4637a'], // love, L 0.599→0.512
        '--syntax-string': ['#8c5700', '#ea9d34'], // gold, L 0.755→0.504
        '--syntax-function': ['#9a4b49', '#d7827e'], // rose, L 0.696→0.511
        '--syntax-tag': ['#2c6b76', '#56949f'], // foam, L 0.629→0.492
        '--syntax-variable': ['#6f5986', '#907aa9'], // iris, L 0.617→0.504
        '--accent-yellow': '#ea9d34', // gold
        '--accent-yellow-text': ['#975e00', '#ea9d34'], // gold, L 0.755→0.533
        '--text-disabled': ['#898496', '#9893a5'], // muted, L 0.673→0.624
        '--text-subtle': ['#6c6878', '#9893a5'], // muted, L 0.673→0.527
      },
      // Brand, action and focus share the accent; contrast is the text on its fill.
      accents: {
        love: { brand: ['#a05169', '#b4637a'], contrast: '#fffaf3' }, // love, L 0.599→0.538
        gold: { brand: ['#955d00', '#ea9d34'], contrast: '#fffaf3' }, // gold, L 0.755→0.528
        rose: { brand: ['#a25250', '#d7827e'], contrast: '#fffaf3' }, // rose, L 0.696→0.535
        pine: { brand: '#286983', contrast: '#fffaf3' }, // pine
        foam: { brand: ['#34727d', '#56949f'], contrast: '#fffaf3' }, // foam, L 0.629→0.516
        iris: { brand: ['#77618f', '#907aa9'], contrast: '#fffaf3' }, // iris, L 0.617→0.532
      },
      channels: {
        dev: { brand: '#98560c', contrast: '#ffffff' },
        beta: { brand: '#4f5bd5', contrast: '#ffffff' },
        nightly: { brand: '#7c3aed', contrast: '#ffffff' },
      },
    },
    dark: [
      {
        id: 'main',
        label: 'Main',
        mode: 'dark',
        roles: {
          '--k-bg': '#191724', // base
          '--k-panel': '#1f1d2e', // surface
          '--k-panel-raised': '#26233a', // overlay
          '--k-line': '#403d52', // highlight_med
          '--k-line-strong': '#524f67', // highlight_high
          '--k-text': '#e0def4', // text
          '--k-text-muted': '#908caa', // subtle
          '--k-text-faint': ['#8d89a6', '#6e6a86'], // muted, L 0.538→0.644
          '--k-status-contrast': '#191724', // base
          '--k-positive': '#95b1ac', // leaf
          '--k-caution': '#f6c177', // gold
          '--k-negative': '#eb6f92', // love
          '--k-active': '#9ccfd8', // foam
        },
        variables: {
          '--error-bg': '#402a3e', // love 16% into surface
          '--error-border': '#60374e', // love 32% into surface
          '--error-text': ['#ec7093', '#eb6f92'], // love, L 0.698→0.701
          '--success-bg': '#323542', // leaf 16% into surface
          '--success-border': '#454c56', // leaf 32% into surface
          '--success-text': '#95b1ac', // leaf
          '--warning-bg': '#41373a', // gold 16% into surface
          '--warning-border': '#645145', // gold 32% into surface
          '--warning-text': '#f6c177', // gold
          '--warning-primary': '#ebbcba', // rose
          '--health-success': '#95b1ac', // leaf
          '--health-error': '#eb6f92', // love
          '--health-warning': '#f6c177', // gold
          '--event-agent-start': '#9ccfd8', // foam
          '--event-agent-complete': '#c4a7e7', // iris
          '--event-tool-call': '#ebbcba', // rose
          '--event-tool-result': '#95b1ac', // leaf
          '--event-agent-health': '#9ccfd8', // foam
          '--event-planning': '#c4a7e7', // iris
          '--event-reasoning': '#ebbcba', // rose
          '--series-1': '#c4a7e7', // iris
          '--series-2': '#f6c177', // gold
          '--series-3': '#95b1ac', // leaf
          '--series-4': '#9ccfd8', // foam
          '--series-5': '#ebbcba', // rose
          '--series-6': '#ebbcba', // rose
          '--meter-low': '#95b1ac', // leaf
          '--meter-mid': '#f6c177', // gold
          '--meter-high': '#eb6f92', // love
          '--syntax-keyword': ['#5fa1bd', '#31748f'], // pine, L 0.528→0.676
          '--syntax-number': ['#ec7093', '#eb6f92'], // love, L 0.698→0.701
          '--syntax-string': '#f6c177', // gold
          '--syntax-function': '#ebbcba', // rose
          '--syntax-tag': '#9ccfd8', // foam
          '--syntax-variable': '#c4a7e7', // iris
          '--accent-yellow': '#f6c177', // gold
          '--accent-yellow-text': '#f6c177', // gold
          '--text-disabled': ['#706c88', '#6e6a86'], // muted, L 0.538→0.545
          '--text-subtle': ['#8d89a6', '#6e6a86'], // muted, L 0.538→0.644
        },
        // Brand, action and focus share the accent; contrast is the text on its fill.
        accents: {
          love: { brand: '#eb6f92', contrast: '#191724' }, // love
          gold: { brand: '#f6c177', contrast: '#191724' }, // gold
          rose: { brand: '#ebbcba', contrast: '#191724' }, // rose
          pine: { brand: ['#5394b0', '#31748f'], contrast: '#191724' }, // pine, L 0.528→0.634
          foam: { brand: '#9ccfd8', contrast: '#191724' }, // foam
          iris: { brand: '#c4a7e7', contrast: '#191724' }, // iris
        },
        channels: {
          dev: { brand: '#e08b2f', contrast: '#1b1205' },
          beta: { brand: '#7983f4', contrast: '#06080b' },
          nightly: { brand: '#9d7bf8', contrast: '#06080b' },
        },
      },
      {
        id: 'moon',
        label: 'Moon',
        mode: 'dark',
        roles: {
          '--k-bg': '#232136', // base
          '--k-panel': '#2a273f', // surface
          '--k-panel-raised': '#393552', // overlay
          '--k-line': '#44415a', // highlight_med
          '--k-line-strong': '#56526e', // highlight_high
          '--k-text': '#e0def4', // text
          '--k-text-muted': ['#a29ebc', '#908caa'], // subtle, L 0.654→0.713
          '--k-text-faint': ['#a29ebc', '#6e6a86'], // muted, L 0.538→0.713
          '--k-status-contrast': '#232136', // base
          '--k-positive': '#95b1ac', // leaf
          '--k-caution': '#f6c177', // gold
          '--k-negative': '#eb6f92', // love
          '--k-active': '#9ccfd8', // foam
        },
        variables: {
          '--error-bg': '#49334c', // love 16% into surface
          '--error-border': '#683e5a', // love 32% into surface
          '--error-text': ['#f97c9e', '#eb6f92'], // love, L 0.698→0.738
          '--success-bg': '#3b3d50', // leaf 16% into surface
          '--success-border': '#4c5362', // leaf 32% into surface
          '--success-text': '#95b1ac', // leaf
          '--warning-bg': '#4b4048', // gold 16% into surface
          '--warning-border': '#6b5851', // gold 32% into surface
          '--warning-text': '#f6c177', // gold
          '--warning-primary': '#ea9a97', // rose
          '--health-success': '#95b1ac', // leaf
          '--health-error': '#eb6f92', // love
          '--health-warning': '#f6c177', // gold
          '--event-agent-start': '#9ccfd8', // foam
          '--event-agent-complete': '#c4a7e7', // iris
          '--event-tool-call': '#ea9a97', // rose
          '--event-tool-result': '#95b1ac', // leaf
          '--event-agent-health': '#9ccfd8', // foam
          '--event-planning': '#c4a7e7', // iris
          '--event-reasoning': '#ea9a97', // rose
          '--series-1': '#c4a7e7', // iris
          '--series-2': '#f6c177', // gold
          '--series-3': '#95b1ac', // leaf
          '--series-4': '#9ccfd8', // foam
          '--series-5': '#ea9a97', // rose
          '--series-6': '#ea9a97', // rose
          '--meter-low': '#95b1ac', // leaf
          '--meter-mid': '#f6c177', // gold
          '--meter-high': '#eb6f92', // love
          '--syntax-keyword': ['#5dadcf', '#3e8fb0'], // pine, L 0.614→0.710
          '--syntax-number': ['#f87b9d', '#eb6f92'], // love, L 0.698→0.735
          '--syntax-string': '#f6c177', // gold
          '--syntax-function': '#ea9a97', // rose
          '--syntax-tag': '#9ccfd8', // foam
          '--syntax-variable': '#c4a7e7', // iris
          '--accent-yellow': '#f6c177', // gold
          '--accent-yellow-text': '#f6c177', // gold
          '--text-disabled': ['#837f9c', '#6e6a86'], // muted, L 0.538→0.610
          '--text-subtle': ['#a29ebc', '#6e6a86'], // muted, L 0.538→0.713
        },
        // Brand, action and focus share the accent; contrast is the text on its fill.
        accents: {
          love: { brand: ['#f6799c', '#eb6f92'], contrast: '#232136' }, // love, L 0.698→0.729
          gold: { brand: '#f6c177', contrast: '#232136' }, // gold
          rose: { brand: '#ea9a97', contrast: '#232136' }, // rose
          pine: { brand: ['#5babcd', '#3e8fb0'], contrast: '#232136' }, // pine, L 0.614→0.704
          foam: { brand: '#9ccfd8', contrast: '#232136' }, // foam
          iris: { brand: '#c4a7e7', contrast: '#232136' }, // iris
        },
        channels: {
          dev: { brand: ['#e38e33', '#e08b2f'], contrast: '#1b1205' }, // L 0.711→0.720
          beta: { brand: ['#8d99ff', '#7983f4'], contrast: '#06080b' }, // L 0.655→0.717
          nightly: { brand: ['#ac90ff', '#9d7bf8'], contrast: '#06080b' }, // L 0.672→0.725
        },
      },
    ],
  },
  {
    id: 'gruvbox',
    label: 'Gruvbox',
    source: 'https://github.com/morhetz/gruvbox colors/gruvbox.vim',
    defaultDarkFlavor: 'dark',
    defaultAccent: 'orange',
    accents: [
      { id: 'red', label: 'Red' },
      { id: 'green', label: 'Green' },
      { id: 'yellow', label: 'Yellow' },
      { id: 'blue', label: 'Blue' },
      { id: 'purple', label: 'Purple' },
      { id: 'aqua', label: 'Aqua' },
      { id: 'orange', label: 'Orange' },
    ],
    light: {
      id: 'light',
      label: 'Light',
      mode: 'light',
      roles: {
        '--k-bg': '#f2e5bc', // light0_soft
        '--k-panel': '#fbf1c7', // light0
        '--k-panel-raised': '#ebdbb2', // light1
        '--k-line': '#d5c4a1', // light2
        '--k-line-strong': '#bdae93', // light3
        '--k-text': '#3c3836', // dark1
        '--k-text-muted': '#665c54', // dark3
        '--k-text-faint': ['#6b5f54', '#7c6f64'], // dark4, L 0.550→0.494
        '--k-status-contrast': '#fbf1c7', // light0
        '--k-positive': ['#6e6900', '#79740e'], // faded_green, L 0.546→0.509
        '--k-caution': ['#905b00', '#b57614'], // faded_yellow, L 0.618→0.518
        '--k-negative': '#9d0006', // faded_red
        '--k-active': '#076678', // faded_blue
      },
      variables: {
        '--error-bg': '#f3deb8', // faded_red 8% into light0
        '--error-border': '#e4b799', // faded_red 24% into light0
        '--error-text': '#9d0006', // faded_red
        '--success-bg': '#f1e7b8', // faded_green 8% into light0
        '--success-border': '#dcd39b', // faded_green 24% into light0
        '--success-text': ['#605b00', '#79740e'], // faded_green, L 0.546→0.461
        '--warning-bg': '#f5e7b9', // faded_yellow 8% into light0
        '--warning-border': '#ead39c', // faded_yellow 24% into light0
        '--warning-text': ['#7e4f00', '#b57614'], // faded_yellow, L 0.618→0.470
        '--warning-primary': '#af3a03', // faded_orange
        '--health-success': '#79740e', // faded_green
        '--health-error': '#9d0006', // faded_red
        '--health-warning': ['#ae6f03', '#b57614'], // faded_yellow, L 0.618→0.595
        '--event-agent-start': '#076678', // faded_blue
        '--event-agent-complete': '#8f3f71', // faded_purple
        '--event-tool-call': '#af3a03', // faded_orange
        '--event-tool-result': '#79740e', // faded_green
        '--event-agent-health': '#427b58', // faded_aqua
        '--event-planning': '#076678', // faded_blue
        '--event-reasoning': '#8f3f71', // faded_purple
        '--series-1': '#8f3f71', // faded_purple
        '--series-2': ['#ae6f03', '#b57614'], // faded_yellow, L 0.618→0.595
        '--series-3': '#79740e', // faded_green
        '--series-4': '#427b58', // faded_aqua
        '--series-5': '#8f3f71', // faded_purple
        '--series-6': '#af3a03', // faded_orange
        '--meter-low': '#79740e', // faded_green
        '--meter-mid': ['#ae6f03', '#b57614'], // faded_yellow, L 0.618→0.595
        '--meter-high': '#9d0006', // faded_red
        '--syntax-keyword': '#9d0006', // faded_red
        '--syntax-number': ['#89396b', '#8f3f71'], // faded_purple, L 0.489→0.469
        '--syntax-string': ['#5d5800', '#79740e'], // faded_green, L 0.546→0.451
        '--syntax-function': ['#794c00', '#b57614'], // faded_yellow, L 0.618→0.457
        '--syntax-tag': ['#26603f', '#427b58'], // faded_aqua, L 0.534→0.441
        '--syntax-variable': ['#005e6f', '#076678'], // faded_blue, L 0.471→0.444
        '--accent-yellow': '#b57614', // faded_yellow
        '--accent-yellow-text': ['#865500', '#b57614'], // faded_yellow, L 0.618→0.493
        '--text-disabled': ['#897a6b', '#928374'], // gray, L 0.619→0.589
        '--text-subtle': ['#6b5f54', '#7c6f64'], // dark4, L 0.550→0.494
      },
      // Brand, action and focus share the accent; contrast is the text on its fill.
      accents: {
        red: { brand: '#9d0006', contrast: '#fbf1c7' }, // faded_red
        green: { brand: ['#686300', '#79740e'], contrast: '#fbf1c7' }, // faded_green, L 0.546→0.489
        yellow: { brand: ['#885600', '#b57614'], contrast: '#fbf1c7' }, // faded_yellow, L 0.618→0.497
        blue: { brand: '#076678', contrast: '#fbf1c7' }, // faded_blue
        purple: { brand: '#8f3f71', contrast: '#fbf1c7' }, // faded_purple
        aqua: { brand: ['#336c4a', '#427b58'], contrast: '#fbf1c7' }, // faded_aqua, L 0.534→0.483
        orange: { brand: ['#ae3902', '#af3a03'], contrast: '#fbf1c7' }, // faded_orange, L 0.513→0.510
      },
      channels: {
        dev: { brand: ['#925101', '#98560c'], contrast: '#ffffff' }, // L 0.519→0.501
        beta: { brand: ['#4953cc', '#4f5bd5'], contrast: '#ffffff' }, // L 0.532→0.506
        nightly: { brand: ['#7732e6', '#7c3aed'], contrast: '#ffffff' }, // L 0.541→0.522
      },
    },
    dark: [
      {
        id: 'dark',
        label: 'Dark',
        mode: 'dark',
        roles: {
          '--k-bg': '#1d2021', // dark0_hard
          '--k-panel': '#282828', // dark0
          '--k-panel-raised': '#3c3836', // dark1
          '--k-line': '#504945', // dark2
          '--k-line-strong': '#665c54', // dark3
          '--k-text': '#ebdbb2', // light1
          '--k-text-muted': '#bdae93', // light3
          '--k-text-faint': ['#afa08b', '#a89984'], // light4, L 0.690→0.713
          '--k-status-contrast': '#1d2021', // dark0_hard
          '--k-positive': '#b8bb26', // bright_green
          '--k-caution': '#fabd2f', // bright_yellow
          '--k-negative': ['#ff4f39', '#fb4934'], // bright_red, L 0.660→0.673
          '--k-active': '#83a598', // bright_blue
        },
        variables: {
          '--error-bg': '#4a2d2a', // bright_red 16% into dark0
          '--error-border': '#6c332c', // bright_red 32% into dark0
          '--error-text': ['#ff7965', '#fb4934'], // bright_red, L 0.660→0.729
          '--success-bg': '#3f4028', // bright_green 16% into dark0
          '--success-border': '#565727', // bright_green 32% into dark0
          '--success-text': '#b8bb26', // bright_green
          '--warning-bg': '#4a4029', // bright_yellow 16% into dark0
          '--warning-border': '#6b582a', // bright_yellow 32% into dark0
          '--warning-text': '#fabd2f', // bright_yellow
          '--warning-primary': '#fe8019', // bright_orange
          '--health-success': '#b8bb26', // bright_green
          '--health-error': '#fb4934', // bright_red
          '--health-warning': '#fabd2f', // bright_yellow
          '--event-agent-start': '#83a598', // bright_blue
          '--event-agent-complete': '#d3869b', // bright_purple
          '--event-tool-call': '#fe8019', // bright_orange
          '--event-tool-result': '#b8bb26', // bright_green
          '--event-agent-health': '#8ec07c', // bright_aqua
          '--event-planning': '#83a598', // bright_blue
          '--event-reasoning': '#d3869b', // bright_purple
          '--series-1': '#d3869b', // bright_purple
          '--series-2': '#fabd2f', // bright_yellow
          '--series-3': '#b8bb26', // bright_green
          '--series-4': '#8ec07c', // bright_aqua
          '--series-5': '#d3869b', // bright_purple
          '--series-6': '#fe8019', // bright_orange
          '--meter-low': '#b8bb26', // bright_green
          '--meter-mid': '#fabd2f', // bright_yellow
          '--meter-high': '#fb4934', // bright_red
          '--syntax-keyword': ['#ff735e', '#fb4934'], // bright_red, L 0.660→0.720
          '--syntax-number': ['#d6889d', '#d3869b'], // bright_purple, L 0.705→0.713
          '--syntax-string': '#b8bb26', // bright_green
          '--syntax-function': '#fabd2f', // bright_yellow
          '--syntax-tag': '#8ec07c', // bright_aqua
          '--syntax-variable': ['#84a699', '#83a598'], // bright_blue, L 0.693→0.696
          '--accent-yellow': '#fabd2f', // bright_yellow
          '--accent-yellow-text': '#fabd2f', // bright_yellow
          '--text-disabled': '#928374', // gray
          '--text-subtle': ['#afa08b', '#a89984'], // light4, L 0.690→0.713
        },
        // Brand, action and focus share the accent; contrast is the text on its fill.
        accents: {
          red: { brand: ['#ff7965', '#fb4934'], contrast: '#1d2021' }, // bright_red, L 0.660→0.729
          green: { brand: '#b8bb26', contrast: '#1d2021' }, // bright_green
          yellow: { brand: '#fabd2f', contrast: '#1d2021' }, // bright_yellow
          blue: { brand: ['#87a99c', '#83a598'], contrast: '#1d2021' }, // bright_blue, L 0.693→0.706
          purple: { brand: ['#d98ba0', '#d3869b'], contrast: '#1d2021' }, // bright_purple, L 0.705→0.722
          aqua: { brand: '#8ec07c', contrast: '#1d2021' }, // bright_aqua
          orange: { brand: '#fe8019', contrast: '#1d2021' }, // bright_orange
        },
        channels: {
          dev: { brand: ['#e38e33', '#e08b2f'], contrast: '#1b1205' }, // L 0.711→0.720
          beta: { brand: ['#8e9aff', '#7983f4'], contrast: '#06080b' }, // L 0.655→0.720
          nightly: { brand: ['#ac90ff', '#9d7bf8'], contrast: '#06080b' }, // L 0.672→0.725
        },
      },
    ],
  },
  {
    id: 'nord',
    label: 'Nord',
    source:
      'https://github.com/nordtheme/vim colors/nord.vim (nordtheme.com/docs/colors-and-palettes)',
    defaultDarkFlavor: 'polar-night',
    defaultAccent: 'frost',
    accents: [
      { id: 'frost', label: 'Frost' },
      { id: 'teal', label: 'Teal' },
      { id: 'blue', label: 'Blue' },
      { id: 'deep-blue', label: 'Deep blue' },
      { id: 'red', label: 'Red' },
      { id: 'orange', label: 'Orange' },
      { id: 'yellow', label: 'Yellow' },
      { id: 'green', label: 'Green' },
      { id: 'purple', label: 'Purple' },
    ],
    light: {
      id: 'snow-storm',
      label: 'Snow Storm',
      mode: 'light',
      roles: {
        '--k-bg': '#e5e9f0', // nord5
        '--k-panel': '#eceff4', // nord6
        '--k-panel-raised': '#d8dee9', // nord4
        '--k-line': '#d8dee9', // nord4
        '--k-line-strong': '#616e88', // nord3_bright
        '--k-text': '#2e3440', // nord0
        '--k-text-muted': '#4c566a', // nord3
        '--k-text-faint': ['#55627b', '#616e88'], // nord3_bright, L 0.537→0.495
        '--k-status-contrast': '#eceff4', // nord6
        '--k-positive': ['#587042', '#a3be8c'], // nord14, L 0.768→0.514
        '--k-caution': ['#816423', '#ebcb8b'], // nord13, L 0.855→0.520
        '--k-negative': ['#a74b55', '#bf616a'], // nord11, L 0.606→0.533
        '--k-active': ['#496b95', '#5e81ac'], // nord10, L 0.594→0.520
      },
      variables: {
        '--error-bg': '#e8e4e9', // nord11 8% into nord6
        '--error-border': '#e1cdd3', // nord11 24% into nord6
        '--error-text': ['#973d48', '#bf616a'], // nord11, L 0.606→0.485
        '--success-bg': '#e6ebec', // nord14 8% into nord6
        '--success-border': '#dae3db', // nord14 24% into nord6
        '--success-text': ['#4b6234', '#a3be8c'], // nord14, L 0.768→0.465
        '--warning-bg': '#ececec', // nord13 8% into nord6
        '--warning-border': '#ece6db', // nord13 24% into nord6
        '--warning-text': ['#735612', '#ebcb8b'], // nord13, L 0.855→0.471
        '--warning-primary': ['#b26c56', '#d08770'], // nord12, L 0.693→0.603
        '--health-success': ['#6c8556', '#a3be8c'], // nord14, L 0.768→0.585
        '--health-error': '#bf616a', // nord11
        '--health-warning': ['#97793a', '#ebcb8b'], // nord13, L 0.855→0.592
        '--event-agent-start': ['#5d80ab', '#5e81ac'], // nord10, L 0.594→0.591
        '--event-agent-complete': ['#977290', '#b48ead'], // nord15, L 0.692→0.599
        '--event-tool-call': ['#b26c56', '#d08770'], // nord12, L 0.693→0.603
        '--event-tool-result': ['#6c8556', '#a3be8c'], // nord14, L 0.768→0.585
        '--event-agent-health': ['#4f8695', '#88c0d0'], // nord8, L 0.775→0.588
        '--event-planning': ['#5d80ab', '#5e81ac'], // nord10, L 0.594→0.591
        '--event-reasoning': ['#977290', '#b48ead'], // nord15, L 0.692→0.599
        '--series-1': ['#977290', '#b48ead'], // nord15, L 0.692→0.599
        '--series-2': ['#97793a', '#ebcb8b'], // nord13, L 0.855→0.592
        '--series-3': ['#6c8556', '#a3be8c'], // nord14, L 0.768→0.585
        '--series-4': ['#4f8695', '#88c0d0'], // nord8, L 0.775→0.588
        '--series-5': ['#977290', '#b48ead'], // nord15, L 0.692→0.599
        '--series-6': ['#b26c56', '#d08770'], // nord12, L 0.693→0.603
        '--meter-low': ['#6c8556', '#a3be8c'], // nord14, L 0.768→0.585
        '--meter-mid': ['#97793a', '#ebcb8b'], // nord13, L 0.855→0.592
        '--meter-high': '#bf616a', // nord11
        '--syntax-keyword': ['#3c5d86', '#5e81ac'], // nord10, L 0.594→0.472
        '--syntax-number': ['#73506d', '#b48ead'], // nord15, L 0.692→0.479
        '--syntax-string': ['#4b6335', '#a3be8c'], // nord14, L 0.768→0.468
        '--syntax-function': ['#2c6372', '#88c0d0'], // nord8, L 0.775→0.469
        '--syntax-tag': ['#386362', '#8fbcbb'], // nord7, L 0.763→0.468
        '--syntax-variable': ['#8c4934', '#d08770'], // nord12, L 0.693→0.483
        '--accent-yellow': '#ebcb8b', // nord13
        '--accent-yellow-text': ['#7f6221', '#ebcb8b'], // nord13, L 0.855→0.513
        '--text-disabled': '#616e88', // nord3_bright
        '--text-subtle': ['#55627b', '#616e88'], // nord3_bright, L 0.537→0.495
      },
      // Brand, action and focus share the accent; contrast is the text on its fill.
      accents: {
        frost: { brand: ['#326978', '#88c0d0'], contrast: '#eceff4' }, // nord8, L 0.775→0.490
        teal: { brand: ['#3e6969', '#8fbcbb'], contrast: '#eceff4' }, // nord7, L 0.763→0.490
        blue: { brand: ['#476582', '#81a1c1'], contrast: '#eceff4' }, // nord9, L 0.697→0.495
        'deep-blue': { brand: ['#42648e', '#5e81ac'], contrast: '#eceff4' }, // nord10, L 0.594→0.496
        red: { brand: ['#9f454f', '#bf616a'], contrast: '#eceff4' }, // nord11, L 0.606→0.511
        orange: { brand: ['#93503a', '#d08770'], contrast: '#eceff4' }, // nord12, L 0.693→0.506
        yellow: { brand: ['#7a5e1c', '#ebcb8b'], contrast: '#eceff4' }, // nord13, L 0.855→0.498
        green: { brand: ['#51693b', '#a3be8c'], contrast: '#eceff4' }, // nord14, L 0.768→0.489
        purple: { brand: ['#7a5774', '#b48ead'], contrast: '#eceff4' }, // nord15, L 0.692→0.504
      },
      channels: {
        dev: { brand: ['#935203', '#98560c'], contrast: '#ffffff' }, // L 0.519→0.505
        beta: { brand: ['#4954cd', '#4f5bd5'], contrast: '#ffffff' }, // L 0.532→0.509
        nightly: { brand: ['#7733e7', '#7c3aed'], contrast: '#ffffff' }, // L 0.541→0.524
      },
    },
    dark: [
      {
        id: 'polar-night',
        label: 'Polar Night',
        mode: 'dark',
        roles: {
          '--k-bg': '#2e3440', // nord0
          '--k-panel': '#3b4252', // nord1
          '--k-panel-raised': '#434c5e', // nord2
          '--k-line': '#4c566a', // nord3
          '--k-line-strong': '#616e88', // nord3_bright
          '--k-text': '#eceff4', // nord6
          '--k-text-muted': '#d8dee9', // nord4
          '--k-text-faint': ['#adbcd8', '#616e88'], // nord3_bright, L 0.537→0.793
          '--k-status-contrast': '#2e3440', // nord0
          '--k-positive': '#a3be8c', // nord14
          '--k-caution': '#ebcb8b', // nord13
          '--k-negative': ['#f59199', '#bf616a'], // nord11, L 0.606→0.764
          '--k-active': ['#90b1d1', '#81a1c1'], // nord9, L 0.697→0.747
        },
        variables: {
          '--error-bg': '#504756', // nord11 16% into nord1
          '--error-border': '#654c5a', // nord11 32% into nord1
          '--error-text': ['#ffa2a8', '#bf616a'], // nord11, L 0.606→0.807
          '--success-bg': '#4c565b', // nord14 16% into nord1
          '--success-border': '#5c6a65', // nord14 32% into nord1
          '--success-text': ['#b5d19e', '#a3be8c'], // nord14, L 0.768→0.827
          '--warning-bg': '#57585b', // nord13 16% into nord1
          '--warning-border': '#736e64', // nord13 32% into nord1
          '--warning-text': '#ebcb8b', // nord13
          '--warning-primary': '#d08770', // nord12
          '--health-success': '#a3be8c', // nord14
          '--health-error': ['#de7c84', '#bf616a'], // nord11, L 0.606→0.696
          '--health-warning': '#ebcb8b', // nord13
          '--event-agent-start': '#81a1c1', // nord9
          '--event-agent-complete': '#b48ead', // nord15
          '--event-tool-call': '#d08770', // nord12
          '--event-tool-result': '#a3be8c', // nord14
          '--event-agent-health': '#88c0d0', // nord8
          '--event-planning': ['#789cc8', '#5e81ac'], // nord10, L 0.594→0.683
          '--event-reasoning': '#b48ead', // nord15
          '--series-1': '#b48ead', // nord15
          '--series-2': '#ebcb8b', // nord13
          '--series-3': '#a3be8c', // nord14
          '--series-4': '#88c0d0', // nord8
          '--series-5': '#b48ead', // nord15
          '--series-6': '#d08770', // nord12
          '--meter-low': '#a3be8c', // nord14
          '--meter-mid': '#ebcb8b', // nord13
          '--meter-high': ['#de7c84', '#bf616a'], // nord11, L 0.606→0.696
          '--syntax-keyword': ['#9abbdc', '#81a1c1'], // nord9, L 0.697→0.779
          '--syntax-number': ['#d3accc', '#b48ead'], // nord15, L 0.692→0.789
          '--syntax-string': ['#a5c08e', '#a3be8c'], // nord14, L 0.768→0.775
          '--syntax-function': '#88c0d0', // nord8
          '--syntax-tag': ['#93c0bf', '#8fbcbb'], // nord7, L 0.763→0.775
          '--syntax-variable': ['#f1a58d', '#d08770'], // nord12, L 0.693→0.790
          '--accent-yellow': '#ebcb8b', // nord13
          '--accent-yellow-text': '#ebcb8b', // nord13
          '--text-disabled': ['#8b99b5', '#616e88'], // nord3_bright, L 0.537→0.682
          '--text-subtle': ['#adbcd8', '#616e88'], // nord3_bright, L 0.537→0.793
        },
        // Brand, action and focus share the accent; contrast is the text on its fill.
        accents: {
          frost: { brand: ['#8cc4d4', '#88c0d0'], contrast: '#2e3440' }, // nord8, L 0.775→0.787
          teal: { brand: ['#97c4c3', '#8fbcbb'], contrast: '#2e3440' }, // nord7, L 0.763→0.788
          blue: { brand: ['#9ebfe0', '#81a1c1'], contrast: '#2e3440' }, // nord9, L 0.697→0.792
          'deep-blue': { brand: ['#9abfed', '#5e81ac'], contrast: '#2e3440' }, // nord10, L 0.594→0.794
          red: { brand: ['#ffa2a8', '#bf616a'], contrast: '#2e3440' }, // nord11, L 0.606→0.807
          orange: { brand: ['#f5a991', '#d08770'], contrast: '#2e3440' }, // nord12, L 0.693→0.802
          yellow: { brand: '#ebcb8b', contrast: '#2e3440' }, // nord13
          green: { brand: ['#a8c491', '#a3be8c'], contrast: '#2e3440' }, // nord14, L 0.768→0.786
          purple: { brand: ['#d8b0d0', '#b48ead'], contrast: '#2e3440' }, // nord15, L 0.692→0.802
        },
        channels: {
          dev: { brand: ['#ffa850', '#e08b2f'], contrast: '#1b1205' }, // L 0.711→0.802
          beta: { brand: ['#acb7ff', '#7983f4'], contrast: '#06080b' }, // L 0.655→0.797
          nightly: { brand: ['#c1b1ff', '#9d7bf8'], contrast: '#06080b' }, // L 0.672→0.802
        },
      },
    ],
  },
  {
    id: 'tokyo-night',
    label: 'Tokyo Night',
    source:
      'https://github.com/folke/tokyonight.nvim lua/tokyonight/colors/{storm,night}.lua and extras/lua/tokyonight_day.lua',
    defaultDarkFlavor: 'night',
    defaultAccent: 'blue',
    accents: [
      { id: 'blue', label: 'Blue' },
      { id: 'cyan', label: 'Cyan' },
      { id: 'teal', label: 'Teal' },
      { id: 'green', label: 'Green' },
      { id: 'yellow', label: 'Yellow' },
      { id: 'orange', label: 'Orange' },
      { id: 'red', label: 'Red' },
      { id: 'magenta', label: 'Magenta' },
      { id: 'purple', label: 'Purple' },
    ],
    light: {
      id: 'day',
      label: 'Day',
      mode: 'light',
      roles: {
        '--k-bg': '#d0d5e3', // bg_dark
        '--k-panel': '#e1e2e7', // bg
        '--k-panel-raised': '#c4c8da', // bg_highlight
        '--k-line': '#a8aecb', // fg_gutter
        '--k-line-strong': '#8990b3', // dark3
        '--k-text': ['#284fac', '#3760bf'], // Tokyo Night fg #3760bf, OKLCH L 0.512→0.456: text AA on page, panel and raised panel
        '--k-text-muted': ['#42518c', '#6172b0'], // Tokyo Night fg_dark #6172b0, OKLCH L 0.565→0.451: muted text AA on page, panel and raised panel
        '--k-text-faint': ['#4b527a', '#68709a'], // Tokyo Night dark5 #68709a, OKLCH L 0.555→0.450: faint text AA on page, panel and raised panel
        '--k-status-contrast': '#e1e2e7', // bg
        '--k-positive': ['#496529', '#587539'], // Tokyo Night green #587539, OKLCH L 0.525→0.470: status text AA on page and panel, and status-contrast text on the fill
        '--k-caution': ['#765729', '#8c6c3e'], // Tokyo Night yellow #8c6c3e, OKLCH L 0.553→0.479: status text AA on page and panel, and status-contrast text on the fill
        '--k-negative': ['#ba0046', '#f52a65'], // Tokyo Night red #f52a65, OKLCH L 0.634→0.503: status text AA on page and panel, and status-contrast text on the fill
        '--k-active': ['#0059be', '#2e7de9'], // Tokyo Night blue #2e7de9, OKLCH L 0.600→0.483: status text AA on page and panel, and status-contrast text on the fill
      },
      variables: {
        '--error-bg': '#e3d3dd', // red 8% into bg
        '--error-border': '#e6b6c8', // red 24% into bg
        '--error-text': ['#990038', '#f52a65'], // Tokyo Night red #f52a65, OKLCH L 0.634→0.436: self-tint
        '--success-bg': '#d6d9d9', // green 8% into bg
        '--success-border': '#c0c8bd', // green 24% into bg
        '--success-text': ['#3c571b', '#587539'], // Tokyo Night green #587539, OKLCH L 0.525→0.421: self-tint
        '--warning-bg': '#dad9d9', // yellow 8% into bg
        '--warning-border': '#cdc6be', // yellow 24% into bg
        '--warning-text': ['#68491a', '#8c6c3e'], // Tokyo Night yellow #8c6c3e, OKLCH L 0.553→0.430: self-tint
        '--warning-primary': ['#ac5900', '#b15c00'], // Tokyo Night orange #b15c00, OKLCH L 0.565→0.553: non-text 3:1 on page, panel and raised panel
        '--health-success': '#587539', // green
        '--health-error': ['#dc0054', '#f52a65'], // Tokyo Night red #f52a65, OKLCH L 0.634→0.571: non-text 3:1 on page, panel and raised panel
        '--health-warning': ['#89693b', '#8c6c3e'], // Tokyo Night yellow #8c6c3e, OKLCH L 0.553→0.543: non-text 3:1 on page, panel and raised panel
        '--event-agent-start': ['#1b6cd7', '#2e7de9'], // Tokyo Night blue #2e7de9, OKLCH L 0.600→0.547: non-text 3:1 on page, panel and raised panel
        '--event-agent-complete': '#7847bd', // purple
        '--event-tool-call': ['#ac5900', '#b15c00'], // Tokyo Night orange #b15c00, OKLCH L 0.565→0.553: non-text 3:1 on page, panel and raised panel
        '--event-tool-result': '#587539', // green
        '--event-agent-health': '#007197', // cyan
        '--event-planning': ['#8d47e4', '#9854f1'], // Tokyo Night magenta #9854f1, OKLCH L 0.604→0.567: non-text 3:1 on page, panel and raised panel
        '--event-reasoning': ['#8d47e4', '#9854f1'], // Tokyo Night magenta #9854f1, OKLCH L 0.604→0.567: non-text 3:1 on page, panel and raised panel
        '--series-1': '#7847bd', // purple
        '--series-2': ['#89693b', '#8c6c3e'], // Tokyo Night yellow #8c6c3e, OKLCH L 0.553→0.543: non-text 3:1 on page, panel and raised panel
        '--series-3': '#587539', // green
        '--series-4': '#007197', // cyan
        '--series-5': ['#8d47e4', '#9854f1'], // Tokyo Night magenta #9854f1, OKLCH L 0.604→0.567: non-text 3:1 on page, panel and raised panel
        '--series-6': ['#ac5900', '#b15c00'], // Tokyo Night orange #b15c00, OKLCH L 0.565→0.553: non-text 3:1 on page, panel and raised panel
        '--meter-low': '#587539', // green
        '--meter-mid': ['#89693b', '#8c6c3e'], // Tokyo Night yellow #8c6c3e, OKLCH L 0.553→0.543: non-text 3:1 on page, panel and raised panel
        '--meter-high': ['#dc0054', '#f52a65'], // Tokyo Night red #f52a65, OKLCH L 0.634→0.571: non-text 3:1 on page, panel and raised panel
        '--syntax-keyword': ['#6b17bc', '#9854f1'], // Tokyo Night magenta #9854f1, OKLCH L 0.604→0.449: code text AA on page, panel and every accent’s selected-line tint
        '--syntax-number': ['#793d00', '#b15c00'], // Tokyo Night orange #b15c00, OKLCH L 0.565→0.428: code text AA on page, panel and every accent’s selected-line tint
        '--syntax-string': ['#395417', '#587539'], // Tokyo Night green #587539, OKLCH L 0.525→0.410: code text AA on page, panel and every accent’s selected-line tint
        '--syntax-function': ['#00499f', '#2e7de9'], // Tokyo Night blue #2e7de9, OKLCH L 0.600→0.422: code text AA on page, panel and every accent’s selected-line tint
        '--syntax-tag': ['#9c0039', '#f52a65'], // Tokyo Night red #f52a65, OKLCH L 0.634→0.442: code text AA on page, panel and every accent’s selected-line tint
        '--syntax-variable': ['#654718', '#8c6c3e'], // Tokyo Night yellow #8c6c3e, OKLCH L 0.553→0.422: code text AA on page, panel and every accent’s selected-line tint
        '--accent-yellow': ['#8f6f41', '#8c6c3e'], // Tokyo Night yellow #8c6c3e, OKLCH L 0.553→0.563: black text AA on the solid yellow fill
        '--accent-yellow-text': ['#6d4f20', '#8c6c3e'], // Tokyo Night yellow #8c6c3e, OKLCH L 0.553→0.450: text AA on the 12% yellow chip tint over page and panel
        '--text-disabled': ['#676e8f', '#8990b3'], // Tokyo Night dark3 #8990b3, OKLCH L 0.660→0.545: inactive text 3:1 on page and raised panel
        '--text-subtle': ['#4b527a', '#68709a'], // Tokyo Night dark5 #68709a, OKLCH L 0.555→0.450: placeholder text AA on the input, raised panel and hover surfaces
      },
      // Brand, action and focus share the accent; contrast is the text on its fill.
      accents: {
        blue: { brand: ['#0051ae', '#2e7de9'], contrast: '#e1e2e7' }, // blue, L 0.600→0.452
        cyan: { brand: ['#005b7a', '#007197'], contrast: '#e1e2e7' }, // cyan, L 0.514→0.441
        teal: { brand: ['#00604f', '#118c74'], contrast: '#e1e2e7' }, // teal, L 0.573→0.437
        green: { brand: ['#415c20', '#587539'], contrast: '#e1e2e7' }, // green, L 0.525→0.439
        yellow: { brand: ['#6d4f20', '#8c6c3e'], contrast: '#e1e2e7' }, // yellow, L 0.553→0.450
        orange: { brand: ['#854300', '#b15c00'], contrast: '#e1e2e7' }, // orange, L 0.565→0.457
        red: { brand: ['#ab003f', '#f52a65'], contrast: '#e1e2e7' }, // red, L 0.634→0.473
        magenta: { brand: ['#7325c5', '#9854f1'], contrast: '#e1e2e7' }, // magenta, L 0.604→0.477
        purple: { brand: ['#6b38ad', '#7847bd'], contrast: '#e1e2e7' }, // purple, L 0.515→0.468
      },
      channels: {
        dev: { brand: ['#804600', '#98560c'], contrast: '#ffffff' }, // L 0.519→0.455
        beta: { brand: ['#3e45bd', '#4f5bd5'], contrast: '#ffffff' }, // L 0.532→0.462
        nightly: { brand: ['#6b1dd7', '#7c3aed'], contrast: '#ffffff' }, // L 0.541→0.478
      },
    },
    dark: [
      {
        id: 'night',
        label: 'Night',
        mode: 'dark',
        roles: {
          '--k-bg': '#16161e', // bg_dark
          '--k-panel': '#1a1b26', // bg
          '--k-panel-raised': '#292e42', // bg_highlight
          '--k-line': '#3b4261', // fg_gutter
          '--k-line-strong': '#545c7e', // dark3
          '--k-text': '#c0caf5', // fg
          '--k-text-muted': '#a9b1d6', // fg_dark
          '--k-text-faint': ['#8c94bd', '#737aa2'], // Tokyo Night dark5 #737aa2, OKLCH L 0.589→0.675: faint text AA on page, panel and raised panel
          '--k-status-contrast': '#16161e', // bg_dark
          '--k-positive': '#9ece6a', // green
          '--k-caution': '#e0af68', // yellow
          '--k-negative': '#f7768e', // red
          '--k-active': '#7aa2f7', // blue
        },
        variables: {
          '--error-bg': '#3d2a37', // red 16% into bg
          '--error-border': '#613847', // red 32% into bg
          '--error-text': '#f7768e', // red
          '--success-bg': '#2f3831', // green 16% into bg
          '--success-border': '#44543c', // green 32% into bg
          '--success-text': '#9ece6a', // green
          '--warning-bg': '#3a3331', // yellow 16% into bg
          '--warning-border': '#594a3b', // yellow 32% into bg
          '--warning-text': '#e0af68', // yellow
          '--warning-primary': '#ff9e64', // orange
          '--health-success': '#9ece6a', // green
          '--health-error': '#f7768e', // red
          '--health-warning': '#e0af68', // yellow
          '--event-agent-start': '#7aa2f7', // blue
          '--event-agent-complete': '#9d7cd8', // purple
          '--event-tool-call': '#ff9e64', // orange
          '--event-tool-result': '#9ece6a', // green
          '--event-agent-health': '#7dcfff', // cyan
          '--event-planning': '#bb9af7', // magenta
          '--event-reasoning': '#bb9af7', // magenta
          '--series-1': '#9d7cd8', // purple
          '--series-2': '#e0af68', // yellow
          '--series-3': '#9ece6a', // green
          '--series-4': '#7dcfff', // cyan
          '--series-5': '#bb9af7', // magenta
          '--series-6': '#ff9e64', // orange
          '--meter-low': '#9ece6a', // green
          '--meter-mid': '#e0af68', // yellow
          '--meter-high': '#f7768e', // red
          '--syntax-keyword': '#bb9af7', // magenta
          '--syntax-number': '#ff9e64', // orange
          '--syntax-string': '#9ece6a', // green
          '--syntax-function': '#7aa2f7', // blue
          '--syntax-tag': '#f7768e', // red
          '--syntax-variable': '#e0af68', // yellow
          '--accent-yellow': '#e0af68', // yellow
          '--accent-yellow-text': '#e0af68', // yellow
          '--text-disabled': ['#6d7699', '#545c7e'], // Tokyo Night dark3 #545c7e, OKLCH L 0.482→0.572: inactive text 3:1 on page and raised panel
          '--text-subtle': ['#8c94bd', '#737aa2'], // Tokyo Night dark5 #737aa2, OKLCH L 0.589→0.675: placeholder text AA on the input, raised panel and hover surfaces
        },
        // Brand, action and focus share the accent; contrast is the text on its fill.
        accents: {
          blue: { brand: '#7aa2f7', contrast: '#16161e' }, // blue
          cyan: { brand: '#7dcfff', contrast: '#16161e' }, // cyan
          teal: { brand: '#1abc9c', contrast: '#16161e' }, // teal
          green: { brand: '#9ece6a', contrast: '#16161e' }, // green
          yellow: { brand: '#e0af68', contrast: '#16161e' }, // yellow
          orange: { brand: '#ff9e64', contrast: '#16161e' }, // orange
          red: { brand: '#f7768e', contrast: '#16161e' }, // red
          magenta: { brand: '#bb9af7', contrast: '#16161e' }, // magenta
          purple: { brand: ['#a685e2', '#9d7cd8'], contrast: '#16161e' }, // purple, L 0.655→0.685
        },
        channels: {
          dev: { brand: '#e08b2f', contrast: '#1b1205' },
          beta: { brand: ['#818cfe', '#7983f4'], contrast: '#06080b' }, // L 0.655→0.684
          nightly: { brand: ['#a280fd', '#9d7bf8'], contrast: '#06080b' }, // L 0.672→0.687
        },
      },
      {
        id: 'storm',
        label: 'Storm',
        mode: 'dark',
        roles: {
          '--k-bg': '#1f2335', // bg_dark
          '--k-panel': '#24283b', // bg
          '--k-panel-raised': '#292e42', // bg_highlight
          '--k-line': '#3b4261', // fg_gutter
          '--k-line-strong': '#545c7e', // dark3
          '--k-text': '#c0caf5', // fg
          '--k-text-muted': '#a9b1d6', // fg_dark
          '--k-text-faint': ['#8c94bd', '#737aa2'], // Tokyo Night dark5 #737aa2, OKLCH L 0.589→0.675: faint text AA on page, panel and raised panel
          '--k-status-contrast': '#1f2335', // bg_dark
          '--k-positive': '#9ece6a', // green
          '--k-caution': '#e0af68', // yellow
          '--k-negative': '#f7768e', // red
          '--k-active': '#7aa2f7', // blue
        },
        variables: {
          '--error-bg': '#463448', // red 16% into bg
          '--error-border': '#684156', // red 32% into bg
          '--error-text': ['#fc7b93', '#f7768e'], // Tokyo Night red #f7768e, OKLCH L 0.723→0.738: self-tint
          '--success-bg': '#384343', // green 16% into bg
          '--success-border': '#4b5d4a', // green 32% into bg
          '--success-text': '#9ece6a', // green
          '--warning-bg': '#423e42', // yellow 16% into bg
          '--warning-border': '#605349', // yellow 32% into bg
          '--warning-text': '#e0af68', // yellow
          '--warning-primary': '#ff9e64', // orange
          '--health-success': '#9ece6a', // green
          '--health-error': '#f7768e', // red
          '--health-warning': '#e0af68', // yellow
          '--event-agent-start': '#7aa2f7', // blue
          '--event-agent-complete': '#9d7cd8', // purple
          '--event-tool-call': '#ff9e64', // orange
          '--event-tool-result': '#9ece6a', // green
          '--event-agent-health': '#7dcfff', // cyan
          '--event-planning': '#bb9af7', // magenta
          '--event-reasoning': '#bb9af7', // magenta
          '--series-1': '#9d7cd8', // purple
          '--series-2': '#e0af68', // yellow
          '--series-3': '#9ece6a', // green
          '--series-4': '#7dcfff', // cyan
          '--series-5': '#bb9af7', // magenta
          '--series-6': '#ff9e64', // orange
          '--meter-low': '#9ece6a', // green
          '--meter-mid': '#e0af68', // yellow
          '--meter-high': '#f7768e', // red
          '--syntax-keyword': '#bb9af7', // magenta
          '--syntax-number': '#ff9e64', // orange
          '--syntax-string': '#9ece6a', // green
          '--syntax-function': '#7aa2f7', // blue
          '--syntax-tag': ['#fc7b93', '#f7768e'], // Tokyo Night red #f7768e, OKLCH L 0.723→0.738: code text AA on page, panel and every accent’s selected-line tint
          '--syntax-variable': '#e0af68', // yellow
          '--accent-yellow': '#e0af68', // yellow
          '--accent-yellow-text': '#e0af68', // yellow
          '--text-disabled': ['#6d7699', '#545c7e'], // Tokyo Night dark3 #545c7e, OKLCH L 0.482→0.572: inactive text 3:1 on page and raised panel
          '--text-subtle': ['#8c94bd', '#737aa2'], // Tokyo Night dark5 #737aa2, OKLCH L 0.589→0.675: placeholder text AA on the input, raised panel and hover surfaces
        },
        // Brand, action and focus share the accent; contrast is the text on its fill.
        accents: {
          blue: { brand: '#7aa2f7', contrast: '#1f2335' }, // blue
          cyan: { brand: '#7dcfff', contrast: '#1f2335' }, // cyan
          teal: { brand: '#1abc9c', contrast: '#1f2335' }, // teal
          green: { brand: '#9ece6a', contrast: '#1f2335' }, // green
          yellow: { brand: '#e0af68', contrast: '#1f2335' }, // yellow
          orange: { brand: '#ff9e64', contrast: '#1f2335' }, // orange
          red: { brand: '#f7768e', contrast: '#1f2335' }, // red
          magenta: { brand: '#bb9af7', contrast: '#1f2335' }, // magenta
          purple: { brand: ['#a685e2', '#9d7cd8'], contrast: '#1f2335' }, // purple, L 0.655→0.685
        },
        channels: {
          dev: { brand: '#e08b2f', contrast: '#1b1205' },
          beta: { brand: ['#818cfe', '#7983f4'], contrast: '#06080b' }, // L 0.655→0.684
          nightly: { brand: ['#a280fd', '#9d7bf8'], contrast: '#06080b' }, // L 0.672→0.687
        },
      },
    ],
  },
];

/** A resolved accent (or channel) pair: brand/action/focus fill and its text. */
export interface ColorThemeAccentValue {
  readonly brand: string;
  readonly contrast: string;
}

export interface ColorThemeFlavor {
  readonly id: string;
  readonly label: string;
  readonly mode: ColorThemeMode;
  readonly roles: Readonly<Record<ColorThemeRoleProperty, string>>;
  readonly variables: Readonly<Record<ColorThemeVariableProperty, string>>;
  readonly accents: Readonly<Record<string, ColorThemeAccentValue>>;
  readonly channels: Readonly<Record<ColorThemeChannel, ColorThemeAccentValue>>;
}

export interface ColorThemeFamily {
  readonly id: Exclude<ColorThemeId, 'station'>;
  readonly label: string;
  readonly source: string;
  readonly defaultDarkFlavor: string;
  readonly defaultAccent: string;
  readonly accents: readonly { readonly id: string; readonly label: string }[];
  readonly light: ColorThemeFlavor;
  readonly dark: readonly ColorThemeFlavor[];
}

/** One `[adjusted, official]` entry, for the contrast test's provenance checks. */
export interface ColorThemeAdjustment {
  readonly family: string;
  readonly flavor: string;
  /** A role or variable property, `accent:<id>` or `channel:<id>`. */
  readonly slot: string;
  readonly value: string;
  readonly official: string;
}

const adjustments: ColorThemeAdjustment[] = [];

function color(
  family: string,
  flavor: string,
  slot: string,
  value: CatalogColor,
): string {
  if (typeof value === 'string') return value;
  const [adjusted, official] = value;
  adjustments.push({ family, flavor, slot, value: adjusted, official });
  return adjusted;
}

function resolveFlavor(family: string, raw: CatalogFlavor): ColorThemeFlavor {
  const map = <K extends string>(
    values: Record<K, CatalogColor>,
  ): Readonly<Record<K, string>> =>
    Object.freeze(
      Object.fromEntries(
        Object.entries<CatalogColor>(values).map(([key, value]) => [
          key,
          color(family, raw.id, key, value),
        ]),
      ) as Record<K, string>,
    );
  const pairs = <K extends string>(
    kind: string,
    values: Record<K, CatalogPair>,
  ): Readonly<Record<K, ColorThemeAccentValue>> =>
    Object.freeze(
      Object.fromEntries(
        Object.entries<CatalogPair>(values).map(([key, pair]) => [
          key,
          Object.freeze({
            brand: color(family, raw.id, `${kind}:${key}`, pair.brand),
            contrast: pair.contrast,
          }),
        ]),
      ) as Record<K, ColorThemeAccentValue>,
    );
  return Object.freeze({
    id: raw.id,
    label: raw.label,
    mode: raw.mode,
    roles: map(raw.roles),
    variables: map(raw.variables),
    accents: pairs('accent', raw.accents),
    channels: pairs('channel', raw.channels),
  });
}

/** Every non-default family, in picker order. */
export const COLOR_THEME_FAMILIES: readonly ColorThemeFamily[] = Object.freeze(
  CATALOG.map((family) =>
    Object.freeze({
      id: family.id,
      label: family.label,
      source: family.source,
      defaultDarkFlavor: family.defaultDarkFlavor,
      defaultAccent: family.defaultAccent,
      accents: Object.freeze(
        family.accents.map((a) => Object.freeze({ ...a })),
      ),
      light: resolveFlavor(family.id, family.light),
      dark: Object.freeze(family.dark.map((d) => resolveFlavor(family.id, d))),
    }),
  ),
);

export const COLOR_THEME_ADJUSTMENTS: readonly ColorThemeAdjustment[] =
  Object.freeze(adjustments);
