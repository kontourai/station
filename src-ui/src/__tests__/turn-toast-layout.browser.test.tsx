import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

// The production toast overlay with a real agent-turn toast raised through
// the store, the way `turnAttentionNotifications` raises it.
const fixture = `
import React, {useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {NavigationProvider} from './src-ui/src/contexts/NavigationContext';
import {ToastProvider, toastStore} from './src-ui/src/contexts/ToastContext';
import {NotificationContainer} from './src-ui/src/components/notifications/NotificationContainer';
function Raise() {
  useEffect(() => {
    const id = toastStore.showTurnActivity({
      sessionId: 'chat-background',
      message: 'Codex finished',
      conversationTitle: 'Queued message',
      detail: 'Renamed loginUser to signIn across the module and its tests.',
      failed: false,
      onNavigate: () => {},
    });
    // Held open, as a reader holding it would: measuring both themes at two
    // widths outlasts its seven seconds on a loaded runner.
    toastStore.pause(id, 'focus', true);
  }, []);
  return null;
}
createRoot(document.getElementById('root')).render(
  <NavigationProvider><ToastProvider><Raise/><NotificationContainer/></ToastProvider></NavigationProvider>);
`;

// #4396: at 412px the card was 392x176 at the top of the screen.
test('an agent-turn toast is a compact snackbar on a phone and a full card on desktop', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(fixture);
  try {
    await page.addStyleTag({
      content: resolveCssImports(resolve(import.meta.dirname, '../index.css')),
    });
    const measure = async (width: number) => {
      await page.setViewportSize({ width, height: 915 });
      const card = page.getByTestId('toast-card');
      await card.waitFor();
      return card.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const visible = (selector: string) => {
          const node = element.querySelector(selector);
          return Boolean(node && node.getClientRects().length > 0);
        };
        const open = [...element.querySelectorAll('button')].find(
          (button) => button.textContent === 'Open',
        );
        const dismiss = element.querySelector('.toast-card__dismiss');
        return {
          width: box.width,
          height: box.height,
          eyebrow: visible('.toast-card__eyebrow'),
          message: visible('.toast-card__message'),
          title: visible('.toast-card__conversation'),
          openHeight: open?.getBoundingClientRect().height ?? 0,
          dismissWidth: dismiss?.getBoundingClientRect().width ?? 0,
        };
      });
    };

    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (value) => document.documentElement.setAttribute('data-theme', value),
        theme,
      );
      const phone = await measure(412);
      expect(phone.height, theme).toBeLessThanOrEqual(72);
      expect(phone.message && phone.title, theme).toBe(true);
      expect(phone.eyebrow, theme).toBe(false);
      // Its controls keep the 44px touch floor.
      expect(phone.openHeight, theme).toBeGreaterThanOrEqual(44);
      expect(phone.dismissWidth, theme).toBeGreaterThanOrEqual(44);

      const desktop = await measure(1280);
      expect(desktop.eyebrow, theme).toBe(true);
      expect(desktop.height, theme).toBeGreaterThan(phone.height);
    }
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
