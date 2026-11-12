import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CDPSession, Page } from '@playwright/test';
import { expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

const fixture = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
  import {NavigationProvider} from './src-ui/src/contexts/NavigationContext';
  import {ToastProvider, toastStore} from './src-ui/src/contexts/ToastContext';
  import {NotificationContainer} from './src-ui/src/components/notifications/NotificationContainer';
  let root;
  window.mount = () => {
    root?.unmount();
    document.body.dataset.theme = document.documentElement.dataset.theme;
    root = createRoot(document.getElementById('root'));
    root.render(<QueryClientProvider client={new QueryClient()}><NavigationProvider><ToastProvider>
      <NotificationContainer/>
    </ToastProvider></NavigationProvider></QueryClientProvider>);
  };
  window.raise = (message, tone) => toastStore.show(message, undefined, 0, undefined, undefined, tone);
  window.clearToasts = () => toastStore.dismissAll?.();
`;

async function touchDrag(
  cdp: CDPSession,
  page: Page,
  text: string,
  dx: number,
) {
  const card = page.getByTestId('toast-card').filter({ hasText: text });
  const box = await card.boundingBox();
  if (!box) throw new Error(`Toast "${text}" did not render`);
  const x = box.x + box.width / 2;
  const y = box.y + 20;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y }],
  });
  for (let step = 1; step <= 6; step++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + (dx * step) / 6, y }],
    });
    await page.waitForTimeout(30);
  }
  return {
    card,
    end: () =>
      cdp.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      }),
  };
}

test('a touch swipe dismisses a toast, a short drag springs back, and the stack renders at phone and desktop widths', async () => {
  const { page, browser, errors } = await scrollBrowserFixture(fixture, [], {
    hasTouch: true,
  });
  try {
    await page.addStyleTag({
      content: resolveCssImports(resolve('src-ui/src/index.css')),
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => {
      const w = window as unknown as {
        mount: () => void;
        raise: (message: string, tone: string) => void;
      };
      w.mount();
      w.raise('Build finished', 'success');
      w.raise('Couldn’t reach the engine', 'error');
    });
    await page.getByTestId('toast-card').first().waitFor();

    const short = await touchDrag(cdp, page, 'Build finished', -30);
    await short.end();
    await page.waitForTimeout(300);
    await expect(short.card.count()).resolves.toBe(1);

    const artifacts = resolve('.surface/toast-swipe');
    await mkdir(artifacts, { recursive: true });
    for (const theme of ['dark', 'light']) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.body.dataset.theme = theme;
      }, theme);
      const mid = await touchDrag(cdp, page, 'Build finished', -120);
      await page.screenshot({
        path: resolve(artifacts, `390-${theme}-mid-swipe.png`),
        animations: 'disabled',
      });
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchCancel',
        touchPoints: [],
      });
      await page.waitForTimeout(250);
      expect(await mid.card.count()).toBe(1);
    }

    const swipe = await touchDrag(cdp, page, 'Build finished', -200);
    await swipe.end();
    await expect.poll(() => swipe.card.count(), { timeout: 2_000 }).toBe(0);
    expect(
      await page
        .getByTestId('toast-card')
        .filter({ hasText: 'engine' })
        .count(),
    ).toBe(1);

    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const theme of ['dark', 'light']) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.body.dataset.theme = theme;
      }, theme);
      await page.screenshot({
        path: resolve(artifacts, `1440-${theme}.png`),
        animations: 'disabled',
      });
    }
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 60_000);
