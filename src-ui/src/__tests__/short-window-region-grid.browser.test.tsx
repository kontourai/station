import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

// The desktop region grid as App renders it: toolbar, the page in `main`,
// and an open bottom dock region whose height the shell publishes as
// `--region-bottom-size` (regions/region-clearance.ts).
const fixture = `
document.getElementById('root').innerHTML = \`
  <div class="app" style="display:flex;height:100vh">
    <div class="app__main">
      <div class="app-toolbar">Toolbar</div>
      <main class="main-content"><div class="content-view">Page</div></main>
      <section class="chat-dock chat-dock--bottom" data-region="bottom">Dock</section>
    </div>
  </div>\`;
`;

// #4394: a short desktop-pointer window (a phone preset emulated in a desktop
// browser, 915x412) gave the 320px dock and the toolbar the whole height and
// `main` rendered at 0px.
test('a short window keeps room for the page above an open bottom dock', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(fixture);
  try {
    await page.addStyleTag({
      content: resolveCssImports(resolve(import.meta.dirname, '../index.css')),
    });
    await page.evaluate(() =>
      document.documentElement.style.setProperty(
        '--region-bottom-size',
        '320px',
      ),
    );
    const measure = async (width: number, height: number) => {
      await page.setViewportSize({ width, height });
      return page.evaluate(() => {
        const box = (selector: string) =>
          document.querySelector(selector)!.getBoundingClientRect();
        return {
          main: box('.main-content').height,
          dock: box('[data-region="bottom"]').height,
          frame: box('.app__main').height,
        };
      });
    };

    const short = await measure(915, 412);
    expect(short.main).toBeGreaterThanOrEqual(120);
    expect(short.dock).toBeGreaterThan(150);

    // A window with room keeps the dock's own height.
    const roomy = await measure(1280, 800);
    expect(Math.round(roomy.dock)).toBe(320);
    expect(roomy.main).toBeGreaterThan(300);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
