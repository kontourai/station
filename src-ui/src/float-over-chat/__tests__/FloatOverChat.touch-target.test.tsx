// @vitest-environment jsdom

/**
 * #90 D9: the float's pill controls are 44px touch targets, measured in a
 * real Chromium against the real cascade (`index.css`, then this chunk's
 * `FloatOverChat.css`), not read out of the stylesheet. jsdom lays nothing
 * out, so a stylesheet read cannot see a later `max-height`, a `transform` or
 * a `zoom` on the same rule, a global rule that outranks it, or an ancestor
 * that scales the pill; a measured box does.
 *
 * The markup is the real component's: `FloatOverChat` renders in jsdom with
 * the pill opened, and that DOM is what Chromium styles. Each control is
 * measured at rest and while hovered, focused and pressed, at a phone and a
 * desktop viewport. State selectors this markup never enters stay with the
 * same-sheet scan in `FloatOverChat.test.tsx`.
 */

import { resolve } from 'node:path';
import type { BrowserSessionView } from '@kontourai/station-contracts/workspace-browser-pane';
import { chromium } from '@playwright/test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { resolveCssImports } from '../../../../tests/helpers/css-cascade-fixture';
import { MIN_TOUCH_TARGET_PX } from '../../../../tests/helpers/touch-target';

vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('../../hooks/useFeatureSettings', () => ({
  useFeatureSettings: () => ({ settings: {} }),
}));
vi.mock('../../contexts/useOpenInRegion', () => ({
  useOpenBrowserSessionInRegion: () => () => {},
  describeOpenInRegionRefusal: (reason: string) => reason,
}));
// An agent holds control, so the pill carries all four of its controls
// (Take control only renders when the person can claim).
vi.mock('../../live-surface/LiveSurfaceCanvas', () => ({
  LiveSurfaceCanvas: (props: { onControlState?: (state: unknown) => void }) => {
    const { onControlState } = props;
    useEffect(() => {
      onControlState?.({
        status: 'live',
        tone: 'agent',
        claimControl: async () => {},
      });
    }, [onControlState]);
    return <div data-testid="float-canvas" />;
  },
}));

import FloatOverChat from '../FloatOverChat';
import { resetFloatStoreForTests } from '../floatStore';

const css = ['../../index.css', '../FloatOverChat.css']
  .map((path) => resolveCssImports(resolve(import.meta.dirname, path)))
  .join('\n');

const SESSION: BrowserSessionView = {
  browserSessionId: 'bs_0f8f7c1e-9a41-4f2b-9d4a-2b8b1c0e5a77',
  projectId: 'p-alpha',
  projectSlug: 'alpha',
  principalKey: 'operator',
  reach: 'operator',
  threadId: 'conversation-1',
  url: 'https://example.com/path',
  viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
  generation: 1,
  state: 'live',
  createdAt: '2026-09-22T12:00:00.000Z',
  updatedAt: '2026-09-22T12:00:00.000Z',
  history: { entries: [], total: 0 },
  activity: {
    agentDriven: true,
    lastDriver: { kind: 'agent', sessionId: 'agent-session-1' },
  },
  surfaceId: 'browser:0f8f7c1e-9a41-4f2b-9d4a-2b8b1c0e5a77:g1',
};

const CHAT = { width: 900, height: 700, composer: 120 };

function rect(left: number, top: number, width: number, height: number) {
  return {
    left,
    top,
    width,
    height,
    x: left,
    y: top,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

/** The open pill's DOM, as the real component renders it over a chat body. */
async function openPillMarkup(): Promise<string> {
  const area = document.createElement('div');
  document.body.appendChild(area);
  area.getBoundingClientRect = () => rect(0, 0, CHAT.width, CHAT.height);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains('float-over-chat__anchor')
        ? rect(0, CHAT.height - CHAT.composer, CHAT.width, 0)
        : rect(0, 0, 0, 0);
    },
  );
  const transport = vi.fn(async (input: unknown) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/browser/projects/alpha/access')
      return Response.json({
        success: true,
        data: {
          projectId: 'p-alpha',
          role: 'operator',
          principalKey: 'operator',
          operator: true,
          browser: 'ready',
        },
      });
    if (url.pathname === '/api/browser/sessions')
      return Response.json({
        success: true,
        data: [{ ...SESSION, serverNow: new Date().toISOString() }],
      });
    return Response.json({ success: false }, { status: 404 });
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <FloatOverChat
        session={{
          id: 'tab-1',
          conversationId: 'conversation-1',
          projectSlug: 'alpha',
        }}
        transport={transport as never}
      />
    </QueryClientProvider>,
    { container: area },
  );
  await screen.findByTestId('float-canvas');
  fireEvent.click(
    screen.getByRole('button', { name: /^Floating browser controls/ }),
  );
  await screen.findByRole('toolbar', { name: 'Floating browser' });
  const markup = area.innerHTML;
  client.clear();
  return markup;
}

let browser: Awaited<ReturnType<typeof chromium.launch>>;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetFloatStoreForTests();
  window.localStorage.clear();
  document.body.innerHTML = '';
});

test('every pill control renders at least 44x44 at rest, hovered, focused and pressed, on a phone and a desktop', async () => {
  const markup = await openPillMarkup();
  const failures: string[] = [];
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1280, height: 800 },
  ]) {
    const page = await browser.newPage({ viewport });
    try {
      await page.setContent(
        `<!doctype html><html><head><style>${css}</style></head><body>` +
          `<div style="position:relative;width:${CHAT.width}px;height:${CHAT.height}px">${markup}</div>` +
          '</body></html>',
      );
      const controls = page
        .getByRole('toolbar', { name: 'Floating browser' })
        .getByRole('button');
      const names: string[] = [];
      for (const control of await controls.all())
        names.push(
          (await control.getAttribute('aria-label')) ??
            (await control.innerText()).trim(),
        );
      // The exact set: a control added later is measured, not skipped.
      expect(names).toEqual([
        'Move floating browser. Arrow keys move it; Shift and an arrow key resize it.',
        'Take control',
        'Open in right panel',
        'Close floating browser',
      ]);
      const measure = async (state: string) => {
        for (const [index, control] of (await controls.all()).entries()) {
          const box = await control.boundingBox();
          const label = `${viewport.width}px, ${state}: ${names[index]}`;
          if (box === null) failures.push(`${label}: not rendered`);
          else if (
            box.width < MIN_TOUCH_TARGET_PX ||
            box.height < MIN_TOUCH_TARGET_PX
          )
            failures.push(`${label}: ${box.width}x${box.height}`);
        }
      };
      await measure('at rest');
      for (const [index, control] of (await controls.all()).entries()) {
        // The raw pointer, not `locator.hover()`: a control that shrinks
        // under the pointer never settles, and its actionability wait would
        // time out instead of reporting the size.
        const box = await control.boundingBox();
        if (box === null) continue;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await measure(`hovering "${names[index]}"`);
        await control.focus();
        await measure(`focusing "${names[index]}"`);
        await page.mouse.down();
        await measure(`pressing "${names[index]}"`);
        await page.mouse.up();
      }
    } finally {
      await page.close();
    }
  }
  expect(failures).toEqual([]);
}, 120_000);
