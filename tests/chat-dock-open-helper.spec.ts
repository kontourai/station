import { expect, test } from '@playwright/test';
import { ensureChatDockOpen } from './helpers/agents-journey';

/**
 * `ensureChatDockOpen` against the race behind #4175.
 *
 * The dock's toggle is one button whose name flips with the dock's state
 * ("Show Chat" / "Hide Chat"). Starting a chat opens the dock by itself, so
 * the product can open it after the helper has resolved "Show Chat" and
 * before its click lands. The click then hits "Hide Chat" and closes the dock
 * the product just opened. The PR smoke trace of #4175 shows exactly that:
 * the snapshot before the click has "Hide Chat", the one after has
 * "Show Chat", and the dock stays collapsed.
 *
 * This page puts the product's open in the worst place, deterministically: the
 * first time the pointer reaches the toggle (Playwright moves the pointer
 * after resolving and before clicking), the "product" opens the dock. A helper
 * that decides from one look closes it and never recovers.
 *
 * No Station instance: the subject is the shared helper, not the dock.
 */

const TOGGLE_PAGE = `<!doctype html>
<html><body>
<section id="chat-dock" data-state="collapsed">
  <button type="button" id="toggle" aria-label="Show Chat">Toggle</button>
</section>
<script>
  const dock = document.getElementById('chat-dock');
  const toggle = document.getElementById('toggle');
  const render = (state) => {
    dock.dataset.state = state;
    toggle.setAttribute('aria-label', state === 'open' ? 'Hide Chat' : 'Show Chat');
  };
  let productOpened = false;
  toggle.addEventListener('pointerover', () => {
    if (productOpened) return;
    productOpened = true;
    render('open');
  });
  toggle.addEventListener('click', () => {
    render(dock.dataset.state === 'open' ? 'collapsed' : 'open');
  });
</script>
</body></html>`;

test.describe('ensureChatDockOpen', () => {
  test('ends open when the product opens the dock under its click', async ({
    page,
  }) => {
    await page.setContent(TOGGLE_PAGE);
    await ensureChatDockOpen(page);
    await expect(page.locator('#chat-dock')).toHaveAttribute(
      'data-state',
      'open',
    );
  });

  test('leaves an already open dock open', async ({ page }) => {
    await page.setContent(TOGGLE_PAGE);
    await page.evaluate(() => {
      const dock = document.getElementById('chat-dock');
      const toggle = document.getElementById('toggle');
      if (!dock || !toggle) throw new Error('fixture page is missing');
      dock.dataset.state = 'open';
      toggle.setAttribute('aria-label', 'Hide Chat');
    });
    await ensureChatDockOpen(page);
    await expect(page.locator('#chat-dock')).toHaveAttribute(
      'data-state',
      'open',
    );
  });
});
