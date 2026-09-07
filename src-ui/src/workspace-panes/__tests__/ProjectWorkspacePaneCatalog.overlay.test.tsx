/**
 * @vitest-environment jsdom
 *
 * #1616: on `/projects/:slug/layouts/:layout` the pane picker rendered inline
 * and unstyled — no scrim, no centred panel, the catalog shoving the layout
 * down the page. Measured live on `origin/main` (6a7aafb95) through a
 * temp-home instance: the overlay computed `position: static`,
 * `display: block`, `background-color: rgba(0, 0, 0, 0)`, box
 * `x=240 y=141.7 1200x716` inside a 1440x900 viewport.
 *
 * The mechanism is chunk loading, not a missing rule. The picker named
 * `project-page__modal-overlay`/`project-page__modal`, which are defined in
 * `views/ProjectPage.css` — a stylesheet only `views/ProjectPage.tsx` imports.
 * Vite emits it into the lazily loaded project-page chunk, and the coding
 * layout route (`app-shell/ProjectLayoutRenderer.tsx`, its own lazy chunk)
 * never loads it. `ResponsiveDialogSurface` then falls back to
 * `.responsive-surface-overlay`, which sets a `z-index` and no `position`.
 *
 * WHY THIS FIXTURE COMPOSES `index.css` AND NOTHING ELSE. That is the entry
 * stylesheet, the one sheet every route loads. Every co-located component
 * stylesheet is emitted into whichever chunk imports it, so it is
 * route-dependent by construction. A picker whose overlay geometry resolves
 * from `index.css` alone therefore cannot lose it on ANY route — which is the
 * property the defect broke, stated without naming a route. Adding the
 * picker's other sheets here would make the fixture measure a richer cascade
 * than the worst route offers and pass for the wrong reason.
 *
 * `assertModelsARouteWithoutTheProjectPageChunk` keeps that honest: if
 * `project-page__modal-overlay` ever migrates INTO `index.css`, this fixture
 * silently stops modelling the broken route, so it fails loudly instead.
 *
 * WHAT THIS FIXTURE DOES NOT REPRODUCE: `setContent` has no base URL, so
 * `@font-face` files never load. Nothing asserted below depends on glyph
 * metrics.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-file-preview';
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
} from '../../../../tests/helpers/css-cascade-fixture';
import { createFilePreviewPaneInstance } from '../filePreviewPaneInstance';
import { ProjectWorkspacePaneModal } from '../ProjectWorkspacePaneCatalog';
import type { ResolvedWorkspacePaneCatalogEntry } from '../resolvedWorkspacePaneCatalog';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../');
const INDEX_CSS_PATH = resolve(HERE, '../../index.css');

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })),
});

const preview = createFilePreviewPaneInstance(
  {
    version: '1.0',
    projectSlug: 'project-route',
    path: 'src/pickable.ts',
    wrap: true,
  },
  'project-uuid',
  'd'.repeat(32),
)!;

const entries: readonly ResolvedWorkspacePaneCatalogEntry[] = [
  {
    instance: preview,
    availability: {
      state: 'available',
      reason: { code: 'ready', source: 'resolver' },
    },
    descriptor: WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR,
    clientRendererPresence: 'present',
  },
];

/** The picker's own markup, exactly as either route mounts it. */
function pickerMarkup(): string {
  const { container, unmount } = render(
    <ProjectWorkspacePaneModal
      show
      onClose={vi.fn()}
      entries={entries}
      loading={false}
      error={false}
      onRetry={vi.fn()}
      onSelect={vi.fn()}
      onAction={vi.fn(() => '')}
      canExecuteAction={vi.fn(() => false)}
    />,
  );
  const overlay = container.firstElementChild;
  if (!overlay) throw new Error('the picker rendered nothing');
  const html = overlay.outerHTML;
  unmount();
  return html;
}

function routeStylesheet(): string {
  const css = resolveCssImports(INDEX_CSS_PATH);
  assertNoImportsSurvive(css);
  return css;
}

function assertModelsARouteWithoutTheProjectPageChunk(css: string): void {
  // The property every measurement below rests on is not "one class is absent"
  // — it is "this cascade is index.css and its own imports, and NOTHING else".
  // Recomputed here independently of `routeStylesheet`, so appending a
  // co-located sheet to that function (which would measure a richer cascade
  // than the worst route offers, and pass for the wrong reason) fails here
  // rather than silently widening the fixture.
  if (css !== resolveCssImports(INDEX_CSS_PATH)) {
    throw new Error(
      'the composed stylesheet is no longer exactly `index.css` and its own ' +
        'imports. A component stylesheet only reaches a route that imports it, ' +
        'so adding one here measures a cascade some route does not have — the ' +
        'exact condition #1616 lived on. Measure the worst route, or change ' +
        'what this fixture claims.',
    );
  }
  if (css.includes('.project-page__modal-overlay')) {
    throw new Error(
      'index.css now defines `.project-page__modal-overlay`, so this fixture ' +
        'no longer models a route that lacks the project-page chunk — the ' +
        'exact condition #1616 lived on. Point the fixture at a stylesheet ' +
        'set that still excludes it rather than deleting this check.',
    );
  }
  if (!css.includes('.responsive-surface-overlay')) {
    throw new Error(
      'the composed stylesheet does not contain `.responsive-surface-overlay`, ' +
        'so `index.css` was not read as expected and every measurement below ' +
        'would be taken against an empty cascade.',
    );
  }
}

/**
 * Alpha of a computed `background-color`. Chromium serializes an opaque colour
 * as `rgb(r, g, b)` and a translucent one as `rgba(r, g, b, a)`, so the alpha
 * is the FOURTH component or nothing — reading "the last number" says 36 for
 * `rgb(28, 28, 36)`, which is how the first draft of this file passed the
 * opaque-panel assertion for the wrong reason.
 */
function backgroundAlpha(color: string): number {
  if (color === 'transparent') return 0;
  const parts = /^rgba?\(([^)]*)\)$/.exec(color)?.[1].split(',');
  if (!parts) {
    throw new Error(`unrecognized computed background-color: ${color}`);
  }
  return parts.length < 4 ? 1 : Number(parts[3]);
}

const VIEWPORT = { width: 1440, height: 900 };
const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)(
  'the workspace pane picker is a modal overlay on every route that mounts it (#1616)',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;

    beforeAll(async () => {
      browser = await chromium.launch();
    });
    afterAll(async () => {
      await browser?.close();
    });
    afterEach(() => cleanup());

    async function measure() {
      const css = routeStylesheet();
      assertModelsARouteWithoutTheProjectPageChunk(css);
      const markup = pickerMarkup();
      const page = await browser.newPage({ viewport: VIEWPORT });
      try {
        // A plain page: the live route mounts this inside the app shell, but
        // the question here is whether the overlay's OWN rules take it out of
        // flow, which no ancestor supplies.
        await page.setContent(`<!doctype html>
<html>
  <head><style>${css}</style></head>
  <body style="margin:0">
    <div style="width:${VIEWPORT.width}px">${markup}</div>
  </body>
</html>`);
        return await page.evaluate(() => {
          const panel = document.querySelector('[role="dialog"]');
          const overlay = panel?.parentElement ?? null;
          if (!panel || !overlay) return null;
          const read = (element: Element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return {
              position: style.position,
              display: style.display,
              zIndex: style.zIndex,
              backgroundColor: style.backgroundColor,
              rect: {
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
              },
            };
          };
          return {
            overlay: read(overlay),
            panel: read(panel),
            viewport: {
              width: window.innerWidth,
              height: window.innerHeight,
            },
          };
        });
      } finally {
        await page.close();
      }
    }

    test('the overlay is taken out of flow and covers the viewport', async () => {
      const measured = await measure();
      expect(measured).not.toBeNull();
      const { overlay, viewport } = measured!;

      // The whole defect in one assertion: the fallback overlay computed
      // `static`, so the picker laid out inline in the pane.
      expect(overlay.position).toBe('fixed');
      expect(overlay.rect).toEqual({
        left: 0,
        top: 0,
        width: viewport.width,
        height: viewport.height,
      });
    });

    test('the overlay paints a scrim and centres the panel over the page', async () => {
      const measured = await measure();
      const { overlay, panel, viewport } = measured!;

      // `display: block` with a transparent background is what the live route
      // rendered: no scrim, nothing centred, the catalog simply in the flow.
      expect(overlay.display).toBe('flex');
      expect(backgroundAlpha(overlay.backgroundColor)).toBeGreaterThan(0);

      // A centred panel, not a full-bleed block: the pre-fix panel measured
      // the full 1200px content width of the pane it was rendered inside.
      expect(panel.rect.width).toBeLessThan(viewport.width);
      expect(panel.rect.height).toBeLessThanOrEqual(viewport.height);
      const leftGap = panel.rect.left;
      const rightGap = viewport.width - (panel.rect.left + panel.rect.width);
      expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(1);
      expect(leftGap).toBeGreaterThan(0);
    });

    test('the panel is an opaque surface, not bare text over the page', async () => {
      const measured = await measure();
      const { panel } = measured!;
      // Pre-fix: `rgba(0, 0, 0, 0)` — the catalog's cards sat directly on the
      // layout behind them.
      expect(backgroundAlpha(panel.backgroundColor)).toBe(1);
    });
  },
);
