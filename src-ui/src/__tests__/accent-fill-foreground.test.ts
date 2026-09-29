import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
// The gate's own reading of what an accent fill is. Importing it rather than
// re-deriving here is the point: a second detector beside it would eventually
// disagree about which rules are in scope, and the disagreement would be
// invisible — each side would be green about a different set.
import {
  discoverAccentFilledRules,
  discoverAccentForegroundOffenders,
} from '../../../scripts/accent-foreground-ratchet.mjs';
import {
  accentContrastColor,
  accentHoverFill,
  contrastRatio,
} from '../lib/accent-contrast';
import { ACCENT_PRESETS } from '../views/settings/AccentColorPicker';

/**
 * archive#3392. A control filled with the accent and painted with a foreground
 * that is not derived FROM that accent is a colour pair nothing computes. On
 * the shipped dark brand (`#5ce0c6`) white measures 1.62:1; `--text-on-accent`,
 * the brand's own declared contrast partner, measures 12.35:1.
 *
 * `scripts/accent-foreground-ratchet.mjs` blocks a NEW one. This measures the
 * migrated ones: every rule the same detector reports as consuming the derived
 * partner is resolved the way the runtime resolves it and checked against its
 * fill, for every shipped preset. There is no hand-maintained selector list —
 * a list of 53 would rot, and a control dropping out of it would read as
 * "covered" while nothing measured it.
 */
const INDEX_CSS = readFileSync(
  resolve(__dirname, '../index.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * The custom properties index.css declares for one shipped theme, in source
 * order, so a later declaration wins as it does in the cascade. The yellow
 * pair is read from the stylesheet rather than restated here: a copied hex
 * would stay green while the shipped token drifted below AA.
 */
function themeTokens(theme: 'dark' | 'light'): Map<string, string> {
  const selector = `[data-theme="${theme}"]`;
  const tokens = new Map<string, string>();
  for (const [, selectors, body] of INDEX_CSS.matchAll(
    /([^{}]+)\{([^{}]*)\}/g,
  )) {
    const list = selectors.split(',').map((entry) => entry.trim());
    if (!list.includes(selector)) continue;
    for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      tokens.set(name, value.trim());
    }
  }
  return tokens;
}

function resolveToken(
  tokens: Map<string, string>,
  name: string,
  seen: string[] = [],
): string | undefined {
  const value = tokens.get(name);
  const alias = value?.match(/^var\((--[\w-]+)\)$/)?.[1];
  if (!alias) return value;
  if (seen.includes(alias)) return undefined;
  return resolveToken(tokens, alias, [...seen, name]);
}

const rules = discoverAccentFilledRules();
const derived = rules.filter((rule) => rule.derived);

describe('accent-filled controls take their fill’s own foreground', () => {
  test('the detector reads real rules, so a green result is not an empty scan', () => {
    expect(rules.length).toBeGreaterThan(40);
    expect(derived.length).toBeGreaterThan(40);
    // The gate and this test must be looking at the same population.
    expect(rules.length - derived.length).toBe(
      discoverAccentForegroundOffenders().length,
    );
  });

  test('every accent-filled control clears AA for every shipped preset', () => {
    const failures: string[] = [];
    for (const rule of derived.filter((entry) => entry.fill === 'accent')) {
      for (const preset of ACCENT_PRESETS) {
        // `--accent-hover-fill` is what the fill becomes on hover; the
        // foreground does not change with it, which is the whole reason the
        // fill is the side that has to move.
        const fill =
          rule.fillToken === '--accent-hover-fill'
            ? accentHoverFill(preset)
            : preset;
        const foreground = accentContrastColor(preset);
        const ratio =
          fill && foreground ? contrastRatio(fill, foreground) : null;
        if ((ratio ?? 0) < 4.5) {
          failures.push(
            `${rule.path} ${rule.selector}: ${rule.fillToken} (${fill}) on ${foreground} = ${ratio}`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });

  test('every yellow-filled control clears AA in both shipped themes', () => {
    const yellow = derived.filter((rule) => rule.fill === 'yellow');
    // The remaining first-run coachmark consumes this token. Keep a non-empty
    // population assertion so the contrast loop cannot turn vacuously green
    // when that control changes or leaves the shipped surface.
    expect(yellow.length).toBeGreaterThanOrEqual(1);
    for (const theme of ['dark', 'light'] as const) {
      const tokens = themeTokens(theme);
      const foreground = resolveToken(tokens, '--text-on-accent-yellow');
      for (const rule of yellow) {
        const fill = resolveToken(tokens, rule.fillToken);
        const ratio =
          fill && foreground ? contrastRatio(fill, foreground) : null;
        expect(
          ratio ?? 0,
          `${rule.selector}: ${theme} ${rule.fillToken} ${fill} on --text-on-accent-yellow ${foreground}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test('white on a shipped accent is what this prevents, and it does fail', () => {
    // The negative control. Without it, the assertions above would pass for a
    // threshold that nothing can breach.
    const worst = Math.min(
      ...ACCENT_PRESETS.map((preset) => contrastRatio(preset, '#ffffff') ?? 21),
    );
    expect(worst).toBeLessThan(4.5);
  });
});
