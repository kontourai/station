import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import {
  bookSnapshot,
  coldLaunchBookSnapshot,
  coldLaunchFirstSnapshot,
  flatSnapshot,
} from '../platform/fold/__tests__/nativeFoldFixtures';
import { scrollBrowserFixture } from './scroll-browser-fixture';

/*
 * The fold, end to end in Chromium: a source (the iOS plugin's `state` reply
 * through a stand-in Tauri IPC, or Chromium's own Viewport Segments
 * emulation) feeds the one fold store, `useFoldSplit` measures, and the
 * production CSS places the panes. Rendered geometry is asserted, not markup.
 */

const CSS =
  resolveCssImports(resolve(import.meta.dirname, '../index.css')) +
  resolveCssImports(
    resolve(
      import.meta.dirname,
      '../components/chat-dock/ChatDockInboxPanel.css',
    ),
  );

/** A single column (the route outlet's treatment) above a real list/detail. */
const LAYOUT = `
import React, {useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {installFoldGeometry} from './src-ui/src/platform/fold/foldSources';
import {useFoldSplit} from './src-ui/src/hooks/useFoldSplit';
import {SplitPaneLayout} from './src-ui/src/components/SplitPaneLayout';
import {NavigationProvider} from './src-ui/src/contexts/NavigationContext';
document.head.insertAdjacentHTML('beforeend', '<meta name="viewport" content="width=device-width, initial-scale=1">');
__SETUP__
installFoldGeometry();
function Column() {
  const ref = useRef(null);
  useFoldSplit(ref);
  return <div ref={ref} className="fold-avoid-crease" data-probe="column"
    style={{position:'fixed', left:0, right:0, top:0, height:100}}>
    <p data-probe="text">A single column of text that must not cross the crease.</p>
  </div>;
}
function Split() {
  return <div style={{position:'fixed', left:0, right:0, top:120, bottom:0, display:'flex'}}>
    <SplitPaneLayout label="Fixture" title="Fixture" items={[{id:'a', name:'Alpha'}, {id:'b', name:'Beta'}]}
      selectedId="a" onSelect={()=>{}} onSearch={()=>{}}>
      <div data-probe="detail">Alpha detail</div>
    </SplitPaneLayout>
  </div>;
}
createRoot(document.getElementById('root')).render(<NavigationProvider><Column/><Split/></NavigationProvider>);
`;

/** A stand-in for Tauri's IPC: answers `station-fold` and delivers its nudge. */
const NATIVE_SETUP = `
const callbacks = new Map();
let nextId = 1, nextIndex = 0, channel = null;
window.__foldState = ${JSON.stringify(bookSnapshot)};
window.__TAURI_INTERNALS__ = {
  transformCallback(cb) { const id = nextId++; callbacks.set(id, cb); return id; },
  unregisterCallback(id) { callbacks.delete(id); },
  async invoke(cmd, args) {
    if (cmd === 'plugin:station-fold|state') return window.__foldState;
    if (cmd === 'plugin:station-fold|register_listener') { channel = args.handler; return null; }
    throw new Error('unexpected command ' + cmd);
  },
};
window.__foldNudge = () => callbacks.get(channel.id)({ index: nextIndex++, message: {} });
`;

/**
 * A cold launch into Book, as the plugin answers it: the first `state` is the
 * launch reading (no hinge, no region), every later one is Book. No `change`
 * event is ever delivered and nothing resizes.
 */
const COLD_SETUP = `
window.__foldReplies = [];
window.__TAURI_INTERNALS__ = {
  transformCallback() { return 1; },
  unregisterCallback() {},
  async invoke(cmd) {
    if (cmd === 'plugin:station-fold|state') {
      const reply = window.__foldReplies.length === 0
        ? ${JSON.stringify(coldLaunchFirstSnapshot)}
        : ${JSON.stringify(coldLaunchBookSnapshot)};
      window.__foldReplies.push(reply.regions.length);
      return reply;
    }
    if (cmd === 'plugin:station-fold|register_listener') return null;
    throw new Error('unexpected command ' + cmd);
  },
};
`;

async function geometry(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const el = document.querySelector(selector);
      if (!el?.getClientRects().length) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width };
    };
    const column = document.querySelector<HTMLElement>(
      '[data-probe="column"]',
    )!;
    return {
      textLeft: box('[data-probe="text"]')?.left ?? null,
      columnPadding: parseFloat(getComputedStyle(column).paddingLeft),
      list: box('.split-pane__left'),
      detail: box('.split-pane__right'),
      divider: box('.split-pane__divider'),
      posture: document.documentElement.dataset.foldPosture ?? null,
    };
  });
}

const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );

test('the native Book crease keeps a column off it and puts the list/detail split on it', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(
    LAYOUT.replace('__SETUP__', NATIVE_SETUP),
    [],
    { viewport: { width: 951, height: 669 } },
  );
  try {
    await page.addStyleTag({ content: CSS });
    await page.waitForFunction(
      () => document.documentElement.dataset.foldPosture === 'folded',
    );
    await page.waitForSelector('.split-pane--fold-snapped', { timeout: 5000 });
    await settle(page);
    const [crease] = bookSnapshot.regions;
    const creaseEnd = crease.x + crease.width;
    const book = await geometry(page);
    // The column's text starts after the crease, not across it.
    expect(book.textLeft).toBeGreaterThanOrEqual(creaseEnd - 1);
    // The split IS the crease: list before it, detail after it, no drag divider.
    expect(book.list?.left).toBe(0);
    expect(Math.abs(book.list!.right - crease.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(book.detail!.left - creaseEnd)).toBeLessThanOrEqual(1);
    expect(book.divider).toBeNull();

    // The hinge opens flat: the plugin nudges, the page re-reads, and both
    // layouts give the space back (the list returns to its own width).
    await page.evaluate((flat) => {
      (window as unknown as { __foldState: unknown }).__foldState = flat;
      (window as unknown as { __foldNudge: () => void }).__foldNudge();
    }, flatSnapshot);
    await page.waitForFunction(
      () => document.documentElement.dataset.foldPosture === 'flat',
    );
    await page.waitForSelector('.split-pane:not(.split-pane--fold-snapped)', {
      timeout: 5000,
    });
    await settle(page);
    const flat = await geometry(page);
    expect(flat.columnPadding).toBe(0);
    expect(Math.abs(flat.list!.right - crease.x)).toBeGreaterThan(40);
    expect(flat.divider).not.toBeNull();
    await page.screenshot({
      path: resolve('.kontourai/fold-layout/native-book.png'),
    });
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('without a native plugin, CSS Viewport Segments drive the same layouts', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(
    LAYOUT.replace('__SETUP__', ''),
    [],
    { viewport: { width: 951, height: 669 } },
  );
  try {
    await page.addStyleTag({ content: CSS });
    const cdp = await page.context().newCDPSession(page);
    const feature = {
      orientation: 'vertical' as const,
      offset: 400,
      maskLength: 0,
    };
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 951,
      height: 669,
      deviceScaleFactor: 1,
      mobile: false,
      displayFeature: feature,
    });
    await cdp.send('Emulation.setDevicePostureOverride', {
      posture: { type: 'folded' },
    });
    // Segments are read at install and on every resize, which is how an
    // engine reports a posture change; send the one the override implies.
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.waitForFunction(
      () => document.documentElement.dataset.foldPosture === 'folded',
    );
    // Wait for the effect, not a frame count: the split re-renders a frame
    // after it measures.
    await page.waitForSelector('.split-pane--fold-snapped', { timeout: 5000 });
    await settle(page);
    const folded = await geometry(page);
    // The larger side is after the crease, so the column moves there.
    expect(folded.textLeft).toBeGreaterThanOrEqual(399);
    expect(Math.abs(folded.list!.right - 400)).toBeLessThanOrEqual(1);
    expect(Math.abs(folded.detail!.left - 400)).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

const SPLIT_ONLY = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {SplitPaneLayout} from './src-ui/src/components/SplitPaneLayout';
import {NavigationProvider} from './src-ui/src/contexts/NavigationContext';
document.head.insertAdjacentHTML('beforeend', '<meta name="viewport" content="width=device-width, initial-scale=1">');
createRoot(document.getElementById('root')).render(
  <NavigationProvider><div style={{position:'fixed', inset:0, display:'flex'}}>
    <SplitPaneLayout label="Fixture" title="Fixture" items={[{id:'a', name:'Alpha'}]}
      selectedId={null} onSelect={()=>{}} onSearch={()=>{}}><div>detail</div></SplitPaneLayout>
  </div></NavigationProvider>);
`;

test.each([
  // A foldable open flat in portrait: a phone shell with room for both panes.
  { width: 669, height: 951, touch: true, sideBySide: true },
  // Narrower than 641px the split's own container rule shows list OR detail
  // (the narrow-region mode, with a back control rather than a sheet).
  { width: 640, height: 900, touch: true, sideBySide: false },
  // Every phone in portrait, and a phone held sideways, still stack.
  { width: 599, height: 900, touch: true, sideBySide: false },
  { width: 852, height: 393, touch: true, sideBySide: false },
])(
  'list/detail at $width×$height (touch $touch) side by side: $sideBySide',
  async ({ width, height, touch, sideBySide }) => {
    const { browser, page, errors } = await scrollBrowserFixture(
      SPLIT_ONLY,
      [],
      {
        viewport: { width, height },
        hasTouch: touch,
        isMobile: touch,
      },
    );
    try {
      await page.addStyleTag({ content: CSS });
      await page.locator('.split-pane__left').waitFor();
      await settle(page);
      const [list, detail] = await page.evaluate(() =>
        ['.split-pane__left', '.split-pane__right'].map((selector) => {
          const el = document.querySelector(selector);
          if (!el || !el.getClientRects().length) return null;
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top };
        }),
      );
      expect(list).not.toBeNull();
      if (sideBySide) {
        // Side by side: on the same row, the detail right of the list
        // (across at most the resize divider).
        expect(detail).not.toBeNull();
        expect(detail!.top).toBe(list!.top);
        expect(detail!.left).toBeGreaterThanOrEqual(list!.right - 1);
        expect(detail!.left - list!.right).toBeLessThanOrEqual(24);
      } else {
        expect(detail).toBeNull();
      }
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  },
);

const SHELL = `
import React from 'react';
import {createRoot} from 'react-dom/client';
document.head.insertAdjacentHTML('beforeend', '<meta name="viewport" content="width=device-width, initial-scale=1">');
createRoot(document.getElementById('root')).render(
  <div className="app__main" style={{height:'100vh'}}>
    <header className="app-toolbar"><button type="button" className="tap-target" style={{minHeight:44, minWidth:44}}>Menu</button></header>
    <main className="main-content"><div className="content-view"><p data-probe="heading">What would you like to do? A long first line of the page.</p></div></main>
  </div>);
`;

test('the route outlet stays inside a side safe area (a cover display’s vertical status bar)', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(SHELL, [], {
    viewport: { width: 466, height: 678 },
    hasTouch: true,
    isMobile: true,
  });
  try {
    await page.addStyleTag({ content: CSS });
    await page.evaluate(() =>
      document.documentElement.style.setProperty('--safe-right', '84px'),
    );
    await settle(page);
    const right = await page
      .locator('[data-probe="heading"]')
      .evaluate((el) => el.getBoundingClientRect().right);
    expect(right).toBeLessThanOrEqual(466 - 84);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test.each([
  // Tent posture's cover display, and a phone held sideways: compact chrome.
  { width: 678, height: 466, compact: true },
  // The same device upright keeps the roomier bar.
  { width: 466, height: 678, compact: false },
])(
  'toolbar at $width×$height keeps 44px controls; compact: $compact',
  async ({ width, height, compact }) => {
    const { browser, page, errors } = await scrollBrowserFixture(SHELL, [], {
      viewport: { width, height },
      hasTouch: true,
      isMobile: true,
    });
    try {
      await page.addStyleTag({ content: CSS });
      await settle(page);
      const { bar, control } = await page.evaluate(() => ({
        bar: document.querySelector('.app-toolbar')!.getBoundingClientRect()
          .height,
        control: document
          .querySelector('.app-toolbar button')!
          .getBoundingClientRect().height,
      }));
      expect(control).toBeGreaterThanOrEqual(44);
      if (compact) expect(bar).toBeLessThanOrEqual(45);
      else expect(bar).toBeGreaterThan(45);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  },
);

/** The dock's row mounts only once the dock opens, after its owner mounted. */
const DOCK_ROW = `
import React, {useEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {installFoldGeometry} from './src-ui/src/platform/fold/foldSources';
import {useFoldSplit} from './src-ui/src/hooks/useFoldSplit';
${NATIVE_SETUP}
installFoldGeometry();
function Dock() {
  const [open, setOpen] = useState(false);
  const row = useRef(null);
  useFoldSplit(row);
  useEffect(() => { const t = setTimeout(() => setOpen(true), 100); return () => clearTimeout(t); }, []);
  if (!open) return null;
  return <div ref={row} className="chat-dock__workspace" style={{position:'fixed', inset:0, display:'flex'}}>
    <aside className="chat-dock-inbox">Inbox rows</aside>
    <div className="chat-dock__reader" style={{flex:1, minWidth:0}}>Transcript</div>
  </div>;
}
createRoot(document.getElementById('root')).render(<Dock/>);
`;

test('the dock’s Inbox snaps to the crease even when its row mounts after the dock', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(DOCK_ROW, [], {
    viewport: { width: 951, height: 669 },
  });
  try {
    await page.addStyleTag({ content: CSS });
    await page.waitForSelector(
      '.chat-dock__workspace[data-fold-split="vertical"]',
      {
        timeout: 5000,
      },
    );
    // The panel slides in; measure where it rests.
    await page.evaluate(() =>
      Promise.all(document.getAnimations().map((a) => a.finished)),
    );
    await settle(page);
    const [crease] = bookSnapshot.regions;
    const { inbox, reader } = await page.evaluate(() => ({
      inbox: document.querySelector('.chat-dock-inbox')!.getBoundingClientRect()
        .right,
      reader: document
        .querySelector('.chat-dock__reader')!
        .getBoundingClientRect().left,
    }));
    expect(Math.abs(inbox - crease.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(reader - (crease.x + crease.width))).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('a cold launch into Book reaches the split when the first reply is empty and nothing changes after', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(
    LAYOUT.replace('__SETUP__', COLD_SETUP),
    [],
    { viewport: { width: 951, height: 669 } },
  );
  try {
    await page.addStyleTag({ content: CSS });
    await page.waitForSelector('.split-pane--fold-snapped', { timeout: 5000 });
    await settle(page);
    const replies = await page.evaluate(
      () => (window as unknown as { __foldReplies: number[] }).__foldReplies,
    );
    // The page's first answer really was the empty launch reading.
    expect(replies[0]).toBe(0);
    expect(replies.at(-1)).toBe(1);
    const [crease] = coldLaunchBookSnapshot.regions;
    const book = await geometry(page);
    expect(Math.abs(book.list!.right - crease.x)).toBeLessThanOrEqual(1);
    expect(book.textLeft).toBeGreaterThanOrEqual(crease.x + crease.width - 1);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
