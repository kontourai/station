import { resolve } from 'node:path';
import { contrastRatio, SHIPPED_THEMES } from '@kontourai/ui/contrast';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../tests/helpers/css-cascade-fixture';
import {
  BRANDING_BASE_THEME,
  BRANDING_FOCUS_ATTRIBUTE,
  resolveBrandingTheme,
} from '../lib/branding-theme';

/**
 * Station paints its accent, accent text and focus ring from the interaction
 * roles (`var(--k-action, …)`, and `--k-focus` when a white-label theme
 * supplies it; otherwise the ring follows the accent), which the installed
 * @kontourai/ui tokens define as literals beside the brand. Only a real
 * cascade can show which declaration wins, so this measures computed values
 * in Chromium against the real index.css (with the installed tokens inlined)
 * for the release build, an inline override, and every release channel.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);
const SHIPPED = SHIPPED_THEMES[BRANDING_BASE_THEME];

type Mode = 'dark' | 'light';
type Channel = 'release' | 'dev' | 'beta' | 'nightly';

interface Measured {
  brand: string;
  brandContrast: string;
  accent: string;
  onAccent: string;
  action: string;
  actionContrast: string;
  focus: string;
  outline: string;
  primaryFill: string;
  focused: boolean;
}

// The kit's buttons transition their fill; the inline role values land after
// load, so a mid-transition colour would be measured without this.
const NO_TRANSITIONS =
  '*,*::before,*::after{transition:none!important;animation:none!important}';

function toHex(color: string): string {
  const value = color.trim().toLowerCase();
  if (value.startsWith('#')) return value;
  const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return value;
  return `#${match
    .slice(1, 4)
    .map((n) => Number(n).toString(16).padStart(2, '0'))
    .join('')}`;
}

describe.skipIf(!chromiumAvailable)('action and focus role cascade', () => {
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  let css: string;

  beforeAll(async () => {
    browser = await chromium.launch();
    css = resolveCssImports(resolve(import.meta.dirname, '../index.css'));
    assertNoImportsSurvive(css);
  });
  afterAll(async () => {
    await browser?.close();
  });

  async function measure(
    mode: Mode,
    channel: Channel,
    options: { inline?: Record<string, string>; themeFocus?: boolean } = {},
  ): Promise<Measured> {
    const page = await browser.newPage();
    try {
      await page.setContent(
        `<!doctype html><html data-theme="${mode}"><head><style>${css}</style><style>${NO_TRANSITIONS}</style></head><body><button type="button" id="probe">probe</button><button type="button" class="btn btn-primary" id="primary">primary</button></body></html>`,
      );
      await page.evaluate(
        ({ channel, inline, focusAttribute }) => {
          const root = document.documentElement;
          if (channel === 'dev') root.classList.add('is-dev-build');
          else if (channel !== 'release') root.dataset.appChannel = channel;
          for (const [name, value] of Object.entries(inline ?? {}))
            root.style.setProperty(name, value);
          // What applyBrandingTheme sets when the theme supplies --k-focus.
          if (focusAttribute) root.setAttribute(focusAttribute, '');
        },
        {
          channel,
          inline: options.inline,
          focusAttribute: options.themeFocus ? BRANDING_FOCUS_ATTRIBUTE : null,
        },
      );
      // Keyboard focus, so the product-level :focus-visible rule applies.
      await page.keyboard.press('Tab');
      const measured: Measured = await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        const read = (name: string) => style.getPropertyValue(name).trim();
        const probe = document.getElementById('probe')!;
        return {
          brand: read('--k-brand'),
          brandContrast: read('--k-brand-contrast'),
          accent: read('--accent-primary'),
          onAccent: read('--text-on-accent'),
          action: read('--k-action'),
          actionContrast: read('--k-action-contrast'),
          focus: read('--k-focus'),
          outline: getComputedStyle(probe).outlineColor,
          primaryFill: getComputedStyle(document.getElementById('primary')!)
            .backgroundColor,
          focused: document.activeElement === probe,
        };
      });
      // The outline is only the focus ring while the probe holds focus.
      expect(measured.focused).toBe(true);
      return measured;
    } finally {
      await page.close();
    }
  }

  test.each(['dark', 'light'] as const)(
    'the release build in %s mode paints the installed roles, which equal the shipped brand',
    async (mode) => {
      const m = await measure(mode, 'release');
      // The roles come from the installed tokens, not the brand fallback...
      expect(toHex(m.action)).toBe(SHIPPED[mode]['--k-action']);
      expect(toHex(m.accent)).toBe(toHex(m.action));
      expect(toHex(m.onAccent)).toBe(SHIPPED[mode]['--k-action-contrast']);
      expect(toHex(m.outline)).toBe(SHIPPED[mode]['--k-focus']);
      // ...and render exactly what the brand fallback rendered before the
      // roles existed, so the release build looks the same.
      expect(toHex(m.accent)).toBe(SHIPPED[mode]['--k-brand']);
      expect(toHex(m.onAccent)).toBe(SHIPPED[mode]['--k-brand-contrast']);
      expect(toHex(m.outline)).toBe(SHIPPED[mode]['--k-brand']);
    },
  );

  test.each(['dark', 'light'] as const)(
    'an inline role override on the root wins in %s mode',
    async (mode) => {
      const m = await measure(mode, 'release', {
        inline: {
          '--k-action': '#123456',
          '--k-action-contrast': '#fedcba',
          '--k-focus': '#abcdef',
        },
        themeFocus: true,
      });
      expect(toHex(m.accent)).toBe('#123456');
      expect(toHex(m.onAccent)).toBe('#fedcba');
      expect(toHex(m.outline)).toBe('#abcdef');
    },
  );

  test.each(['dark', 'light'] as const)(
    'a device accent in %s mode colours the focus ring when no theme sets focus',
    async (mode) => {
      // What the Appearance accent picker writes (lib/accent-contrast.ts).
      // The installed tokens still define --k-focus; it must not win here.
      const m = await measure(mode, 'release', {
        inline: { '--accent-primary': '#d946ef' },
      });
      expect(toHex(m.focus)).toBe(SHIPPED[mode]['--k-focus']);
      expect(toHex(m.accent)).toBe('#d946ef');
      expect(toHex(m.outline)).toBe('#d946ef');
    },
  );

  test.each(['dark', 'light'] as const)(
    "a theme's focus wins over a device accent in %s mode",
    async (mode) => {
      const m = await measure(mode, 'release', {
        inline: { '--accent-primary': '#d946ef', '--k-focus': '#abcdef' },
        themeFocus: true,
      });
      expect(toHex(m.accent)).toBe('#d946ef');
      expect(toHex(m.outline)).toBe('#abcdef');
    },
  );

  test.each(['dark', 'light'] as const)(
    'a brand-only theme in %s mode drives buttons, accent and focus',
    async (mode) => {
      // Before the package defined --k-action, everything read the brand. The
      // resolver expands a brand-only mode into the action role; apply what
      // it accepted, as applyBrandingTheme would.
      const brand = mode === 'dark' ? '#60a5fa' : '#1d4ed8';
      const { overrides, violations } = resolveBrandingTheme({
        [mode]: { '--k-brand': brand },
      });
      expect(violations).toEqual([]);
      const m = await measure(mode, 'release', {
        inline: { ...overrides[mode] },
      });
      expect(toHex(m.brand)).toBe(brand);
      expect(toHex(m.primaryFill)).toBe(brand);
      expect(toHex(m.accent)).toBe(brand);
      expect(toHex(m.outline)).toBe(brand);
    },
  );

  const channels = (['dev', 'beta', 'nightly'] as const).flatMap((channel) =>
    (['dark', 'light'] as const).map((mode) => [channel, mode] as const),
  );

  test.each(channels)(
    'the %s channel in %s mode keeps its focus colour over a device accent',
    async (channel, mode) => {
      const m = await measure(mode, channel, {
        inline: { '--accent-primary': '#d946ef' },
      });
      expect(toHex(m.accent)).toBe('#d946ef');
      expect(toHex(m.outline)).toBe(toHex(m.focus));
      expect(toHex(m.focus)).not.toBe('#d946ef');
    },
  );

  test.each(channels)(
    'the %s channel in %s mode drives brand, action and focus with readable values',
    async (channel, mode) => {
      const m = await measure(mode, channel);
      const action = toHex(m.action);
      const actionContrast = toHex(m.actionContrast);
      const focus = toHex(m.focus);
      // The channel, not the release accent or the vendor default, paints
      // buttons and focus.
      expect(action).not.toBe(SHIPPED[mode]['--k-action']);
      expect(toHex(m.accent)).toBe(action);
      expect(toHex(m.onAccent)).toBe(actionContrast);
      expect(toHex(m.outline)).toBe(focus);
      // The same rules a white-label theme must pass. The brand group covers
      // brand painted as text (the channel badge, the kit's `.eyebrow`) and
      // the brand fill with its own text (#2905).
      const check = resolveBrandingTheme({
        [mode]: {
          '--k-brand': toHex(m.brand),
          '--k-brand-contrast': toHex(m.brandContrast),
          '--k-action': action,
          '--k-action-contrast': actionContrast,
          '--k-focus': focus,
        },
      });
      expect(check.violations).toEqual([]);
      expect(contrastRatio(action, actionContrast)).toBeGreaterThanOrEqual(4.5);
    },
  );
});
