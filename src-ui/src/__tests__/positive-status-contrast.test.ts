import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { contrastRatio } from '../lib/accent-contrast';

const STATION_CSS = readFileSync(
  resolve(process.cwd(), 'src-ui/src/index.css'),
  'utf8',
);
const KIT_TOKENS = readFileSync(
  resolve(process.cwd(), 'node_modules/@kontourai/ui/tokens/tokens.css'),
  'utf8',
);

type Theme = 'dark' | 'light';
type Channel = 'default' | 'beta' | 'nightly';
type Tone = 'positive' | 'caution' | 'negative' | 'active';

const THEMES: Theme[] = ['dark', 'light'];
const CHANNELS: Channel[] = ['default', 'beta', 'nightly'];

function hexValues(source: string, token: string): string[] {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...source.matchAll(new RegExp(`${escaped}:\\s*(#[0-9a-f]{6})`, 'gi'))]
    .map((match) => match[1])
    .filter((value): value is string => Boolean(value));
}

/**
 * The kit's own block for a mode, selected by its selector. Occurrence order
 * is not a contract: @kontourai/ui 1.17 added a dark-island block
 * (`[data-theme="dark"]:where([data-theme="light"] *)`) between `:root` and
 * the light block, so "the second occurrence" of a token became a dark value.
 */
function kitBlock(theme: Theme): string {
  const selector = theme === 'dark' ? ':root {' : '[data-theme="light"] {';
  // At the start of a line, so a longer selector ending the same way (or the
  // dark-island selector, which contains the light one) cannot match.
  const start = KIT_TOKENS.search(
    new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm'),
  );
  if (start < 0) throw new Error(`kit tokens have no "${selector}" block`);
  return KIT_TOKENS.slice(start, KIT_TOKENS.indexOf('\n}', start));
}

function themedHex(source: string, token: string, theme: Theme): string {
  if (source === KIT_TOKENS) {
    const [value] = hexValues(kitBlock(theme), token);
    if (!value) throw new Error(`kit ${theme} block does not set ${token}`);
    return value;
  }
  // Station's index.css declares each of these once per mode, dark first.
  const values = hexValues(source, token);
  return values[theme === 'dark' ? 0 : 1]!;
}

const TONES: Record<
  Tone,
  {
    oldFill: string;
    background: [source: string, token: string];
    foreground: [source: string, token: string];
    border: string;
  }
> = {
  positive: {
    oldFill: '--k-positive',
    background: [STATION_CSS, '--success-bg'],
    foreground: [STATION_CSS, '--success-text'],
    border: '--success-border',
  },
  caution: {
    oldFill: '--k-caution',
    background: [STATION_CSS, '--warning-bg'],
    foreground: [STATION_CSS, '--warning-text'],
    border: '--warning-border',
  },
  negative: {
    oldFill: '--k-negative',
    background: [STATION_CSS, '--error-bg'],
    foreground: [STATION_CSS, '--error-text'],
    border: '--error-border',
  },
  active: {
    oldFill: '--k-active',
    background: [KIT_TOKENS, '--k-panel-raised'],
    foreground: [KIT_TOKENS, '--k-text'],
    border: '--k-active',
  },
};

function oldForeground(channel: Channel, theme: Theme): string {
  if (channel === 'default') {
    return themedHex(KIT_TOKENS, '--k-brand-contrast', theme);
  }
  // A channel's light block wins in light mode when it sets the token;
  // otherwise its base block applies to both modes.
  const block = (suffix: string) =>
    STATION_CSS.match(
      new RegExp(
        `:root\\[data-app-channel="${channel}"\\]${suffix}\\s*{[^}]*--k-brand-contrast:\\s*(#[0-9a-f]{6})`,
        'i',
      ),
    )?.[1];
  return (
    (theme === 'light' ? block('\\[data-theme="light"\\]') : undefined) ??
    block('') ??
    ''
  );
}

describe('StatusBadge tone contrast (station#923)', () => {
  test('pins the vendored filled-tone regression across every channel and theme', () => {
    // This intentionally pins the VENDORED kit values. If the kit fixes its
    // own filled-tone contract, this tripwire should red so Station can remove
    // or reconsider its overrides—not be silenced by bumping these numbers.
    const expected: Record<Tone, Record<Channel, [number, number]>> = {
      positive: {
        default: [10.43, 4.81],
        beta: [10.43, 4.81],
        nightly: [10.43, 4.81],
      },
      caution: {
        default: [10.7, 5.93],
        beta: [10.7, 5.93],
        nightly: [10.7, 5.93],
      },
      negative: {
        default: [7.4, 5.07],
        beta: [7.4, 5.07],
        nightly: [7.4, 5.07],
      },
      active: {
        default: [8.06, 4.71],
        beta: [8.06, 4.71],
        nightly: [8.06, 4.71],
      },
    };

    for (const [tone, config] of Object.entries(TONES) as [
      Tone,
      (typeof TONES)[Tone],
    ][]) {
      for (const channel of CHANNELS) {
        for (const [themeIndex, theme] of THEMES.entries()) {
          const ratio = contrastRatio(
            themedHex(KIT_TOKENS, config.oldFill, theme),
            oldForeground(channel, theme),
          );
          expect(ratio, `${tone}/${channel}/${theme}`).toBeCloseTo(
            expected[tone][channel][themeIndex]!,
            2,
          );
        }
      }
    }
  });

  test('all four quiet treatments clear AA in every channel and theme', () => {
    // Every pair below clears AA in both modes, so a reader that returned the
    // dark block for light would pass unnoticed (it did, for the kit-backed
    // active tone, after @kontourai/ui 1.17). The modes must really differ.
    for (const [source, token] of Object.values(TONES).map(
      ({ background }) => background,
    )) {
      expect(themedHex(source, token, 'light'), token).not.toBe(
        themedHex(source, token, 'dark'),
      );
    }

    // The a11y render ratchet only exercises the DEFAULT channel. Its dark
    // --k-brand-contrast is near-black, so filled tones passed there while the
    // beta/nightly white override failed for owners. Keep channels explicit.
    for (const [tone, config] of Object.entries(TONES) as [
      Tone,
      (typeof TONES)[Tone],
    ][]) {
      const rule = STATION_CSS.match(
        new RegExp(`\\.tone-${tone}\\s*{[^}]+}`),
      )?.[0];
      expect(rule).toContain(`background: var(${config.background[1]})`);
      expect(rule).toContain(`color: var(${config.foreground[1]})`);
      expect(rule).toContain(`border-color: var(${config.border})`);

      for (const channel of CHANNELS) {
        for (const theme of THEMES) {
          const ratio = contrastRatio(
            themedHex(config.background[0], config.background[1], theme),
            themedHex(config.foreground[0], config.foreground[1], theme),
          );
          expect(ratio, `${tone}/${channel}/${theme}`).toBeGreaterThanOrEqual(
            4.5,
          );
        }
      }
    }
  });
});
