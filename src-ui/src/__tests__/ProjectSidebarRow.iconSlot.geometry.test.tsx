/**
 * @vitest-environment jsdom
 *
 * When only some projects have icons, every expanded sidebar row still
 * reserves the icon's slot, so the project names start at one x. Before,
 * an icon-less row drew nothing there and its name started ~26px further
 * left than its neighbours'.
 *
 * jsdom computes no layout, so the real rows are measured in Chromium with
 * the cascade-resolved stylesheets.
 */

import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { cleanup, render } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
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

// Activity is current when `main` shows its surface at `/`.
const region = vi.hoisted(() => ({ mainOccupant: null as string | null }));
vi.mock('../contexts/RegionModelContext', () => ({
  useRegionModelOptional: () => ({
    regions: {
      main: {
        visible: true,
        size: 0,
        panes: region.mainOccupant ? [region.mainOccupant] : [],
        occupant: region.mainOccupant,
      },
      left: { visible: false, size: 400, panes: [], occupant: null },
      right: { visible: false, size: 400, panes: [], occupant: null },
      bottom: { visible: true, size: 320, panes: ['chat'], occupant: 'chat' },
    },
  }),
}));
vi.mock('../contexts/useShowSurface', () => ({
  useShowSurfacePage: () => vi.fn(),
}));
vi.mock('../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () => new Set<string>(),
}));

import { ProjectSidebarNav } from '../components/project-sidebar/ProjectSidebarNav';
import { ProjectSidebarRow } from '../components/project-sidebar/ProjectSidebarRow';

const REPO_ROOT = resolve(import.meta.dirname, '../../../');
const css = [
  '../index.css',
  '../components/icons/BrandIcon.css',
  '../components/icons/ProjectIcon.css',
  '../components/project-sidebar/ProjectSidebar.css',
]
  .map((path) => resolveCssImports(resolve(import.meta.dirname, path)))
  .join('\n');
assertNoImportsSurvive(css);

// A real 1x1 PNG in the writer's shape, so the image icon loads.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const CASES: Array<{
  slug: string;
  icon?: string;
  accent?: string;
  active?: boolean;
}> = [
  { slug: 'glyph', icon: '🧭', accent: 'var(--event-tool-call)' },
  // The selected project: its 2px active border must not shift it.
  { slug: 'plain', accent: 'var(--event-agent-complete)', active: true },
  { slug: 'image', icon: PNG, accent: 'var(--event-error)' },
  // A refused legacy link draws no icon: it is an icon-less row.
  {
    slug: 'legacy',
    icon: 'https://example.com/logo.png',
    accent: 'var(--event-tool-call)',
  },
  // No colour allocated yet (the list is still loading): the slot holds.
  { slug: 'bare' },
];

function rowsMarkup(collapsed: boolean): string {
  const { container, unmount } = render(
    <>
      {CASES.map(({ slug, icon, accent, active }) => (
        <ProjectSidebarRow
          key={slug}
          project={
            {
              id: `id-${slug}`,
              slug,
              name: `${slug} project`,
              layoutCount: 0,
              hasKnowledge: false,
              ...(icon ? { icon } : {}),
            } as ProjectMetadata
          }
          isActive={Boolean(active)}
          activeLayout={null}
          collapsed={collapsed}
          accent={accent}
        />
      ))}
    </>,
  );
  const html = container.innerHTML;
  unmount();
  cleanup();
  return html;
}

describe.skipIf(!chromiumIsInstalled(REPO_ROOT))(
  'sidebar project rows with and without icons',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    beforeAll(async () => {
      browser = await chromium.launch();
    });
    afterAll(async () => {
      await browser?.close();
    });

    test('every project name starts at the same x, and an icon-less row leaves the reserved slot empty', async () => {
      for (const viewport of [
        { width: 1280, height: 800 },
        { width: 390, height: 844 },
      ]) {
        const page = await browser.newPage({ viewport });
        try {
          await page.setContent(
            // `--expanded`: on a phone the sidebar is the open drawer.
            `<style>${css}</style><div class="sidebar sidebar--expanded" style="width:250px">${rowsMarkup(false)}</div>`,
          );
          const rows = await page.evaluate(() =>
            Array.from(
              document.querySelectorAll<HTMLElement>('.sidebar__project-btn'),
            ).map((row) => {
              const name = row.querySelector('.sidebar__project-name');
              const icon = row.querySelector('.sidebar__project-icon');
              const slot = row.querySelector('.sidebar__project-icon-slot');
              const bar = row.querySelector('.sidebar__project-accent');
              return {
                name: name?.textContent,
                nameLeft: name?.getBoundingClientRect().left ?? null,
                hasImageOrGlyph: Boolean(
                  icon?.querySelector('img, .brand-icon__glyph'),
                ),
                slotWidth: slot?.getBoundingClientRect().width ?? 0,
                barLeft: bar?.getBoundingClientRect().left ?? null,
                active: row.classList.contains('sidebar__project-btn--active'),
                slotChildren: slot?.childElementCount ?? null,
                rowHeight: row.getBoundingClientRect().height,
              };
            }),
          );
          const label = `${viewport.width}px`;
          // The fixture mixes what it claims to: two rows with an icon, three
          // without.
          expect(
            rows.map((row) => row.hasImageOrGlyph),
            label,
          ).toEqual([true, false, true, false, false]);
          const lefts = rows.map((row) => row.nameLeft);
          // Laid out, not hidden: a hidden rail puts every name at 0.
          expect(
            lefts.every((left) => left !== null && left > 0),
            `${label} names drawn: ${lefts}`,
          ).toBe(true);
          expect(new Set(lefts).size, `${label} name x: ${lefts}`).toBe(1);
          // The fixture includes the selected row, and its bar sits where
          // every other row's does.
          expect(rows.map((row) => row.active)).toEqual([
            false,
            true,
            false,
            false,
            false,
          ]);
          const bars = rows.map((row) => row.barLeft);
          expect(new Set(bars).size, `${label} bar x: ${bars}`).toBe(1);
          // Every row reserves the same slot; only the iconed rows fill it.
          expect(
            rows.map((row) => row.slotWidth),
            `${label} slot widths`,
          ).toEqual([18, 18, 18, 18, 18]);
          expect(
            rows.map((row) => row.slotChildren),
            `${label} slot contents`,
          ).toEqual([1, 0, 1, 0, 0]);
          // An icon changes no row's height.
          expect(new Set(rows.map((row) => row.rowHeight)).size).toBe(1);
        } finally {
          await page.close();
        }
      }
    });

    test('a current Activity row keeps its icon and label where they sit when it is not current', async () => {
      const navMarkup = (current: boolean) => {
        region.mainOccupant = current ? 'activity' : null;
        const { container, unmount } = render(
          <ProjectSidebarNav
            collapsed={false}
            isMobile={false}
            navigate={vi.fn()}
            activePath="/"
          />,
        );
        const html = container.innerHTML;
        unmount();
        cleanup();
        return html;
      };
      const page = await browser.newPage({
        viewport: { width: 1280, height: 800 },
      });
      try {
        const measure = async (current: boolean) => {
          await page.setContent(
            `<style>${css}</style><div class="sidebar sidebar--expanded" style="width:250px">${navMarkup(current)}</div>`,
          );
          return page.evaluate(() => {
            const row = document.querySelector<HTMLElement>(
              'button[aria-label="Activity"]',
            );
            return {
              current: row?.getAttribute('aria-current') ?? null,
              iconLeft:
                row?.querySelector('svg')?.getBoundingClientRect().left ?? null,
              labelLeft:
                row
                  ?.querySelector('.sidebar__nav-label')
                  ?.getBoundingClientRect().left ?? null,
            };
          });
        };
        const idle = await measure(false);
        const current = await measure(true);
        // The fixture really toggles the current state.
        expect(idle.current).toBeNull();
        expect(current.current).toBe('page');
        expect(idle.labelLeft).not.toBeNull();
        expect({
          icon: current.iconLeft,
          label: current.labelLeft,
        }).toEqual({ icon: idle.iconLeft, label: idle.labelLeft });
      } finally {
        await page.close();
      }
    });

    test('the collapsed rail reserves no slot: an icon-less project keeps its bar alone', async () => {
      const page = await browser.newPage();
      try {
        await page.setContent(
          `<style>${css}</style><div class="sidebar sidebar--collapsed" style="width:56px">${rowsMarkup(true)}</div>`,
        );
        expect(await page.locator('.sidebar__project-icon-slot').count()).toBe(
          0,
        );
        expect(await page.locator('.sidebar__project-icon').count()).toBe(2);
      } finally {
        await page.close();
      }
    });
  },
);

test.skipIf(chromiumIsInstalled(REPO_ROOT))(
  'sidebar project name alignment — Chromium not installed, cannot verify',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so sidebar project name alignment ' +
        'could not be measured: a missing precondition, not a passing ' +
        'check. Run `npm run install:playwright`.',
    );
  },
);
