import { expect, test } from 'vitest';
import { scrollBrowserFixture } from './scroll-browser-fixture';

const routeFixture = () =>
  scrollBrowserFixture(`
    import React, {useRef, useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {useScrollRestoration} from './src-ui/src/app-shell/useScrollRestoration';
    function App(){
      const [route, setRoute] = useState('settings');
      const [height, setHeight] = useState(5000);
      const ref = useRef(null);
      useScrollRestoration(ref, route);
      window.go = (next, size) => {
        window.dispatchEvent(new PopStateEvent('popstate'));
        flushSync(() => {setRoute(next); setHeight(size)});
      };
      return <div id="scroll" ref={ref} style={{height:300,overflow:'auto'}}><div style={{height}}>{route}</div></div>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  `);

test('a clamped restore survives leaving a short route before its content arrives', async () => {
  const { browser, page, errors } = await routeFixture();
  try {
    await page.waitForSelector('#scroll');
    await page.locator('#scroll').evaluate((element) => {
      element.scrollTop = 3000;
    });
    await page.waitForFunction(
      () => document.querySelector('#scroll')?.scrollTop === 3000,
    );
    // Let the native scroll event record the original offset.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await page.evaluate('go("away", 400)');
    await page.evaluate('go("settings", 400)');
    await page.waitForFunction(
      () => document.querySelector('#scroll')?.scrollTop === 100,
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await page.evaluate('go("away", 400)');
    await page.evaluate('go("settings", 5000)');
    await page.waitForFunction(
      () => document.querySelector('#scroll')?.scrollTop === 3000,
      undefined,
      { timeout: 1500 },
    );
    expect(
      await page.locator('#scroll').evaluate((element) => element.scrollTop),
    ).toBe(3000);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('an expired restore resumes saving the route position', async () => {
  const { browser, page, errors } = await routeFixture();
  try {
    await page.waitForSelector('#scroll');
    await page.locator('#scroll').evaluate((element) => {
      element.scrollTop = 3000;
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    // Advance the real hook's deadline without an eight-second wall-clock wait.
    await page.clock.install();
    await page.evaluate('go("away", 400)');
    await page.evaluate('go("settings", 400)');
    expect(
      await page.locator('#scroll').evaluate((element) => element.scrollTop),
    ).toBe(100);
    await page.clock.fastForward(8250);
    // Programmatic movement emits a native scroll without the reader-input
    // interrupt that would independently release the pending restore guard.
    await page.locator('#scroll').evaluate((element) => {
      element.scrollTop = 40;
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await page.evaluate('go("away", 400)');
    await page.evaluate('go("settings", 5000)');
    expect(
      await page.locator('#scroll').evaluate((element) => element.scrollTop),
    ).toBe(40);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
