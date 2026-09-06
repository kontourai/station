/**
 * @vitest-environment jsdom
 *
 * #1582 D10: the Agents rail printed "Station…" — a seven-character name
 * ellipsized — while the detail pane beside it showed "Nothing selected"
 * across ~900px.
 *
 * The rail's width is not the cause and widening it is not the fix: the row's
 * badge was rendered INSIDE `.split-pane__item-name`, a single
 * `white-space: nowrap; overflow: hidden; text-overflow: ellipsis` box, so the
 * name and the status pill shared ONE ellipsis run and the pill's length
 * decided where the name got cut.
 *
 * jsdom lays out nothing, so this is unobservable there. Following
 * `ChatDockActiveIdentity.overflow.test.tsx`: render the real
 * `SplitPaneLayout` with the real Agents row content, put its markup into a
 * real Chromium page carrying the real cascade-resolved `index.css`, and
 * measure.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { cleanup, render } from '@testing-library/react';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../tests/helpers/css-cascade-fixture';

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));
vi.mock('../hooks/useIsMobile', () => ({
  useIsMobile: () => false,
  MOBILE_MEDIA_QUERY: '(max-width: 768px)',
}));

import { SplitPaneLayout } from '../components/SplitPaneLayout';
import type { AgentData } from '../contexts/AgentsContext';
import { buildAgentsViewItems } from '../views/agent-editor/agentsViewHelpers';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../');
const INDEX_CSS_PATH = resolve(HERE, '../index.css');
/**
 * `index.css` carries the token layer and the app cascade, but a co-located
 * component stylesheet is imported by its own module and never reaches it. The
 * row's geometry lives entirely in these three, so a fixture built from
 * `index.css` alone measures an UNSTYLED row and passes for the wrong reason —
 * which is what the first draft of this file did.
 */
const ROW_CSS_PATHS = [
  resolve(HERE, '../components/SplitPaneLayout.css'),
  resolve(HERE, '../components/AgentReadinessCell.css'),
  resolve(HERE, '../components/badges/EngineChip.css'),
];

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })),
});

/**
 * The row the audit photographed: the built-in agent named "Station", whose
 * engine chip is suppressed (the chip label equals the name) so the badge is
 * the readiness pill alone, plus the Connect action in the trailing slot.
 */
const STATION_AGENT = {
  slug: 'station',
  name: 'Station',
  engineId: 'station',
  engineDisplayName: 'Station',
  provenance: { origin: 'builtin' },
  runnability: { status: 'needs-setup', reason: 'no connection configured' },
} as unknown as AgentData;

function railMarkup(): string {
  const items = buildAgentsViewItems(
    [STATION_AGENT],
    [],
    undefined,
    { onChat: () => {}, onFix: () => {} },
    { readinessKnown: true },
  );
  const { container, unmount } = render(
    <SplitPaneLayout
      paneId="agents-overflow-fixture"
      label="agents"
      title="Agents"
      items={items}
      selectedId={null}
      onSelect={() => {}}
      onSearch={() => {}}
    >
      <div>Nothing selected</div>
    </SplitPaneLayout>,
  );
  const left = container.querySelector('.split-pane__left');
  if (!left) throw new Error('the rail did not render');
  const html = left.outerHTML;
  unmount();
  return html;
}

function fixtureHtml(rail: string, railWidth: number): string {
  const css = [INDEX_CSS_PATH, ...ROW_CSS_PATHS]
    .map((path) => resolveCssImports(path))
    .join('\n');
  assertNoImportsSurvive(css);
  // The rail's own width is what the row lives inside; the surrounding page is
  // the 1440 desktop the audit ran at.
  return `<!doctype html>
<html>
  <head><style>${css}</style></head>
  <body style="margin:0">
    <div class="split-pane" style="display:flex;width:1440px;height:700px">
      <div style="width:${railWidth}px;display:flex;flex:0 0 auto">${rail}</div>
      <div style="flex:1 1 auto">Nothing selected</div>
    </div>
  </body>
</html>`;
}

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)(
  'the Agents rail row keeps its name readable (#1582 D10)',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;

    beforeAll(async () => {
      browser = await chromium.launch();
    });
    afterAll(async () => {
      await browser?.close();
    });
    afterEach(() => cleanup());

    async function measure(railWidth: number) {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 700 },
      });
      try {
        await page.setContent(fixtureHtml(railMarkup(), railWidth));
        await page.evaluate(() => document.fonts?.ready);
        return await page.evaluate(() => {
          const box = (selector: string) => {
            const element = document.querySelector(selector);
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            return {
              width: rect.width,
              left: rect.left,
              right: rect.right,
              text: (element.textContent ?? '').trim(),
              clipped: element.scrollWidth > element.clientWidth + 1,
            };
          };
          return {
            nameText: box('.split-pane__item-name-text'),
            name: box('.split-pane__item-name'),
            trailing: box('.split-pane__item-trailing'),
            row: box('.split-pane__item-row'),
          };
        });
      } finally {
        await page.close();
      }
    }

    // The rail's own range: `min-width: 220px`, `max-width: 420px`, default
    // 280 (`split-pane-metrics.ts`). The name has to survive all of it — the
    // audit's screenshot was the default.
    test.each([220, 280, 420])(
      'a short agent name is not ellipsized at a %ipx rail',
      async (railWidth) => {
        const { nameText } = await measure(railWidth);
        if (!nameText) throw new Error('the name span did not render');
        expect(nameText.text).toContain('Station');
        expect(nameText.clipped).toBe(false);
      },
    );

    test('the name is a box of its own, so the badge cannot spend its width', async () => {
      const { nameText, name } = await measure(280);
      if (!nameText || !name) throw new Error('the row did not render');
      // The discriminating measurement: pre-fix the name and the badge were
      // the same element, so these were equal and the pill's length decided
      // where "Station" got cut.
      expect(nameText.width).toBeLessThan(name.width);
      expect(nameText.text).toBe('Station');
    });

    test('the row still fits its rail — the name is not just overflowing instead', async () => {
      const { row, nameText, trailing } = await measure(280);
      if (!row || !nameText) throw new Error('the row did not render');
      expect(nameText.right).toBeLessThanOrEqual(row.right + 1);
      if (trailing) {
        expect(trailing.right).toBeLessThanOrEqual(row.right + 1);
        expect(nameText.right).toBeLessThanOrEqual(trailing.left + 1);
      }
    });
  },
);

test.skipIf(chromiumAvailable)(
  'Agents rail name overflow — Chromium not installed, cannot verify (#1582 D10)',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the rail ' +
        'row’s name truncation could not be measured — this is a missing ' +
        'precondition, not a passing check. Install it with ' +
        '`npm run install:playwright` and re-run.',
    );
  },
);
