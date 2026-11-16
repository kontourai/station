import type { Page } from '@playwright/test';
import { expect, test } from 'vitest';
import { scrollBrowserFixture } from './scroll-browser-fixture';

// The production RoomConversation in Chromium, inside a fixed-height chat
// column. `window.room` adds rows at either end the way a room's history
// does: new messages after the newest, older history before the oldest.
const fixture = (initial: number) => `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {RoomConversation} from './src-ui/src/components/room/RoomConversation';
const at = (index) => new Date(Date.UTC(2026, 10, 3, 9, 0) + index * 7 * 60000).toISOString();
const row = (index) => ({
  id: 'm' + index,
  kind: 'message',
  author: {id: index % 3 ? 'ana' : 'scout', label: index % 3 ? 'Ana Ruiz' : 'Scout', agent: !(index % 3)},
  at: at(index),
  text: 'Message ' + index + (index % 4 ? '' : ' with a longer body that wraps onto a second line in a phone-width column.'),
});
function Harness() {
  const [range, setRange] = useState({first: 1000, last: 1000 + ${initial} - 1});
  window.room = {
    append: (count) => setRange((r) => ({...r, last: r.last + count})),
    prepend: (count) => setRange((r) => ({...r, first: r.first - count})),
  };
  const rows = [];
  for (let index = range.first; index <= range.last; index += 1) rows.push(row(index));
  return <div style={{height: 600, display: 'flex', flexDirection: 'column'}}>
    <RoomConversation label="Conversation" rows={rows} hasOlder onLoadOlder={() => {}} />
  </div>;
}
createRoot(document.getElementById('root')).render(<Harness />);
`;

const scroller = (page: Page) => page.locator('.room-conversation__scroller');
const distanceFromEnd = (page: Page) =>
  scroller(page).evaluate(
    (element) =>
      element.scrollHeight - element.scrollTop - element.clientHeight,
  );
/** The first row the reader can see and its offset from the top. */
const readerRow = (page: Page) =>
  scroller(page).evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const node = [
      ...element.querySelectorAll<HTMLElement>('[data-chat-message-key]'),
    ].find((candidate) => candidate.getBoundingClientRect().bottom > top + 1);
    return node
      ? {
          id: node.dataset.chatMessageKey,
          offset: Math.round(node.getBoundingClientRect().top - top),
        }
      : null;
  });
/** The rows that carry a New marker, by message id. */
const unreadMarkers = (page: Page) =>
  scroller(page).evaluate((element) =>
    [...element.querySelectorAll('.room-divider--unread')].map(
      (marker) =>
        marker.closest<HTMLElement>('[data-chat-message-key]')?.dataset
          .chatMessageKey,
    ),
  );
const call = (page: Page, method: 'append' | 'prepend', count: number) =>
  page.evaluate(
    ([name, value]) =>
      (
        window as unknown as {
          room: Record<string, (count: number) => void>;
        }
      ).room[name]!(value),
    [method, count] as const,
  );
const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );

test.each([
  { mode: 'every row rendered', initial: 40 },
  { mode: 'virtualized', initial: 200 },
])(
  'follows the newest message until the reader scrolls up, then holds their place and counts new ones ($mode)',
  async ({ initial }) => {
    const { browser, page, errors } = await scrollBrowserFixture(
      fixture(initial),
    );
    try {
      await scroller(page).waitFor();
      await expect.poll(() => distanceFromEnd(page)).toBeLessThanOrEqual(1);

      // Following: a new message keeps the end in view.
      await call(page, 'append', 2);
      await settle(page);
      await expect.poll(() => distanceFromEnd(page)).toBeLessThanOrEqual(1);

      // The reader scrolls up with the wheel.
      const box = await scroller(page).boundingBox();
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.mouse.wheel(0, -900);
      await expect.poll(() => distanceFromEnd(page)).toBeGreaterThan(400);
      await settle(page);
      const before = await readerRow(page);
      expect(before).not.toBeNull();

      // New messages arrive: the reader does not move; the count shows.
      await call(page, 'append', 3);
      await settle(page);
      expect(await readerRow(page)).toEqual(before);
      await page
        .getByRole('button', { name: '3 new messages', exact: true })
        .waitFor();

      // Older history loads above: the reader still does not move.
      await call(page, 'prepend', 30);
      await settle(page);
      await settle(page);
      expect(await readerRow(page)).toEqual(before);

      // Momentum: a scroll long after the last input still moves the
      // reader's place, so the next arrival keeps them where they ended up.
      await page.waitForTimeout(1000);
      await scroller(page).evaluate((element) => {
        element.scrollTop -= 150;
      });
      await settle(page);
      const drifted = await readerRow(page);
      expect(drifted).not.toEqual(before);
      await call(page, 'append', 1);
      await settle(page);
      await settle(page);
      expect(await readerRow(page)).toEqual(drifted);

      // Jump to latest returns to the end and clears the count.
      await page
        .getByRole('button', { name: '4 new messages', exact: true })
        .click();
      await expect.poll(() => distanceFromEnd(page)).toBeLessThanOrEqual(1);
      await expect
        .poll(() => page.getByRole('button', { name: /new message/ }).count())
        .toBe(0);
      // Reading to the end retires the old New marker (#4810 review 5).
      await expect.poll(() => unreadMarkers(page)).toEqual([]);

      // A second away-and-back cycle marks only its own first arrival.
      const lastBefore = 1000 + initial - 1 + 2 + 3 + 1;
      await page.mouse.wheel(0, -300);
      await expect.poll(() => distanceFromEnd(page)).toBeGreaterThan(100);
      await settle(page);
      await call(page, 'append', 2);
      await settle(page);
      await page
        .getByRole('button', { name: '2 new messages', exact: true })
        .waitFor();
      await expect
        .poll(() => unreadMarkers(page))
        .toEqual([`m${lastBefore + 1}`]);
      await page
        .getByRole('button', { name: '2 new messages', exact: true })
        .click();
      await expect.poll(() => unreadMarkers(page)).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  },
);
