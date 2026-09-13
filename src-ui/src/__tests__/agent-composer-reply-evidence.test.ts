import { chromium } from '@playwright/test';
import { expect, test } from 'vitest';
import { sendComposerTurn } from '../../../tests/helpers/agents-journey';

test.each([false, true])(
  'composer reply proof requires assistant output (reply=%s)',
  async (reply) => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <section id="chat-dock">
          <h1>PONG</h1>
          <textarea placeholder="Type a message..."></textarea>
        </section>
      `);
      await page.evaluate((withReply) => {
        document
          .querySelector('textarea')!
          .addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            document.body.dataset.submitted = 'true';
            if (withReply) {
              const message = document.createElement('div');
              message.className = 'message assistant';
              message.textContent = 'PONG';
              document.querySelector('#chat-dock')!.append(message);
            }
          });
      }, reply);
      const result = sendComposerTurn(page, 'PONG', /PONG/, 250);
      if (reply) await result;
      else await expect(result).rejects.toThrow(/toBeVisible/);
      expect(await page.locator('textarea').inputValue()).toBe('PONG');
      expect(await page.locator('body').getAttribute('data-submitted')).toBe(
        'true',
      );
      expect(await page.locator('.message.assistant').count()).toBe(
        reply ? 1 : 0,
      );
    } finally {
      await browser.close();
    }
  },
  15_000,
);
