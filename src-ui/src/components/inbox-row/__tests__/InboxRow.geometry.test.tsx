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
 * which rows animate (with and without reduced motion), and the
 * always-visible touch actions at a phone viewport.
 */

import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
import type { WorkFactsById } from '../../../views/home/work-facts';
import { ChatDockInboxPanel } from '../../chat-dock/ChatDockInboxPanel';
import { InboxRow } from '../../chat-dock/ChatDockInboxRows';
import { MobileTaskSwitcher } from '../../chat-dock/MobileTaskSwitcher';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../../');
const css = [
  '../../../index.css',
  '../../chat/chat.css',
  '../../chat-dock/ChatDockInboxPanel.css',
  '../../chat-dock/ChatInboxHoverCard.css',
  '../InboxRow.css',
]
  .map((path) => resolveCssImports(resolve(import.meta.dirname, path)))
  .join('\n');
assertNoImportsSurvive(css);

// The Details sheet's on-demand reads need a connection scope; with none
// they stay disabled, which is all the sheet's geometry needs of them.
vi.mock('../../../contexts/ApiBaseContext', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../contexts/ApiBaseContext')
  >()),
  useHostRequestAuthorityScope: () => null,
}));

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
    environmentLabel: 'a-remote-machine-name-long-enough-to-truncate-in-a-rail',
  }),
  item({ id: 'running', lifecycleLabel: 'Running' }),
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

const FACTS: WorkFactsById = new Map([
  ['approval', { attention: 'approval' }],
  [
    'running',
    {
      activity: { turnStartedAt: '2026-09-30T10:00:03.000Z', toolName: 'Bash' },
    },
  ],
]);

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
      workFacts={FACTS}
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
      workFacts={FACTS}
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

  test('a revealed action is a 44px-tall target that stays inside its own row', async () => {
    const pg = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    try {
      await pg.setContent(page(panelMarkup()));
      await settle(pg);
      const rows = pg.locator('[data-testid="inbox-row"]');
      const count = await rows.count();
      let cards = 0;
      for (let index = 0; index < count; index += 1) {
        const row = rows.nth(index);
        await row.hover();
        const measured = await row.evaluate((element) => {
          const rowBox = element.getBoundingClientRect();
          return {
            slim: element.classList.contains('inbox-row--slim'),
            rowTop: rowBox.top,
            rowBottom: rowBox.bottom,
            targets: [...element.querySelectorAll('.inbox-row__action')].map(
              (action) => {
                const rect = action.getBoundingClientRect();
                const after = getComputedStyle(action, '::after');
                const top = rect.top + Number.parseFloat(after.top);
                const height = Number.parseFloat(after.height);
                return {
                  label: action.getAttribute('aria-label'),
                  top,
                  bottom: top + height,
                  height,
                  left: rect.left + Number.parseFloat(after.left),
                  right: rect.right - Number.parseFloat(after.right),
                };
              },
            ),
          };
        });
        expect(measured.targets.length).toBeGreaterThanOrEqual(2);
        for (const [position, target] of measured.targets.entries()) {
          // Inside the row's own box: never the row above or below.
          expect(target.top, `${target.label} top`).toBeGreaterThanOrEqual(
            measured.rowTop - 0.01,
          );
          expect(target.bottom, `${target.label} bottom`).toBeLessThanOrEqual(
            measured.rowBottom + 0.01,
          );
          if (!measured.slim) {
            expect(target.height, `${target.label}`).toBeGreaterThanOrEqual(
              MIN_TOUCH_TARGET_PX,
            );
          }
          if (position > 0) {
            expect(target.left).toBeGreaterThanOrEqual(
              measured.targets[position - 1].right - 0.01,
            );
          }
        }
        if (!measured.slim) cards += 1;
      }
      expect(cards).toBeGreaterThanOrEqual(4);
    } finally {
      await pg.close();
    }
  });

  test('hit-testing just outside a hovered row never lands on that row’s actions', async () => {
    const pg = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    try {
      await pg.setContent(page(panelMarkup()));
      await settle(pg);
      const rows = pg.locator('[data-testid="inbox-row"]');
      const count = await rows.count();
      let probes = 0;
      for (let index = 0; index < count; index += 1) {
        const row = rows.nth(index);
        await row.hover();
        const hits = await row.evaluate((element) => {
          const rowBox = element.getBoundingClientRect();
          const owner = (x: number, y: number) =>
            document
              .elementFromPoint(x, y)
              ?.closest('[data-testid="inbox-row"]')
              ?.getAttribute('data-row-key') ?? null;
          return [...element.querySelectorAll('.inbox-row__action')].flatMap(
            (action) => {
              const rect = action.getBoundingClientRect();
              const x = rect.left + rect.width / 2;
              return [
                // One pixel into whatever is above, and below, this row.
                owner(x, rowBox.top - 1),
                owner(x, rowBox.bottom + 1),
              ];
            },
          );
        });
        const key = await row.getAttribute('data-row-key');
        probes += hits.length;
        expect(hits, `row ${key}`).not.toContain(key);
      }
      expect(probes).toBeGreaterThanOrEqual(2 * ITEMS.length);
    } finally {
      await pg.close();
    }
  });

  test('only a waiting-on-you icon moves, and reduced motion stills it', async () => {
    const markup = panelMarkup();
    const animations = async (reducedMotion: 'reduce' | 'no-preference') => {
      const pg = await browser.newPage({
        viewport: { width: 1280, height: 900 },
        reducedMotion,
      });
      try {
        await pg.setContent(page(markup));
        return await pg.evaluate(() =>
          Object.fromEntries(
            [...document.querySelectorAll('[data-testid="inbox-row"]')].map(
              (row) => {
                const moving = [row, ...row.querySelectorAll('*')]
                  .map((element) => getComputedStyle(element))
                  .filter(
                    (style) =>
                      style.animationName !== 'none' &&
                      style.animationIterationCount === 'infinite',
                  )
                  .map((style) => style.animationName);
                return [row.getAttribute('data-row-key'), moving];
              },
            ),
          ),
        );
      } finally {
        await pg.close();
      }
    };
    expect(await animations('no-preference')).toEqual({
      approval: ['inbox-row-attention-pulse'],
      running: [],
      idle: [],
      failed: [],
      snoozed: [],
      earlier: [],
    });
    // The global reset caps every animation at one near-instant iteration.
    expect(await animations('reduce')).toEqual({
      approval: [],
      running: [],
      idle: [],
      failed: [],
      snoozed: [],
      earlier: [],
    });
  });

  /** Every touch-chrome action is 44x44, beside its row, never wrapped under
   *  it, and the row's title keeps a readable width. */
  async function auditTouchRows(
    pg: import('@playwright/test').Page,
    minimumTitleWidth: number,
  ) {
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
    const rows = await pg.evaluate(() =>
      [...document.querySelectorAll('.inbox-row--touch')].map((row) => {
        const open = row
          .querySelector('.inbox-row__open')!
          .getBoundingClientRect();
        const actionsBox = row
          .querySelector('.inbox-row__actions')
          ?.getBoundingClientRect();
        return {
          key: row.getAttribute('data-row-key'),
          targets: row.querySelectorAll('.inbox-row__action').length,
          title: row.querySelector('.inbox-row__title')!.getBoundingClientRect()
            .width,
          right: row.getBoundingClientRect().right,
          wrapped: actionsBox
            ? actionsBox.left < open.right - 0.5 ||
              actionsBox.top >= open.bottom
            : false,
        };
      }),
    );
    expect(rows.length).toBe(ITEMS.length);
    for (const row of rows) {
      expect(row.wrapped, `${row.key} actions wrapped under the row`).toBe(
        false,
      );
      // Details plus at most one more target, on every row.
      expect(row.targets, `${row.key} targets`).toBeLessThanOrEqual(2);
      expect(row.title, `${row.key} title width`).toBeGreaterThanOrEqual(
        minimumTitleWidth,
      );
    }
    return rows;
  }

  test.each([
    [390, 200],
    [320, 160],
  ])(
    'touch chrome at %ipx: 44px actions beside the row and a title of at least %ipx',
    async (width, minimumTitleWidth) => {
      const markup = sheetMarkup();
      const pg = await browser.newPage({
        viewport: { width, height: 844 },
        hasTouch: true,
        isMobile: true,
      });
      try {
        await pg.setContent(page(markup));
        await settle(pg);
        const rows = await auditTouchRows(pg, minimumTitleWidth);
        for (const row of rows) {
          expect(row.right, `${row.key} right edge`).toBeLessThanOrEqual(width);
        }
      } finally {
        await pg.close();
      }
    },
  );

  test('the actions a touch row keeps in its Details sheet are 44px targets on a phone', async () => {
    seed();
    const view = render(
      <QueryClientProvider client={new QueryClient()}>
        <InboxRow
          item={ITEMS[1]}
          isCurrent={false}
          isSnoozed={false}
          isOpenChat
          now={NOW}
          chrome="touch"
          snoozeMenuOnly
          onActivate={vi.fn()}
          onSnoozeWake={vi.fn()}
          onCloseChat={vi.fn()}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Details for/ }));
    await screen.findByTestId('inbox-row-details', {}, { timeout: 8000 });
    const markup = document.body.innerHTML;
    view.unmount();
    const pg = await browser.newPage({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    try {
      await pg.setContent(page(markup));
      await settle(pg);
      const buttons = pg.locator('.chat-dock-inbox-details__actions button');
      const labels: string[] = [];
      for (let index = 0; index < (await buttons.count()); index += 1) {
        const box = await buttons.nth(index).boundingBox();
        const label = (await buttons.nth(index).textContent()) ?? '';
        labels.push(label);
        expect(box, `${label} is visible`).not.toBeNull();
        expect(box!.height, `${label} height`).toBeGreaterThanOrEqual(
          MIN_TOUCH_TARGET_PX,
        );
      }
      // Snooze stays beside the row, so the sheet holds only the rest.
      expect(labels).toEqual(['Close chat']);
    } finally {
      await pg.close();
    }
  });

  test('a coarse pointer gets the touch chrome in the dock panel, slim rows included', async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === '(pointer: coarse)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    let markup: string;
    try {
      markup = panelMarkup();
    } finally {
      window.matchMedia = original;
    }
    expect(markup).not.toContain('inbox-row--hover');
    const pg = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      hasTouch: true,
    });
    try {
      await pg.setContent(page(markup));
      await settle(pg);
      const rows = await auditTouchRows(pg, 100);
      // The slim rows are in the audit: they are the ones a hover chrome
      // could only give a 30px target.
      const slim = await pg
        .locator('.inbox-row--slim.inbox-row--touch')
        .count();
      expect(slim).toBeGreaterThanOrEqual(2);
      expect(rows.length).toBe(ITEMS.length);
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
