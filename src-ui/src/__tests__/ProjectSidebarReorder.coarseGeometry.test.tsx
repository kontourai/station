/**
 * @vitest-environment jsdom
 *
 * archive#3331: a coarse pointer has neither hover nor focus-visible, so the
 * reorder handle was permanently invisible AND permanently active: a finger
 * starting a sidebar scroll inside its zone had the scroll suppressed by
 * `touch-action: none` and could commit a reorder it never asked for. Touch
 * gets a visible handle at the 44px floor, inside a row tall enough that
 * adjacent handles do not overlap, and the project name stops short of it.
 *
 * jsdom evaluates no media query and computes no layout, so this renders the
 * real rows, puts their markup into Chromium with the cascade-resolved
 * `index.css` and `ProjectSidebar.css`, and measures under touch emulation.
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
} from '../../../tests/helpers/css-cascade-fixture';
import type { ProjectMetadata } from '../contexts/ProjectsContext';

vi.mock('@kontourai/station-sdk', () => ({
  useProjectLayoutsQuery: () => ({ data: [] }),
  useBoardAvailabilityQuery: () => ({ data: undefined }),
}));

vi.mock('../contexts/NavigationContext', () => {
  const navigation = () => ({
    navigate: vi.fn(),
    setProject: vi.fn(),
    setLayout: vi.fn(),
    pathname: '/',
  });
  return {
    useNavigation: (
      selector?: (state: ReturnType<typeof navigation>) => unknown,
    ) => (selector ? selector(navigation()) : navigation()),
    useNavigationActions: navigation,
  };
});

import { ProjectSidebarRow } from '../components/project-sidebar/ProjectSidebarRow';
import { useProjectListReorder } from '../components/project-sidebar/useProjectListReorder';

const REPO_ROOT = resolve(import.meta.dirname, '../../../');
const css = ['../index.css', '../components/project-sidebar/ProjectSidebar.css']
  .map((path) => resolveCssImports(resolve(import.meta.dirname, path)))
  .join('\n');
assertNoImportsSurvive(css);

const PROJECTS: ProjectMetadata[] = ['alpha', 'beta'].map((slug) => ({
  id: `id-${slug}`,
  slug,
  // Long enough to ellipsize in the rail, so the name runs as far right as
  // the row lets it.
  name: `${slug} project with a name far too long for the sidebar rail`,
  hasWorkingDirectory: false,
  layoutCount: 0,
  hasKnowledge: false,
}));

function Rows() {
  const { rowReorderProps } = useProjectListReorder(
    PROJECTS.map((project) => project.slug),
    () => {},
  );
  return (
    <>
      {PROJECTS.map((project, index) => (
        <ProjectSidebarRow
          key={project.slug}
          project={project}
          isActive={false}
          activeLayout={null}
          collapsed={false}
          reorder={rowReorderProps(index)}
        />
      ))}
    </>
  );
}

function rowsMarkup(): string {
  const { container, unmount } = render(<Rows />);
  const html = container.innerHTML;
  unmount();
  return html;
}

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)(
  'the sidebar reorder handle on a coarse pointer (archive#3331)',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    beforeAll(async () => {
      browser = await chromium.launch();
    });
    afterAll(async () => {
      await browser?.close();
    });
    afterEach(cleanup);

    async function measure(hasTouch: boolean) {
      // Desktop-sized, so the narrow/short mobile drawer rules stay out of it
      // and only the pointer type differs between the two runs.
      const context = await browser.newContext({
        viewport: { width: 1024, height: 800 },
        hasTouch,
      });
      try {
        const page = await context.newPage();
        await page.setContent(
          `<style>${css}</style><div class="sidebar" style="width:250px">${rowsMarkup()}</div>`,
        );
        return await page.evaluate(() => {
          const box = (element: Element) => {
            const { top, bottom, left, right, height } =
              element.getBoundingClientRect();
            return { top, bottom, left, right, height };
          };
          const rows = Array.from(
            document.querySelectorAll('.sidebar__project-row-main'),
          ).map((rowMain) => {
            const handle = rowMain.querySelector('.sidebar__reorder-handle');
            const name = rowMain.querySelector('.sidebar__project-name');
            if (!handle || !name) throw new Error('the row did not render');
            const handleBox = box(handle);
            return {
              row: box(rowMain),
              handle: handleBox,
              name: box(name),
              opacity: getComputedStyle(handle).opacity,
              centerHitsHandle:
                document
                  .elementFromPoint(
                    (handleBox.left + handleBox.right) / 2,
                    (handleBox.top + handleBox.bottom) / 2,
                  )
                  ?.closest('.sidebar__reorder-handle') === handle,
            };
          });
          return {
            coarse: matchMedia('(pointer: coarse)').matches,
            rows,
          };
        });
      } finally {
        await context.close();
      }
    }

    test('the handle is visible, 44px tall, inside its own row, and clear of the name', async () => {
      const { coarse, rows } = await measure(true);
      expect(coarse).toBe(true);
      expect(rows).toHaveLength(2);

      for (const { row, handle, name, opacity, centerHitsHandle } of rows) {
        expect(opacity).toBe('1');
        expect(handle.height).toBeGreaterThanOrEqual(44);
        // The row grew to hold the target, so it does not overhang.
        expect(handle.top).toBeGreaterThanOrEqual(row.top - 0.5);
        expect(handle.bottom).toBeLessThanOrEqual(row.bottom + 0.5);
        expect(name.right).toBeLessThanOrEqual(handle.left);
        expect(centerHitsHandle).toBe(true);
      }
      // Adjacent handles tile instead of overlapping.
      expect(rows[0].handle.bottom).toBeLessThanOrEqual(rows[1].handle.top);
    }, 120_000);

    test('a fine pointer leaves the handle hidden at rest', async () => {
      const { coarse, rows } = await measure(false);
      expect(coarse).toBe(false);
      for (const { opacity } of rows) expect(opacity).toBe('0');
    }, 120_000);
  },
);

test.skipIf(chromiumAvailable)(
  'sidebar reorder handle geometry — Chromium not installed, cannot verify (archive#3331)',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the coarse-' +
        'pointer reorder handle could not be measured. This is a missing ' +
        'precondition, not a passing check. Install it with ' +
        '`npm run install:playwright` and re-run.',
    );
  },
);
