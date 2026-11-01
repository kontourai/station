/**
 * The live transcript's turn rail (#342) in Chromium: the real
 * ChatMessageList, TranscriptVirtualizer and stylesheets, in a dock-shaped
 * column (`transcript-turn-rail-fixture.ts`). jsdom-level wiring is pinned in
 * `ChatMessageList.turnRail.test.tsx`; this file owns geometry: where a jump
 * lands, that streaming leaves it there, and what a phone width shows.
 *
 * The fixture reads the app stylesheet through `css-cascade-fixture`, which
 * defaults Playwright to worktree-local browsers; CI exports
 * PLAYWRIGHT_BROWSERS_PATH, and so must a local run without them.
 */
import type { Page } from '@playwright/test';
import { expect, test } from 'vitest';
import { turnRailBrowserFixture } from './transcript-turn-rail-fixture';

const TURNS = 36;
const DESKTOP = {
  turns: TURNS,
  viewport: { width: 1280, height: 800 },
  dockHeight: 800,
};
const PHONE = {
  turns: TURNS,
  viewport: { width: 390, height: 844 },
  dockHeight: 844,
};
const userRow = (turn: number) =>
  `[data-transcript-row="turn-rail-session:message:u-${turn}"]`;

test('Appearance answer widths change the rendered assistant bubble and preserve user width', async () => {
  const { browser, page } = await turnRailBrowserFixture({
    ...DESKTOP,
    turns: 2,
  });
  try {
    await page.waitForFunction(() => '__setAnswerText' in window);
    await page.evaluate(() =>
      (
        window as unknown as { __setAnswerText(value: string): void }
      ).__setAnswerText(
        'A long answer should use the chosen reading width while the user bubble keeps its existing width. '.repeat(
          40,
        ),
      ),
    );
    const widths = [];
    for (const value of ['comfortable', 'wide', 'full']) {
      await page.evaluate(
        (width) =>
          (
            window as unknown as { __setAnswerWidth(value: string): void }
          ).__setAnswerWidth(width),
        value,
      );
      await page.waitForSelector(
        `.chat-messages[data-answer-width="${value}"]`,
      );
      widths.push({
        assistant: (await page
          .locator('.message.assistant')
          .last()
          .boundingBox())!.width,
        user: (await page.locator('.message.user').last().boundingBox())!.width,
      });
    }
    expect(widths[1].assistant).toBeGreaterThan(widths[0].assistant);
    expect(widths[2].assistant).toBeGreaterThan(widths[1].assistant);
    expect(widths[1].user).toBe(widths[0].user);
    expect(widths[2].user).toBe(widths[0].user);
  } finally {
    await browser.close();
  }
});

function frames(page: Page, count = 12) {
  return page.evaluate(
    `new Promise((resolve) => { let left = ${count}; const tick = () => (--left ? requestAnimationFrame(tick) : resolve()); requestAnimationFrame(tick); })`,
  );
}

/** The scroller's position once it has held still for a few frames. */
async function settledScrollTop(page: Page): Promise<number> {
  let previous = -1;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await frames(page, 3);
    const top = await page
      .locator('.chat-messages')
      .evaluate((element) => element.scrollTop);
    if (top === previous) return top;
    previous = top;
  }
  throw new Error('the transcript never stopped moving');
}

/** How far the row's centre sits from the transcript's, in px. */
async function offsetFromCentre(page: Page, selector: string) {
  return page.evaluate((rowSelector) => {
    const scroller = document.querySelector('.chat-messages')!;
    const row = document.querySelector(rowSelector);
    if (!row) return null;
    const box = scroller.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    return rect.top + rect.height / 2 - (box.top + box.height / 2);
  }, selector);
}

async function pressTick(page: Page, turn: number) {
  const tick = page.locator(
    `.transcript-turn-rail__tick[data-turn-index="${turn}"]`,
  );
  const box = (await tick.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

const activeLabel = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute('aria-label'));

test('every user turn has a tick while the virtualizer mounts only rows near the reader', async () => {
  const { browser, page, errors } = await turnRailBrowserFixture(DESKTOP);
  try {
    await page.waitForSelector('.transcript-turn-rail__tick');
    await settledScrollTop(page);
    expect(await page.locator('.transcript-turn-rail__tick').count()).toBe(
      TURNS,
    );
    const mounted = await page.locator('[data-transcript-row]').count();
    expect(mounted).toBeLessThan(TURNS * 2);
    expect(
      await page
        .getByRole('navigation', { name: 'Conversation turns' })
        .isVisible(),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('a press on the rail centres that turn, and text streaming afterwards leaves it there', async () => {
  const { browser, page, errors } = await turnRailBrowserFixture(DESKTOP);
  try {
    await page.waitForSelector('.transcript-turn-rail__tick');
    await settledScrollTop(page);
    await pressTick(page, 11);
    await page.waitForSelector(userRow(11));
    const revealedAt = await settledScrollTop(page);
    expect(Math.abs((await offsetFromCentre(page, userRow(11)))!)).toBeLessThan(
      24,
    );
    expect(
      await page.getByRole('button', { name: 'Scroll to bottom' }).isVisible(),
    ).toBe(true);

    for (let flush = 0; flush < 6; flush += 1) {
      await page.evaluate('window.__growTail()');
      await frames(page, 4);
    }
    expect(await settledScrollTop(page)).toBe(revealedAt);
    expect(Math.abs((await offsetFromCentre(page, userRow(11)))!)).toBeLessThan(
      24,
    );
    expect(
      await page
        .locator('.chat-messages')
        .evaluate(
          (element) =>
            element.scrollHeight - element.scrollTop - element.clientHeight,
        ),
    ).toBeGreaterThan(1000);
    // The rail follows the reader: the revealed turn is the current one.
    expect(
      await page
        .locator('.transcript-turn-rail__tick[data-turn-index="11"]')
        .getAttribute('aria-current'),
    ).toBe('location');
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('the rail is one tab stop; arrow keys step turns and focus stays on the rail', async () => {
  const { browser, page, errors } = await turnRailBrowserFixture(DESKTOP);
  try {
    await page.waitForSelector('.transcript-turn-rail__tick');
    await settledScrollTop(page);
    expect(
      await page.locator('.transcript-turn-rail__tick[tabindex="0"]').count(),
    ).toBe(1);
    // The tab stop is the turn at the transcript's centre.
    const stop = page.locator('.transcript-turn-rail__tick[tabindex="0"]');
    expect(await stop.getAttribute('aria-current')).toBe('location');
    const start = Number(await stop.getAttribute('data-turn-index'));
    expect(start).toBeGreaterThan(TURNS - 4);
    await stop.focus();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    const target = start - 2;
    await page.waitForSelector(userRow(target));
    await settledScrollTop(page);
    expect(
      Math.abs((await offsetFromCentre(page, userRow(target)))!),
    ).toBeLessThan(24);
    expect(await activeLabel(page)).toMatch(
      new RegExp(`^Turn ${target + 1} of ${TURNS}: `),
    );
    expect(await page.locator('[role="tooltip"]').innerText()).toContain(
      `Turn ${target + 1} of ${TURNS}`,
    );
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('Previous and Next turn step from the turn in view and keep focus', async () => {
  const { browser, page, errors } = await turnRailBrowserFixture(DESKTOP);
  try {
    await page.waitForSelector('.transcript-turn-rail__tick');
    await settledScrollTop(page);
    await pressTick(page, 20);
    await page.waitForSelector(userRow(20));
    await settledScrollTop(page);
    const previous = page.getByRole('button', { name: 'Previous turn' });
    await previous.click();
    await page.waitForSelector(userRow(19));
    await settledScrollTop(page);
    expect(Math.abs((await offsetFromCentre(page, userRow(19)))!)).toBeLessThan(
      24,
    );
    expect(await activeLabel(page)).toBe('Previous turn');
    const next = page.getByRole('button', { name: 'Next turn' });
    await next.click();
    await settledScrollTop(page);
    await next.click();
    await page.waitForSelector(userRow(21));
    await settledScrollTop(page);
    expect(Math.abs((await offsetFromCentre(page, userRow(21)))!)).toBeLessThan(
      24,
    );
    expect(await activeLabel(page)).toBe('Next turn');
    // Returning to the latest keeps focus in the conversation.
    await page.getByRole('button', { name: 'Scroll to bottom' }).click();
    expect(await page.evaluate(() => document.activeElement?.role)).toBe('log');
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('a phone keeps turn browsing in the conversation menu and return-to-latest stays touch-sized', async () => {
  const { browser, page, errors } = await turnRailBrowserFixture(PHONE);
  try {
    await page.waitForSelector('.chat-messages');
    await settledScrollTop(page);
    expect(
      await page
        .locator('.transcript-turn-rail-host')
        .evaluate((host) => getComputedStyle(host).display),
    ).toBe('none');
    expect(
      await page.getByRole('button', { name: 'Previous turn' }).count(),
    ).toBe(0);
    expect(await page.getByRole('button', { name: 'Next turn' }).count()).toBe(
      0,
    );
    await page.getByRole('button', { name: 'Browse turns' }).click();
    const browserDialog = page.getByRole('dialog', { name: 'Browse turns' });
    await browserDialog.waitFor();
    await browserDialog.getByRole('button', { name: /Turn 1:/ }).click();
    await browserDialog.waitFor({ state: 'hidden' });
    await settledScrollTop(page);
    await page.getByRole('button', { name: 'Scroll to bottom' }).waitFor();
    const box = (await page
      .getByRole('button', { name: 'Scroll to bottom' })
      .boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('#3862: a desktop column with the rail shows no turn step at the latest message', async () => {
  const { browser, page, errors } = await turnRailBrowserFixture(DESKTOP);
  try {
    await page.waitForSelector('.transcript-turn-rail__tick');
    await settledScrollTop(page);
    await frames(page);
    expect(
      await page.getByRole('button', { name: 'Previous turn' }).count(),
    ).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

/** The rail's drawn viewport against the rows actually on screen. */
async function drawnViewport(page: Page) {
  return page.evaluate(() => {
    const scroller = document.querySelector('.chat-messages')!;
    const box = scroller.getBoundingClientRect();
    const visible = [
      ...document.querySelectorAll<HTMLElement>('[data-transcript-row]'),
    ]
      .filter((row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > box.top && rect.top < box.bottom;
      })
      .map((row) => Number(row.dataset.index));
    const rowCount = Number(
      document
        .querySelector('[data-testid="virtualized-transcript-spacer"]')!
        .getAttribute('data-transcript-row-count'),
    );
    const band = document.querySelector<HTMLElement>(
      '.transcript-turn-rail__band',
    )!;
    return {
      first: Math.min(...visible),
      last: Math.max(...visible),
      rowCount,
      inView: [
        ...document.querySelectorAll<HTMLElement>(
          '.transcript-turn-rail__tick[data-in-view]',
        ),
      ].map((tick) => Number(tick.dataset.turnIndex)),
      bandTop: Number.parseFloat(band.style.top),
      bandHeight: Number.parseFloat(band.style.height),
    };
  });
}

test('the in-view ticks and the viewport band follow a reader scroll', async () => {
  const { browser, page, errors } = await turnRailBrowserFixture(DESKTOP);
  try {
    await page.waitForSelector('.transcript-turn-rail__tick');
    await settledScrollTop(page);
    const check = async () => {
      const drawn = await drawnViewport(page);
      // Fixture rows alternate prompt and reply: row r belongs to turn r>>1.
      const turns = [];
      for (let turn = drawn.first >> 1; turn <= drawn.last >> 1; turn += 1)
        turns.push(turn);
      expect(drawn.inView).toEqual(turns);
      expect(drawn.bandTop).toBeCloseTo((drawn.first / drawn.rowCount) * 100);
      expect(drawn.bandHeight).toBeCloseTo(
        ((drawn.last + 1 - drawn.first) / drawn.rowCount) * 100,
      );
      return drawn;
    };
    const atEnd = await check();
    expect(atEnd.inView).toContain(TURNS - 1);

    await page.locator('.chat-messages').hover();
    await page.mouse.wheel(0, -4000);
    await settledScrollTop(page);
    const scrolled = await check();
    expect(scrolled.inView).not.toContain(TURNS - 1);
    expect(scrolled.bandTop).toBeLessThan(atEnd.bandTop);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('Escape dismisses a hover preview while focus stays in the composer', async () => {
  const { browser, page, errors } = await turnRailBrowserFixture(DESKTOP);
  try {
    await page.waitForSelector('.transcript-turn-rail__tick');
    await settledScrollTop(page);
    await page.evaluate(() => {
      const input = document.createElement('textarea');
      input.setAttribute('aria-label', 'Draft');
      document.querySelector('.chat-input__meta')!.append(input);
      input.focus();
    });
    const rail = (await page.locator('.transcript-turn-rail').boundingBox())!;
    await page.mouse.move(rail.x + rail.width / 2, rail.y + rail.height * 0.3);
    const preview = page.getByRole('tooltip');
    await preview.waitFor();
    await page.keyboard.press('Escape');
    await preview.waitFor({ state: 'detached' });
    expect(await activeLabel(page)).toBe('Draft');
    // Pointing at another turn previews again.
    await page.mouse.move(rail.x + rail.width / 2, rail.y + rail.height * 0.6);
    await preview.waitFor();
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test.each([
  { width: 390, theme: 'dark' },
  { width: 390, theme: 'light' },
  { width: 1440, theme: 'dark' },
  { width: 1440, theme: 'light' },
])(
  'short conversation navigation at $width px in $theme',
  async ({ width, theme }) => {
    const { browser, page, errors } = await turnRailBrowserFixture({
      turns: 2,
      viewport: { width, height: 844 },
      dockHeight: 844,
    });
    try {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await settledScrollTop(page);
      const rail = page.getByRole('navigation', { name: 'Conversation turns' });
      expect(await rail.isVisible()).toBe(width >= 560);
      expect(await page.locator('.transcript-turn-rail__tick').count()).toBe(2);
      if (width < 560) {
        expect(
          await page.getByRole('button', { name: 'Previous turn' }).count(),
        ).toBe(0);
        await page.getByRole('button', { name: 'Browse turns' }).click();
        const dialog = page.getByRole('dialog', { name: 'Browse turns' });
        await dialog.waitFor();
        await dialog.getByRole('button', { name: /Turn 1:/ }).click();
        await dialog.waitFor({ state: 'hidden' });
        await settledScrollTop(page);
        await page.getByRole('button', { name: 'Scroll to bottom' }).waitFor();
      }
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  },
);
