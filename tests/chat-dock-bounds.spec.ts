import { expect, type Page } from '@playwright/test';
import { codingViewItem } from './helpers/coding-stack';
import { test } from './helpers/fixture-audit';
import {
  DEFAULT_CONVERSATION_LOOKUPS,
  DEFAULT_CONVERSATIONS,
  dismissSetupLauncher,
  installMockOrchestrationSse,
  seedActiveChats,
  seedOrchestrationRoutes,
} from './helpers/orchestration';
import { dragDockTo } from './helpers/region-placement';

/**
 * #4401: the dock's chrome stays inside its own bounds.
 *
 * - A30: a crowded dock bar (the narrowest side region) keeps the chat title
 *   readable and no control lies over another; the × in particular used to
 *   slide under the status chip once the title had shrunk to nothing.
 * - A31: the 36px strip of a collapsed side region holds only what fits in
 *   it; the chat title, avatar and × used to run out of it over the page.
 * - The Coding bar's "Inbox" crumb is never the one that truncates.
 * - A32: a rail item's tooltip follows the pointer and the keyboard, not
 *   focus that a mouse-driven close hands back to the item.
 *
 * Geometry is read from the rendered page; these are layout contracts a DOM
 * assertion cannot establish.
 */

const LONG_TITLE =
  'Triage the inbox and summarize the overnight failures across every project, then draft a fix plan for each failing check';

async function seed(page: Page) {
  await seedActiveChats(page, [
    {
      sessionId: 'session-1',
      conversationId: 'conv-1',
      agentSlug: 'dev-agent',
      title: LONG_TITLE,
      model: 'claude-sonnet',
      provider: 'codex',
      providerOptions: {},
      projectSlug: 'dev',
      projectName: 'Dev',
      orchestrationSessionStarted: true,
      inputHistory: [],
      ephemeralMessages: [],
    },
  ]);
  await installMockOrchestrationSse(page);
  await seedOrchestrationRoutes(page, {
    conversations: DEFAULT_CONVERSATIONS.map((conversation) => ({
      ...conversation,
      title: LONG_TITLE,
    })),
    conversationLookups: {
      'conv-1': {
        ...DEFAULT_CONVERSATION_LOOKUPS['conv-1'],
        title: LONG_TITLE,
      },
    },
  });
}

type Box = { left: number; top: number; right: number; bottom: number };

/**
 * Every control and the title in the dock's bar that takes space, with the
 * bar's own box. The bar is hovered first, so the controls it reveals on
 * hover (the placement grab, the ×) are measured where they are pressed.
 */
async function barGeometry(page: Page) {
  return page.evaluate(() => {
    const dock = document.querySelector('#chat-dock');
    const bar = dock?.querySelector('.chat-dock__header');
    if (!dock || !bar) throw new Error('no dock bar');
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      };
    };
    const items = [
      ...bar.querySelectorAll('button, .chat-dock__active-identity-title'),
    ]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .map((element) => ({
        name:
          element.getAttribute('aria-label') ??
          element.textContent?.trim() ??
          '',
        box: box(element),
      }));
    return { dock: box(dock), bar: box(bar), items };
  });
}

const overlaps = (a: Box, b: Box) =>
  Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
  Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;

function overlappingPairs(items: { name: string; box: Box }[]): string[] {
  const pairs: string[] = [];
  for (let i = 0; i < items.length; i += 1)
    for (let j = i + 1; j < items.length; j += 1)
      if (overlaps(items[i].box, items[j].box))
        pairs.push(`${items[i].name} × ${items[j].name}`);
  return pairs;
}

async function openDockOnRight(page: Page) {
  await page.goto('/projects/dev?chat=conv-1&dock=open');
  await dismissSetupLauncher(page);
  const dock = page.locator('#chat-dock');
  await expect(dock).toBeVisible({ timeout: 20_000 });
  await expect(dock.locator('.chat-dock__active-identity-title')).toHaveText(
    LONG_TITLE,
  );
  await dragDockTo(page, 'right');
  await expect(dock).toHaveClass(/chat-dock--right/);
  return dock;
}

/** Drags the side region's inner edge outward until the region is at its minimum. */
async function narrowSideDock(page: Page) {
  const handle = page.locator(
    '#chat-dock .chat-dock__resize-handle--horizontal',
  );
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 400, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
}

/** Collapses Chat's side region and lists what its strip draws outside itself. */
async function collapseAndExpectContained(page: Page) {
  const dock = page.locator('#chat-dock');
  await dock.getByRole('button', { name: 'Hide Chat' }).click();
  await expect(dock).toHaveClass(/is-collapsed/);
  await expect
    .poll(async () => Math.round((await dock.boundingBox())!.width))
    .toBe(36);
  const spill = await page.evaluate(() => {
    const shell = document.querySelector('#chat-dock')!;
    const bounds = shell.getBoundingClientRect();
    return (
      [...shell.querySelectorAll('.chat-dock__header *')]
        // A tooltip is an overlay by design, drawn beside its control.
        .filter((element) => !element.closest('[role="tooltip"]'))
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            (rect.left < bounds.left - 0.5 || rect.right > bounds.right + 0.5)
          );
        })
        .map(
          (element) =>
            `${element.getAttribute('aria-label') ?? element.className} ${Math.round(element.getBoundingClientRect().left)}-${Math.round(element.getBoundingClientRect().right)} of ${Math.round(bounds.left)}-${Math.round(bounds.right)}`,
        )
    );
  });
  expect(spill).toEqual([]);
  // What remains is still the way back.
  await expect(dock.getByRole('button', { name: 'Show Chat' })).toBeVisible();
}

test.describe('Dock bar bounds (#4401)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await seed(page);
  });

  test('a side region at its narrowest keeps the title readable and no control over another', async ({
    page,
  }) => {
    const dock = await openDockOnRight(page);
    await narrowSideDock(page);
    // MIN_DOCK_WIDTH (useDockShellChrome.ts).
    await expect
      .poll(async () => Math.round((await dock.boundingBox())!.width))
      .toBe(280);
    // Any point of the bar reveals its hover-only controls.
    await dock.getByRole('button', { name: /^More dock actions/ }).hover();

    const { bar: barBox, items } = await barGeometry(page);
    expect(overlappingPairs(items)).toEqual([]);
    for (const item of items) {
      expect(item.box.left, item.name).toBeGreaterThanOrEqual(
        barBox.left - 0.5,
      );
      expect(item.box.right, item.name).toBeLessThanOrEqual(barBox.right + 0.5);
    }
    // The title is readable: at least its floor of three characters.
    const title = items.find((item) => item.name === LONG_TITLE);
    expect(title, 'the chat title is in the bar').toBeTruthy();
    expect(title!.box.right - title!.box.left).toBeGreaterThanOrEqual(36);
    // The × is where the pointer finds it, not clipped under its neighbour.
    const close = dock.getByRole('button', { name: 'Close chat' });
    const closeBox = (await close.boundingBox())!;
    const hit = await page.evaluate(
      ({ x, y }) =>
        document
          .elementFromPoint(x, y)
          ?.closest('button')
          ?.getAttribute('aria-label') ?? null,
      {
        x: closeBox.x + closeBox.width / 2,
        y: closeBox.y + closeBox.height / 2,
      },
    );
    expect(hit).toBe('Close chat');
  });

  test('the default side region keeps the full bar, its title and no overlap', async ({
    page,
  }) => {
    const dock = await openDockOnRight(page);
    // Any point of the bar reveals its hover-only controls.
    await dock.getByRole('button', { name: /^More dock actions/ }).hover();
    await expect(dock.locator('.chat-dock__header')).not.toHaveClass(
      /is-compact/,
    );
    await expect(
      dock.getByRole('button', { name: 'Move the dock' }),
    ).toBeVisible();
    const { items } = await barGeometry(page);
    expect(overlappingPairs(items)).toEqual([]);
  });

  for (const region of ['right', 'left'] as const) {
    test(`a collapsed ${region} region's strip holds everything it draws`, async ({
      page,
    }) => {
      const dock = await openDockOnRight(page);
      if (region === 'left') {
        await dragDockTo(page, 'left');
        await expect(dock).toHaveClass(/chat-dock--left/);
      }
      await collapseAndExpectContained(page);
    });
  }

  test('a collapsed strip with no chat open holds its New chat action too', async ({
    page,
  }) => {
    const dock = await openDockOnRight(page);
    await dock.getByRole('button', { name: /^More dock actions/ }).hover();
    await dock.getByRole('button', { name: 'Close chat' }).click();
    await expect(dock.locator('.chat-dock__active-identity')).toHaveCount(0);
    await collapseAndExpectContained(page);
    await expect(dock.getByRole('button', { name: /^New chat/ })).toBeVisible();
  });
});

test.describe('Coding bar and rail (#4401)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await seed(page);
    await page.goto('/projects/dev/layouts/code?chat=conv-1');
    await dismissSetupLauncher(page);
    await expect(page.locator('#chat-workspace-pane')).toBeVisible({
      timeout: 20_000,
    });
  });

  for (const width of [1180, 900]) {
    test(`the Inbox crumb is never the one that truncates (${width}px)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const crumbs = page.getByRole('list', { name: 'Breadcrumb' });
      const inbox = crumbs.getByRole('button', { name: 'Inbox', exact: true });
      await expect(inbox).toBeVisible();
      // How much of an element's text its box cuts off, in CSS px.
      const cutOff = (element: Element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const text = range.getBoundingClientRect().width;
        const style = getComputedStyle(element);
        const room =
          element.getBoundingClientRect().width -
          Number.parseFloat(style.paddingLeft) -
          Number.parseFloat(style.paddingRight);
        return text - room;
      };
      // The long title does yield: the bar is crowded enough to test this.
      await expect
        .poll(() => crumbs.locator('[aria-current="page"]').evaluate(cutOff))
        .toBeGreaterThan(20);
      expect(await inbox.evaluate(cutOff)).toBeLessThanOrEqual(0.5);
    });
  }

  test('a rail tooltip leaves with the pointer after a panel closed with the mouse, and still shows for the keyboard', async ({
    page,
  }) => {
    const item = codingViewItem(page, 'Files');
    const tip = page.getByRole('tooltip').filter({ hasText: /^Files$/ });
    await item.hover();
    await expect(tip).toBeVisible();
    await item.click();
    const close = page.getByRole('button', { name: 'Close Files' });
    await close.click();
    await expect(close).toHaveCount(0);
    // The close hands focus back to the rail item…
    await expect(item).toBeFocused();
    // …and once the pointer is elsewhere, no tooltip stays over the rail.
    await page.mouse.move(400, 400);
    await expect(tip).toHaveCount(0);

    // Keyboard focus still shows it.
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(item).toBeFocused();
    await expect(tip).toBeVisible();
  });
});
