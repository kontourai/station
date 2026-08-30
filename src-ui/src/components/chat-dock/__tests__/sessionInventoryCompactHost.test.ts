/** @vitest-environment jsdom */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect as expectPlaywright } from '@playwright/test';
import { render } from '@testing-library/react';
import { createElement } from 'react';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../../../tests/helpers/css-cascade-fixture';
import { resolveSessionInventoryCompactHost } from '../sessionInventoryCompactHost';

const hooks = vi.hoisted(() => ({
  inventory: vi.fn(),
}));

vi.mock('@kontourai/station-sdk/session-inventory', () => ({
  useSessionInventoryQuery: (...args: unknown[]) => hooks.inventory(...args),
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'compact-geometry',
  }),
}));
vi.mock('../useSessionInventoryLive', () => ({
  useSessionInventoryLive: () => ({ running: [], pendingApprovalIds: [] }),
  sessionInventoryLiveItems: () => [],
}));

import { SessionInventoryCompact } from '../SessionInventoryCompact';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../../');
const INDEX_CSS_PATH = resolve(HERE, '../../../index.css');
const COMPACT_CSS_PATH = resolve(HERE, '../SessionInventoryCompact.css');
const BASIS_LAUNCHER_CSS_PATH = resolve(
  HERE,
  '../../../workspace-panes/BasisPaneLauncher.css',
);
const compactScope = {
  kind: 'kept-in-task' as const,
  sessionId: 'compact-session',
  taskId: `task-${'bidi-\u202e-path/'.repeat(24)}`,
};

function buildFixtureCss(): string {
  const css = `${resolveCssImports(INDEX_CSS_PATH)}\n${resolveCssImports(COMPACT_CSS_PATH)}\n${resolveCssImports(BASIS_LAUNCHER_CSS_PATH)}`;
  assertNoImportsSurvive(css);
  return css;
}

function buildBasisFallbackHtml(): string {
  return `<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>${buildFixtureCss()}</style></head>
<body style="margin:0"><header id="app-header" style="position:fixed;inset:0 0 auto;height:46px;z-index:1;background:#111;color:#fff">App header</header>
<main style="padding-top:46px"><div class="chat-dock__conversation-surface"><div class="responsive-surface-overlay basis-pane-fallback-overlay" data-responsive-layer="dialog"><div class="basis-pane-fallback responsive-surface-panel" role="dialog" aria-label="Basis"><div class="responsive-dialog-header"><strong>Basis</strong><button type="button" class="responsive-dialog-close" aria-label="Close Basis">Close</button></div><h2>Session inventory</h2></div></div></div></main></body></html>`;
}

function renderCompactMarkup(): string {
  hooks.inventory.mockReturnValue({
    data: {
      version: 'station.session-inventory/v2',
      scope: compactScope,
      groups: [
        {
          id: 'work-items',
          owner: { owner: 'station.session-work-items', id: 'v1' },
          state: 'empty',
          count: { kind: 'exact', value: 0 },
          gaps: [],
          items: [],
        },
      ],
    },
    isLoading: false,
    error: null,
  });
  const { container, unmount } = render(
    createElement(SessionInventoryCompact, {
      scope: compactScope,
      density: 'card',
      chatStoreId: 'compact-geometry',
      onClose: () => {},
      onOpenFull: () => {},
    }),
  );
  const markup = container.innerHTML;
  unmount();
  return markup;
}

function buildFixtureHtml(): string {
  return `<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>${buildFixtureCss()}</style></head>
<body style="margin:0"><main style="width:390px;max-width:100%">${renderCompactMarkup()}</main></body></html>`;
}

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe('Session inventory compact host', () => {
  test('uses a rail only for desktop bottom/fullscreen and a card for side docks', () => {
    expect(
      resolveSessionInventoryCompactHost({
        isMobile: false,
        dockMode: 'bottom',
        fullscreen: false,
      }),
    ).toBe('aside');
    expect(
      resolveSessionInventoryCompactHost({
        isMobile: false,
        dockMode: 'left',
        fullscreen: false,
      }),
    ).toBe('card');
    expect(
      resolveSessionInventoryCompactHost({
        isMobile: false,
        dockMode: 'right',
        fullscreen: false,
      }),
    ).toBe('card');
    expect(
      resolveSessionInventoryCompactHost({
        isMobile: false,
        dockMode: 'right',
        fullscreen: true,
      }),
    ).toBe('aside');
  });

  test('never renders a beside-chat body on phone', () => {
    expect(
      resolveSessionInventoryCompactHost({
        isMobile: true,
        dockMode: 'bottom',
        fullscreen: false,
      }),
    ).toBe('full-fallback');
  });
});

describe.skipIf(!chromiumAvailable)(
  'Session inventory compact host mobile geometry',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;

    beforeAll(async () => {
      browser = await chromium.launch();
    });

    afterAll(async () => {
      await browser?.close();
    });

    test('wraps the three-cell heading and preserves tab order without horizontal overflow at 390px', async () => {
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
      });
      try {
        await page.setContent(buildFixtureHtml());
        const inventory = page.locator('.session-inventory-compact');
        const heading = page.locator('.session-inventory-compact__heading');
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        expect(
          await inventory.evaluate(
            (element) => element.scrollWidth <= element.clientWidth,
          ),
        ).toBe(true);
        expect(
          await heading.evaluate(
            (element) => getComputedStyle(element).display,
          ),
        ).toBe('flex');
        expect(
          await heading.evaluate(
            (element) => getComputedStyle(element).flexWrap,
          ),
        ).toBe('wrap');
        const titleBox = await heading.locator('h2').boundingBox();
        const scopeBox = await heading.locator('bdi').boundingBox();
        const closeBox = await heading.getByRole('button').boundingBox();
        expect(titleBox).not.toBeNull();
        expect(scopeBox).not.toBeNull();
        expect(closeBox).not.toBeNull();
        expect(scopeBox!.y).toBeGreaterThan(titleBox!.y);
        expect(closeBox!.x).toBeGreaterThan(scopeBox!.x);

        await page.keyboard.press('Tab');
        await expectPlaywright(
          heading.getByRole('button', { name: 'Close Session inventory' }),
        ).toBeFocused();
        await page.keyboard.press('Tab');
        await expectPlaywright(
          page.getByRole('button', { name: /^Inputs/ }),
        ).toBeFocused();
      } finally {
        await page.close();
      }
    });

    test('keeps desktop Basis fallback below app chrome and wholly inside the supported desktop viewport', async () => {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
      });
      try {
        await page.setContent(buildBasisFallbackHtml());
        const header = page.locator('#app-header');
        const overlay = page.locator('.basis-pane-fallback-overlay');
        const panel = page.getByRole('dialog', { name: 'Basis' });
        const [headerBox, overlayBox, panelBox] = await Promise.all([
          header.boundingBox(),
          overlay.boundingBox(),
          panel.boundingBox(),
        ]);
        expect(headerBox).not.toBeNull();
        expect(overlayBox).not.toBeNull();
        expect(panelBox).not.toBeNull();
        expect(overlayBox!.y).toBeGreaterThanOrEqual(
          headerBox!.y + headerBox!.height,
        );
        expect(panelBox!.y).toBeGreaterThanOrEqual(overlayBox!.y);
        expect(panelBox!.x).toBeGreaterThanOrEqual(0);
        expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(1440);
        expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(900);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        await panel.getByRole('button', { name: 'Close Basis' }).focus();
        await expectPlaywright(
          panel.getByRole('button', { name: 'Close Basis' }),
        ).toBeFocused();
      } finally {
        await page.close();
      }
    });

    test('preserves the mobile full-height Basis sheet geometry', async () => {
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
      });
      try {
        await page.setContent(buildBasisFallbackHtml());
        const overlay = page.locator('.basis-pane-fallback-overlay');
        const panel = page.getByRole('dialog', { name: 'Basis' });
        const [overlayBox, panelBox] = await Promise.all([
          overlay.boundingBox(),
          panel.boundingBox(),
        ]);
        expect(overlayBox).not.toBeNull();
        expect(panelBox).not.toBeNull();
        expect(overlayBox!.x).toBe(0);
        expect(overlayBox!.y).toBe(0);
        expect(overlayBox!.width).toBe(390);
        expect(overlayBox!.height).toBe(844);
        expect(panelBox!.height).toBeGreaterThanOrEqual(overlayBox!.height - 1);
      } finally {
        await page.close();
      }
    });
  },
);

test.skipIf(chromiumAvailable)(
  'Session inventory compact host mobile geometry — Chromium not installed',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so Session inventory compact mobile geometry cannot be verified. Run npm run install:playwright and retry.',
    );
  },
);
