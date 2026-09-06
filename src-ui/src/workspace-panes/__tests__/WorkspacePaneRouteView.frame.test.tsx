/**
 * @vitest-environment jsdom
 *
 * #1636: a workspace pane's own route lost its page frame on a direct load.
 *
 * The route renders `project-page` / `project-page__inner`, whose only
 * definitions lived in `views/ProjectPage.css` — a stylesheet only
 * `views/ProjectPage.tsx` imports, which Vite emits into the project-page
 * chunk. `WorkspacePaneRouteView` is its OWN lazily loaded chunk
 * (`app-shell/AppViewContent.tsx`, view type `workspace-pane`), so it never
 * loaded that sheet. Clicking through the project page left the chunk's
 * stylesheet in the document and everything looked right; a bookmark, a
 * refresh or a deep link did not. Measured live at 1440x900 on a temp-home
 * instance built from `origin/main` (cd42700d3):
 *
 *                          via project page   direct load
 *   ProjectPage-*.css          present          ABSENT
 *   .project-page__inner       40px 32px 48px   0px
 *   .project-page__inner       max-width 860px  none
 *   .project-page__inner box   x=410 w=860      x=240 w=1200
 *
 * WHAT THIS FIXTURE COMPOSES, AND WHY IT IS NOT A HARDCODED LIST.
 * `index.css` is the entry stylesheet — the one sheet every route loads —
 * plus the `.css` files THIS ROUTE'S OWN MODULE declares, read out of its
 * source. Every other co-located stylesheet in the app is emitted into
 * whichever chunk imports it, so it is route-dependent by construction. A
 * frame that resolves from those two sources alone therefore cannot be lost
 * on ANY route, which is the property the defect broke — stated without
 * naming a route, and derived rather than asserted, so the composition moves
 * with the module instead of with an editor's memory of it. Before the fix
 * the derived list is EMPTY and every geometry assertion below fails.
 *
 * `assertModelsARouteWithoutTheProjectPageChunk` keeps the fixture honest in
 * both directions: it fails if the frame migrates into `index.css` (the
 * fixture would no longer model the broken condition), and it fails if the
 * composition drags in the project page's own content stylesheet (which
 * would make the measurement pass by re-borrowing the chunk this issue is
 * about, rather than by owning the frame).
 *
 * WHAT THIS FIXTURE DOES NOT REPRODUCE: `setContent` has no base URL, so
 * `@font-face` files never load. Nothing asserted below depends on glyph
 * metrics.
 */

import { readFileSync } from 'node:fs';
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
} from '../../../../tests/helpers/css-cascade-fixture';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../');
const INDEX_CSS_PATH = resolve(HERE, '../../index.css');
const ROUTE_MODULE_PATH = resolve(HERE, '../WorkspacePaneRouteView.tsx');

/**
 * The shell's content column at 1440x900 — the box the route is handed, and
 * the width the live measurements above were taken in.
 */
const CONTENT_COLUMN = { width: 1200, height: 762 };

const catalogMock = vi.hoisted(() => ({
  projectId: 'project-uuid',
  projectSlug: 'demo',
  entries: [
    {
      descriptor: {
        id: 'builtin:flow-run-console',
        name: 'Flow run console',
        description: 'Observe Flow run state',
      },
      instance: {
        instanceId: 'flow-console-1',
        boundContext: { projectId: 'project-uuid' },
      },
      availability: {
        state: 'available',
        reason: { code: 'ready', source: 'resolver' },
      },
      clientRendererPresence: 'present',
    },
  ],
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}));

vi.mock('@kontourai/station-sdk', () => ({
  LayoutNavigationProvider: ({ children }: { children: React.ReactNode }) =>
    children,
  useProjectLayoutQuery: () => ({ data: undefined, isLoading: false }),
}));

vi.mock('../../core/SDKAdapter', () => ({
  SDKAdapter: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('../../layouts', () => ({
  LayoutRenderer: () => <div data-testid="contributed-pane" />,
}));

vi.mock('../resolvedWorkspacePaneCatalog', () => ({
  useResolvedWorkspacePaneCatalog: () => ({
    ...catalogMock,
    entries: catalogMock.entries.map((entry) => ({
      ...entry,
      instance: {
        version: '1.0',
        descriptorId: entry.descriptor.id,
        stateKey: `state:${entry.instance.instanceId}`,
        ...entry.instance,
      },
    })),
  }),
}));

vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

vi.mock('../../contexts/ConfigContext', () => ({
  useConfig: () => ({ mcpUiHost: true }),
}));

vi.mock('../builtinWorkspacePaneRegistry', () => ({
  builtinWorkspacePaneRendererPresence: () => 'present',
  isCanonicalBuiltinCodingOccurrence: () => false,
  getBuiltinWorkspacePaneRenderer: () => () => (
    <div data-testid="mounted-pane">Pane content</div>
  ),
}));

import { WorkspacePaneRouteView } from '../WorkspacePaneRouteView';

/**
 * The `.css` files the route module itself declares — the whole of what a
 * direct load of this route adds to the entry stylesheet, read from the
 * source rather than restated here. `page-layout-import.test.ts` states the
 * same rule structurally (archive#3306); this measures the consequence of
 * breaking it.
 */
function routeOwnStylesheets(): string[] {
  const source = readFileSync(ROUTE_MODULE_PATH, 'utf8');
  const moduleDir = dirname(ROUTE_MODULE_PATH);
  return [...source.matchAll(/import\s+['"]([^'"]+\.css)['"]\s*;/g)].map(
    (match) => resolve(moduleDir, match[1]),
  );
}

/** `index.css` plus exactly what the route's own module brings with it. */
function routeStylesheet(): string {
  const sheets = [INDEX_CSS_PATH, ...routeOwnStylesheets()];
  const css = sheets.map((sheet) => resolveCssImports(sheet)).join('\n');
  assertNoImportsSurvive(css);
  return css;
}

function assertModelsARouteWithoutTheProjectPageChunk(): void {
  const entryOnly = resolveCssImports(INDEX_CSS_PATH);
  if (!entryOnly.includes('.station-dialog__overlay')) {
    throw new Error(
      'the composed entry stylesheet does not contain ' +
        '`.station-dialog__overlay`, so `index.css` was not read as expected ' +
        'and every measurement below would be taken against an empty cascade.',
    );
  }
  if (entryOnly.includes('.project-page__inner')) {
    throw new Error(
      'index.css now defines `.project-page__inner`, so this fixture no ' +
        'longer models a route that lacks the project-page chunk — the exact ' +
        'condition #1636 lived on. Point the fixture at a stylesheet set that ' +
        'still excludes it rather than deleting this check.',
    );
  }
  // `.project-page__git-log` is project-page CONTENT and stays in
  // `ProjectPage.css`. If it reaches this composition the route has started
  // importing the project page's own stylesheet again, which would make the
  // geometry below pass for exactly the reason #1636 was filed about.
  if (routeStylesheet().includes('.project-page__git-log')) {
    throw new Error(
      'this route now imports `views/ProjectPage.css` (its content selectors ' +
        'are in the composed cascade). The frame it renders must come from a ' +
        'stylesheet it owns, not from another route’s chunk — see #1636.',
    );
  }
}

/** The route's real markup, exactly as a direct load mounts it. */
function routeMarkup(): string {
  const { container, unmount } = render(
    <WorkspacePaneRouteView
      projectSlug="demo"
      descriptorId="builtin:flow-run-console"
      instanceId="flow-console-1"
    />,
  );
  const frame = container.firstElementChild;
  if (!frame) throw new Error('the workspace pane route rendered nothing');
  const html = frame.outerHTML;
  unmount();
  return html;
}

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)(
  'a workspace pane route keeps its page frame on every route that mounts it (#1636)',
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
      assertModelsARouteWithoutTheProjectPageChunk();
      const css = routeStylesheet();
      const markup = routeMarkup();
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
      });
      try {
        await page.setContent(`<!doctype html>
<html>
  <head><style>${css}</style></head>
  <body style="margin:0">
    <div id="content-column" style="width:${CONTENT_COLUMN.width}px;height:${CONTENT_COLUMN.height}px">${markup}</div>
  </body>
</html>`);
        return await page.evaluate(() => {
          const column = document.getElementById('content-column');
          const root = document.querySelector('[data-workspace-pane-route]');
          const inner = root?.querySelector('.project-page__inner') ?? null;
          if (!column || !root || !inner) return null;
          const read = (element: Element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return {
              overflowY: style.overflowY,
              backgroundColor: style.backgroundColor,
              maxWidth: style.maxWidth,
              paddingTop: Number.parseFloat(style.paddingTop),
              paddingLeft: Number.parseFloat(style.paddingLeft),
              paddingBottom: Number.parseFloat(style.paddingBottom),
              rect: { left: rect.left, width: rect.width },
            };
          };
          return {
            root: read(root),
            inner: read(inner),
            column: {
              left: column.getBoundingClientRect().left,
              width: column.getBoundingClientRect().width,
            },
          };
        });
      } finally {
        await page.close();
      }
    }

    test('the route composes stylesheets it owns, not another route’s chunk', () => {
      // Scope honesty: with an empty list the whole file measures `index.css`
      // alone and could only ever report the pre-fix geometry — a state in
      // which the assertions below stop being able to distinguish anything.
      const sheets = routeOwnStylesheets();
      expect(
        sheets.length,
        'WorkspacePaneRouteView.tsx declares no stylesheet of its own, so the ' +
          'page frame it renders can only come from whichever chunk happened ' +
          'to load first (#1636)',
      ).toBeGreaterThan(0);
      const owned = sheets
        .map((sheet) => readFileSync(sheet, 'utf8'))
        .join('\n');
      expect(
        owned,
        'none of the stylesheets this route imports defines the frame it renders',
      ).toContain('.project-page__inner');
      assertModelsARouteWithoutTheProjectPageChunk();
    });

    test('the content sits in a centred measure column, not edge to edge', async () => {
      const measured = await measure();
      expect(
        measured,
        'the route did not render the frame this fixture measures',
      ).not.toBeNull();
      const { inner, column } = measured!;

      // The whole defect in one assertion: with the frame's stylesheet
      // missing, `max-width` computed `none` and the inner box measured the
      // full 1200px content column.
      expect(inner.maxWidth).not.toBe('none');
      expect(inner.rect.width).toBeLessThan(column.width);
      const leftGap = inner.rect.left - column.left;
      const rightGap =
        column.left + column.width - (inner.rect.left + inner.rect.width);
      expect(leftGap).toBeGreaterThan(0);
      expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(1);
    });

    test('the content is inset from the frame edges', async () => {
      const { inner } = (await measure())!;
      // Pre-fix: `0px` on every side, which is why the pane's own header
      // collided with the banner stack above it.
      expect(inner.paddingTop).toBeGreaterThan(0);
      expect(inner.paddingLeft).toBeGreaterThan(0);
      expect(inner.paddingBottom).toBeGreaterThan(0);
    });

    test('the frame is an opaque surface that scrolls itself', async () => {
      const { root } = (await measure())!;
      // Pre-fix: `rgba(0, 0, 0, 0)` over whatever the shell painted, and
      // `visible`, so a tall pane pushed the shell's own scroller instead of
      // scrolling inside the route.
      expect(root.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
      expect(root.backgroundColor).not.toBe('transparent');
      expect(root.overflowY).toBe('auto');
    });
  },
);
