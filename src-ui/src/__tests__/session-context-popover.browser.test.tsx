/**
 * #3888: the session context card's collapsed-chip popover
 * (SessionContextSheet) opens on whichever side of the chip has more room,
 * as measured by ResponsiveDialogSurface (`data-anchor-side`), and caps itself
 * to that room. Real component and stylesheets in Chromium, with the chip
 * where a dock's header puts it: near the top of an 820px window (a tall or
 * maximized dock) and low in it (a bottom dock).
 */
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from 'vitest';
import {
  assertNoImportsSurvive,
  resolveCssImports,
} from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

const ROOT = resolve(import.meta.dirname, '../../..');
/** The app cascade, then the popover's own sheet, in the app's order. */
function appCss(): string {
  const css = [
    'src-ui/src/index.css',
    'src-ui/src/components/chat-dock/SessionContextChip.css',
    'src-ui/src/components/chat-dock/SessionContextCard.css',
  ]
    .map((path) => resolveCssImports(resolve(ROOT, path)))
    .join('\n');
  assertNoImportsSurvive(css);
  return css;
}

const VIEWPORT = { width: 1280, height: 820 };

async function popoverFixture() {
  const fixture = await scrollBrowserFixture(`
    import React, {useEffect, useRef, useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
    import {SessionContextSheet} from './src-ui/src/components/chat-dock/SessionContextSheet';
    const client = new QueryClient({defaultOptions: {queries: {retry: false, enabled: false}}});
    function App() {
      const chip = useRef(null);
      const [top, setTop] = useState(null);
      const [open, setOpen] = useState(false);
      useEffect(() => { window.__placeChip = (y) => setTop(y); }, []);
      return <QueryClientProvider client={client}>
        {top !== null && <button ref={chip} type="button" className="session-context-chip" aria-haspopup="dialog" aria-expanded={open}
          style={{position: 'fixed', top, right: 240}} onClick={() => setOpen(true)}>Working</button>}
        {open && <SessionContextSheet
          anchorRef={chip}
          returnFocusTarget={chip.current}
          onClose={() => setOpen(false)}
          workspace={{projectName: 'station', directory: '/Users/dev/src/station', action: {label: 'Open in Coding', onSelect() {}}}}
          gitStatus={{isRepo: true, branch: 'fix/session-surfaces', changes: ['a.ts', 'b.ts', 'c.ts'], staged: 0, unstaged: 3, untracked: 0, ahead: 2, behind: 0, lastCommit: null}}
          onOpenChanges={() => {}}
          status={{text: 'Working · 2m', tone: 'active'}}
          backgroundTasksRunning={2}
          onOpenBackgroundTasks={() => {}}
          pendingMessages={1}
          conversationId={null}
          inventory={{onOpen() {}}}
        />}
      </QueryClientProvider>;
    }
    document.documentElement.dataset.theme = 'dark';
    createRoot(document.getElementById('root')).render(<App/>);
  `);
  await fixture.page.setViewportSize(VIEWPORT);
  await fixture.page.addStyleTag({ content: appCss() });
  return fixture;
}

async function openAt(page: Page, chipTop: number) {
  await page.evaluate((y) => {
    (window as unknown as { __placeChip(y: number): void }).__placeChip(y);
  }, chipTop);
  await page.getByRole('button', { name: 'Working' }).click();
  const panel = page.locator('.session-context-sheet-panel');
  await panel.waitFor();
  // The surface measures the chip after mount; let placement settle.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  return page.evaluate(() => {
    const chip = document
      .querySelector('.session-context-chip')!
      .getBoundingClientRect();
    const panel = document.querySelector<HTMLElement>(
      '.session-context-sheet-panel',
    )!;
    const rect = panel.getBoundingClientRect();
    return {
      side: document
        .querySelector('.session-context-sheet-overlay')!
        .getAttribute('data-anchor-side'),
      chipTop: chip.top,
      chipBottom: chip.bottom,
      top: rect.top,
      bottom: rect.bottom,
      scrolls: panel.scrollHeight > panel.clientHeight + 1,
      viewport: window.innerHeight,
    };
  });
}

test('a chip low in the window (a bottom dock) opens its popover upward, unscrolled', async () => {
  const { browser, page, errors } = await popoverFixture();
  try {
    // About 250px below the chip, about 520px above it.
    const placed = await openAt(page, 520);
    expect(placed.side).toBe('above');
    expect(placed.bottom).toBeLessThanOrEqual(placed.chipTop);
    expect(placed.top).toBeGreaterThanOrEqual(0);
    expect(placed.scrolls).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('a chip near the top of the window opens its popover downward, inside the viewport', async () => {
  const { browser, page, errors } = await popoverFixture();
  try {
    const placed = await openAt(page, 60);
    expect(placed.side).toBe('below');
    expect(placed.top).toBeGreaterThanOrEqual(placed.chipBottom);
    expect(placed.bottom).toBeLessThanOrEqual(placed.viewport);
    expect(placed.scrolls).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
