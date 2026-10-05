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

const CASES: Array<{ slug: string; icon?: string; accent?: string }> = [
  { slug: 'glyph', icon: '🧭', accent: 'var(--event-tool-call)' },
  { slug: 'plain', accent: 'var(--event-agent-complete)' },
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
      {CASES.map(({ slug, icon, accent }) => (
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
          isActive={false}
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

    test('every project name starts at the same x, and an icon-less row shows a faint colour dot in the slot', async () => {
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
              const dot = row.querySelector('[data-project-icon="dot"]');
              return {
                name: name?.textContent,
                nameLeft: name?.getBoundingClientRect().left ?? null,
                hasImageOrGlyph: Boolean(
                  icon?.querySelector('img, .brand-icon__glyph'),
                ),
                dotWidth: dot?.getBoundingClientRect().width ?? 0,
                dotOpacity: dot ? Number(getComputedStyle(dot).opacity) : null,
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
          // The icon-less rows with a colour draw it, faintly.
          for (const row of [rows[1], rows[3]]) {
            expect(row?.dotWidth, `${label} ${row?.name}`).toBeGreaterThan(0);
            expect(row?.dotOpacity ?? 1).toBeLessThan(1);
          }
          // An icon changes no row's height.
          expect(new Set(rows.map((row) => row.rowHeight)).size).toBe(1);
        } finally {
          await page.close();
        }
      }
    });

    test('the collapsed rail draws no dot: an icon-less project keeps its bar alone', async () => {
      const page = await browser.newPage();
      try {
        await page.setContent(
          `<style>${css}</style><div class="sidebar sidebar--collapsed" style="width:56px">${rowsMarkup(true)}</div>`,
        );
        expect(await page.locator('[data-project-icon="dot"]').count()).toBe(0);
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
