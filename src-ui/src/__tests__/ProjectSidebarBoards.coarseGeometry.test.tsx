/**
 * @vitest-environment jsdom
 *
 * #2062: the Boards row menu's trigger, measured in a real engine.
 *
 * - Review M1: the row menu is a phone's only rename affordance, so on a
 *   coarse pointer (no hover) its trigger must be visible, at the 44px floor,
 *   and actually hit-testable.
 * - Review F1: the trigger is absolutely centred on its positioned ancestor.
 *   When that ancestor was the whole row, opening a menu grew the row and slid
 *   the trigger down onto the menu's first item. The open menu must sit
 *   clear of the trigger.
 * - #2083: the menu keeps a raised fill, because the shared `.menu-surface`
 *   fill is the rail's own colour and would read as an outline on the panel.
 *
 * jsdom evaluates no media query and computes no layout, so this renders the
 * real section with its menu open, puts that markup into Chromium with the
 * cascade-resolved stylesheets, and measures under a touch and a mouse
 * context. The menu rows' own 44px coarse floor is measured by
 * `menu-primitive.cascade.test.tsx`; ProjectSidebarBoards.test.tsx proves the
 * panel mounts this section.
 */

import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

vi.mock('@kontourai/station-sdk', () => ({
  usePersonalLayoutsQuery: () => ({
    data: [{ slug: 'daily', name: 'Daily brief', icon: '▦' }],
  }),
  useCreatePersonalLayoutMutation: () => ({
    isPending: false,
    mutate: () => {},
  }),
  useUpdatePersonalLayoutMutation: () => ({ mutate: () => {} }),
  useDeletePersonalLayoutMutation: () => ({ mutate: () => {} }),
  usePromotePersonalLayoutMutation: () => ({ mutate: () => {} }),
}));

vi.mock('../contexts/ProjectsContext', () => ({
  useProjects: () => ({ projects: [], isLoading: false }),
}));

vi.mock('../contexts/RegionModelContext', () => ({
  useRegionModelOptional: () => null,
}));

import { ProjectSidebarBoards } from '../components/project-sidebar/ProjectSidebarBoards';

const REPO_ROOT = resolve(import.meta.dirname, '../../../');
const css = [
  '../index.css',
  '../components/chat/chat.css',
  '../components/project-sidebar/ProjectSidebar.css',
  '../components/project-sidebar/ProjectSidebarBoards.css',
]
  .map((path) => resolveCssImports(resolve(import.meta.dirname, path)))
  .join('\n');
assertNoImportsSurvive(css);

/** The section with the row's actions menu open, as a user leaves it. */
function openMenuMarkup(): string {
  const { container, unmount } = render(
    <ProjectSidebarBoards
      collapsed={false}
      isMobile={false}
      navigate={() => {}}
      activePath="/"
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Daily brief actions' }));
  expect(screen.getByRole('menu')).toBeTruthy();
  const html = container.innerHTML;
  unmount();
  return html;
}

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)(
  'the Boards row menu trigger in a real engine (#2062)',
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
      // Desktop-sized, so the narrow drawer rules stay out of it and only the
      // pointer type differs between the two runs.
      const context = await browser.newContext({
        viewport: { width: 1024, height: 800 },
        hasTouch,
      });
      try {
        const page = await context.newPage();
        await page.setContent(
          `<style>${css}</style><div class="sidebar">${openMenuMarkup()}</div>`,
        );
        return await page.evaluate(() => {
          const trigger = document.querySelector(
            '.sidebar__board-menu-trigger',
          );
          const menu = document.querySelector('.sidebar__board-menu');
          const sidebar = document.querySelector('.sidebar');
          if (!trigger || !menu || !sidebar) {
            throw new Error('the open Board row did not render');
          }
          const t = trigger.getBoundingClientRect();
          const m = menu.getBoundingClientRect();
          return {
            coarse: matchMedia('(pointer: coarse)').matches,
            opacity: getComputedStyle(trigger).opacity,
            trigger: { width: t.width, height: t.height, bottom: t.bottom },
            menuTop: m.top,
            centerHitsTrigger:
              document
                .elementFromPoint(t.left + t.width / 2, t.top + t.height / 2)
                ?.closest('.sidebar__board-menu-trigger') === trigger,
            menuBackground: getComputedStyle(menu).backgroundColor,
            railBackground: getComputedStyle(sidebar).backgroundColor,
          };
        });
      } finally {
        await context.close();
      }
    }

    test('on touch the trigger is visible, at least 44x44, and hit-testable', async () => {
      const result = await measure(true);
      expect(result.coarse).toBe(true);
      expect(result.opacity).toBe('1');
      expect(result.trigger.width).toBeGreaterThanOrEqual(44);
      expect(result.trigger.height).toBeGreaterThanOrEqual(44);
      expect(result.centerHitsTrigger).toBe(true);
    }, 120_000);

    test('a mouse leaves the trigger hidden until hover', async () => {
      const result = await measure(false);
      expect(result.coarse).toBe(false);
      expect(result.opacity).toBe('0');
    }, 120_000);

    test.each([true, false])(
      'the open menu sits below the trigger, never under it (hasTouch=%s)',
      async (hasTouch) => {
        const result = await measure(hasTouch);
        expect(result.trigger.bottom).toBeLessThanOrEqual(result.menuTop);
      },
      120_000,
    );

    test('the menu is filled differently from the rail it sits on', async () => {
      const result = await measure(false);
      expect(result.menuBackground).not.toBe(result.railBackground);
    }, 120_000);
  },
);

test.skipIf(chromiumAvailable)(
  'Boards row menu trigger geometry: Chromium not installed, cannot verify (#2062)',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the Boards ' +
        'row menu trigger could not be measured. This is a missing ' +
        'precondition, not a passing check. Install it with ' +
        '`npm run install:playwright` and re-run.',
    );
  },
);
