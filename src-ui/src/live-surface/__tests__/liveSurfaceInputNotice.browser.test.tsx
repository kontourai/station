// @vitest-environment jsdom

/**
 * The input notice is one slim line over the top of the live view, in a real
 * Chromium against the real cascade. jsdom lays nothing out, so the REAL
 * canvas renders the notice in jsdom (a host-busy refusal, which offers
 * Retry) and Chromium styles that markup with `index.css`, the error
 * primitive's sheet and `LiveSurfaceCanvas.css`.
 *
 * Checked: the notice does not push the picture down (the stage keeps its
 * box), it is one line no taller than its 44px Retry, it sits at the stage's
 * top and is what a tap there hits (above the zoom layer and corner
 * buttons), in immersive mode it is a row under the controls rather than
 * under them, and no codec name is drawn under the picture.
 */

import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from 'vitest';
import { resolveCssImports } from '../../../../tests/helpers/css-cascade-fixture';
import { MIN_TOUCH_TARGET_PX } from '../../../../tests/helpers/touch-target';
import type { LiveSurfaceControlState } from '../LiveSurfaceCanvas';
import {
  canvasHarness,
  flush,
  layoutStage,
  lease,
  MY_HOLD,
  renderCanvas,
} from './fixtures/canvasStreamHarness';

const css = [
  '../../index.css',
  '../../../../packages/sdk/src/components/ErrorState.css',
  '../LiveSurfaceCanvas.css',
]
  .map((path) => resolveCssImports(resolve(import.meta.dirname, path)))
  .join('\n');

let browser: Awaited<ReturnType<typeof chromium.launch>>;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 1280, height: 800, close() {} })),
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const busy = () =>
  Response.json({ success: false, code: 'surface-busy' }, { status: 503 });

/** The live view's markup with the host-busy notice (and Retry) showing. */
async function markupWithNotice(options: { immersive: boolean }) {
  layoutStage({ width: 390, height: 244 });
  const h = canvasHarness({ inputReply: busy });
  let control: LiveSurfaceControlState | undefined;
  const { container } = await renderCanvas(
    h,
    {
      onControlState: (state) => {
        control = state;
      },
    },
    lease(0, MY_HOLD),
  );
  if (options.immersive) {
    act(() => control?.enterImmersive());
    await flush();
  }
  fireEvent.pointerDown(screen.getByTestId('live-surface-canvas'), {
    clientX: 20,
    clientY: 20,
    button: 0,
    pointerId: 1,
  });
  await flush();
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  const root = container.querySelector('.live-surface') as HTMLElement;
  const html = root.outerHTML;
  // The same view with no notice: the stage's box must not change.
  const without = html.replace(
    /<div role="alert" class="error-state live-surface__input-notice">[\s\S]*?<\/button><\/div><\/div><\/div>/,
    '',
  );
  expect(without).not.toBe(html);
  return { html, without };
}

async function layOut(
  markup: string,
  viewport: { width: number; height: number },
  theme: 'dark' | 'light',
  shot?: string,
) {
  const page = await browser.newPage({ viewport });
  try {
    await page.setContent(
      `<!doctype html><html data-theme="${theme}"><head><style>${css}</style></head><body style="margin:0">` +
        `<div style="display:flex;flex-direction:column;width:${viewport.width}px;height:${Math.round(viewport.width * 0.625) + 60}px">${markup}</div></body></html>`,
    );
    // A picture on the canvas, so a screenshot shows what the notice covers.
    await page.evaluate(() => {
      const canvas = document.querySelector('canvas')!;
      canvas.width = 640;
      canvas.height = 400;
      const g = canvas.getContext('2d')!;
      const fill = g.createLinearGradient(0, 0, 640, 400);
      fill.addColorStop(0, '#3a7bd5');
      fill.addColorStop(0.5, '#00d2ff');
      fill.addColorStop(1, '#f7971e');
      g.fillStyle = fill;
      g.fillRect(0, 0, 640, 400);
    });
    const evidence = process.env.STATION_UI_EVIDENCE_DIR;
    if (evidence && shot)
      await page.screenshot({ path: `${evidence}/${shot}.png` });
    return await page.evaluate(() => {
      const box = (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        };
      };
      const notice = document.querySelector('.live-surface__input-notice');
      const noticeBox = box('.live-surface__input-notice > .empty');
      const hit = noticeBox
        ? document.elementFromPoint(
            noticeBox.left + 8,
            noticeBox.top + noticeBox.height / 2,
          )
        : null;
      const label = document.querySelector(
        '.live-surface__input-notice .empty__label',
      ) as HTMLElement | null;
      return {
        stage: box('.live-surface__stage'),
        canvas: box('canvas'),
        notice: noticeBox,
        retry: box('.live-surface__input-notice button'),
        controls: box('.live-surface__immersive-bar .live-surface-controls'),
        hitIsNotice: !!(hit && notice?.contains(hit)),
        labelLines: label
          ? Math.round(
              label.getBoundingClientRect().height /
                Number.parseFloat(getComputedStyle(label).lineHeight),
            )
          : 0,
        text: document.body.textContent ?? '',
      };
    });
  } finally {
    await page.close();
  }
}

test.each([
  { theme: 'dark', viewport: { width: 390, height: 844 } },
  { theme: 'light', viewport: { width: 390, height: 844 } },
  { theme: 'dark', viewport: { width: 412, height: 915 } },
  { theme: 'dark', viewport: { width: 1440, height: 900 } },
  { theme: 'light', viewport: { width: 1440, height: 900 } },
] as const)(
  'the input notice is one slim line over the top of the picture ($theme, $viewport.width px)',
  async ({ theme, viewport }) => {
    const { html, without } = await markupWithNotice({ immersive: false });
    const shown = await layOut(
      html,
      viewport,
      theme,
      `input-notice-${theme}-${viewport.width}`,
    );
    const hidden = await layOut(without, viewport, theme);
    // Over the picture, not pushing it (or the stage) down.
    expect(shown.stage).toEqual(hidden.stage);
    expect(shown.canvas).toEqual(hidden.canvas);
    const { stage, notice, retry } = shown;
    if (!stage || !notice || !retry) throw new Error('not rendered');
    expect(notice.top - stage.top).toBeLessThanOrEqual(12);
    expect(notice.top).toBeGreaterThanOrEqual(stage.top);
    // One line, no taller than its 44px Retry plus its 1px borders.
    expect(shown.labelLines).toBe(1);
    expect(notice.height).toBeLessThanOrEqual(46);
    expect(retry.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    expect(retry.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    // On top: a tap on it hits it, not the picture under it.
    expect(shown.hitIsNotice).toBe(true);
    // No codec name drawn under the picture.
    expect(shown.text).not.toMatch(/\b(JPEG|PNG|H\.264)\b/);
  },
  120_000,
);

test.each([
  { theme: 'dark', viewport: { width: 390, height: 844 } },
  { theme: 'light', viewport: { width: 1440, height: 900 } },
] as const)(
  'in immersive mode the notice is a row under the controls, never under them ($theme, $viewport.width px)',
  async ({ theme, viewport }) => {
    const { html } = await markupWithNotice({ immersive: true });
    const shown = await layOut(
      html,
      viewport,
      theme,
      `input-notice-immersive-${theme}-${viewport.width}`,
    );
    const { notice, controls, retry } = shown;
    if (!notice || !controls || !retry) throw new Error('not rendered');
    // Below the bar's controls, not overlapping them.
    expect(notice.top).toBeGreaterThanOrEqual(controls.top + controls.height);
    expect(shown.hitIsNotice).toBe(true);
    expect(retry.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
  },
  120_000,
);
