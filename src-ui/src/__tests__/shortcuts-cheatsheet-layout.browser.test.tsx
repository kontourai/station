import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

// The production cheatsheet with enough registered shortcuts to overflow a
// phone-height panel, as the app registers on any real page.
const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {DialogHistoryHostBoundary} from './src-ui/src/components/DialogHistoryHost';
import {KeyboardShortcutsProvider} from './src-ui/src/contexts/KeyboardShortcutsContext';
import {useKeyboardShortcut} from './src-ui/src/hooks/useKeyboardShortcut';
import {ShortcutsCheatsheet} from './src-ui/src/components/ShortcutsCheatsheet';
function One({index}) {
  useKeyboardShortcut('dock.fixture' + index, String.fromCharCode(97 + (index % 26)),
    index < 26 ? ['cmd'] : ['cmd','shift'], 'Fixture command ' + index, () => {});
  return null;
}
function Host() {
  return <>
    <main><p>Page text that must not show through the dialog.</p></main>
    {Array.from({length: 36}, (_, i) => <One key={i} index={i} />)}
    <ShortcutsCheatsheet isOpen onClose={() => {}} />
  </>;
}
createRoot(document.getElementById('root')).render(
  <DialogHistoryHostBoundary><KeyboardShortcutsProvider><Host/></KeyboardShortcutsProvider></DialogHistoryHostBoundary>);
`;

// #4384: the panel computed to a transparent background, its × sat under the
// title, and the end of the list was cut off.
test('the shortcuts cheatsheet is an opaque framed dialog with a reachable close and a scrolling list', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(fixture);
  try {
    await page.addStyleTag({
      content: resolveCssImports(resolve(import.meta.dirname, '../index.css')),
    });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (value) => document.documentElement.setAttribute('data-theme', value),
        theme,
      );
      for (const [width, height] of [
        [1280, 800],
        [390, 844],
      ]) {
        await page.setViewportSize({ width, height });
        const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
        await dialog.getByText('Fixture command 35').waitFor({
          state: 'attached',
        });
        await page.evaluate(() =>
          Promise.all(document.getAnimations().map((a) => a.finished)),
        );
        const geometry = await dialog.evaluate((panel) => {
          const rect = (el: Element | null) => el?.getBoundingClientRect();
          const title = panel.querySelector('h2');
          const close = panel.querySelector(
            'button[aria-label="Close keyboard shortcuts"]',
          );
          const rows = panel.querySelectorAll('.shortcuts-cheatsheet__row');
          const scroller = rows[0]?.closest('.station-dialog__body');
          return {
            background: getComputedStyle(panel).backgroundColor,
            panel: rect(panel)?.toJSON(),
            title: rect(title)?.toJSON(),
            close: rect(close)?.toJSON(),
            scrollable: scroller
              ? scroller.scrollHeight > scroller.clientHeight &&
                ['auto', 'scroll'].includes(
                  getComputedStyle(scroller).overflowY,
                )
              : false,
          };
        });
        const label = `${theme} ${width}px`;
        expect(geometry.background, label).not.toBe('rgba(0, 0, 0, 0)');
        expect(geometry.background, label).toMatch(/^rgb\(/);
        // The × is inside the panel and beside the title, not under it.
        const { panel, title, close } = geometry;
        expect(close.left, label).toBeGreaterThanOrEqual(panel.left);
        expect(close.right, label).toBeLessThanOrEqual(panel.right);
        expect(close.top, label).toBeGreaterThanOrEqual(panel.top);
        expect(close.left, label).toBeGreaterThanOrEqual(title.right);
        expect(close.top, label).toBeLessThan(title.bottom);
        // The panel fits the viewport and the list scrolls inside it.
        expect(panel.bottom, label).toBeLessThanOrEqual(height);
        expect(geometry.scrollable, label).toBe(true);
        const last = dialog.getByText('Fixture command 35');
        await last.scrollIntoViewIfNeeded();
        const lastBox = await last.boundingBox();
        expect(lastBox, label).not.toBeNull();
        // The sheet settles its height to the viewport after a resize, so
        // the bound is the panel as it stands once the row is in view.
        const settledBottom = await dialog.evaluate(
          (element) => element.getBoundingClientRect().bottom,
        );
        expect(settledBottom, label).toBeLessThanOrEqual(height);
        expect(lastBox!.y + lastBox!.height, label).toBeLessThanOrEqual(
          settledBottom,
        );
      }
    }
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

const settingsFixture = `
import React, { useState } from 'react';
import {createRoot} from 'react-dom/client';
import {DialogHistoryHostBoundary} from './src-ui/src/components/DialogHistoryHost';
import {ResponsiveDialogSurface} from './src-ui/src/components/ResponsiveDialogSurface';
import {KeyboardShortcutsProvider, setShortcutContext} from './src-ui/src/contexts/KeyboardShortcutsContext';
import {useKeyboardShortcut} from './src-ui/src/hooks/useKeyboardShortcut';
import {KeyboardShortcutsSection} from './src-ui/src/views/settings/KeyboardShortcutsSection';
function Host() {
  const [runs, setRuns] = useState(0);
  const [modal, setModal] = useState(false);
  useKeyboardShortcut('app.preview', 'g', ['ctrl'], 'Preview note', () => setRuns((count) => count + 1), true, 0, 'composerFocused');
  return <main>
    <textarea aria-label="Composer" onFocus={() => setShortcutContext('composerFocused', true)} onBlur={() => setShortcutContext('composerFocused', false)} />
    <output aria-label="Preview invocations">{runs}</output>
    <button onClick={() => setModal(true)}>Open dialog</button>
    <KeyboardShortcutsSection />
    {modal && <ResponsiveDialogSurface layer="dialog" ariaLabel="Preview dialog" onClose={() => setModal(false)}>
      <textarea aria-label="Modal composer" onFocus={() => setShortcutContext('composerFocused', true)} onBlur={() => setShortcutContext('composerFocused', false)} />
      <button onClick={() => setModal(false)}>Close preview dialog</button>
    </ResponsiveDialogSurface>}
  </main>;
}
createRoot(document.getElementById('root')).render(
  <DialogHistoryHostBoundary><KeyboardShortcutsProvider><Host/></KeyboardShortcutsProvider></DialogHistoryHostBoundary>);
`;

test('shortcut settings captures Space, reloads the binding, and honors the registered focus rule', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(
    settingsFixture,
    [],
    { viewport: { width: 1440, height: 900 } },
  );
  try {
    const composer = page.getByRole('textbox', { name: 'Composer' });
    const binding = page.getByRole('button', {
      name: 'Shortcut for Preview note',
    });
    const runs = page.getByRole('status', { name: 'Preview invocations' });
    await composer.focus();
    await page.keyboard.press('Control+g');
    await expect.poll(() => runs.textContent()).toBe('1');
    await binding.click();
    await page.keyboard.press('Control+Space');
    await expect.poll(() => binding.textContent()).toMatch(/Space$/);
    expect(await runs.textContent()).toBe('1');

    await page.reload();
    for (const path of [
      '../index.css',
      '../views/settings/KeyboardShortcutsSection.css',
    ]) {
      await page.addStyleTag({
        content: resolveCssImports(resolve(import.meta.dirname, path)),
      });
    }
    await expect.poll(() => binding.textContent()).toMatch(/Space$/);
    const advanced = page.locator('summary', { hasText: 'Advanced' });
    await advanced.click();
    await page
      .getByText('"composerFocused"', { exact: true })
      .waitFor({ state: 'visible' });
    await page.keyboard.press('Control+Space');
    expect(await runs.textContent()).toBe('0');
    await composer.focus();
    await page.keyboard.press('Control+Space');
    await expect.poll(() => runs.textContent()).toBe('1');

    await page.getByRole('button', { name: 'Open dialog' }).click();
    const dialog = page.getByRole('dialog', { name: 'Preview dialog' });
    await dialog.getByRole('textbox', { name: 'Modal composer' }).focus();
    await page.keyboard.press('Control+Space');
    expect(await runs.textContent()).toBe('1');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });

    if (
      !(await advanced.evaluate((summary) =>
        summary.parentElement?.hasAttribute('open'),
      ))
    )
      await advanced.click();
    for (const width of [1440, 390]) {
      const mobile = width === 390;
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(() => binding.isDisabled()).toBe(mobile);
      for (const theme of ['light', 'dark']) {
        await page.evaluate(
          (value) => document.documentElement.setAttribute('data-theme', value),
          theme,
        );
        expect(await binding.isVisible()).toBe(true);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBeLessThanOrEqual(width);
        const captureDir = process.env.STATION_SHORTCUT_REVIEW_CAPTURE_DIR;
        if (captureDir)
          await page.screenshot({
            path: resolve(
              captureDir,
              'shortcuts-' + width + '-' + theme + '.png',
            ),
          });
      }
    }
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
