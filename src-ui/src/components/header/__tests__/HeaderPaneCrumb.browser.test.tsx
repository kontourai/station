// @vitest-environment jsdom

/**
 * A direct pane route's top-bar crumb, in a real Chromium against the real
 * cascade. jsdom renders the real `Header` for a view (its breadcrumb derived
 * by the real view model's `getHeaderBreadcrumb`), and Chromium lays that
 * markup out with `index.css` and the header sheets.
 *
 * Checked: a pane route names its project and pane ("Demo Project / Browser")
 * at desktop and phone width, the pane name is shown whole on a phone, and a
 * project route keeps its crumb a desktop affordance (its own identity header
 * names it on a phone).
 */

import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { cleanup, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { resolveCssImports } from '../../../../../tests/helpers/css-cascade-fixture';
import type { NavigationView } from '../../../types';
import { getHeaderBreadcrumb } from '../utils';

const css = [
  '../../../index.css',
  '../../chat/chat.css',
  '../Header.css',
  '../LayoutSwitcher.css',
]
  .map((path) => resolveCssImports(resolve(import.meta.dirname, path)))
  .join('\n');

vi.mock('../../../contexts/AgentsContext', () => ({ useAgents: () => [] }));
vi.mock('../HeaderActions', () => ({ HeaderActions: () => null }));
vi.mock('../RegionToolbarControls', () => ({
  RegionToolbarControls: () => null,
}));
vi.mock('../../../contexts/ProjectsContext', () => ({
  useProjects: () => ({ projects: [{ slug: 'demo', name: 'Demo Project' }] }),
}));
vi.mock('../../../contexts/DeviceSettingsContext', () => ({
  useDeviceSettings: () => ({ projectSidebarCollapsed: false }),
}));
vi.mock('../../../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../../../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ productName: 'Station' }),
}));
vi.mock('@kontourai/station-sdk/workspace-pane', () => ({
  useProjectWorkspacePanesQuery: (slug: string) => ({
    data:
      slug === 'demo'
        ? {
            descriptors: [
              { id: 'pane:browser', name: 'Browser' },
              { id: 'pane:device', name: 'Device' },
            ],
          }
        : undefined,
  }),
}));
// The view model's breadcrumb is the real derivation; the rest of it (menus,
// notifications) is not what this measures.
vi.mock('../useHeaderViewModel', () => ({
  useHeaderViewModel: ({ currentView }: { currentView?: NavigationView }) => ({
    breadcrumb: getHeaderBreadcrumb(currentView),
    closeHelp: vi.fn(),
    closeNotifications: vi.fn(),
    closeOverflow: vi.fn(),
    goHome: vi.fn(),
    handleHelpPrompt: vi.fn(),
    helpPrompts: [],
    openConnectionModal: vi.fn(),
    openProfile: vi.fn(),
    showHelp: false,
    showNotifications: false,
    showOverflow: false,
    openHelp: vi.fn(),
    toggleNotifications: vi.fn(),
    toggleOverflow: vi.fn(),
    userInitials: 'BA',
  }),
}));

import { Header } from '../Header';

const PANE: NavigationView = {
  type: 'workspace-pane',
  projectSlug: 'demo',
  descriptorId: 'pane:browser',
  instanceId: 'browser-preview:1',
};

let browser: Awaited<ReturnType<typeof chromium.launch>>;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

afterEach(cleanup);

function headerMarkup(view: NavigationView): string {
  const { container } = render(
    <Header currentView={view} onNavigate={() => undefined} />,
  );
  return container.innerHTML;
}

async function crumb(
  markup: string,
  width: number,
  theme: 'dark' | 'light',
  shot: string,
) {
  const page = await browser.newPage({ viewport: { width, height: 120 } });
  try {
    await page.setContent(
      `<!doctype html><html data-theme="${theme}"><head><style>${css}</style></head>` +
        `<body style="margin:0">${markup}</body></html>`,
    );
    const evidence = process.env.STATION_UI_EVIDENCE_DIR;
    if (evidence)
      await page.screenshot({
        path: `${evidence}/${shot}-${width}-${theme}.png`,
      });
    return await page.evaluate(() => {
      const crumb = document.querySelector<HTMLElement>(
        '.app-toolbar__breadcrumb',
      );
      const current = document.querySelector<HTMLElement>(
        '.app-toolbar__breadcrumb-current',
      );
      const shown = (element: HTMLElement | null) =>
        !!element &&
        getComputedStyle(element).display !== 'none' &&
        element.getBoundingClientRect().width > 0;
      return {
        crumbShown: shown(crumb),
        text:
          crumb && shown(crumb)
            ? [...crumb.children]
                .map((segment) => segment.textContent?.trim())
                .join(' ')
            : '',
        currentWhole: !!current && current.scrollWidth <= current.clientWidth,
        currentName: current?.getAttribute('aria-current') ?? null,
      };
    });
  } finally {
    await page.close();
  }
}

for (const theme of ['dark', 'light'] as const) {
  for (const width of [1440, 390]) {
    test(`a pane route's top bar names its project and pane (${width}px, ${theme})`, async () => {
      const facts = await crumb(headerMarkup(PANE), width, theme, 'pane-crumb');
      expect(facts.crumbShown).toBe(true);
      expect(facts.text).toBe('Demo Project / Browser');
      expect(facts.currentName).toBe('page');
      expect(facts.currentWhole).toBe(true);
    });
  }
}

test("a project route's crumb stays a desktop affordance", async () => {
  const markup = headerMarkup({ type: 'project', slug: 'demo' });
  expect((await crumb(markup, 1440, 'dark', 'project-crumb')).text).toBe(
    'Demo Project',
  );
  expect((await crumb(markup, 390, 'dark', 'project-crumb')).crumbShown).toBe(
    false,
  );
});
