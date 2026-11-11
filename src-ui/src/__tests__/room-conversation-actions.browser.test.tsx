import { expect, test } from 'vitest';
import { scrollBrowserFixture } from './scroll-browser-fixture';

// The production RoomConversation on a touch phone (390px, coarse pointer, no
// hover): every message with actions must reach them without a long press,
// by touch, keyboard and assistive tech (#4810 gallery delta).
const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {RoomConversation} from './src-ui/src/components/room/RoomConversation';
const authors = ['Ana Ruiz', 'Ben Ode', 'Scout'];
const rows = Array.from({length: 6}, (_, index) => ({
  id: 'm' + index,
  kind: 'message',
  author: {id: 'a' + (index % 3), label: authors[index % 3], agent: index % 3 === 2},
  at: new Date(Date.UTC(2026, 10, 3, 9, index * 10)).toISOString(),
  text: 'Message ' + index,
  actions: <button type="button" className="button" aria-label={'Reply to ' + authors[index % 3]}>Reply</button>,
}));
createRoot(document.getElementById('root')).render(
  <div style={{height: 700, display: 'flex', flexDirection: 'column'}}>
    <RoomConversation label="Conversation" regionLabel="Messages in #general" rows={rows} />
  </div>);
`;

const TOUCH_PHONE = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
};

test('on a touch phone each message has a visible, named, 44px More actions button that opens its actions (#4810 gallery delta 1)', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(
    fixture,
    [],
    TOUCH_PHONE,
  );
  try {
    await page.getByRole('list', { name: 'Conversation' }).waitFor();
    // Each message's actions are reachable without a long press.
    const more = page.getByRole('button', { name: /^More actions for / });
    expect(await more.count()).toBe(6);
    // One author's messages are told apart by their time.
    const first = page
      .getByRole('button', { name: /^More actions for Ana Ruiz's message at / })
      .first();
    const names = await more.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('aria-label')),
    );
    expect(new Set(names).size).toBe(6);
    expect(await first.getAttribute('aria-expanded')).toBe('false');
    const size = await first.boundingBox();
    // The gallery hit-target audit's own floor (sub-pixel layout rounds).
    expect(size!.width).toBeGreaterThanOrEqual(43.5);
    expect(size!.height).toBeGreaterThanOrEqual(43.5);
    // Closed actions are not in the accessibility tree.
    expect(await page.getByRole('button', { name: /^Reply to / }).count()).toBe(
      0,
    );

    // Keyboard: from the scroll region, Tab reaches the first More button.
    await page.locator('.room-conversation__scroller').focus();
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(() =>
        document.activeElement?.getAttribute('aria-label'),
      ),
    ).toBe(await first.getAttribute('aria-label'));

    // Opening moves focus into the actions; the controls relation resolves.
    await page.keyboard.press('Enter');
    expect(await first.getAttribute('aria-expanded')).toBe('true');
    const controls = await first.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    const reply = page.getByRole('button', { name: 'Reply to Ana Ruiz' });
    await expect.poll(() => reply.count()).toBe(1);
    expect(
      await page.evaluate(
        (id) => document.getElementById(id!)?.contains(document.activeElement),
        controls,
      ),
    ).toBe(true);
    const replyBox = await reply.boundingBox();
    expect(replyBox!.height).toBeGreaterThanOrEqual(43.5);

    // Escape closes and returns focus to the button.
    await page.keyboard.press('Escape');
    expect(await first.getAttribute('aria-expanded')).toBe('false');
    expect(
      await page.evaluate(() =>
        document.activeElement?.getAttribute('aria-label'),
      ),
    ).toBe(await first.getAttribute('aria-label'));

    // Touch: tap opens; a tap outside closes and returns focus to the button.
    await first.tap();
    await expect.poll(() => reply.count()).toBe(1);
    await page.getByText('Message 3').tap();
    expect(await first.getAttribute('aria-expanded')).toBe('false');
    expect(await reply.count()).toBe(0);
    expect(
      await page.evaluate(() =>
        document.activeElement?.getAttribute('aria-label'),
      ),
    ).toBe(await first.getAttribute('aria-label'));
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('the focusable scroll area is a named region around the message list (#4810 gallery delta 2)', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(
    fixture,
    [],
    TOUCH_PHONE,
  );
  try {
    await page.getByRole('list', { name: 'Conversation' }).waitFor();
    const region = page.getByRole('region', { name: 'Messages in #general' });
    expect(await region.count()).toBe(1);
    // The scroll region keeps the list inside it.
    expect(
      await region.getByRole('list', { name: 'Conversation' }).count(),
    ).toBe(1);

    expect(
      await page
        .locator('.room-conversation__scroller')
        .evaluate((element) => element.tabIndex),
    ).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
