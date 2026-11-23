/**
 * A row the reader opens at the end of the transcript stays where it is,
 * including as what it opened finishes rendering, an answer still streaming
 * and a new answer arriving: Scroll to bottom shows while it is held, and the
 * tail is followed again once the reader is back at the end. What needs the
 * reader ends the hold (their own message, a request), and so does closing
 * the row or switching chats.
 */
import type { Page } from '@playwright/test';
import { expect, test } from 'vitest';
import {
  DESKTOP,
  distanceFromEnd,
  frames,
  lastToolRow,
  PHONE,
  rowTop,
  setNotice,
  settledAtTail,
  tailFixture,
} from './transcript-tail-fixture';

const call = (page: Page, name: string, arg?: unknown) =>
  page.evaluate(
    ([fn, value]) =>
      (window as unknown as Record<string, (v: unknown) => void>)[
        fn as string
      ]!(value),
    [name, arg] as const,
  );

const scrollToBottom = (page: Page) =>
  page.getByRole('button', { name: 'Scroll to bottom' });

/** The newest answer keeps streaming, a few words every 40ms. */
function startStream(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as {
      __streamTail(text: string): void;
      __stream?: number;
    };
    w.__stream = window.setInterval(
      () => w.__streamTail(' and a few more streamed words'),
      40,
    );
  });
}
function stopStream(page: Page) {
  return page.evaluate(() =>
    window.clearInterval((window as unknown as { __stream: number }).__stream),
  );
}

/** Opens the newest tool row, then grows it 600px past the input grace. */
async function openAndGrow(page: Page) {
  const row = lastToolRow(page);
  await row.click();
  await expect.poll(() => row.getAttribute('aria-expanded')).toBe('true');
  await page.waitForTimeout(1_500);
  await row.evaluate((button) => {
    const late = document.createElement('div');
    late.style.height = '600px';
    button.closest('.chat-message-anchor')!.append(late);
  });
  await frames(page);
  return row;
}

/** Wheels over the middle of the transcript. */
async function wheelOver(page: Page, deltaY: number) {
  const log = (await page
    .getByRole('log', { name: 'Conversation transcript' })
    .boundingBox())!;
  await page.mouse.move(log.x + log.width / 2, log.y + log.height / 2);
  await page.mouse.wheel(0, deltaY);
}

/** The row the reader is looking at: the first whose top is in view. */
const lookingAt = (page: Page) =>
  page.evaluate(() => {
    const view = document
      .querySelector('.chat-messages')!
      .getBoundingClientRect();
    const row = [...document.querySelectorAll('.chat-message-anchor')].find(
      (candidate) => {
        const top = candidate.getBoundingClientRect().top;
        return top >= view.top && top < view.bottom - 40;
      },
    );
    return row
      ? {
          key: row.getAttribute('data-chat-message-key')!,
          top: row.getBoundingClientRect().top,
        }
      : null;
  });

const topOf = (page: Page, key: string) =>
  page.evaluate(
    (rowKey) =>
      document
        .querySelector(`[data-chat-message-key="${rowKey}"]`)!
        .getBoundingClientRect().top,
    key,
  );

const transcriptTop = (page: Page) =>
  page
    .getByRole('log', { name: 'Conversation transcript' })
    .evaluate((element) => element.scrollTop);

/**
 * The answer under the held row grows, then a scroll event arrives with no
 * reader input and no movement, as the app's layout produces one.
 */
async function growWithoutReader(page: Page) {
  for (let i = 0; i < 6; i += 1)
    await call(page, '__streamTail', ' and the rest of the answer lands');
  await frames(page);
  await page
    .getByRole('log', { name: 'Conversation transcript' })
    .evaluate((element) => element.dispatchEvent(new Event('scroll')));
  await frames(page);
}

/**
 * A drag of the transcript's own scrollbar: a press on the scroller itself
 * (not on a row inside it), the view moving by `by` px (or to the end)
 * while the button is down, and the release. Headless Chromium hides scrollbars, so the press
 * lands on the scroller's own gutter, which is the same element.
 */
async function dragScroller(page: Page, by: number | 'end') {
  const log = page.getByRole('log', { name: 'Conversation transcript' });
  const point = await log.evaluate((element) => {
    const box = element.getBoundingClientRect();
    for (let x = Math.floor(box.right) - 1; x > box.left; x -= 1)
      for (const y of [box.top + box.height / 2, box.top + 12, box.bottom - 12])
        if (document.elementFromPoint(x, y) === element) return { x, y };
    return null;
  });
  expect(point, 'a point on the scroller itself').not.toBeNull();
  // The reader was in the composer: the press moves focus, and the blur that
  // follows inside the page must not drop the press.
  await page.locator('.chat-input textarea').focus();
  await page.mouse.move(point!.x, point!.y);
  await page.mouse.down();
  await log.evaluate((element, delta) => {
    element.scrollTop =
      delta === 'end' ? element.scrollHeight : element.scrollTop + delta;
  }, by);
  await frames(page);
  await page.mouse.up();
  await frames(page);
}

for (const [name, viewport] of [
  ['desktop', DESKTOP],
  ['phone', PHONE],
] as const) {
  test.each([
    ['a short transcript', 6],
    ['a virtualized transcript', 30],
  ])(
    `(${name}, %s) a tool row opened at the tail keeps its header in view until new content arrives`,
    async (_label, turns) => {
      const { browser, page, errors } = await tailFixture(viewport, turns);
      try {
        await settledAtTail(page);
        const row = lastToolRow(page);
        const before = await rowTop(page);
        await row.click();
        await expect.poll(() => row.getAttribute('aria-expanded')).toBe('true');
        // Past the reader-interaction grace and any late detail rendering.
        await page.waitForTimeout(1_500);
        await frames(page);
        expect(await rowTop(page), 'the opened row stays put').toBeCloseTo(
          before,
          0,
        );
        expect(await distanceFromEnd(page)).toBeGreaterThan(0);
        // What the reader opened finishes rendering after the grace (a late
        // code-split detail, highlighting, an image): it still holds still.
        await row.evaluate((button) => {
          const late = document.createElement('div');
          late.style.height = '600px';
          late.dataset.lateDetail = 'true';
          button.closest('.chat-message-anchor')!.append(late);
        });
        await frames(page);
        expect(await rowTop(page), 'late detail growth').toBeCloseTo(before, 0);
        // A new answer arriving while held is not followed either: Scroll to
        // bottom tells the reader it is there.
        await call(page, '__answer', 'A new answer arrives at the tail.');
        await frames(page);
        await page.waitForTimeout(300);
        expect(await rowTop(page), 'a new answer').toBeCloseTo(before, 0);
        await expect.poll(() => scrollToBottom(page).count()).toBe(1);
        // Back at the end, the tail is followed again.
        await scrollToBottom(page).click();
        await expect.poll(() => distanceFromEnd(page)).toBeLessThanOrEqual(1);
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
      }
    },
  );

  test(`(${name}) a row opened inside a streaming answer stays put while it streams`, async () => {
    const { browser, page, errors } = await tailFixture(viewport);
    try {
      await settledAtTail(page);
      await startStream(page);
      const row = lastToolRow(page);
      await row.click();
      await expect.poll(() => row.getAttribute('aria-expanded')).toBe('true');
      await frames(page);
      const opened = await rowTop(page);
      // Well past the input grace, with tokens arriving all the while.
      await page.waitForTimeout(1_500);
      await frames(page);
      expect(await rowTop(page), 'the opened row stays put').toBeCloseTo(
        opened,
        0,
      );
      expect(await scrollToBottom(page).count()).toBe(1);
      // Back at the end, the stream is followed again.
      await scrollToBottom(page).click();
      await expect.poll(() => distanceFromEnd(page)).toBeLessThanOrEqual(1);
      await page.waitForTimeout(500);
      await expect.poll(() => distanceFromEnd(page)).toBeLessThanOrEqual(1);
      expect(await rowTop(page), 'followed again').toBeLessThan(opened - 20);
      await stopStream(page);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test(`(${name}) the reader's own message ends the hold and is followed`, async () => {
    const { browser, page, errors } = await tailFixture(viewport);
    try {
      await settledAtTail(page);
      await openAndGrow(page);
      expect(await distanceFromEnd(page)).toBeGreaterThan(100);
      await call(page, '__sendUser', 'My own new question');
      await expect.poll(() => distanceFromEnd(page)).toBeLessThanOrEqual(1);
      await expect.poll(() => scrollToBottom(page).count()).toBe(0);
      // Their answer streams in and is followed.
      await call(page, '__answer', 'The answer to my question.');
      for (let i = 0; i < 10; i += 1)
        await call(page, '__streamTail', ' and more words of the answer');
      await frames(page);
      await expect.poll(() => distanceFromEnd(page)).toBeLessThanOrEqual(1);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test(`(${name}) a request opening ends the hold and comes into view`, async () => {
    const { browser, page, errors } = await tailFixture(viewport);
    try {
      await settledAtTail(page);
      await openAndGrow(page);
      expect(await distanceFromEnd(page)).toBeGreaterThan(100);
      await call(page, '__setRequest', 'approval');
      await frames(page);
      await expect.poll(() => distanceFromEnd(page)).toBeLessThanOrEqual(1);
      await expect.poll(() => scrollToBottom(page).count()).toBe(0);
      const card = page.locator('.pending-approvals').last();
      await card.waitFor();
      const log = (await page
        .getByRole('log', { name: 'Conversation transcript' })
        .boundingBox())!;
      const shown = (await card.boundingBox())!;
      expect(shown.y + shown.height).toBeLessThanOrEqual(log.y + log.height);
      expect(shown.y).toBeGreaterThanOrEqual(log.y);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  // A reader who left the end, held row or not, is not taken back to it by a
  // send or a request: Scroll to bottom stays to tell them it is there.
  test.each([
    ['a request opens during a hold', true, 'request'],
    ['the reader sends during a hold', true, 'send'],
    ['a request opens with no hold', false, 'request'],
  ] as const)(
    `(${name}) a reader far up stays put when %s`,
    async (_label, hold, event) => {
      const { browser, page, errors } = await tailFixture(viewport, 30);
      try {
        await settledAtTail(page);
        if (hold) await openAndGrow(page);
        const log = (await page
          .getByRole('log', { name: 'Conversation transcript' })
          .boundingBox())!;
        await page.mouse.move(log.x + log.width / 2, log.y + log.height / 2);
        await page.mouse.wheel(0, -3000);
        await expect.poll(() => distanceFromEnd(page)).toBeGreaterThan(2_000);
        await page.waitForTimeout(400);
        await frames(page);
        await expect.poll(() => scrollToBottom(page).count()).toBe(1);
        if (event === 'request') await call(page, '__setRequest', 'approval');
        else await call(page, '__sendUser', 'My own new question');
        await frames(page);
        await page.waitForTimeout(300);
        expect(await distanceFromEnd(page), 'not moved').toBeGreaterThan(2_000);
        expect(await scrollToBottom(page).count()).toBe(1);
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
      }
    },
  );

  test(`(${name}) closing the held row ends the hold`, async () => {
    const { browser, page, errors } = await tailFixture(viewport);
    try {
      await settledAtTail(page);
      const row = await openAndGrow(page);
      expect(await distanceFromEnd(page)).toBeGreaterThan(100);
      // What it opened goes with it, and the reader closes the row.
      await row.evaluate((button) => {
        const anchor = button.closest('.chat-message-anchor')!;
        anchor.lastElementChild!.remove();
      });
      await row.click();
      await expect.poll(() => row.getAttribute('aria-expanded')).toBe('false');
      await page.waitForTimeout(1_200);
      await frames(page);
      // The end is in view again, nothing says otherwise, and the next
      // tokens are followed.
      expect(await distanceFromEnd(page)).toBeLessThanOrEqual(1);
      expect(await scrollToBottom(page).count()).toBe(0);
      for (let i = 0; i < 10; i += 1)
        await call(page, '__streamTail', ' and more words after closing');
      await frames(page);
      await expect.poll(() => distanceFromEnd(page)).toBeLessThanOrEqual(1);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test(`(${name}) closing the held row after content passed the end keeps the reader where they are`, async () => {
    const { browser, page, errors } = await tailFixture(viewport);
    try {
      await settledAtTail(page);
      const row = await openAndGrow(page);
      await call(page, '__answer', 'A new answer that arrived while held.');
      await frames(page);
      await row.click();
      await expect.poll(() => row.getAttribute('aria-expanded')).toBe('false');
      await page.waitForTimeout(1_200);
      await frames(page);
      const closed = await rowTop(page);
      // Not at the end: they are scrolled up like any reader, and told so.
      expect(await scrollToBottom(page).count()).toBe(1);
      await call(page, '__streamTail', ' more words below');
      await frames(page);
      expect(await rowTop(page)).toBeCloseTo(closed, 0);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test(`(${name}) the server's copy of the reader's message replacing their bubble keeps the hold`, async () => {
    const { browser, page, errors } = await tailFixture(viewport);
    try {
      await call(page, '__beginTurn');
      await settledAtTail(page);
      await openAndGrow(page);
      const held = await rowTop(page);
      expect(await distanceFromEnd(page)).toBeGreaterThan(100);
      // Same message, its id now the server's: nothing new appeared.
      await call(page, '__serverCopy', 'client-a');
      await frames(page);
      await page.waitForTimeout(300);
      expect(await rowTop(page), 'not moved').toBeCloseTo(held, 0);
      expect(await scrollToBottom(page).count()).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test(`(${name}) a scroll event the reader did not cause leaves a holding reader at the end's side`, async () => {
    const { browser, page, errors } = await tailFixture(viewport);
    try {
      await settledAtTail(page);
      await openAndGrow(page);
      const top = await transcriptTop(page);
      await growWithoutReader(page);
      expect(await transcriptTop(page), 'nothing moved').toBe(top);
      // Not scrolled up: their own message still ends the hold and is
      // followed, as for any holding reader.
      await call(page, '__sendUser', 'My own new question');
      await expect.poll(() => distanceFromEnd(page)).toBeLessThanOrEqual(1);
      await expect.poll(() => scrollToBottom(page).count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test(`(${name}) a follow-up queued during a turn, then a row opened, is followed when it is delivered`, async () => {
    const { browser, page, errors } = await tailFixture(viewport);
    try {
      await call(page, '__beginTurn');
      await settledAtTail(page);
      await call(page, '__queueFollowUp', 'Also check the release notes.');
      await page.waitForTimeout(400);
      await settledAtTail(page);
      await openAndGrow(page);
      expect(await distanceFromEnd(page)).toBeGreaterThan(100);
      // The answer lands, the reader's bubble becomes the server's copy, the
      // turn ends and Station delivers the follow-up.
      await growWithoutReader(page);
      await call(page, '__serverCopy', 'client-a');
      await frames(page);
      await call(page, '__setLive', false);
      await frames(page);
      await call(page, '__deliver', 'Also check the release notes.');
      await expect.poll(() => distanceFromEnd(page)).toBeLessThanOrEqual(1);
      await expect.poll(() => scrollToBottom(page).count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test(`(${name}) a row opened, then a follow-up queued, holds until it is delivered`, async () => {
    const { browser, page, errors } = await tailFixture(viewport);
    try {
      await call(page, '__beginTurn');
      await settledAtTail(page);
      await openAndGrow(page);
      const held = await rowTop(page);
      await call(page, '__queueFollowUp', 'Also check the release notes.');
      await page.waitForTimeout(400);
      await frames(page);
      expect(await rowTop(page), 'queueing alone').toBeCloseTo(held, 0);
      expect(await scrollToBottom(page).count()).toBe(1);
      await call(page, '__setLive', false);
      await frames(page);
      await call(page, '__deliver', 'Also check the release notes.');
      await expect.poll(() => distanceFromEnd(page)).toBeLessThanOrEqual(1);
      await expect.poll(() => scrollToBottom(page).count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test(`(${name}) content shrinking above a held row, the browser clamping scrollTop, keeps the hold`, async () => {
    const { browser, page, errors } = await tailFixture(viewport, 16);
    try {
      await settledAtTail(page);
      await openAndGrow(page);
      const distance = await distanceFromEnd(page);
      expect(distance).toBeGreaterThan(100);
      const top = await transcriptTop(page);
      // Earlier rows render smaller (collapsed by their own content) by more
      // than the distance to the end: the browser clamps scrollTop to the
      // new end, a scroll the reader did not make.
      const removed = await page.evaluate((needed) => {
        let total = 0;
        for (const row of document.querySelectorAll<HTMLElement>(
          '.chat-message-anchor',
        )) {
          if (total > needed + 200) break;
          total += row.getBoundingClientRect().height;
          row.style.display = 'none';
        }
        return total;
      }, distance);
      expect(removed).toBeGreaterThan(distance);
      await frames(page);
      expect(await transcriptTop(page), 'clamped').toBeLessThan(top - 50);
      const held = await rowTop(page);
      await call(page, '__answer', 'A new answer arrives at the tail.');
      for (let i = 0; i < 6; i += 1)
        await call(page, '__streamTail', ' and more words of the answer');
      await frames(page);
      await page.waitForTimeout(300);
      expect(await rowTop(page), 'still held').toBeCloseTo(held, 0);
      await expect.poll(() => scrollToBottom(page).count()).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test(`(${name}) the reader's message keeps the hold through its server copy, under a queued bubble`, async () => {
    const { browser, page, errors } = await tailFixture(viewport);
    try {
      // Typed with no turn running, then its turn starts: the bubble gains
      // its turn and event.
      await call(page, '__sendBubble', 'Check the deploy script once more.');
      await frames(page);
      await call(page, '__startBubbleTurn');
      await settledAtTail(page);
      await openAndGrow(page);
      const held = await rowTop(page);
      expect(await distanceFromEnd(page)).toBeGreaterThan(100);
      // A follow-up's bubble covers it while the server's copy replaces it
      // (a new id, no client id); then the bubble goes and it is last again.
      await call(page, '__queueFollowUp', 'Also check the release notes.');
      await frames(page);
      await call(page, '__serverCopy', 'client-c');
      await page.waitForTimeout(400);
      await frames(page);
      expect(await rowTop(page), 'not moved').toBeCloseTo(held, 0);
      expect(await scrollToBottom(page).count()).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test(`(${name}) a reader who drags the scrollbar away from a held row is not taken to their send`, async () => {
    const { browser, page, errors } = await tailFixture(viewport);
    try {
      await settledAtTail(page);
      await openAndGrow(page);
      const before = await distanceFromEnd(page);
      await dragScroller(page, -300);
      expect(await distanceFromEnd(page)).toBeGreaterThan(before + 250);
      await call(page, '__sendUser', 'My own new question');
      await frames(page);
      await page.waitForTimeout(300);
      expect(await distanceFromEnd(page), 'not followed').toBeGreaterThan(
        before,
      );
      expect(await scrollToBottom(page).count()).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test(`(${name}) a reader who wheeled up from a held row stays put as the pending list appears`, async () => {
    const { browser, page, errors } = await tailFixture(viewport, 30);
    try {
      await settledAtTail(page);
      await openAndGrow(page);
      const log = (await page
        .getByRole('log', { name: 'Conversation transcript' })
        .boundingBox())!;
      await page.mouse.move(log.x + log.width / 2, log.y + log.height / 2);
      await page.mouse.wheel(0, -2000);
      await expect.poll(() => distanceFromEnd(page)).toBeGreaterThan(2_000);
      await page.waitForTimeout(400);
      await frames(page);
      // The row the reader is looking at: the first whose top is in view.
      const looking = () =>
        page.evaluate(() => {
          const view = document
            .querySelector('.chat-messages')!
            .getBoundingClientRect();
          const rows = [...document.querySelectorAll('.chat-message-anchor')];
          const row = rows.find((candidate) => {
            const top = candidate.getBoundingClientRect().top;
            return top >= view.top && top < view.bottom - 40;
          });
          return row
            ? {
                key: row.getAttribute('data-chat-message-key'),
                top: row.getBoundingClientRect().top,
              }
            : null;
        });
      const before = await looking();
      expect(before).not.toBeNull();
      // A follow-up is queued: the pending list takes room above the
      // composer and the transcript gets shorter.
      await call(page, '__queueFollowUp', 'Also check the release notes.');
      await setNotice(page, 'queued');
      await page.waitForTimeout(400);
      await frames(page);
      const after = await page.evaluate(
        (key) =>
          document
            .querySelector(`[data-chat-message-key="${key}"]`)
            ?.getBoundingClientRect().top ?? null,
        before!.key,
      );
      // A few px of re-measurement, never the jump to the held row.
      expect(
        Math.abs(after! - before!.top),
        'the row being read',
      ).toBeLessThanOrEqual(8);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test(`(${name}) loading earlier history keeps the hold`, async () => {
    const { browser, page, errors } = await tailFixture(viewport);
    try {
      await call(page, '__answersOnly');
      await settledAtTail(page);
      await openAndGrow(page);
      expect(await distanceFromEnd(page)).toBeGreaterThan(100);
      await call(page, '__loadOlder');
      await frames(page);
      await page.waitForTimeout(300);
      expect(await distanceFromEnd(page), 'not moved').toBeGreaterThan(100);
      expect(await scrollToBottom(page).count()).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test(`(${name}) switching chats ends the hold`, async () => {
    const { browser, page, errors } = await tailFixture(viewport);
    try {
      await settledAtTail(page);
      await openAndGrow(page);
      expect(await distanceFromEnd(page)).toBeGreaterThan(100);
      await call(page, '__switchSession');
      await frames(page);
      await expect.poll(() => distanceFromEnd(page)).toBeLessThanOrEqual(1);
      await expect.poll(() => scrollToBottom(page).count()).toBe(0);
      for (let i = 0; i < 10; i += 1)
        await call(page, '__streamTail', ' words in the other chat');
      await frames(page);
      await expect.poll(() => distanceFromEnd(page)).toBeLessThanOrEqual(1);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test(`(${name}) a reader who wheeled a little way up from a held row stays put as the view gets shorter`, async () => {
    const { browser, page, errors } = await tailFixture(viewport);
    try {
      await settledAtTail(page);
      const row = await openAndGrow(page);
      await wheelOver(page, -500);
      await page.waitForTimeout(400);
      await frames(page);
      // The held row is still in the page, below the view: the step that
      // brings it back could reach it.
      expect(
        await row.evaluate((button) => button.isConnected),
        'held row still in the page',
      ).toBe(true);
      const before = await lookingAt(page);
      expect(before).not.toBeNull();
      await page.setViewportSize({
        width: viewport.width,
        height: Math.round(viewport.height * 0.6),
      });
      await frames(page);
      await page.waitForTimeout(300);
      expect(
        Math.abs((await topOf(page, before!.key)) - before!.top),
        'the row being read',
      ).toBeLessThanOrEqual(8);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test(`(${name}) the held row drawn again closed ends the hold and the end is followed`, async () => {
    const { browser, page, errors } = await tailFixture(viewport);
    try {
      await settledAtTail(page);
      await openAndGrow(page);
      expect(await distanceFromEnd(page)).toBeGreaterThan(100);
      // The turn settles: its answer is drawn again and the row comes back
      // closed. Nothing is open to protect any more.
      await call(page, '__redrawLast');
      await frames(page);
      await expect.poll(() => distanceFromEnd(page)).toBeLessThanOrEqual(1);
      await expect.poll(() => scrollToBottom(page).count()).toBe(0);
      await call(page, '__answer', 'The next answer arrives.');
      for (let i = 0; i < 10; i += 1)
        await call(page, '__streamTail', ' and more words of it');
      await frames(page);
      await expect.poll(() => distanceFromEnd(page)).toBeLessThanOrEqual(1);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test(`(${name}) the held row drawn again closed leaves a reader who wheeled away where they are`, async () => {
    const { browser, page, errors } = await tailFixture(viewport);
    try {
      await settledAtTail(page);
      await openAndGrow(page);
      await wheelOver(page, -300);
      await page.waitForTimeout(400);
      await frames(page);
      const before = await lookingAt(page);
      expect(before).not.toBeNull();
      await call(page, '__redrawLast');
      await frames(page);
      await page.waitForTimeout(300);
      expect(
        Math.abs((await topOf(page, before!.key)) - before!.top),
        'the row being read',
      ).toBeLessThanOrEqual(8);
      expect(await distanceFromEnd(page)).toBeGreaterThan(100);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test(`(${name}) a chat switched to with a queued follow-up last is held as on a fresh mount`, async () => {
    const { browser, page, errors } = await tailFixture(viewport);
    try {
      await settledAtTail(page);
      // A turn runs in this chat when the reader switches away.
      await call(page, '__beginTurn');
      await frames(page);
      await call(page, '__switchToQueued', 'Also check the release notes.');
      await frames(page);
      await expect.poll(() => distanceFromEnd(page)).toBeLessThanOrEqual(1);
      await openAndGrow(page);
      expect(await distanceFromEnd(page)).toBeGreaterThan(100);
      // That chat's turn ends and an answer lands: the queued message was
      // there from the start, so it is nothing new.
      await call(page, '__setLive', false);
      await call(page, '__answer', 'An answer lands in the other chat.');
      await frames(page);
      await page.waitForTimeout(300);
      expect(await distanceFromEnd(page), 'still held').toBeGreaterThan(100);
      expect(await scrollToBottom(page).count()).toBe(1);
      // A message of theirs that is new ends the hold.
      await call(page, '__sendUser', 'My own new question');
      await expect.poll(() => distanceFromEnd(page)).toBeLessThanOrEqual(1);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test(`(${name}) an incidental tap does not stop the tail being followed`, async () => {
    const { browser, page, errors } = await tailFixture(viewport);
    try {
      await settledAtTail(page);
      // The newest answer's text, not a disclosure.
      const answer = page
        .locator('.chat-message-anchor')
        .last()
        .getByText(/^Reply 6:/);
      await answer.click();
      const grow = () =>
        answer.evaluate((element) => {
          const late = document.createElement('div');
          late.style.height = '300px';
          element.closest('.chat-message-anchor')!.append(late);
        });
      // The answer grows inside the tap's interaction window (a renderer
      // arriving), then again after it (an image): the tap opened nothing,
      // so the end is followed again.
      await grow();
      await frames(page);
      await page.waitForTimeout(1_500);
      await grow();
      await frames(page);
      await expect.poll(() => distanceFromEnd(page)).toBeLessThanOrEqual(1);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test(`(${name}) returning to the end releases the hold`, async () => {
    const { browser, page, errors } = await tailFixture(viewport);
    try {
      await settledAtTail(page);
      const row = lastToolRow(page);
      await row.click();
      await expect.poll(() => row.getAttribute('aria-expanded')).toBe('true');
      await page.waitForTimeout(1_500);
      const grow = () =>
        row.evaluate((button) => {
          const late = document.createElement('div');
          late.style.height = '600px';
          button.closest('.chat-message-anchor')!.append(late);
        });
      // Held: the opened row grows and the end is left below.
      await grow();
      await frames(page);
      expect(await distanceFromEnd(page)).toBeGreaterThan(100);
      // The reader drags the scrollbar to the end in one step, never
      // scrolling up on the way.
      await dragScroller(page, 'end');
      await expect.poll(() => distanceFromEnd(page)).toBeLessThanOrEqual(1);
      await page.waitForTimeout(1_500);
      // Back at the end the tail is followed again.
      await grow();
      await frames(page);
      await expect.poll(() => distanceFromEnd(page)).toBeLessThanOrEqual(1);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test(`(${name}) a shorter view keeps the opened row in sight and the hold on`, async () => {
    const { browser, page, errors } = await tailFixture(viewport);
    try {
      await settledAtTail(page);
      const row = lastToolRow(page);
      await row.click();
      await expect.poll(() => row.getAttribute('aria-expanded')).toBe('true');
      await page.waitForTimeout(1_500);
      // A keyboard opens: the dock loses the bottom half of the screen.
      await page.setViewportSize({
        width: viewport.width,
        height: Math.round(viewport.height * 0.46),
      });
      await frames(page);
      const log = await page
        .getByRole('log', { name: 'Conversation transcript' })
        .boundingBox();
      const header = await row.boundingBox();
      expect(header!.y, 'header below the top').toBeGreaterThanOrEqual(log!.y);
      expect(
        header!.y + header!.height,
        'header above the shortened view’s bottom',
      ).toBeLessThanOrEqual(log!.y + log!.height);
      // The keyboard closes; the hold is still on: late growth stays put.
      await page.setViewportSize(viewport);
      await frames(page);
      const before = await rowTop(page);
      await row.evaluate((button) => {
        const late = document.createElement('div');
        late.style.height = '600px';
        button.closest('.chat-message-anchor')!.append(late);
      });
      await frames(page);
      expect(await rowTop(page), 'still held after the resize').toBeCloseTo(
        before,
        0,
      );
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });
}

// Smooth keyboard scrolling and the glide, as a desktop reader has them.
const SMOOTH = { reducedMotion: 'no-preference' } as const;

test('(desktop) holding a row shows Scroll to bottom without moving the row', async () => {
  const { browser, page, errors } = await tailFixture(DESKTOP, SMOOTH);
  try {
    await settledAtTail(page);
    const before = await rowTop(page);
    const row = lastToolRow(page);
    await row.click();
    await expect.poll(() => row.getAttribute('aria-expanded')).toBe('true');
    await scrollToBottom(page).waitFor();
    await page.waitForTimeout(1_500);
    await frames(page);
    expect(await rowTop(page), 'the held row').toBeCloseTo(before, 0);
    expect(await scrollToBottom(page).isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('(desktop) with a row held, one End reaches the end', async () => {
  const { browser, page, errors } = await tailFixture(DESKTOP, SMOOTH);
  try {
    await settledAtTail(page);
    await openAndGrow(page);
    expect(await distanceFromEnd(page)).toBeGreaterThan(100);
    // (That Scroll to bottom shows is pinned above; this is about End.)
    await page.keyboard.press('End');
    // The smooth scroll settles.
    await page.waitForTimeout(1_500);
    await frames(page);
    expect(await distanceFromEnd(page)).toBeLessThanOrEqual(1);
    expect(await scrollToBottom(page).count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('(desktop) with a row held, Scroll to bottom reaches the end', async () => {
  const { browser, page, errors } = await tailFixture(DESKTOP, SMOOTH);
  try {
    await settledAtTail(page);
    await openAndGrow(page);
    await scrollToBottom(page).click();
    await page.waitForTimeout(1_500);
    await frames(page);
    expect(await distanceFromEnd(page)).toBeLessThanOrEqual(1);
    expect(await scrollToBottom(page).count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('(desktop) a row opened in a transcript that still fits shows no Scroll to bottom', async () => {
  const { browser, page, errors } = await tailFixture(DESKTOP, 1);
  try {
    await lastToolRow(page).waitFor();
    await frames(page);
    const row = lastToolRow(page);
    await row.click();
    await expect.poll(() => row.getAttribute('aria-expanded')).toBe('true');
    await page.waitForTimeout(1_500);
    await frames(page);
    // The opened row still fits: there is nothing below to scroll to.
    expect(await distanceFromEnd(page)).toBeLessThanOrEqual(1);
    expect(await scrollToBottom(page).count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
