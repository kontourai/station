/**
 * @vitest-environment jsdom
 *
 * The failure stack above the composer, measured in a real Chromium at a
 * phone viewport. On a 390px phone the failed-session banner ran edge to edge
 * while the recovery notice under it stayed inset, and the notice's Retry and
 * Start new chat sat apart at different sizes.
 *
 * The banner's inset was a one-class rule in `index.css`
 * (`.chat-dock__session-failure`) that tied `SessionFailureAlert.css`'s
 * `.session-failure { margin: 0 }` on specificity, so it lost whenever that
 * sheet came later — which it does in production, where the dock is a lazy
 * chunk whose stylesheet is injected after the entry sheet. jsdom resolves no
 * cascade, so this renders the REAL components' markup into Chromium with the
 * REAL source stylesheets in BOTH injection orders and measures the boxes.
 *
 * PRECONDITION / RESOURCE CLASSIFICATION: same as
 * `NotificationContainer.touch-target.test.tsx` — a real Chromium via
 * `@playwright/test` (`npm run install:playwright`), listed in
 * `scripts/vitest-resource-manifest.mjs`'s `PROCESS_HEAVY_VITEST_FILES`.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { render } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  isWslHost,
  WSL_QUARANTINE_REASON,
} from '../../../../../scripts/lib/wsl-host-class.mjs';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../../../tests/helpers/css-cascade-fixture';
import { MIN_TOUCH_TARGET_PX } from '../../../../../tests/helpers/touch-target';
import { SessionFailureAlert } from '../../session-failure/SessionFailureAlert';
import { ConversationOpenRecoveryNotice } from '../ConversationOpenRecoveryNotice';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../../');
const SHEETS = {
  index: resolve(HERE, '../../../index.css'),
  chat: resolve(HERE, '../../chat/chat.css'),
  failure: resolve(HERE, '../../session-failure/SessionFailureAlert.css'),
  notice: resolve(HERE, '../ConversationOpenRecoveryNotice.css'),
} as const;

/** The two orders a bundler may inject the dock chunk's sheets in. */
const ORDERS = {
  'chunk sheets after the entry sheet': ['index', 'chat', 'failure', 'notice'],
  'chunk sheets before the entry sheet': ['failure', 'notice', 'chat', 'index'],
} as const satisfies Record<string, ReadonlyArray<keyof typeof SHEETS>>;

function fixtureMarkup(): string {
  const { container, unmount } = render(
    <div className="chat-dock__body">
      <SessionFailureAlert
        failureText="Internal error: Cannot connect to API: Unable to connect. Is the computer able to access the url?"
        className="chat-dock__session-failure"
        testId="chat-dock-session-failure"
      />
      <ConversationOpenRecoveryNotice
        title="New chat"
        state="unverified"
        onRetry={() => {}}
        onStartNew={() => {}}
      />
    </div>,
  );
  const markup = container.innerHTML;
  unmount();
  return markup;
}

function fixtureHtml(order: ReadonlyArray<keyof typeof SHEETS>): string {
  const css = order.map((sheet) => resolveCssImports(SHEETS[sheet])).join('\n');
  assertNoImportsSurvive(css);
  return `<!doctype html>
<html data-theme="dark">
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>${css}</style>
  </head>
  <body style="margin:0">${fixtureMarkup()}</body>
</html>`;
}

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);
// Same WSL2 host-class quarantine as the sibling touch-target files
// (station#4177): the cases skip there and the sentinel below names why.
const wslQuarantinedHost = isWslHost();

describe.skipIf(!chromiumAvailable || wslQuarantinedHost)(
  'chat dock failure stack at 390x844',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;

    beforeAll(async () => {
      browser = await chromium.launch();
    });

    afterAll(async () => {
      await browser?.close();
    });

    for (const [name, order] of Object.entries(ORDERS)) {
      test(`the banner and the notice share one inset, ${name}`, async () => {
        const page = await browser.newPage({
          viewport: { width: 390, height: 844 },
          hasTouch: true,
          isMobile: true,
        });
        try {
          await page.setContent(fixtureHtml(order));
          const banner = await page
            .getByTestId('chat-dock-session-failure')
            .boundingBox();
          const notice = await page
            .locator('.session-history-error')
            .boundingBox();
          expect(banner).not.toBeNull();
          expect(notice).not.toBeNull();
          if (!banner || !notice) return;
          // Not edge to edge: the banner keeps the dock's gutter...
          expect(banner.x).toBeGreaterThan(0);
          expect(banner.x + banner.width).toBeLessThan(390);
          // ...and it is the notice's gutter, on both sides.
          expect(banner.x).toBe(notice.x);
          expect(banner.width).toBe(notice.width);
          // One type step for both alerts, so the stack reads as one style.
          const fontSizes = await page.evaluate(() =>
            ['.session-failure__cause', '.session-history-error__detail'].map(
              (selector) =>
                getComputedStyle(
                  document.querySelector(selector) as HTMLElement,
                ).fontSize,
            ),
          );
          expect(fontSizes[0]).toBe(fontSizes[1]);
        } finally {
          await page.close();
        }
      });
    }

    // A phone, and a touch tablet past both phone breakpoints (wider than
    // 768px, taller than 540px), which only the `(hover: none)` block reaches.
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 1024, height: 1366 },
    ]) {
      test(`Retry and Start new chat are one row of equal 44px targets at ${viewport.width}x${viewport.height} touch`, async () => {
        const page = await browser.newPage({
          viewport,
          hasTouch: true,
          isMobile: true,
        });
        try {
          expect(
            await page.evaluate(() => matchMedia('(hover: none)').matches),
            'the emulated device must be one that cannot hover',
          ).toBe(true);
          await page.setContent(
            fixtureHtml(ORDERS['chunk sheets after the entry sheet']),
          );
          const retry = await page
            .getByRole('button', { name: 'Retry' })
            .boundingBox();
          const startNew = await page
            .getByRole('button', { name: 'Start new chat' })
            .boundingBox();
          expect(retry).not.toBeNull();
          expect(startNew).not.toBeNull();
          if (!retry || !startNew) return;
          for (const box of [retry, startNew]) {
            expect(box.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
            expect(box.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
          }
          expect(startNew.height).toBe(retry.height);
          // One row: side by side, not Start new chat stretched under Retry.
          expect(startNew.y).toBe(retry.y);
          expect(startNew.x).toBeGreaterThan(retry.x + retry.width);
        } finally {
          await page.close();
        }
      });
    }
  },
);

test.skipIf(chromiumAvailable)(
  'chat dock failure stack — Chromium not installed, cannot verify',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the chat ' +
        'dock failure stack geometry could not be checked — this is a ' +
        'missing precondition, not a passing check. Install it with ' +
        '`npm run install:playwright` and re-run.',
    );
  },
);

test.runIf(chromiumAvailable && wslQuarantinedHost)(
  'chat dock failure stack — quarantined on the WSL2 host class (station#4177)',
  (ctx) => {
    ctx.skip(WSL_QUARANTINE_REASON);
  },
);
