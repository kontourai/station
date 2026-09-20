/** @vitest-environment jsdom */
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { cleanup, render } from '@testing-library/react';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { ProjectSidebarHeader } from '../components/project-sidebar/ProjectSidebarHeader';

const css = [
  '../index.css',
  '../components/project-sidebar/ProjectSidebar.css',
]
  .map((path) => resolveCssImports(resolve(import.meta.dirname, path)))
  .join('\n');

// #2254: the iOS runtime smoke dropped its tap on "Close navigation" because
// the button laid out at 24x24 (16px glyph + 4px padding), below the 44x44
// minimum touch target. jsdom cannot compute layout, so this proves the real
// rendered geometry and the center-point hit test in a browser page.
describe('mobile drawer close touch target', () => {
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });
  afterEach(cleanup);

  test('Close navigation is at least 44x44 and its center hit-tests to the button', async () => {
    const { container } = render(
      <ProjectSidebarHeader
        appName="Station"
        homeLabel="Station v0.1.2"
        collapsed={false}
        isMobile
        onCloseMobile={() => {}}
        onGoHome={() => {}}
        onToggleCollapse={() => {}}
      />,
    );
    const page = await browser.newPage({
      viewport: { width: 390, height: 800 },
    });
    try {
      await page.setContent(
        // The drawer-open surface is what the smoke test taps inside: at
        // mobile widths `.sidebar` alone is display:none; `.sidebar--expanded`
        // is the overlay drawer.
        `<style>${css}</style><div class="sidebar sidebar--expanded">${container.innerHTML}</div>`,
      );
      const close = page.getByRole('button', { name: 'Close navigation' });
      const box = await close.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);

      // A tap at the box center — what XCUITest delivers — must land on the
      // button (or its glyph), not on a sibling under a too-small target.
      const hit = await page.evaluate(
        ([cx, cy]) =>
          document.elementFromPoint(cx, cy)?.closest('.sidebar__mobile-close') !==
          null,
        [box!.x + box!.width / 2, box!.y + box!.height / 2],
      );
      expect(hit).toBe(true);

      // Only the hit target grew; the visible glyph stays 16px.
      const glyph = await close.locator('svg').boundingBox();
      expect(glyph!.width).toBe(16);
      expect(glyph!.height).toBe(16);
    } finally {
      await page.close();
    }
  }, 120_000);
});
