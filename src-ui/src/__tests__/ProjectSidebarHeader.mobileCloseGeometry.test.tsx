/** @vitest-environment jsdom */
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { cleanup, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { ProjectSidebarHeader } from '../components/project-sidebar/ProjectSidebarHeader';

const css = ['../index.css', '../components/project-sidebar/ProjectSidebar.css']
  .map((path) => resolveCssImports(resolve(import.meta.dirname, path)))
  .join('\n');

// #2260: the failed iOS smoke exposed a 24x24 close control. This test
// measures the rendered target and hit testing; native interaction has its
// own packaged-simulator smoke.
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

      // Check the control center and a point outside the viewport; a missing
      // element must never be accepted as a hit.
      const hit = await page.evaluate(
        ([cx, cy]) => ({
          center: Boolean(
            document
              .elementFromPoint(cx, cy)
              ?.closest('.sidebar__mobile-close'),
          ),
          outside: Boolean(
            document
              .elementFromPoint(-1, -1)
              ?.closest('.sidebar__mobile-close'),
          ),
        }),
        [box!.x + box!.width / 2, box!.y + box!.height / 2],
      );
      expect(hit).toEqual({ center: true, outside: false });

      // Only the hit target grew; the visible glyph stays 16px.
      const glyph = await close.locator('svg').boundingBox();
      expect(glyph!.width).toBe(16);
      expect(glyph!.height).toBe(16);
    } finally {
      await page.close();
    }
  }, 120_000);
});
