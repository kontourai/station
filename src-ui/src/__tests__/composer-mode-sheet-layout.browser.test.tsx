import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

// The production picker, opened from a real trigger, with the account state
// that shows the "save as default" checkbox.
const fixture = `
import React, {useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {DialogHistoryHostBoundary} from './src-ui/src/components/DialogHistoryHost';
import {AccountPreferencesContext} from './src-ui/src/contexts/AccountPreferencesContext';
import {ComposerModeSheet} from './src-ui/src/components/badges/ComposerModeSheet';
const account = {status:'account', saving:false, waitingForConnection:false, error:false, conflict:false, save(){}, retry(){}};
function Host() {
  const trigger = useRef(null);
  return <div style={{position:'fixed',left:16,bottom:16}}>
    <button ref={trigger} type="button">Approval</button>
    <ComposerModeSheet triggerRef={trigger} effectiveMode="ask" engineConnectionId="codex"
      onClose={()=>{}} onSelect={()=>{}} sourceNote="From adapter default" isNewSession />
  </div>;
}
createRoot(document.getElementById('root')).render(
  <DialogHistoryHostBoundary><AccountPreferencesContext.Provider value={account}><Host/></AccountPreferencesContext.Provider></DialogHistoryHostBoundary>);
`;

test('approval picker notes line up with its menu rows at phone and desktop widths in both themes', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(fixture);
  try {
    await page.addStyleTag({
      // The app's cascade order: index.css, then the chat styles that own
      // the popover panel and `composer-actions-menu` rows.
      content:
        resolveCssImports(resolve(import.meta.dirname, '../index.css')) +
        resolveCssImports(
          resolve(import.meta.dirname, '../components/chat/chat.css'),
        ),
    });
    const out = resolve('.kontourai/composer-mode-sheet');
    mkdirSync(out, { recursive: true });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (value) => document.documentElement.setAttribute('data-theme', value),
        theme,
      );
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        const sheet = page.getByRole('dialog', { name: 'Approval mode' });
        await sheet.getByText('Applies on start').waitFor();
        await page.evaluate(() =>
          Promise.all(document.getAnimations().map((a) => a.finished)),
        );
        const edges = await sheet.evaluate((root) => {
          // Where text starts: the content box of each element.
          const contentLeft = (el: Element) =>
            el.getBoundingClientRect().left +
            parseFloat(getComputedStyle(el).paddingLeft);
          const find = (text: string) =>
            [...root.querySelectorAll('p, label')].find((el) =>
              el.textContent?.trim().startsWith(text),
            )!;
          const row = root.querySelector('[role="radiogroup"] > label')!;
          return {
            row: contentLeft(row),
            source: find('From adapter default').getBoundingClientRect().left,
            applies: find('Applies on start').getBoundingClientRect().left,
            save: find('Save as my codex default').getBoundingClientRect().left,
          };
        });
        await page.screenshot({ path: `${out}/${width}-${theme}.png` });
        for (const note of ['source', 'applies', 'save'] as const)
          expect(
            Math.abs(edges[note] - edges.row),
            `${note} at ${width}px ${theme}`,
          ).toBeLessThanOrEqual(1);
      }
    }
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
