// @vitest-environment jsdom

/**
 * The File Preview's type and touch targets, measured in a real engine with
 * the real cascade (`index.css` and the pane's own sheets, imports inlined):
 * jsdom lays nothing out and resolves no custom property, so a size or a
 * hit area asserted there proves nothing.
 *
 * - The source is drawn at the Changes view's size: the diff surface
 *   (`@pierre/diffs`) draws its lines at `var(--diffs-font-size, 13px)` over
 *   `var(--diffs-line-height, 20px)`, and the File view's code takes the
 *   same declarations, so both resolve to one size. The `code` element
 *   inherits the block's font instead of the browser's own monospace rule,
 *   and a line number is a gutter, not an underlined link.
 * - At 390px with a coarse pointer each File | Changes segment is at least
 *   44px wide and 44px tall to the touch, and the 30px icon control is 44px
 *   to the touch, from the pane's own sheet alone.
 */
import { resolve } from 'node:path';
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

vi.mock('@kontourai/station-sdk/workspace-file-preview', () => ({
  useProjectWorkspaceFilePreviewQuery: () => ({
    isLoading: false,
    isError: false,
    data: {
      path: 'src/example.ts',
      status: 'ready',
      renderKind: 'source',
      content: 'const a = 1;\nconst b = 2;\n',
    },
  }),
  useProjectWorkspaceFileChangesQuery: () => ({
    isLoading: false,
    isError: false,
    data: { state: 'unchanged', base: 'HEAD' },
    refetch: () => undefined,
  }),
  isRepositoryBusyError: () => false,
  WORKSPACE_FILE_PREVIEW_MAX_BYTES: 512 * 1024,
  isWorkspaceFilePreviewImageDataUrl: () => false,
  downloadProjectWorkspaceFilePreview: () => Promise.reject(new Error('no')),
}));
vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    navigate: () => undefined,
    selectedProjectLayout: 'coding',
  }),
}));
vi.mock('../../providers/context/CodingFilesContextProvider', () => ({
  useCodingFilesContext: () => ({
    addFile: () => true,
    has: () => false,
    removeFile: () => undefined,
  }),
}));
vi.mock('../resolvedWorkspacePaneCatalog', () => ({
  useResolvedWorkspacePaneCatalog: () => ({ entries: [] }),
}));

import { FilePreviewPane } from '../FilePreviewPane';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../');
const css = [
  '../../index.css',
  '../../components/IconButton.css',
  '../../components/ActionOverflowMenu.css',
  '../FilePreviewPane.css',
]
  .map((path) => resolveCssImports(resolve(import.meta.dirname, path)))
  .join('\n');
assertNoImportsSurvive(css);

/** The pane on a textual file, as the host renders it. */
function paneMarkup(): string {
  const { container, unmount } = render(
    <FilePreviewPane
      projectSlug="demo"
      stateKey="file-preview:geometry"
      state={{
        version: '1.0',
        projectSlug: 'demo',
        path: 'src/example.ts',
        wrap: true,
      }}
    />,
  );
  const html = container.innerHTML;
  unmount();
  return html;
}

/** The declarations the diff surface draws its lines with. */
const DIFF_PROBE =
  '<div id="diff-probe" style="font-size: var(--diffs-font-size, 13px); line-height: var(--diffs-line-height, 20px)">x</div>';

describe.skipIf(!chromiumIsInstalled(REPO_ROOT))(
  'the File Preview in a real engine',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    beforeAll(async () => {
      browser = await chromium.launch();
    });
    afterAll(async () => {
      await browser?.close();
    });
    afterEach(cleanup);

    async function measure(
      viewport: { width: number; height: number },
      hasTouch: boolean,
    ) {
      const context = await browser.newContext({ viewport, hasTouch });
      try {
        const page = await context.newPage();
        await page.setContent(
          `<style>${css}</style><div style="width:${viewport.width}px">${paneMarkup()}${DIFF_PROBE}</div>`,
        );
        return await page.evaluate(() => {
          const block = document.querySelector('.workspace-file-preview__code');
          const code = block?.querySelector('code');
          const number = block?.querySelector('a');
          const probe = document.getElementById('diff-probe');
          const segments = [
            ...document.querySelectorAll<HTMLElement>(
              '.workspace-file-preview__segmented button',
            ),
          ];
          const icon = document.querySelector<HTMLElement>(
            '.workspace-file-preview__icon',
          );
          if (
            !block ||
            !code ||
            !number ||
            !probe ||
            segments.length !== 2 ||
            !icon
          ) {
            throw new Error('the pane did not render its header and source');
          }
          /** The element a touch at (x, y) lands on, named by its text. */
          const hit = (x: number, y: number, target: Element) =>
            document.elementFromPoint(x, y)?.closest('button') === target;
          /** The control's touch target: the invisible `::before` that
           *  carries the 44px floor. Its resolved size is the invariant;
           *  integer-stepped hit probes only quantize it (a 44px area on a
           *  fractional boundary measured 43 steps on Linux CI), so read
           *  the computed box and prove hittability with probes that stay
           *  a pixel inside the edge. */
          const touch = (element: HTMLElement) => {
            const before = getComputedStyle(element, '::before');
            const rect = element.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            // Two pixels of slack, not one: a 44px pseudo on a fractional
            // boundary puts a (w/2 - 1) probe exactly on the edge pixel on
            // some engines (Linux CI measured the File segment's right
            // probe outside by half a pixel). The floor itself is asserted
            // exactly by the width and height checks above; the probes only
            // prove the pseudo is really hittable, and ±2 keeps that proof
            // clear of subpixel boundaries.
            const reachX = Math.floor(Number.parseFloat(before.width) / 2 - 2);
            const reachY = Math.floor(Number.parseFloat(before.height) / 2 - 2);
            // Cardinal probes, one pixel inside the pseudo's edge — the
            // same reach the stepped version measured. A corner probe
            // would demand the pseudo also win diagonally, where the
            // bar's neighbouring buttons sit by design.
            const cardinalHits = [
              hit(cx - reachX, cy, element),
              hit(cx + reachX, cy, element),
              hit(cx, cy - reachY, element),
              hit(cx, cy + reachY, element),
            ].every(Boolean);
            return {
              width: Number.parseFloat(before.width),
              height: Number.parseFloat(before.height),
              hittable: cardinalHits,
            };
          };
          const style = (element: Element) => getComputedStyle(element);
          return {
            coarse: matchMedia('(pointer: coarse)').matches,
            code: {
              fontSize: style(code).fontSize,
              lineHeight: style(code).lineHeight,
              fontFamily: style(code).fontFamily,
            },
            block: { fontFamily: style(block).fontFamily },
            probe: {
              fontSize: style(probe).fontSize,
              lineHeight: style(probe).lineHeight,
            },
            numberDecoration: style(number).textDecorationLine,
            segments: segments.map((segment) => ({
              label: segment.textContent?.trim(),
              width: segment.getBoundingClientRect().width,
              touch: touch(segment),
            })),
            icon: {
              width: icon.getBoundingClientRect().width,
              touch: touch(icon),
            },
          };
        });
      } finally {
        await context.close();
      }
    }

    test('File and Changes text are one size, the code inherits the block font, and line numbers are not underlined', async () => {
      const desktop = await measure({ width: 1440, height: 900 }, false);
      expect(desktop.coarse).toBe(false);
      expect(desktop.code.fontSize).toBe('13px');
      expect(desktop.code.lineHeight).toBe('20px');
      expect(desktop.code.fontSize).toBe(desktop.probe.fontSize);
      expect(desktop.code.lineHeight).toBe(desktop.probe.lineHeight);
      // The block's family, not the UA's `monospace`.
      expect(desktop.code.fontFamily).toBe(desktop.block.fontFamily);
      expect(desktop.code.fontFamily).not.toBe('monospace');
      expect(desktop.numberDecoration).toBe('none');
    });

    test('at 390px with a coarse pointer every header control is a 44px target', async () => {
      const phone = await measure({ width: 390, height: 844 }, true);
      expect(phone.coarse).toBe(true);
      for (const segment of phone.segments) {
        // The box itself, not only the invisible hit area: a neighbour's
        // area cannot be relied on to cover a short segment.
        expect(segment.width, segment.label).toBeGreaterThanOrEqual(44);
        expect(segment.touch.width, segment.label).toBeGreaterThanOrEqual(44);
        expect(segment.touch.height, segment.label).toBeGreaterThanOrEqual(44);
        expect(segment.touch.hittable, segment.label).toBe(true);
      }
      expect(phone.icon.touch.width).toBeGreaterThanOrEqual(44);
      expect(phone.icon.touch.height).toBeGreaterThanOrEqual(44);
      expect(phone.icon.touch.hittable).toBe(true);
    });
  },
);
