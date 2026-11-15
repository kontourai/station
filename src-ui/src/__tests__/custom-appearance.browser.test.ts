import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { chromiumIsInstalled } from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

/**
 * Custom appearance in Chromium, through the real modules
 * (docs/decisions/custom-appearance.md): the CSS guard on the parsed sheet,
 * the palette over a named color theme, suspension while a real approval
 * dialog is mounted, the keep bar against hostile CSS, and the countdown.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const NORD = readFileSync(
  resolve(REPO_ROOT, 'src-ui/public/color-themes/nord.css'),
  'utf8',
);

const FIXTURE = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { sanitizeCustomCss } from '@/lib/custom-appearance/sanitize-css';
import {
  setActiveCustomAppearance,
  getCustomAppearanceSnapshot,
} from '@/lib/custom-appearance/controller';
import { cancelCustomAppearancePreview, customAppearancePreviewBar, previewCustomAppearance } from '@/lib/custom-appearance/preview';
import { PermissionRequestModal } from '@/components/modals/PermissionRequestModal';

const events = [];
let showApproval = null;
function App() {
  const [open, setOpen] = useState(false);
  showApproval = (value) => flushSync(() => setOpen(value));
  return React.createElement(React.Fragment, null,
    React.createElement('div', { id: 'probe', 'data-surface': 'sidebar' }, 'Probe'),
    open && React.createElement(PermissionRequestModal, {
      request: { pluginName: 'demo', permissions: [] },
      onApprove: () => events.push('approve'),
      onDeny: () => events.push('deny'),
    }),
  );
}
createRoot(document.getElementById('root')).render(React.createElement(App));
const appearance = (css, palette = {}) => ({ version: 1, name: 'Fixture', palette, css });
window.harness = {
  events,
  sanitize: (css) => {
    const { text, stripped } = sanitizeCustomCss(css);
    return { text, stripped };
  },
  setActive: (css, palette) => setActiveCustomAppearance(css === null ? null : appearance(css, palette), 'owner-a'),
  snapshot: () => getCustomAppearanceSnapshot(),
  bar: () => {
    const bar = customAppearancePreviewBar();
    if (!bar) return null;
    const r = bar.keepRect();
    return { reason: bar.keepBlockedReason(), x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width };
  },
  showApproval: (value) => showApproval(value),
  report: (css, palette) => new Promise((resolve) => previewCustomAppearance(appearance(css, palette), {
    fromAgent: true,
    proposalId: 'proposal-1',
    onKeep: () => undefined,
    onDiscard: () => undefined,
    onReport: (report) => {
      cancelCustomAppearancePreview();
      resolve(report);
    },
  })),
  previewPalette: (palette) => previewCustomAppearance(appearance('', palette), {
    fromAgent: true,
    onKeep: () => events.push('keep'),
    onDiscard: () => events.push('discard'),
    onRevert: () => events.push('revert'),
  }),
  preview: (css, seconds = 20) => previewCustomAppearance(appearance(css), {
    fromAgent: true,
    seconds,
    onKeep: () => events.push('keep'),
    onDiscard: () => events.push('discard'),
    onRevert: () => events.push('revert'),
  }),
};
`;

describe('custom appearance in Chromium', () => {
  let browser: Browser;
  let page: Page;
  const fetched: string[] = [];

  beforeAll(async () => {
    if (!chromiumIsInstalled(REPO_ROOT))
      throw new Error(
        'Playwright Chromium is not installed in this worktree; install it with `npm run install:playwright`.',
      );
    const fixture = await scrollBrowserFixture(FIXTURE, [], {
      viewport: { width: 1024, height: 700 },
    });
    browser = fixture.browser;
    page = fixture.page;
    // Anything the CSS tries to load leaves the fixture origin.
    page.on('request', (request) => {
      const url = request.url();
      if (!url.startsWith('http://station.test/')) fetched.push(url);
    });
    await page.route('http://evil.test/**', (route) => route.abort());
    await page.waitForFunction(() => 'harness' in window);
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });

  const probe = (property: string) =>
    page.evaluate(
      (name) =>
        getComputedStyle(document.getElementById('probe')!).getPropertyValue(
          name,
        ),
      property,
    );
  const harness = <T>(fn: string, ...args: unknown[]) =>
    page.evaluate(
      ({ fn, args }) =>
        // biome-ignore lint/suspicious/noExplicitAny: fixture bridge.
        (window as any).harness[fn](...args) as T,
      { fn, args },
    );

  test('the guard drops escaped, obfuscated and indirect fetches and keeps the rest', async () => {
    const hostile = [
      '@import url(http://evil.test/import.css);',
      '@import "http://evil.test/import2.css";',
      '@font-face { font-family: x; src: url(http://evil.test/font.woff2); }',
      '#probe { color: rgb(1, 2, 3); }',
      '#probe { background-image: \\75 rl(http://evil.test/escaped.png); }',
      '#probe { background-image: URL( "http://evil.test/upper.png" ); }',
      '#probe { background: red image-set("http://evil.test/set.png" 1x); }',
      '#probe { background-image: -webkit-image-set(url(http://evil.test/wset.png) 1x); }',
      '#probe { --remote: url(http://evil.test/var.png); background-image: var(--remote); }',
      '#probe { --escaped: \\75rl(http://evil.test/var2.png); }',
      '#probe { background: var(--nothing, url(http://evil.test/fallback.png)) no-repeat; }',
      '@media (min-width: 1px) { #probe { list-style-image: url(http://evil.test/media.png); } }',
      '@supports (display: grid) { #probe { cursor: url(http://evil.test/cursor.png), auto; } }',
      '@keyframes k { from { background-image: url(http://evil.test/frame.png); } }',
      '#probe { & span { background-image: url(http://evil.test/nested.png); } }',
      '@property --p { syntax: "<url>"; inherits: false; initial-value: url(http://evil.test/prop.png); }',
      '#probe { mask-image: url("data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22/>"); border-top: 3px solid rgb(4, 5, 6); }',
    ].join('\n');
    const { text, stripped } = await harness<{
      text: string;
      stripped: { what: string; reason: string }[];
    }>('sanitize', hostile);
    expect(text.toLowerCase()).not.toContain('evil.test');
    expect(text).not.toContain('@import');
    expect(text).not.toContain('@font-face');
    expect(text).not.toContain('@property');
    // What is not a fetch survives.
    expect(text).toContain('rgb(1, 2, 3)');
    expect(text).toContain('data:image/svg+xml');
    expect(stripped.map((s) => s.what)).toEqual(
      expect.arrayContaining([
        '@font-face',
        '@property',
        'background-image',
        '--remote',
        '--escaped',
      ]),
    );

    // The apply path refuses the hostile text outright (the same text check
    // the server runs), and applies the guard's output.
    await harness('setActive', hostile);
    expect(await probe('color')).not.toBe('rgb(1, 2, 3)');
    await harness('setActive', text);
    await page.waitForTimeout(300);
    expect(await probe('color')).toBe('rgb(1, 2, 3)');
    expect(await probe('border-top-color')).toBe('rgb(4, 5, 6)');
    expect(await probe('background-image')).toBe('none');
    expect(fetched.filter((url) => url.includes('evil.test'))).toEqual([]);
    await harness('setActive', null);
  });

  test('the palette applies on top of a named color theme and leaves its other roles alone', async () => {
    await page.addStyleTag({ content: NORD });
    await page.evaluate(() => {
      const root = document.documentElement;
      root.setAttribute('data-theme', 'dark');
      root.setAttribute('data-color-theme', 'nord');
      root.setAttribute('data-color-theme-flavor', 'polar-night');
      root.setAttribute('data-color-theme-accent', 'frost');
    });
    const rootVar = (name: string) =>
      page.evaluate(
        (n) =>
          getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
        name,
      );
    const nordBg = await rootVar('--k-bg');
    const nordPanel = await rootVar('--k-panel');
    expect(nordBg).not.toBe('');
    await harness('setActive', '', {
      dark: { roles: { '--k-bg': '#101418' }, accent: '#7cc4ff' },
      light: { roles: { '--k-bg': '#fafafa' } },
    });
    expect(await rootVar('--k-bg')).toBe('#101418');
    expect(await rootVar('--k-panel')).toBe(nordPanel);
    expect(await rootVar('--k-action')).toBe('#7cc4ff');
    expect(await rootVar('--k-action-contrast')).toBe('#000000');
    await page.evaluate(() =>
      document.documentElement.setAttribute('data-theme', 'light'),
    );
    expect(await rootVar('--k-bg')).toBe('#fafafa');
    await page.evaluate(() =>
      document.documentElement.setAttribute('data-theme', 'dark'),
    );
    await harness('setActive', null);
    expect(await rootVar('--k-bg')).toBe(nordBg);
  });

  test('custom CSS is off while an approval dialog is mounted; the palette stays', async () => {
    await harness('setActive', '#probe { color: rgb(9, 8, 7) !important; }', {
      dark: { roles: { '--k-bg': '#101418' } },
    });
    expect(await probe('color')).toBe('rgb(9, 8, 7)');
    await harness('showApproval', true);
    expect(await page.getByRole('button', { name: 'Approve' }).count()).toBe(1);
    expect(await probe('color')).not.toBe('rgb(9, 8, 7)');
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue('--k-bg')
          .trim(),
      ),
    ).toBe('#101418');
    expect(
      (await harness<{ suspendedForDecision: boolean }>('snapshot'))
        .suspendedForDecision,
    ).toBe(true);
    await harness('showApproval', false);
    expect(await probe('color')).toBe('rgb(9, 8, 7)');
    await harness('setActive', null);
  });

  const host = () => page.locator('station-appearance-preview');
  const keepBox = () => host().boundingBox();
  type Bar = { reason: string | null; x: number; y: number; width: number };
  const bar = () => harness<Bar | null>('bar');
  const lastEvent = () =>
    page.evaluate(() => (window as any).harness.events.slice(-1)[0]);

  test('a transparent overlay over the whole page cannot cover Keep; a real click keeps', async () => {
    await harness(
      'preview',
      'body::after { content: ""; position: fixed; inset: 0; z-index: 2147483647; background: transparent; }',
    );
    const box = await keepBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(40);
    expect(box!.y + box!.height).toBeLessThanOrEqual(701);
    await expect.poll(async () => (await bar())?.reason).toBeNull();
    // A real pointer click at Keep (the shadow root is closed to locators).
    const keep = (await bar())!;
    await page.mouse.click(keep.x, keep.y);
    expect(await lastEvent()).toBe('keep');
    expect(await host().count()).toBe(0);
  });

  test('display:none on everything cannot hide the bar into a kept state: Escape reverts', async () => {
    await harness('preview', '* { display: none !important; }');
    const snapshot = await harness<{ previewing: unknown }>('snapshot');
    expect(snapshot.previewing).not.toBeNull();
    expect((await bar())?.reason).toContain('Keep is off');
    await page.keyboard.press('Escape');
    expect(await lastEvent()).toBe('revert');
    expect(
      (await harness<{ previewing: unknown }>('snapshot')).previewing,
    ).toBeNull();
  });

  test('html{opacity:0} disables Keep with a reason; restyling the host does nothing', async () => {
    await harness(
      'preview',
      'html { opacity: 0 !important; } station-appearance-preview { display: none !important; top: -500px !important; }',
    );
    const box = await keepBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThan(600);
    await expect
      .poll(async () => (await bar())?.reason)
      .toContain('Keep is off');
    // A click on disabled Keep keeps nothing.
    const keep = (await bar())!;
    await page.mouse.click(keep.x, keep.y);
    expect(await harness<{ previewing: unknown }>('snapshot')).toMatchObject({
      previewing: expect.anything(),
    });
    expect(await lastEvent()).not.toBe('keep');
    await page.keyboard.press('Escape');
    expect(await lastEvent()).toBe('revert');
  });

  test('a previewed proposal reports matched hooks, the contrast it changed and what the guard removed', async () => {
    await page.evaluate(() =>
      document.documentElement.setAttribute('data-theme', 'dark'),
    );
    const report = await harness<{
      proposalId: string;
      mode: string;
      hooks: { id: string; matched: number }[];
      contrast: { foreground: string; surface: string; pass: boolean }[];
      stripped: { what: string }[];
    }>(
      'report',
      // @namespace must lead the sheet to parse at all.
      '@namespace svg "http://www.w3.org/2000/svg"; #probe { color: red; } #probe { background-image: url(data:image/png;base64,AAAA); }',
      { dark: { roles: { '--k-bg': '#101418', '--k-text': '#1a1a1a' } } },
    );
    expect(report.proposalId).toBe('proposal-1');
    expect(report.mode).toBe('dark');
    expect(report.hooks.find((h) => h.id === 'sidebar')?.matched).toBe(1);
    expect(report.hooks.find((h) => h.id === 'composer')?.matched).toBe(0);
    // The text it made unreadable is reported; a pair it did not touch is not.
    expect(report.contrast).toContainEqual(
      expect.objectContaining({
        foreground: '--k-text',
        surface: '--k-bg',
        pass: false,
      }),
    );
    expect(
      report.contrast.every(
        (r) =>
          ['--k-text', '--k-bg'].includes(r.foreground) ||
          ['--k-text', '--k-bg'].includes(r.surface),
      ),
    ).toBe(true);
    expect(report.stripped.map((s) => s.what)).toContain('@namespace');
    expect(await host().count()).toBe(0);
  });

  test('the host pseudo-elements cannot draw a fake label over Keep', async () => {
    await harness(
      'preview',
      'station-appearance-preview::after, *::before { content: "Discard (safe)" !important; display: block !important; position: fixed; right: 0; bottom: 0; width: 260px; height: 70px; background: #b00; pointer-events: none; }',
    );
    const pseudo = await page.evaluate(() => {
      const host = document.querySelector('station-appearance-preview')!;
      return [
        getComputedStyle(host, '::after').content,
        getComputedStyle(host, '::before').content,
      ];
    });
    expect(pseudo).toEqual(['none', 'none']);
    await expect.poll(async () => (await bar())?.reason).toBeNull();
    await page.keyboard.press('Escape');
    expect(await lastEvent()).toBe('revert');
  });

  test("Keep is off while an approval holds the preview's CSS back", async () => {
    await harness('showApproval', true);
    await harness('preview', '#probe { color: rgb(5, 5, 5) !important; }');
    expect(await probe('color')).not.toBe('rgb(5, 5, 5)');
    await expect
      .poll(async () => (await bar())?.reason)
      .toContain('approval is open');
    await page.keyboard.press('Escape');
    await harness('showApproval', false);
  });

  test('a preview whose palette makes text unreadable cannot be kept', async () => {
    await page.evaluate(() =>
      document.documentElement.setAttribute('data-theme', 'dark'),
    );
    await harness('previewPalette', {
      dark: { roles: { '--k-bg': '#101418', '--k-text': '#1a1a1a' } },
    });
    await expect
      .poll(async () => (await bar())?.reason)
      .toContain('hard to read');
    await page.keyboard.press('Escape');
  });

  test('a palette unreadable only in the mode not on screen cannot be kept', async () => {
    await page.evaluate(() =>
      document.documentElement.setAttribute('data-theme', 'dark'),
    );
    await harness('previewPalette', {
      light: { roles: { '--k-bg': '#000000' } },
    });
    await expect
      .poll(async () => (await bar())?.reason)
      .toContain('hard to read');
    // Rating the other mode leaves the mode on screen as it was.
    expect(
      await page.evaluate(() =>
        document.documentElement.getAttribute('data-theme'),
      ),
    ).toBe('dark');
    await page.keyboard.press('Escape');
  });

  test('the previewed CSS cannot flip the bar right to left', async () => {
    await harness(
      'preview',
      'station-appearance-preview, :root { direction: rtl !important; }',
    );
    const keep = (await bar())!;
    // Keep stays at the right end of the bar, beside Discard.
    expect(keep.x).toBeGreaterThan(700);
    await page.keyboard.press('Escape');
  });

  test('the report rates the palette over the theme, not what the CSS computes from page content', async () => {
    await page.evaluate(() =>
      document.documentElement.setAttribute('data-theme', 'dark'),
    );
    const report = await harness<{
      contrast: { foreground: string; surface: string; pass: boolean }[];
    }>(
      'report',
      // A content-conditional role: readable only if the CSS were rated.
      ':root:has(#probe) { --k-text: #111111 !important; }',
      { dark: { roles: { '--k-bg': '#0a0a0a', '--k-text': '#f0f0f0' } } },
    );
    expect(
      report.contrast.filter((r) => r.foreground === '--k-text' && !r.pass),
    ).toEqual([]);
  });

  test('the countdown reverts a preview nobody answers', async () => {
    await harness('preview', '#probe { color: rgb(3, 3, 3) !important; }', 2);
    expect(await probe('color')).toBe('rgb(3, 3, 3)');
    await page.waitForTimeout(2600);
    expect(await lastEvent()).toBe('revert');
    expect(await probe('color')).not.toBe('rgb(3, 3, 3)');
    expect(await host().count()).toBe(0);
  });
});
