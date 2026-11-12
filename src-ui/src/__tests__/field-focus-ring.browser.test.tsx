import type { Plugin } from 'esbuild';
import { expect, test } from 'vitest';
import { scrollBrowserFixture } from './scroll-browser-fixture';

// index.css pulls in brand fonts and channel badges; focus rings need neither.
const externalAssets: Plugin = {
  name: 'external-assets',
  setup(builder) {
    builder.onResolve({ filter: /\.(woff2?|png)$/ }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
};

// The global `:focus-visible` rule in index.css outlines every text field.
// Where a rounded box or a search row is the visible field, that outline drew
// a second, square ring inside it. These fields move the ring to their box.
// Real stylesheets, real cascade: only Chromium can tell what is drawn.
const FIXTURE = `
  import './src-ui/src/index.css';
  import './src-ui/src/components/chat-start/StartComposer.css';
  import './src-ui/src/components/CommandPalette.css';
  document.getElementById('root').innerHTML = \`
    <div class="start-composer">
      <div class="start-composer__box" id="box">
        <textarea class="start-composer__input" id="draft"></textarea>
        <button type="button" id="chip">Agent</button>
      </div>
    </div>
    <div class="command-palette__search-field" id="field">
      <input class="command-palette__input" id="query" />
    </div>
    <input id="plain" />
  \`;
`;

test('a composer box and a palette search row carry their field focus ring', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(
    FIXTURE,
    [externalAssets],
    {
      viewport: { width: 1440, height: 900 },
    },
  );
  try {
    await page.waitForSelector('#draft');
    expect(errors).toEqual([]);
    const style = (selector: string, property: string) =>
      page
        .locator(selector)
        .evaluate(
          (element, name) => getComputedStyle(element).getPropertyValue(name),
          property,
        );

    // Control: an ordinary field still gets the global ring.
    await page.locator('#plain').focus();
    expect(await style('#plain', 'outline-style')).toBe('solid');

    await page.locator('#draft').focus();
    expect(await style('#draft', 'outline-style')).toBe('none');
    expect(await style('#box', 'outline-style')).toBe('solid');
    expect(await style('#box', 'outline-width')).toBe('2px');

    // A control inside the box keeps its own ring and does not ring the box.
    await page.locator('#chip').focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    expect(await style('#chip', 'outline-style')).toBe('solid');
    expect(await style('#box', 'outline-style')).toBe('none');

    await page.locator('#query').focus();
    expect(await style('#query', 'outline-style')).toBe('none');
    expect(await style('#field', 'outline-style')).toBe('solid');
    expect(await style('#field', 'outline-width')).toBe('2px');
  } finally {
    await browser.close();
  }
});
