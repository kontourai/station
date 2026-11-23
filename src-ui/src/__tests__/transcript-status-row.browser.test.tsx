/**
 * A conversation status appearing, changing or leaving does not move the
 * transcript's rows: the composer's status row floats over the transcript's
 * end, over room the transcript keeps there. It floats only while that end is
 * directly above the composer; with a card between them, or in a short dock,
 * it keeps its line in the composer and covers nothing.
 */
import type { Page } from '@playwright/test';
import { expect, test } from 'vitest';
import {
  frames,
  lastToolRow,
  type NoticeKind,
  pill,
  rowTop,
  setNextTurn,
  setNotice,
  setRequest,
  setStatus,
  settledAtTail,
  THEMES,
  tailFixture,
  transcript,
  VIEWPORTS,
} from './transcript-tail-fixture';

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

async function box(page: Page, selector: string) {
  const found = await page.locator(selector).boundingBox();
  expect(found, selector).not.toBeNull();
  return found!;
}

/** What a press at (x, y) reaches, by the nearest of the given selectors. */
function hitAt(page: Page, x: number, y: number, selectors: string[]) {
  return page.evaluate(
    ({ x, y, selectors }) => {
      const element = document.elementFromPoint(x, y);
      return selectors.find((s) => element?.closest(s)) ?? null;
    },
    { x, y, selectors },
  );
}

/** The transcript's last content box (a row, or a request card at its end). */
function lastContentBottom(page: Page) {
  return transcript(page).evaluate((log) => {
    const children = [...log.children].filter(
      (child) =>
        !child.matches('.chat-messages__status-room') &&
        child.getBoundingClientRect().height > 0,
    );
    return children.at(-1)!.getBoundingClientRect().bottom;
  });
}

for (const [width, viewport] of VIEWPORTS) {
  for (const theme of THEMES) {
    const name = `(${width}, ${theme})`;

    test(`${name} a status appearing, changing or leaving moves no row`, async () => {
      const { browser, page, errors } = await tailFixture(viewport, { theme });
      try {
        await settledAtTail(page);
        const before = await rowTop(page);
        for (const kind of ['catching-up', 'working', 'unavailable'] as const) {
          await setStatus(page, kind);
          expect(await rowTop(page), `${kind} appearing`).toBeCloseTo(
            before,
            0,
          );
          await setStatus(page);
          expect(await rowTop(page), `${kind} leaving`).toBeCloseTo(before, 0);
        }
        await setStatus(page, 'working');
        await setStatus(page, 'unavailable');
        expect(await rowTop(page), 'changing').toBeCloseTo(before, 0);
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
      }
    });

    test(`${name} at the end the pill covers no message and takes no press meant for the transcript`, async () => {
      const { browser, page, errors } = await tailFixture(viewport, { theme });
      try {
        await settledAtTail(page);
        // With no status, where the pill would show the transcript is hit.
        const log = (await transcript(page).boundingBox())!;
        for (const x of [log.x + log.width / 2, log.x + log.width - 48])
          expect(
            await hitAt(page, x, log.y + log.height - 16, [
              '.chat-input',
              '.chat-messages',
            ]),
            'where the pill would show',
          ).toBe('.chat-messages');
        for (const kind of ['working', 'unavailable'] as const) {
          await setStatus(page, kind);
          const shown = (await pill(page, kind).boundingBox())!;
          expect(
            await lastContentBottom(page),
            `${kind}: last message above the pill`,
          ).toBeLessThanOrEqual(shown.y + 0.5);
          const composer = await box(page, '.chat-input__capsule');
          expect(
            shown.y + shown.height,
            `${kind}: above the draft`,
          ).toBeLessThanOrEqual(composer.y + 0.5);
          expect(
            await hitAt(
              page,
              shown.x + shown.width / 2,
              shown.y + shown.height / 2,
              ['[data-chat-status-pill]'],
            ),
            `${kind}: the pill is on top where it shows`,
          ).toBe('[data-chat-status-pill]');
          for (const x of [8, shown.x - 12, shown.x + shown.width + 12].filter(
            (x) => x > 0 && x < viewport.width - 24,
          ))
            expect(
              await hitAt(page, x, shown.y + shown.height / 2, [
                '.chat-input__meta',
                '.chat-messages',
              ]),
              `${kind}: beside the pill at ${x} the transcript is hit`,
            ).toBe('.chat-messages');
        }
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
      }
    });

    test(`${name} with a card between the transcript and the composer the pill covers none of it`, async () => {
      const { browser, page, errors } = await tailFixture(viewport, { theme });
      try {
        await settledAtTail(page);
        const notices: Record<NoticeKind, string> = {
          recovery: '.conversation-open-recovery',
          queued: '.queued-messages-presence',
          'stream-status': '.chat-stream-status',
          wait: '.session-history-controls',
        };
        await setStatus(page, 'unavailable');
        for (const [kind, selector] of Object.entries(notices) as [
          NoticeKind,
          string,
        ][]) {
          await setNotice(page, kind);
          const card = await box(page, selector);
          const shown = (await pill(page, 'unavailable').boundingBox())!;
          expect(overlaps(card, shown), `${kind}: pill over the card`).toBe(
            false,
          );
          for (const control of await page
            .locator(`:is(${selector}) button`)
            .all()) {
            const target = (await control.boundingBox())!;
            expect(
              overlaps(target, shown),
              `${kind}: pill over a control`,
            ).toBe(false);
            // A press there reaches the card (a neighbouring control's
            // enlarged hit area may take it), never the status row.
            expect(
              await control.evaluate((element, selector) => {
                const r = element.getBoundingClientRect();
                return Boolean(
                  document
                    .elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
                    ?.closest(selector),
                );
              }, selector),
              `${kind}: a press reaches the card`,
            ).toBe(true);
          }
          await setNotice(page);
        }
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
      }
    });

    test(`${name} a request card at the end stays above the pill`, async () => {
      const { browser, page, errors } = await tailFixture(viewport, { theme });
      try {
        await settledAtTail(page);
        await setStatus(page, 'working');
        for (const kind of ['approval', 'input'] as const) {
          await setRequest(page, kind);
          await expect
            .poll(() => page.locator('.pending-approvals').count())
            .toBeGreaterThan(0);
          await frames(page);
          const shown = (await pill(page, 'working').boundingBox())!;
          expect(await lastContentBottom(page), kind).toBeLessThanOrEqual(
            shown.y + 0.5,
          );
          await setRequest(page);
        }
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
      }
    });

    test(`${name} a next-turn notice keeps the row in the composer`, async () => {
      const { browser, page, errors } = await tailFixture(viewport, { theme });
      try {
        await settledAtTail(page);
        await setStatus(page, 'working');
        await setNextTurn(page, true);
        const notice = await box(page, '.chat-input__next-turn-notice');
        const shown = (await pill(page, 'working').boundingBox())!;
        const composer = await box(page, '.chat-input');
        expect(overlaps(notice, shown)).toBe(false);
        expect(shown.y).toBeGreaterThanOrEqual(composer.y);
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
      }
    });

    test(`${name} a press that straddles the status leaving still clicks the row`, async () => {
      const { browser, page, errors } = await tailFixture(viewport, { theme });
      try {
        await settledAtTail(page);
        await setStatus(page, 'working');
        const row = lastToolRow(page);
        const target = (await row.boundingBox())!;
        await page.mouse.move(target.x + 24, target.y + target.height / 2);
        await page.mouse.down();
        await setStatus(page);
        await page.mouse.up();
        await expect.poll(() => row.getAttribute('aria-expanded')).toBe('true');
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
      }
    });

    test(`${name} the status is announced once per change`, async () => {
      const { browser, page, errors } = await tailFixture(viewport, { theme });
      try {
        await settledAtTail(page);
        const announcing = (label: string) =>
          page.evaluate(
            (label) =>
              [...document.querySelectorAll('[aria-live]')].filter(
                (region) =>
                  region.closest('[aria-live]') === region &&
                  !region.closest('.chat-messages') &&
                  region.textContent?.includes(label),
              ).length,
            label,
          );
        await setStatus(page, 'working');
        await expect.poll(() => announcing('Working')).toBe(1);
        await setStatus(page, 'unavailable');
        await expect.poll(() => announcing('Status unavailable')).toBe(1);
        expect(await announcing('Working')).toBe(0);
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
      }
    });

    test(`${name} Scroll to bottom appearing for a reader scrolled up moves none of their rows`, async () => {
      const { browser, page, errors } = await tailFixture(viewport, { theme });
      try {
        await settledAtTail(page);
        await setStatus(page, 'working');
        const scrolled = await page.evaluate(() => {
          const log = document.querySelector('.chat-messages') as HTMLElement;
          log.dispatchEvent(
            new WheelEvent('wheel', { deltaY: -400, bubbles: true }),
          );
          log.scrollTop -= 400;
          log.dispatchEvent(new Event('scroll'));
          const rows = log.querySelectorAll('.chat-message-anchor');
          return (rows[rows.length - 3] as HTMLElement).getBoundingClientRect()
            .top;
        });
        await page.getByRole('button', { name: 'Scroll to bottom' }).waitFor();
        await frames(page);
        const after = await page.evaluate(() => {
          const rows = document.querySelectorAll(
            '.chat-messages .chat-message-anchor',
          );
          return (rows[rows.length - 3] as HTMLElement).getBoundingClientRect()
            .top;
        });
        expect(after).toBeCloseTo(scrolled, 0);
        // The pill sits in the composer beside Scroll to bottom, over nothing.
        const shown = (await pill(page, 'working').boundingBox())!;
        const log = (await transcript(page).boundingBox())!;
        expect(shown.y).toBeGreaterThanOrEqual(log.y + log.height - 0.5);
        expect(
          await page.locator('.chat-dock__body[data-status-floats]').count(),
        ).toBe(0);
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
      }
    });
  }

  test(`(${width}) a reader scrolling up and back finds the rows where they left them`, async () => {
    const { browser, page, errors } = await tailFixture(viewport);
    try {
      await settledAtTail(page);
      await setStatus(page, 'working');
      const top = () =>
        transcript(page).evaluate((log) => {
          const rows = log.querySelectorAll('.chat-message-anchor');
          return (rows[rows.length - 1] as HTMLElement).getBoundingClientRect()
            .top;
        });
      const before = await top();
      const box = (await transcript(page).boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, -200);
      await page.getByRole('button', { name: 'Scroll to bottom' }).waitFor();
      await frames(page);
      await page.mouse.wheel(0, 200);
      await frames(page);
      // Scroll to bottom's line in the composer is not taken back from the
      // transcript as a lasting reservation (reduced motion, as here, kept
      // it): the rows are where the reader left them.
      await expect.poll(() => top()).toBeCloseTo(before, 0);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test(`(${width}) a reader moving a few px up moves no row`, async () => {
    const { browser, page, errors } = await tailFixture(viewport);
    try {
      await settledAtTail(page);
      await setStatus(page, 'working');
      expect(await statusRoom(page)).toBeGreaterThan(0);
      // Where the last row is, and where the transcript is scrolled.
      const place = () =>
        transcript(page).evaluate((log) => {
          const rows = log.querySelectorAll('.chat-message-anchor');
          return {
            top: (rows[rows.length - 1] as HTMLElement).getBoundingClientRect()
              .top,
            scrollTop: log.scrollTop,
          };
        });
      const before = await place();
      // A real wheel: its scroll events are the reader's, one per frame, so
      // nothing here races a second, synthetic one.
      const box = (await transcript(page).boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, -8);
      await page.getByRole('button', { name: 'Scroll to bottom' }).waitFor();
      await frames(page);
      // The end keeps the room: taking it away here would move the rows.
      expect(await statusRoom(page)).toBeGreaterThan(0);
      const after = await place();
      const moved = before.scrollTop - after.scrollTop;
      expect(moved).toBeGreaterThan(0);
      // The rows moved by the reader's scroll and nothing else.
      expect(after.top - before.top).toBeCloseTo(moved, 0);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });
}

/** The height of the room the transcript's end keeps for a floating row. */
function statusRoom(page: Page) {
  return page
    .locator('.chat-messages__status-room')
    .evaluate((room) => room.getBoundingClientRect().height);
}

/** How far the turn rail's lowest step sits above the transcript's bottom. */
function stepClearance(page: Page) {
  return page.evaluate(() => {
    const log = document
      .querySelector('.chat-messages')!
      .getBoundingClientRect();
    const steps = [
      ...document.querySelectorAll('.transcript-turn-rail__step'),
    ].map((step) => step.getBoundingClientRect().bottom);
    return log.bottom - Math.max(...steps);
  });
}

test('the pill keeps clear of the turn rail steps', async () => {
  const { browser, page, errors } = await tailFixture(VIEWPORTS[0][1], {
    turns: 14,
  });
  try {
    await settledAtTail(page);
    await setStatus(page, 'working');
    const steps = page.locator('.transcript-turn-rail__step');
    await expect.poll(() => steps.count()).toBe(2);
    const shown = (await pill(page, 'working').boundingBox())!;
    for (const step of await steps.all()) {
      const target = (await step.boundingBox())!;
      expect(overlaps(target, shown)).toBe(false);
    }
    const raised = await stepClearance(page);
    // Scrolled up, the pill is back in the composer: the steps come down.
    await page.evaluate(() => {
      const log = document.querySelector('.chat-messages') as HTMLElement;
      log.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -400, bubbles: true }),
      );
      log.scrollTop -= 400;
      log.dispatchEvent(new Event('scroll'));
    });
    await page.getByRole('button', { name: 'Scroll to bottom' }).waitFor();
    await frames(page);
    expect(await stepClearance(page)).toBeLessThan(raised - 30);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

for (const theme of THEMES)
  test(`(1440, ${theme}, a short dock) the end keeps no room for a status that is not there`, async () => {
    const { browser, page, errors } = await tailFixture(VIEWPORTS[0][1], {
      theme,
      dockHeight: 300,
    });
    try {
      await settledAtTail(page);
      const gap = await transcript(page).evaluate((log) => {
        const rows = log.querySelectorAll('.chat-message-anchor');
        const last = rows[rows.length - 1]!.getBoundingClientRect();
        return (
          log.getBoundingClientRect().bottom -
          last.bottom -
          Number.parseFloat(getComputedStyle(log).paddingBottom)
        );
      });
      // Pinned to the end, the last message ends at the scroller's padding.
      expect(gap).toBeLessThanOrEqual(1);
      // A status in a short dock takes the composer's line and covers nothing.
      await setStatus(page, 'working');
      const shown = (await pill(page, 'working').boundingBox())!;
      expect(await lastContentBottom(page)).toBeLessThanOrEqual(shown.y + 0.5);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });
