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
 * The row the audit photographed: the agent named "Station" in a caution
 * state. `agentReadinessState` prints the server's sentence VERBATIM
 * (`Needs: <unavailableReason>`), which is the whole point — the pill's length
 * is the server's to choose, so it can spend any width the rail is given. Its
 * fix route puts "Connect" in the trailing slot, the other half of the squeeze
 * the audit named.
 *
 * A fixture whose badge reads "Ready" cannot discriminate: at every rail width
 * "Station" plus five characters fits, so the pre-fix single-ellipsis-run
 * arrangement passes it. That fixture was this file's first draft and an
 * injection walked straight through it.
 */
const STATION_AGENT_NEEDING_SETUP = {
  slug: 'station',
  name: 'Station',
  engineId: 'station',
  engineDisplayName: 'Station',
  provenance: { origin: 'builtin' },
  available: false,
  unavailableReason: 'no enabled LLM provider connection is configured.',
  unavailableFix: { kind: 'models' },
} as unknown as AgentData;

/** The same agent, ready: its chip is two words and fits beside the name. */
const READY_STATION_AGENT = {
  slug: 'station',
  name: 'Station',
  engineId: 'station',
  engineDisplayName: 'Station',
  provenance: { origin: 'builtin' },
} as unknown as AgentData;

function railMarkup(agent: AgentData): string {
  const items = buildAgentsViewItems(
    [agent],
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

    async function measureReady(railWidth: number) {
      return measure(railWidth, READY_STATION_AGENT);
    }

    async function measure(
      railWidth: number,
      agent: AgentData = STATION_AGENT_NEEDING_SETUP,
    ) {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 700 },
      });
      try {
        await page.setContent(fixtureHtml(railMarkup(agent), railWidth));
        await page.evaluate(() => document.fonts?.ready);
        return await page.evaluate(() => {
          const box = (selector: string) => {
            const element = document.querySelector(selector);
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            return {
              width: rect.width,
              height: rect.height,
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
              text: (element.textContent ?? '').trim(),
              // No tolerance. A one-pixel overflow ellipsizes on screen, and a
              // `+ 1` slack is what let the live rail read "Stati…" while the
              // measurement said nothing was clipped.
              clipped: element.scrollWidth > element.clientWidth,
            };
          };
          return {
            nameText: box('.split-pane__item-name-text'),
            name: box('.split-pane__item-name'),
            badge: box('.split-pane__item-name-badge'),
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

    // The pixels the first version of this fix produced, and the reason the
    // first version of this test did not see them: shrinking the badge made
    // the pill (a `display: grid` badge whose own white-space is `normal`)
    // wrap to three lines inside a 40px row and paint over the row below,
    // while the name still lost its last pixel. Both are geometry the earlier
    // assertions did not look at.
    test('a long reason takes the line below instead of overflowing the row', async () => {
      const { row, name, badge, nameText } = await measure(280);
      if (!row || !name || !badge || !nameText)
        throw new Error('the row did not render');
      // The badge wrapped: it starts below the name's text, not beside it.
      expect(badge.top).toBeGreaterThanOrEqual(nameText.bottom - 1);
      // ...and the row grew to hold it rather than letting it paint outside.
      expect(badge.bottom).toBeLessThanOrEqual(row.bottom + 1);
      expect(name.height).toBeGreaterThanOrEqual(badge.height);
    });

    test('a short chip still sits beside the name', async () => {
      // The wrap must be driven by the content that cannot fit, not applied to
      // every row: a ready agent keeps its one-line row.
      const { nameText, badge } = await measureReady(280);
      if (!nameText || !badge) throw new Error('the ready row did not render');
      expect(badge.left).toBeGreaterThanOrEqual(nameText.right - 1);
      expect(badge.top).toBeLessThan(nameText.bottom);
      expect(nameText.clipped).toBe(false);
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
