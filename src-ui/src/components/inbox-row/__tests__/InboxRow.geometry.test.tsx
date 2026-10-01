/**
 * @vitest-environment jsdom
 *
 * #3043 acceptance: "Row height is constant on hover (measured in a real
 * render)", and the action targets reach the 44px floor without a media
 * query deciding who gets it.
 *
 * jsdom computes no layout and matches no `:hover`, so this renders the real
 * dock panel and the real mobile sheet, puts that markup into Chromium with
 * the cascade-resolved stylesheets, and measures: every row before and while
 * the pointer is over it, the invisible hit area of each revealed action,
 * and the always-visible touch actions at a phone viewport.
 */

import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../../../tests/helpers/css-cascade-fixture';
import { MIN_TOUCH_TARGET_PX } from '../../../../../tests/helpers/touch-target';
import { writeSnooze } from '../../../utils/activity-snooze-store';
import type { HomeWorkItem } from '../../../views/home/home-view-model';
import { ChatDockInboxPanel } from '../../chat-dock/ChatDockInboxPanel';
import { MobileTaskSwitcher } from '../../chat-dock/MobileTaskSwitcher';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../../');
const css = [
  '../../../index.css',
  '../../chat/chat.css',
  '../../chat-dock/ChatDockInboxPanel.css',
  '../InboxRow.css',
]
  .map((path) => resolveCssImports(resolve(import.meta.dirname, path)))
  .join('\n');
assertNoImportsSurvive(css);

const NOW = Date.parse('2026-09-30T10:01:15.000Z');

function item(over: Partial<HomeWorkItem> & { id: string }): HomeWorkItem {
  return {
    kind: 'chat',
    kindLabel: 'Direct chat',
    title: `${over.id} with a title long enough that it has to be truncated in a rail`,
    projectLabel: 'station',
    agentLabel: 'Claude Code',
    modelLabel: 'Opus',
    updatedAt: NOW - 120_000,
    lifecycleLabel: 'Ready',
    chatSessionId: over.id,
    ...over,
  };
}

/** One row per shape whose height could differ: with and without a chip
 *  line, a long detail, a ticking duration, and both slim groups. */
const ITEMS: HomeWorkItem[] = [
  item({
    id: 'approval',
    lifecycleLabel: 'Needs attention',
    attention: 'approval',
    worktreeBranch: 'station/a-branch-name-long-enough-to-truncate-in-a-rail',
  }),
  item({
    id: 'running',
    lifecycleLabel: 'Running',
    activity: { turnStartedAt: '2026-09-30T10:00:03.000Z', toolName: 'Bash' },
  }),
  item({ id: 'idle', environmentLabel: 'brian-media' }),
  item({
    id: 'failed',
    lifecycleLabel: 'Failed',
    failureNotice:
      'The engine reported an error that is far too long to fit on one line of a narrow inbox rail.',
  }),
  item({ id: 'snoozed' }),
  item({
    id: 'earlier',
    lifecycleLabel: 'Completed',
    updatedAt: NOW - 3 * 3_600_000,
  }),
];

function page(markup: string): string {
  return `<!doctype html><html data-theme="dark"><head><meta name="viewport" content="width=device-width, initial-scale=1" /><style>${css}</style></head><body>${markup}</body></html>`;
}

function seed() {
  localStorage.clear();
  writeSnooze('snoozed', NOW + 3_600_000, NOW);
}

function panelMarkup(): string {
  seed();
  const { container, unmount } = render(
    <ChatDockInboxPanel
      items={ITEMS}
      activeChatSessionId={null}
      openChatSessionIds={ITEMS.map((entry) => entry.id)}
      onFocusChat={vi.fn()}
      onOpenConversation={vi.fn()}
      onOpenSession={vi.fn()}
      onCloseChat={vi.fn()}
      onOpenHistory={vi.fn()}
      now={NOW}
    />,
  );
  // Expand the two collapsed sections the way a user does, so the slim
  // rows are in the measured markup.
  for (const name of [/^Snoozed/, /^Earlier/]) {
    const toggle = screen.getByRole('button', { name });
    if (toggle.getAttribute('aria-expanded') === 'false')
      fireEvent.click(toggle);
  }
  const markup = `<div style="display:flex;height:900px">${container.innerHTML}</div>`;
  unmount();
  return markup;
}

function sheetMarkup(): string {
  seed();
  const { unmount } = render(
    <MobileTaskSwitcher
      open
      tasks={ITEMS}
      activeChatSessionId={null}
      visualViewportStyle={{}}
      triggerRef={createRef<HTMLButtonElement>()}
      onClose={vi.fn()}
      onFocusChat={vi.fn()}
      onOpenConversation={vi.fn()}
      onOpenSession={vi.fn()}
      onCloseChat={vi.fn()}
      now={NOW}
    />,
  );
  const markup = document.body.innerHTML;
  unmount();
  return markup;
}

/**
 * The panel plays a short entrance (a translate), and a transform in flight
 * moves every descendant's measured box. Wait for the finite animations to
 * finish; the waiting-on-you pulse repeats forever and only changes opacity.
 */
async function settle(pg: import('@playwright/test').Page): Promise<void> {
  await pg.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().iterations !==
            Number.POSITIVE_INFINITY,
        )
        .map((animation) => animation.finished),
    ),
  );
}

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)('inbox row geometry (#3043)', () => {
  let browser: Awaited<ReturnType<typeof chromium.launch>>;

  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });
  afterEach(() => cleanup());

  test('hovering a row changes neither its height nor where its text sits', async () => {
    const markup = panelMarkup();
    // The fixture must contain what it claims to measure.
    expect(markup).toContain('inbox-row--slim');
    expect(markup).toContain('inbox-row__chips');
    const pg = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    try {
      await pg.setContent(page(markup));
      await settle(pg);
      const rows = pg.locator('[data-testid="inbox-row"]');
      expect(await rows.count()).toBe(ITEMS.length);
      const measure = (index: number) =>
        rows.nth(index).evaluate((row) => {
          const box = (selector: string) => {
            const rect = row.querySelector(selector)?.getBoundingClientRect();
            return rect ? [rect.left, rect.top, rect.width, rect.height] : null;
          };
          const actions = row.querySelector('.inbox-row__actions');
          return {
            height: row.getBoundingClientRect().height,
            top: row.getBoundingClientRect().top,
            title: box('.inbox-row__title'),
            meta: box('.inbox-row__meta-text'),
            status: box('[data-testid="inbox-row-status"]'),
            actionsOpacity: actions ? getComputedStyle(actions).opacity : null,
          };
        });
      for (let index = 0; index < ITEMS.length; index += 1) {
        await pg.mouse.move(1000, 10);
        const rest = await measure(index);
        expect(rest.actionsOpacity, 'actions hidden at rest').toBe('0');
        await rows.nth(index).hover();
        const hovered = await measure(index);
        expect(hovered.actionsOpacity, 'actions revealed on hover').toBe('1');
        expect({ ...hovered, actionsOpacity: null }).toEqual({
          ...rest,
          actionsOpacity: null,
        });
        // Rows below must not move either.
        if (index + 1 < ITEMS.length) {
          await pg.mouse.move(1000, 10);
          const below = (await measure(index + 1)).top;
          await rows.nth(index).hover();
          expect((await measure(index + 1)).top).toBe(below);
        }
      }
    } finally {
      await pg.close();
    }
  });

  test('a revealed action is a 44px-tall target on any pointer, and neighbours do not overlap', async () => {
    const pg = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    try {
      await pg.setContent(page(panelMarkup()));
      await settle(pg);
      const row = pg.locator('[data-row-key="running"]');
      await row.hover();
      const targets = await row
        .locator('.inbox-row__action')
        .evaluateAll((actions) =>
          actions.map((action) => {
            const rect = action.getBoundingClientRect();
            const after = getComputedStyle(action, '::after');
            const height =
              rect.height -
              Number.parseFloat(after.top) -
              Number.parseFloat(after.bottom);
            const left = rect.left + Number.parseFloat(after.left);
            const right = rect.right - Number.parseFloat(after.right);
            return {
              label: action.getAttribute('aria-label'),
              height,
              left,
              right,
            };
          }),
        );
      expect(targets.length).toBeGreaterThanOrEqual(3);
      for (const target of targets) {
        expect(target.height, `${target.label}`).toBeGreaterThanOrEqual(
          MIN_TOUCH_TARGET_PX,
        );
      }
      for (let index = 1; index < targets.length; index += 1) {
        expect(targets[index].left).toBeGreaterThanOrEqual(
          targets[index - 1].right - 0.01,
        );
      }
    } finally {
      await pg.close();
    }
  });

  test('touch chrome shows every action at the 44px floor with nothing to hover', async () => {
    const markup = sheetMarkup();
    const pg = await browser.newPage({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    try {
      await pg.setContent(page(markup));
      await settle(pg);
      const actions = pg.locator('.inbox-row--touch .inbox-row__action');
      const count = await actions.count();
      expect(count).toBeGreaterThanOrEqual(ITEMS.length);
      for (let index = 0; index < count; index += 1) {
        const box = await actions.nth(index).boundingBox();
        const label = await actions.nth(index).getAttribute('aria-label');
        expect(box, `${label} is visible`).not.toBeNull();
        expect(box!.width, `${label} width`).toBeGreaterThanOrEqual(
          MIN_TOUCH_TARGET_PX,
        );
        expect(box!.height, `${label} height`).toBeGreaterThanOrEqual(
          MIN_TOUCH_TARGET_PX,
        );
      }
      // The actions sit BESIDE the row's open control, never wrapped onto
      // a line of their own under a long title.
      const wrapped = await pg.evaluate(() =>
        [...document.querySelectorAll('.inbox-row--touch')]
          .filter((row) => row.querySelector('.inbox-row__actions'))
          .filter((row) => {
            const open = row
              .querySelector('.inbox-row__open')!
              .getBoundingClientRect();
            const actions = row
              .querySelector('.inbox-row__actions')!
              .getBoundingClientRect();
            return (
              actions.left < open.right - 0.5 || actions.top >= open.bottom
            );
          })
          .map((row) => row.getAttribute('data-row-key')),
      );
      expect(wrapped).toEqual([]);
    } finally {
      await pg.close();
    }
  });
});

test.skipIf(chromiumAvailable)(
  'inbox row geometry — Chromium not installed, cannot verify (#3043)',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so inbox row ' +
        'hover geometry (#3043) could not be measured — a missing ' +
        'precondition, not a passing check. Run `npm run install:playwright`.',
    );
  },
);
