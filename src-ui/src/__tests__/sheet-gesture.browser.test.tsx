import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

/**
 * The Sheet gestures device preview on a real `ResponsiveDialogSurface`,
 * laid out by the production stylesheet in Chromium at phone width and driven
 * by real pointer input. jsdom has no layout, so it cannot see whether the
 * handle sits on the panel's top edge, whether the panel actually grows to
 * Full, or whether a drag down really calls the consumer's close.
 *
 * The consumer here is a plain bottom sheet: a fixed overlay with the panel
 * docked to its bottom edge, the geometry every shared phone sheet uses.
 */

const fixture = `
  import React, {useState} from 'react';
  import {createRoot} from 'react-dom/client';
  import {deviceSettingsStore} from './src-ui/src/lib/device-settings-store';
  import {ResponsiveDialogSurface} from './src-ui/src/components/ResponsiveDialogSurface';

  const css = document.createElement('style');
  css.textContent = \`
    .fixture-overlay { position: fixed; inset: 0; display: flex;
      flex-direction: column; justify-content: flex-end; }
    .fixture-panel { height: 300px; max-height: 60vh; background: #fff; }
  \`;
  document.head.append(css);

  function App() {
    const params = new URLSearchParams(location.hash.slice(1));
    const [open, setOpen] = useState(true);
    const [closes, setCloses] = useState(0);
    const refuse = params.has('refuse');
    return <>
      <output id="closes">{closes}</output>
      {open && <ResponsiveDialogSurface
        historyMode="none"
        layer="dialog"
        ariaLabel="Fixture sheet"
        role={params.has('alert') ? 'alertdialog' : 'dialog'}
        sheetGesture={!params.has('optout')}
        onClose={() => { setCloses(n => n + 1); if (!refuse) setOpen(false); }}
        overlayClassName="fixture-overlay"
        panelClassName="fixture-panel">
        <button type="button">Inside</button>
      </ResponsiveDialogSurface>}
    </>;
  }
  window.mount = (hash) => {
    location.hash = hash;
    deviceSettingsStore.set('developerToolsEnabled', !hash.includes('off'));
    deviceSettingsStore.set('experimentalSheetGesturesEnabled', !hash.includes('off'));
    const root = document.getElementById('root');
    window.fixtureRoot?.unmount();
    window.fixtureRoot = createRoot(root);
    window.fixtureRoot.render(<App/>);
  };
`;

let page: Page;
let close: () => Promise<void>;
let errors: string[];

beforeAll(async () => {
  const opened = await scrollBrowserFixture(fixture);
  page = opened.page;
  await page.addStyleTag({
    content: resolveCssImports(resolve(import.meta.dirname, '../index.css')),
  });
  errors = opened.errors;
  close = () => opened.browser.close();
}, 60_000);

afterAll(async () => {
  await close?.();
});

async function mount(hash = '') {
  await page.evaluate((value) => {
    (window as unknown as { mount: (hash: string) => void }).mount(value);
  }, hash);
  await page.getByRole('dialog').or(page.getByRole('alertdialog')).waitFor();
  // Past the shared entrance animation, which translates the panel.
  await page.waitForTimeout(300);
}

/**
 * Where a docked panel rests: the bottom of the overlay's content box (the
 * shared phone overlay pads its sheets), so the expectations hold for the
 * production stylesheet rather than restating its padding.
 */
async function restingBottom() {
  return page.evaluate(() => {
    const overlay = document.querySelector('.fixture-overlay')!;
    const padding = Number.parseFloat(getComputedStyle(overlay).paddingBottom);
    return overlay.getBoundingClientRect().bottom - padding;
  });
}

async function geometry() {
  return page.evaluate(() => {
    const panel = document.querySelector('.fixture-panel');
    const handle = document.querySelector('[data-sheet-handle]');
    const overlay = document.querySelector('.fixture-overlay');
    const rect = (element: Element | null) => {
      if (!element) return null;
      const { top, bottom, left, width, height } =
        element.getBoundingClientRect();
      return { top, bottom, left, width, height };
    };
    return {
      panel: rect(panel),
      handle: rect(handle),
      expanded: overlay?.hasAttribute('data-sheet-expanded') ?? false,
      closes: Number(document.getElementById('closes')?.textContent),
    };
  });
}

/** Press the grip, travel `deltaY` in slow steps, release. */
async function drag(deltaY: number) {
  const { handle } = await geometry();
  if (!handle) throw new Error('no handle');
  const x = handle.left + handle.width / 2;
  const y = handle.top + handle.height - 8;
  await page.mouse.move(x, y);
  await page.mouse.down();
  const steps = 20;
  for (let step = 1; step <= steps; step += 1) {
    await page.mouse.move(x, y + (deltaY * step) / steps);
    await page.waitForTimeout(16);
  }
  // Hold still before lifting so the release is not a fling.
  await page.waitForTimeout(150);
  await page.mouse.up();
  // Past the settle animation (--motion-base) and its two-frame check.
  await page.waitForTimeout(400);
}

describe('sheet gesture preview', () => {
  test('the handle sits centred on the docked panel’s top edge', async () => {
    await mount();
    const { panel, handle } = await geometry();
    expect(panel?.bottom).toBeCloseTo(await restingBottom(), 0);
    expect(panel?.height).toBeCloseTo(300, 0);
    expect(handle).not.toBeNull();
    // A 44px hit area reaching above the panel, its grip just inside it.
    expect(handle!.height).toBeCloseTo(44, 0);
    expect(handle!.top).toBeLessThan(panel!.top);
    expect(handle!.bottom).toBeGreaterThan(panel!.top);
    expect(handle!.left + handle!.width / 2).toBeCloseTo(
      panel!.left + panel!.width / 2,
      0,
    );
    // The handle takes its own presses: the overlay's scrim dismissal
    // (a press on the overlay itself) is not triggered by it.
    const hit = await page.evaluate(
      ([x, y]) =>
        document.elementFromPoint(x, y)?.closest('[data-sheet-handle]') !==
        null,
      [handle!.left + handle!.width / 2, handle!.top + 4],
    );
    expect(hit).toBe(true);
    expect(errors).toEqual([]);
  });

  test('drag up expands to Full past the consumer’s max-height, drag down restores Default', async () => {
    await mount();
    const bottom = await restingBottom();
    await drag(-400);
    let state = await geometry();
    expect(state.expanded).toBe(true);
    // From its resting edge up to the 16px top gap (no safe area here), well
    // past the consumer's own 60vh max-height.
    expect(state.panel?.top).toBeCloseTo(16, 0);
    expect(state.panel?.bottom).toBeCloseTo(bottom, 0);
    expect(state.handle!.top).toBeLessThan(state.panel!.top);

    await drag(450);
    state = await geometry();
    expect(state.expanded).toBe(false);
    expect(state.panel?.height).toBeCloseTo(300, 0);
    expect(state.panel?.bottom).toBeCloseTo(bottom, 0);
    expect(state.closes).toBe(0);
  });

  test('a short drag down springs back; a long one closes through onClose', async () => {
    await mount();
    const bottom = await restingBottom();
    await drag(100);
    let state = await geometry();
    expect(state.panel?.height).toBeCloseTo(300, 0);
    expect(state.panel?.bottom).toBeCloseTo(bottom, 0);
    expect(state.closes).toBe(0);

    await drag(200);
    state = await geometry();
    expect(state.closes).toBe(1);
    expect(state.panel).toBeNull();
  });

  test('a consumer that refuses to close gets its sheet back', async () => {
    await mount('refuse');
    const bottom = await restingBottom();
    await drag(250);
    const state = await geometry();
    expect(state.closes).toBe(1);
    expect(state.panel?.height).toBeCloseTo(300, 0);
    expect(state.panel?.bottom).toBeCloseTo(bottom, 0);
    expect(state.handle).not.toBeNull();
  });

  test('a tap on the handle toggles Full and back', async () => {
    await mount();
    await drag(0);
    expect((await geometry()).expanded).toBe(true);
    await drag(0);
    const state = await geometry();
    expect(state.expanded).toBe(false);
    expect(state.panel?.height).toBeCloseTo(300, 0);
  });

  test('no handle with the preview off, on an alertdialog, or for a consumer that opts out', async () => {
    await mount('off');
    expect((await geometry()).handle).toBeNull();
    await mount('alert');
    expect((await geometry()).handle).toBeNull();
    await mount('optout');
    expect((await geometry()).handle).toBeNull();
  });
});
