import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

// The production region bar of a right-side region holding a long-titled
// chat tab and the selected Agents tab, beside its Move, Add, Expand and Hide
// buttons — the owner's screenshot showed "#4501 · Agen".
const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {RegionChromeBar} from './src-ui/src/workspace-panes/RegionChromeBar';
import {KeyboardShortcutsProvider} from './src-ui/src/contexts/KeyboardShortcutsContext';
const noop = () => {};
const chrome = {
  isDockOpen: true, isDockMaximized: false, dockMode: 'right', dockHeight: 320,
  dockWidth: Number(new URLSearchParams(location.search).get('w') ?? 400),
  setDockHeight: noop, setDockWidth: noop, previousDockHeight: 320,
  setPreviousDockHeight: noop, previousDockOpen: true, setPreviousDockOpen: noop,
  isDragging: false, setIsDragging: noop, dockSnap: 'half', liveDragHeight: null,
  setLiveDragHeight: noop, isCollapsedDragPreview: false, toolbarHeight: 46,
  collapsedHeight: 38, isMobile: false,
  visualViewport: {style: {}, height: 800, offsetTop: 0},
  availableDockSlotPlacements: ['left', 'bottom', 'right'],
  effectiveDockSlotPlacement: 'right', surfaceShortcutId: 'activity.toggle',
  surfaceTitle: 'Agents', canMaximize: true, regionPanes: [], selectRegionPane: noop,
  ownsMaximizeShortcut: false, applyDockSnap: noop, setRegionOpen: noop,
  commitDesktopBottomHeight: noop, commitDockPlacement: noop,
  restoreDockToDocked: noop, onSidePanelResizePointerDown: noop,
  onHeaderDragPointerDown: noop, onHeaderDragClickCapture: noop,
  activeProjectSlug: null, setActiveProjectSlug: noop,
};
const tabs = [
  {surfaceId: 'chat', instanceId: 'workspace-chat', title: '#4501 Is this machine getting overwhelmed?'},
  {surfaceId: 'workspace-agents', instanceId: 'workspace-activity', title: 'Agents'},
];
function Host() {
  return <div className="chat-dock" style={{width: chrome.dockWidth, marginLeft: 'auto', background: 'var(--bg-primary)', color: 'var(--text-primary)'}}>
    <RegionChromeBar chrome={chrome} groupId="region:right" tabs={tabs}
      selectedSurfaceId="workspace-agents" onSelectTab={noop} onCloseTab={noop}
      onReorderTab={noop} onMoveTab={noop} onAddPane={noop}
      leadingSlotRef={noop} trailingSlotRef={noop} />
  </div>;
}
createRoot(document.getElementById('root')).render(<KeyboardShortcutsProvider><Host/></KeyboardShortcutsProvider>);
`;

test('a narrow side region keeps the selected tab’s name readable beside its buttons', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(fixture);
  try {
    const out = resolve('.kontourai/shell-chrome');
    mkdirSync(out, { recursive: true });
    // The shell's own fonts, and a wide face standing in for the wider
    // fallback metrics a Linux runner draws with (DejaVu Sans): the names
    // must stay readable under both.
    for (const [face, width] of [
      ['default', 400],
      ['default', 320],
      ['default', 240],
      ['wide', 320],
      ['wide', 240],
    ] as const) {
      const label = `${width}px ${face}`;
      await page.goto(`http://station.test/?w=${width}`);
      await page.addStyleTag({
        content: resolveCssImports(
          resolve(import.meta.dirname, '../index.css'),
        ),
      });
      if (face === 'wide')
        await page.addStyleTag({
          content:
            ".region-chrome, .region-chrome * { font-family: Verdana, 'DejaVu Sans', sans-serif !important; }",
        });
      await page.evaluate(() =>
        document.documentElement.setAttribute('data-theme', 'dark'),
      );
      await page.setViewportSize({ width: 1000, height: 200 });
      const selected = page.getByRole('tab', { name: 'Agents' });
      await selected.waitFor();
      await page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => done(null))),
      );
      await page
        .locator('.region-chrome')
        .screenshot({ path: `${out}/region-tabs-${width}-${face}-dark.png` });
      const geometry = await page.evaluate(() => {
        const strip = document.querySelector('.region-tabs')!;
        const tab = document.querySelector<HTMLElement>(
          '[role="tab"][aria-selected="true"]',
        )!;
        const other = document
          .querySelector('[role="tab"][aria-selected="false"]')!
          .closest('.region-tabs__item')!;
        const s = strip.getBoundingClientRect();
        const t = tab.getBoundingClientRect();
        const em = Number.parseFloat(getComputedStyle(other).fontSize);
        return {
          scrolls: strip.scrollWidth > strip.clientWidth + 1,
          clipped: tab.scrollWidth > tab.clientWidth + 1,
          inside: t.left >= s.left - 0.5 && t.right <= s.right + 0.5,
          // The other tab, against the 4em it may shrink to.
          otherAtFloor: other.getBoundingClientRect().width <= 4 * em + 1,
        };
      });
      // Whatever the font: the selected tab's name is whole and in view.
      expect(geometry.clipped, label).toBe(false);
      expect(geometry.inside, label).toBe(true);
      // The other tab gives way first: the strip scrolls only once it has
      // shrunk to its floor, and at the side region's usual widths it never
      // needs to.
      if (geometry.scrolls) expect(geometry.otherAtFloor, label).toBe(true);
      if (width >= 320) expect(geometry.scrolls, label).toBe(false);
    }
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 120_000);
