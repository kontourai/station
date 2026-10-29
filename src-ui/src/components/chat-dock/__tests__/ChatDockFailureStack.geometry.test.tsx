/**
 * @vitest-environment jsdom
 *
 * The chat dock's failed-session banner, measured in a real Chromium at a
 * phone viewport. On a 390px phone it ran edge to edge while its siblings
 * above the composer kept the dock's 12px gutter.
 *
 * Its inset was a one-class rule in `index.css` (`.chat-dock__session-failure`)
 * that tied `SessionFailureAlert.css`'s `.session-failure { margin: 0 }` on
 * specificity, so it lost whenever that sheet came later — which it does in
 * production, where the dock is a lazy chunk whose stylesheets are injected
 * after the entry sheet. jsdom resolves no cascade, so this renders the REAL
 * banner's markup into Chromium with the REAL source stylesheets in BOTH
 * injection orders and measures its box.
 *
 * PRECONDITION / RESOURCE CLASSIFICATION: a real Chromium via
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
import { SessionFailureAlert } from '../../session-failure/SessionFailureAlert';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../../');
const SHEETS = {
  index: resolve(HERE, '../../../index.css'),
  chat: resolve(HERE, '../../chat/chat.css'),
  failure: resolve(HERE, '../../session-failure/SessionFailureAlert.css'),
} as const;

/** The two orders a bundler may inject the dock chunk's sheets in. */
const ORDERS = {
  'chunk sheets after the entry sheet': ['index', 'chat', 'failure'],
  'chunk sheets before the entry sheet': ['failure', 'chat', 'index'],
} as const satisfies Record<string, ReadonlyArray<keyof typeof SHEETS>>;

/** The dock's gutter, the inset the banner's siblings use. */
const DOCK_GUTTER_PX = 12;

function fixtureMarkup(): string {
  const { container, unmount } = render(
    <div className="chat-dock__body">
      <SessionFailureAlert
        failureText="Internal error: Cannot connect to API: Unable to connect. Is the computer able to access the url?"
        className="chat-dock__session-failure"
        testId="chat-dock-session-failure"
        note="You can send a message to try to continue this chat."
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
// Same WSL2 host-class quarantine as the sibling Chromium files
// (station#4177): the cases skip there and the sentinel below names why.
const wslQuarantinedHost = isWslHost();

describe.skipIf(!chromiumAvailable || wslQuarantinedHost)(
  'chat dock failed-session banner at 390x844',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;

    beforeAll(async () => {
      browser = await chromium.launch();
    });

    afterAll(async () => {
      await browser?.close();
    });

    for (const [name, order] of Object.entries(ORDERS)) {
      test(`keeps the dock gutter on both sides, ${name}`, async () => {
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
          expect(banner).not.toBeNull();
          if (!banner) return;
          expect(banner.x).toBe(DOCK_GUTTER_PX);
          expect(390 - (banner.x + banner.width)).toBe(DOCK_GUTTER_PX);
        } finally {
          await page.close();
        }
      });
    }
  },
);

test.skipIf(chromiumAvailable)(
  'chat dock failed-session banner — Chromium not installed, cannot verify',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the chat ' +
        'dock failed-session banner geometry could not be checked — this is ' +
        'a missing precondition, not a passing check. Install it with ' +
        '`npm run install:playwright` and re-run.',
    );
  },
);

test.runIf(chromiumAvailable && wslQuarantinedHost)(
  'chat dock failed-session banner — quarantined on the WSL2 host class (station#4177)',
  (ctx) => {
    ctx.skip(WSL_QUARANTINE_REASON);
  },
);
