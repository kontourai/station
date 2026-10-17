import { expect, test } from 'vitest';
import { scrollBrowserFixture } from './scroll-browser-fixture';

test('a clamped restore survives leaving a short route before its content arrives', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(`
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
