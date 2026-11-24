/**
 * A reader away from the end keeps the rows they are reading: the window's
 * reload, which drops the oldest turns from the front for a reader at the
 * end, keeps what it holds while the list reports them away. Back at the end,
 * the next reload trims again, far above them, and nothing jumps.
 */
import type { Page } from '@playwright/test';
import { expect, test } from 'vitest';
import {
  DESKTOP,
  distanceFromEnd,
  frames,
  PHONE,
  settledAtTail,
  tailFixture,
} from './transcript-tail-fixture';

const reload = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __reload(turns?: number): void }).__reload(2),
  );

const rowCount = (page: Page) =>
  page.evaluate(() => document.querySelectorAll('.chat-message-anchor').length);

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
        .querySelector(`[data-chat-message-key="${rowKey}"]`)
        ?.getBoundingClientRect().top ?? null,
    key,
  );

async function wheelOver(page: Page, deltaY: number) {
  const log = (await page
    .getByRole('log', { name: 'Conversation transcript' })
    .boundingBox())!;
  await page.mouse.move(log.x + log.width / 2, log.y + log.height / 2);
  await page.mouse.wheel(0, deltaY);
}

for (const [name, viewport] of [
  ['desktop', DESKTOP],
  ['phone', PHONE],
] as const) {
  test(`(${name}) a reload keeps the rows a reader away from the end is reading`, async () => {
    const { browser, page, errors } = await tailFixture(viewport, 12);
    try {
      await settledAtTail(page);
      await wheelOver(page, -2000);
      await expect.poll(() => distanceFromEnd(page)).toBeGreaterThan(1_500);
      await page.waitForTimeout(400);
      await frames(page);
      const before = await lookingAt(page);
      expect(before).not.toBeNull();
      const rows = await rowCount(page);
      await reload(page);
      await frames(page);
      await page.waitForTimeout(300);
      expect(await rowCount(page), 'rows above the reader kept').toBe(rows);
      const after = await topOf(page, before!.key);
      expect(after, 'the row being read is still there').not.toBeNull();
      expect(
        Math.abs(after! - before!.top),
        'the row being read',
      ).toBeLessThanOrEqual(2);
      expect(
        await page.getByRole('button', { name: 'Scroll to bottom' }).count(),
      ).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test(`(${name}) back at the end, the next reload trims the window without moving the reader`, async () => {
    const { browser, page, errors } = await tailFixture(viewport, 12);
    try {
      await settledAtTail(page);
      await wheelOver(page, -2000);
      await expect.poll(() => distanceFromEnd(page)).toBeGreaterThan(1_500);
      await page.waitForTimeout(400);
      await reload(page);
      await frames(page);
      const kept = await rowCount(page);
      // Back to the end, then the next reload: the oldest turns leave.
      await wheelOver(page, 20_000);
      await expect.poll(() => distanceFromEnd(page)).toBeLessThanOrEqual(1);
      await page.waitForTimeout(400);
      await frames(page);
      await reload(page);
      await frames(page);
      await expect.poll(() => rowCount(page)).toBeLessThan(kept);
      expect(
        await distanceFromEnd(page),
        'still at the end',
      ).toBeLessThanOrEqual(1);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });
}
