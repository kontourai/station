import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../tests/helpers/css-cascade-fixture';
import {
  checkModeOverrides,
  hexContrast,
  SHIPPED_MODE_TOKENS,
} from '../lib/branding-theme';

/**
 * Station reads the interaction roles with a brand fallback
 * (`var(--k-action, var(--k-brand))`, `var(--k-focus, …)`), so the same
 * stylesheet renders identically on @kontourai/ui 1.12 (no roles) and follows
 * the roles once they exist. Only a real cascade can show which declaration
 * wins, so this measures computed values in Chromium against the real
 * index.css — with the roles absent, with them defined the way the 1.14
 * tokens define them, and under every release channel.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

/** What @kontourai/ui 1.14 adds: literal roles equal to the shipped brand. */
const VENDOR_ROLES_SHIM = `
:root { --k-action: #5ce0c6; --k-action-contrast: #06080b; --k-focus: #5ce0c6; --k-focus-ring: var(--k-focus); }
[data-theme="light"] { --k-action: #0e7c64; --k-action-contrast: #ffffff; --k-focus: #0e7c64; --k-focus-ring: var(--k-focus); }
`;

type Mode = 'dark' | 'light';
type Channel = 'release' | 'dev' | 'beta' | 'nightly';

interface Measured {
  accent: string;
  onAccent: string;
  action: string;
  actionContrast: string;
  focus: string;
  outline: string;
  focused: boolean;
}

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
    options: { vendorRoles?: boolean; inline?: Record<string, string> } = {},
  ): Promise<Measured> {
    const page = await browser.newPage();
    try {
      const shim = options.vendorRoles
        ? `<style>${VENDOR_ROLES_SHIM}</style>`
        : '';
      await page.setContent(
        `<!doctype html><html data-theme="${mode}"><head>${shim}<style>${css}</style></head><body><button type="button" id="probe">probe</button></body></html>`,
      );
      await page.evaluate(
        ({ channel, inline }) => {
          const root = document.documentElement;
          if (channel === 'dev') root.classList.add('is-dev-build');
          else if (channel !== 'release') root.dataset.appChannel = channel;
          for (const [name, value] of Object.entries(inline ?? {}))
            root.style.setProperty(name, value);
        },
        { channel, inline: options.inline },
      );
      // Keyboard focus, so the product-level :focus-visible rule applies.
      await page.keyboard.press('Tab');
      const measured: Measured = await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        const read = (name: string) => style.getPropertyValue(name).trim();
        const probe = document.getElementById('probe')!;
        return {
          accent: read('--accent-primary'),
          onAccent: read('--text-on-accent'),
          action: read('--k-action'),
          actionContrast: read('--k-action-contrast'),
          focus: read('--k-focus'),
          outline: getComputedStyle(probe).outlineColor,
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
    'with no roles defined (ui 1.12), %s mode falls back to the shipped brand',
    async (mode) => {
      const m = await measure(mode, 'release');
      expect(m.action).toBe('');
      expect(toHex(m.accent)).toBe(SHIPPED_MODE_TOKENS[mode].brand);
      expect(toHex(m.onAccent)).toBe(SHIPPED_MODE_TOKENS[mode].brandContrast);
      expect(toHex(m.outline)).toBe(SHIPPED_MODE_TOKENS[mode].brand);
    },
  );

  test.each(['dark', 'light'] as const)(
    'with the roles defined, %s mode reads them instead of the brand',
    async (mode) => {
      const m = await measure(mode, 'release', {
        vendorRoles: true,
        inline: {
          '--k-action': '#123456',
          '--k-action-contrast': '#fedcba',
          '--k-focus': '#abcdef',
        },
      });
      expect(toHex(m.accent)).toBe('#123456');
      expect(toHex(m.onAccent)).toBe('#fedcba');
      expect(toHex(m.outline)).toBe('#abcdef');
    },
  );

  test.each(['dark', 'light'] as const)(
    'the shipped roles leave %s mode unchanged',
    async (mode) => {
      const before = await measure(mode, 'release');
      const after = await measure(mode, 'release', { vendorRoles: true });
      expect(toHex(after.accent)).toBe(toHex(before.accent));
      expect(toHex(after.onAccent)).toBe(toHex(before.onAccent));
      expect(toHex(after.outline)).toBe(toHex(before.outline));
    },
  );

  const channels = (['dev', 'beta', 'nightly'] as const).flatMap((channel) =>
    (['dark', 'light'] as const).flatMap((mode) =>
      [false, true].map((vendorRoles) => [channel, mode, vendorRoles] as const),
    ),
  );

  test.each(channels)(
    'the %s channel in %s mode (vendor roles: %s) drives action and focus with readable values',
    async (channel, mode, vendorRoles) => {
      const m = await measure(mode, channel, { vendorRoles });
      const action = toHex(m.action);
      const actionContrast = toHex(m.actionContrast);
      const focus = toHex(m.focus);
      // The channel, not the release accent or the vendor default, paints
      // buttons and focus — with or without the vendor roles present.
      expect(action).not.toBe(SHIPPED_MODE_TOKENS[mode].brand);
      expect(toHex(m.accent)).toBe(action);
      expect(toHex(m.onAccent)).toBe(actionContrast);
      expect(toHex(m.outline)).toBe(focus);
      // The same rules a white-label theme must pass.
      const check = checkModeOverrides(mode, {
        '--k-action': action,
        '--k-action-contrast': actionContrast,
        '--k-focus': focus,
      });
      expect(check.violations).toEqual([]);
      expect(hexContrast(action, actionContrast)).toBeGreaterThanOrEqual(4.5);
    },
  );
});
