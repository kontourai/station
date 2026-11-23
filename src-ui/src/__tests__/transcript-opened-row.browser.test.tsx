/**
 * A row the reader opens at the end of the transcript stays where it is,
 * including as what it opened finishes rendering, an answer still streaming
 * and a new turn arriving: Scroll to bottom shows while it is held, and the
 * tail is followed again once the reader is back at the end.
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
  settledAtTail,
  tailFixture,
} from './transcript-tail-fixture';

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
        // A new turn arriving while held is not followed either: Scroll to
        // bottom tells the reader it is there.
        await page.evaluate(() =>
          (window as unknown as { __appendTurn(): void }).__appendTurn(),
        );
        await frames(page);
        await page.waitForTimeout(300);
        expect(await rowTop(page), 'a new turn').toBeCloseTo(before, 0);
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
      // The reader jumps to the end in one step (a scrollbar drag to the
      // bottom), never scrolling up on the way.
      await page
        .getByRole('log', { name: 'Conversation transcript' })
        .evaluate((log) => {
          log.scrollTop = log.scrollHeight;
        });
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
