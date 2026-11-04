import { expect, test } from 'vitest';
import { scrollBrowserFixture } from './scroll-browser-fixture';

// The production code-block frame around a 150-character line, the audit's
// reproduction (#4407 A42): at 412px its <pre> scrolled 802px sideways.
const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {CodeBlockFrame} from './src-ui/src/components/chat/CodeBlockFrame';
const line = 'const answer = ' + JSON.stringify('x'.repeat(130)) + ';';
createRoot(document.getElementById('root')).render(
  <div style={{width: 'min(100%, 640px)'}}>
    <CodeBlockFrame lang="ts" code={line + '\\nreturn answer;'} html={null} />
  </div>);
`;

test('#4407: long code lines wrap on a phone, scroll on a desktop, and Wrap switches either', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(fixture);
  const block = () =>
    page.locator('.code-block-body').evaluate((body) => ({
      scrolls: body.scrollWidth > body.clientWidth + 1,
      pres: body.closest('.code-block-frame')?.querySelectorAll('pre').length,
    }));
  try {
    const wrap = page.getByRole('button', { name: 'Wrap' });

    // A desktop scrolls a long line by default.
    await page.setViewportSize({ width: 1280, height: 800 });
    await wrap.waitFor();
    await expect.poll(() => wrap.getAttribute('aria-pressed')).toBe('false');
    expect(await block()).toEqual({ scrolls: true, pres: 1 });

    // A phone wraps it by default.
    await page.setViewportSize({ width: 412, height: 915 });
    await expect.poll(() => wrap.getAttribute('aria-pressed')).toBe('true');
    expect(await block()).toEqual({ scrolls: false, pres: 1 });

    // Wrap is the reader's choice from then on, whatever the width.
    await wrap.click();
    expect(await wrap.getAttribute('aria-pressed')).toBe('false');
    expect((await block()).scrolls).toBe(true);
    await page.setViewportSize({ width: 1280, height: 800 });
    await wrap.click();
    expect(await wrap.getAttribute('aria-pressed')).toBe('true');
    expect(await block()).toEqual({ scrolls: false, pres: 1 });
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
