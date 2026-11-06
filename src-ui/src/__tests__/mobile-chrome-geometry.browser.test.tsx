import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

/**
 * Phone chrome geometry from the Duo audit, measured in Chromium against the
 * real cascade (`index.css` plus each owner's own stylesheet) — layout that
 * jsdom cannot see.
 *
 * - The notifications sheet ends at the VISIBLE viewport's bottom edge. The
 *   browser's `visualViewport` is shortened the way iOS Safari's floating
 *   toolbar shortens it, and the document inset is published by the real
 *   `installVisualViewportInset` from the real shared store.
 * - The real `ComposerChoice` chips, captions shown as in a chat's composer,
 *   fit "Muse Code" and "Model" in that composer's 372px row on a 390px
 *   phone instead of cutting them to "Muse Co…" and "Model & eff…".
 * - A healthy Station chip on a phone shows the Station's name, not a bare dot.
 */
const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {installVisualViewportInset} from './src-ui/src/hooks/useMobileVisualViewport';
import {ComposerChoice} from './src-ui/src/components/ComposerChoice';
import './src-ui/src/components/notifications/NotificationHistory.css';
import './src-ui/src/components/chat/chat.css';

const viewport = new EventTarget();
window.__toolbar = 0;
Object.defineProperty(viewport, 'height', { get: () => window.innerHeight - window.__toolbar });
Object.defineProperty(viewport, 'offsetTop', { get: () => 0 });
Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
window.__setToolbar = (px) => { window.__toolbar = px; viewport.dispatchEvent(new Event('resize')); };
installVisualViewportInset(window);

const icon = <span className="composer-choice__icon"><svg width="24" height="24"/></span>;
createRoot(document.getElementById('root')).render(<>
  <div className="notification-history notification-history--sheet" data-testid="sheet">
    <div style={{height: 120}}>All caught up</div>
  </div>
  <div className="composer-choices" style={{width: 372}} data-testid="chips">
    <ComposerChoice aria-label="Agent" caption="Agent" icon={icon} value="Muse Code"/>
    <ComposerChoice aria-label="Engine & model" caption="Muse Code" value="Model" valueClassName="chat-input__model-name"/>
    <ComposerChoice aria-label="Approval" caption="Approval" value="Default"/>
  </div>
  <div className="app-toolbar__actions">
    <button type="button" data-testid="conn-ok" className="app-toolbar__icon-btn app-toolbar__conn app-toolbar__conn--connected app-toolbar__conn--compact">
      <span className="conn-dot"/><span className="app-toolbar__conn-label">Kontour</span>
    </button>
    <button type="button" data-testid="conn-alert" className="app-toolbar__icon-btn app-toolbar__conn app-toolbar__conn--error">
      <span className="conn-dot"/><span className="app-toolbar__conn-state">Can't connect</span><span className="app-toolbar__conn-name">Kontour</span>
    </button>
  </div>
</>);
`;

test('phone chrome stands clear of the browser toolbar and keeps its names', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(fixture);
  try {
    await page.addStyleTag({
      content: resolveCssImports(resolve(import.meta.dirname, '../index.css')),
    });
    await page
      .getByTestId('sheet')
      .waitFor({ timeout: 10_000 })
      .catch(() => {
        throw new Error(`fixture did not mount: ${errors.join('; ')}`);
      });

    // iOS Safari's floating toolbar: the visual viewport ends 80px early.
    const TOOLBAR = 80;
    await page.evaluate((px) => window.__setToolbar(px), TOOLBAR);
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.style.getPropertyValue(
            '--visual-viewport-bottom-inset',
          ),
        ),
      )
      .toBe(`${TOOLBAR}px`);
    const sheet = await page
      .getByTestId('sheet')
      .evaluate((element) => element.getBoundingClientRect().bottom);
    expect(sheet).toBe(844 - TOOLBAR);

    // No toolbar: the sheet docks to the bottom edge itself.
    await page.evaluate(() => window.__setToolbar(0));
    await expect
      .poll(() =>
        page
          .getByTestId('sheet')
          .evaluate((element) => element.getBoundingClientRect().bottom),
      )
      .toBe(844);

    const values = await page.getByTestId('chips').evaluate((row) =>
      [...row.querySelectorAll('.composer-choice__value')].map((value) => ({
        text: value.textContent,
        clipped: value.scrollWidth > value.clientWidth,
      })),
    );
    expect(values).toEqual([
      { text: 'Muse Code', clipped: false },
      { text: 'Model', clipped: false },
      { text: 'Default', clipped: false },
    ]);

    const label = await page.getByTestId('conn-ok').evaluate((button) => {
      const name = button.querySelector('.app-toolbar__conn-label');
      return {
        shown: Boolean(name && name.getClientRects().length > 0),
        clipped: name ? name.scrollWidth > name.clientWidth : true,
        height: button.getBoundingClientRect().height,
      };
    });
    expect(label).toEqual({ shown: true, clipped: false, height: 44 });
    // A state that needs action stays the 44px dot: its remedy is in the
    // accessible name and the chooser.
    const alert = await page
      .getByTestId('conn-alert')
      .evaluate((button) => button.getBoundingClientRect().width);
    expect(alert).toBe(44);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

declare global {
  interface Window {
    __setToolbar(px: number): void;
  }
}
