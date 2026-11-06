// @vitest-environment jsdom

/**
 * Pinch zoom keeps taps honest, in a real Chromium against the real cascade.
 *
 * The zoom is a CSS transform on the layer that holds the canvas, and the
 * pointer mapping reads the canvas's client rect, trusting the browser to
 * report that rect already moved and scaled. jsdom cannot check that trust
 * (it lays nothing out), so: the REAL canvas is pinched in jsdom, its markup
 * (with the zoom it chose) is laid out by Chromium with `index.css` and
 * `LiveSurfaceCanvas.css`, and the rect Chromium reports is mapped with the
 * production `mapClientPointToSurface`. The surface pixel under a client
 * point must be the one the zoom drew there.
 */

import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { fireEvent, screen } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { resolveCssImports } from '../../../../tests/helpers/css-cascade-fixture';
import { mapClientPointToSurface } from '../liveSurfaceGeometry';
import {
  canvasHarness,
  layoutStage,
  lease,
  MY_HOLD,
  renderCanvas,
} from './fixtures/canvasStreamHarness';

const css = ['../../index.css', '../LiveSurfaceCanvas.css']
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

const touch = (pointerId: number, clientX: number, clientY: number) => ({
  pointerId,
  pointerType: 'touch',
  button: 0,
  clientX,
  clientY,
});

/** The canvas and stage boxes Chromium lays `markup` out at. */
async function layOut(markup: string) {
  const page = await browser.newPage({ viewport: { width: 400, height: 250 } });
  try {
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style></head><body style="margin:0">` +
        `<div style="width:400px;height:250px">${markup}</div></body></html>`,
    );
    return await page.evaluate(() => {
      const box = (selector: string) => {
        const rect = document.querySelector(selector)!.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        };
      };
      return { canvas: box('canvas'), stage: box('.live-surface__stage') };
    });
  } finally {
    await page.close();
  }
}

test('a pinched live view maps a tap to the surface pixel the zoom drew under it', async () => {
  layoutStage({ width: 400, height: 250 });
  const h = canvasHarness();
  const { container } = await renderCanvas(h, {}, lease(0, MY_HOLD));
  const root = () =>
    (container.querySelector('.live-surface') as HTMLElement).outerHTML;
  const fit = await layOut(root());
  // Spread two fingers off-centre: 2x about (120, 80), so the zoom both
  // scales and moves (a wrong transform origin would show up as a shift).
  const canvas = screen.getByTestId('live-surface-canvas');
  fireEvent.pointerDown(canvas, touch(1, 95, 80));
  fireEvent.pointerDown(canvas, touch(2, 145, 80));
  fireEvent.pointerMove(canvas, touch(1, 70, 80));
  fireEvent.pointerMove(canvas, touch(2, 170, 80));
  const zoom = { x: -120, y: -80, scale: 2 };
  expect(screen.getByTestId('live-surface-zoom').style.transform).toBe(
    `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`,
  );
  const zoomed = await layOut(root());
  expect(zoomed.stage).toEqual(fit.stage); // the stage itself never moves
  const frame = { width: 1280, height: 800, deviceScaleFactor: 2 };
  // The invariant: a stage point q is drawn at q * scale + translate. So the
  // client point P on the zoomed view shows the picture point that sits,
  // unzoomed, at stage + (P - stage - translate) / scale.
  for (const at of [
    { x: 120, y: 120 },
    { x: 320, y: 200 },
    { x: 60, y: 90 },
  ]) {
    const unzoomed = {
      x: fit.stage.left + (at.x - fit.stage.left - zoom.x) / zoom.scale,
      y: fit.stage.top + (at.y - fit.stage.top - zoom.y) / zoom.scale,
    };
    const expected = mapClientPointToSurface(unzoomed, fit.canvas, frame);
    expect(expected, `picture under ${at.x},${at.y}`).not.toBeNull();
    expect(mapClientPointToSurface(at, zoomed.canvas, frame)).toEqual(expected);
  }
});
