import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

// #4518: the production picker under a managed approval ceiling of Ask, opened
// from a real trigger, rendered with the app's cascade at phone and desktop
// widths in both themes. The PNGs are the visual evidence for the managed
// state; the assertions pin what a person can and cannot choose.
const fixture = `
import React, {useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {DialogHistoryHostBoundary} from './src-ui/src/components/DialogHistoryHost';
import {AccountPreferencesContext} from './src-ui/src/contexts/AccountPreferencesContext';
import {ManagedPolicyContext} from './src-ui/src/contexts/ManagedPolicyContext';
import {ComposerModeSheet} from './src-ui/src/components/badges/ComposerModeSheet';
const account = {status:'account', saving:false, waitingForConnection:false, error:false, conflict:false, save(){}, retry(){}};
const policy = {organization:'Example Corp', supportUrl:'https://help.example.com/station', lockedSettings:[], limits:{maxApprovalMode:'ask'}};
function Host() {
  const trigger = useRef(null);
  return <div style={{position:'fixed',left:16,bottom:16}}>
    <button ref={trigger} type="button">Approval</button>
    <ComposerModeSheet triggerRef={trigger} effectiveMode="ask" engineConnectionId="codex"
      onClose={()=>{}} onSelect={()=>{}} sourceNote="From this Station’s default" isNewSession />
  </div>;
}
createRoot(document.getElementById('root')).render(
  <DialogHistoryHostBoundary><AccountPreferencesContext.Provider value={account}><ManagedPolicyContext.Provider value={policy}><Host/></ManagedPolicyContext.Provider></AccountPreferencesContext.Provider></DialogHistoryHostBoundary>);
`;

test('the approval picker under a managed ceiling disables the modes above it at phone and desktop widths in both themes', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(fixture);
  try {
    await page.addStyleTag({
      content:
        resolveCssImports(resolve(import.meta.dirname, '../index.css')) +
        resolveCssImports(
          resolve(import.meta.dirname, '../components/chat/chat.css'),
        ),
    });
    const out = resolve('.kontourai/composer-mode-sheet-managed');
    mkdirSync(out, { recursive: true });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (value) => document.documentElement.setAttribute('data-theme', value),
        theme,
      );
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        const sheet = page.getByRole('dialog', { name: 'Approval mode' });
        await sheet
          .getByText(
            "Example Corp's policy manages approval modes: the broadest allowed is Ask first.",
            { exact: false },
          )
          .waitFor();
        await page.evaluate(() =>
          Promise.all(document.getAnimations().map((a) => a.finished)),
        );
        const disabled = await sheet.evaluate((root) =>
          Object.fromEntries(
            [...root.querySelectorAll('input[type="radio"]')].map((input) => [
              (input as HTMLInputElement).value,
              (input as HTMLInputElement).disabled,
            ]),
          ),
        );
        expect(disabled, `${width}px ${theme}`).toEqual({
          'connection-default': false,
          ask: false,
          auto: true,
          never: true,
        });
        await page.screenshot({ path: `${out}/${width}-${theme}.png` });
      }
    }
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
