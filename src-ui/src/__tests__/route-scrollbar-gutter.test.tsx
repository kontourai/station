/** @vitest-environment jsdom */
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { resolvePageFrame } from '../app-shell/page-frame-registry';
import { PageFrame } from '../components/page-frame/PageFrame';

test('fill routes keep the whole scrollport while flow routes reserve space before overflowing', async () => {
  const browser = await chromium.launch({
    ignoreDefaultArgs: ['--hide-scrollbars'],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    const css = [
      'src-ui/src/index.css',
      'src-ui/src/components/page-frame/page-frame.css',
      'src-ui/src/app-shell/route-transition.css',
    ]
      .map((file) => resolveCssImports(resolve(file)))
      .join('\n');
    for (const type of ['agents', 'settings'] as const) {
      const markup = renderToStaticMarkup(
        <PageFrame spec={resolvePageFrame({ type })} routeIdentity={type}>
          <div id="route-body" style={{ height: 20 }}>
            Route body
          </div>
        </PageFrame>,
      );
      await page.setContent(
        `<style>${css}</style><div class="content-view" style="width:390px;height:400px;flex:none">${markup}</div>`,
      );
      const read = () =>
        page.locator('.content-view').evaluate((el) => ({
          gutter: getComputedStyle(el).scrollbarGutter,
          width: el.clientWidth,
          outer: (el as HTMLElement).offsetWidth,
        }));
      const short = await read();
      if (type === 'agents') {
        expect(short.gutter).toBe('auto');
        expect(short.width).toBe(short.outer);
      } else {
        expect(short.gutter).toBe('stable');
        await page.locator('#route-body').evaluate((el) => {
          el.style.height = '1000px';
        });
        expect((await read()).width).toBe(short.width);
        expect(
          await page
            .locator('.content-view')
            .evaluate((el) => el.scrollHeight > el.clientHeight),
        ).toBe(true);
      }
    }
  } finally {
    await browser.close();
  }
});
