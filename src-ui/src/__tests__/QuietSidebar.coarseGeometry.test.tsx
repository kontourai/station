/**
 * @vitest-environment jsdom
 *
 * The quiet sidebar's rows in the phone drawer, measured in a real engine
 * (`quiet-sidebar` preview, `navigation-11`): every row the drawer adds or
 * relabels (Automations, an app, Discover, Customize, Settings) and the
 * Updates and account controls beside Settings are at least 44px tall and
 * wide, and none overlaps the next.
 *
 * jsdom evaluates no media query and computes no layout, so this renders the
 * real parts, puts their markup into Chromium inside the expanded drawer with
 * the cascade-resolved stylesheets, and measures at 390px.
 */

import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { cleanup, render, screen } from '@testing-library/react';
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
  useFeaturePreviewsQuery: () => ({ data: [] }),
  usePersonalLayoutsQuery: () => ({
    data: [{ id: 'b1', slug: 'daily', name: 'Daily brief', icon: '▦' }],
  }),
  useCreatePersonalLayoutMutation: () => ({
    isPending: false,
    mutate: () => {},
  }),
  useUpdatePersonalLayoutMutation: () => ({ mutate: () => {} }),
  useDeletePersonalLayoutMutation: () => ({ mutate: () => {} }),
  usePromotePersonalLayoutMutation: () => ({ mutate: () => {} }),
  useCoreUpdateStatusQuery: () => ({ data: undefined }),
  useAgentsQuery: () => ({ data: [] }),
  useSkillsQuery: () => ({ data: [] }),
  useModelConnectionsQuery: () => ({ data: [] }),
  // A disabled engine, so the Customize row carries its dot.
  useEngineConnectionsQuery: () => ({
    data: [
      {
        id: 'codex',
        kind: 'agent',
        type: 'codex',
        name: 'Codex',
        enabled: false,
        status: 'ready',
        capabilities: ['agent-runtime'],
        config: {},
        prerequisites: [],
        setup: { state: 'ready', detected: true, configured: true },
      },
    ],
  }),
  useIntegrationsQuery: () => ({ data: [] }),
  useGlobalKnowledgeStatusQuery: () => ({ data: undefined }),
  useACPConnectionsQuery: () => ({ data: [] }),
  useACPConnectionRegistryQuery: () => ({ data: [] }),
}));
vi.mock('../contexts/ProjectsContext', () => ({
  useProjects: () => ({ projects: [], isLoading: false }),
}));
vi.mock('../contexts/RegionModelContext', () => ({
  useRegionModelOptional: () => null,
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { name: 'Ada Lovelace' } }),
}));
vi.mock('../contexts/ManagedPolicyContext', () => ({
  useManagedPolicySummary: () => undefined,
}));
vi.mock('../hooks/useConnectedServerUpdateContext', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../hooks/useConnectedServerUpdateContext')
  >()),
  useConnectedServerUpdateContext: () => ({
    apiBase: '',
    scopeKey: 'quiet-sidebar-geometry',
    connectionName: 'Test Station',
    kind: 'remote-server',
    reachability: 'unknown',
    identity: null,
    identityReady: false,
    identitySettled: false,
    nativeObservationPending: false,
    claimedOwnerUnresolved: false,
    isCurrent: () => false,
  }),
}));

import QuietSidebarPart from '../components/project-sidebar/QuietSidebar';

const REPO_ROOT = resolve(import.meta.dirname, '../../../');
const css = [
  '../index.css',
  '../components/project-sidebar/ProjectSidebar.css',
  '../components/project-sidebar/ProjectSidebarBoards.css',
  '../components/project-sidebar/ProjectSidebarFooter.css',
  '../components/project-sidebar/QuietSidebar.css',
  '../components/updates/Updates.css',
]
  .map((path) => resolveCssImports(resolve(import.meta.dirname, path)))
  .join('\n');
assertNoImportsSurvive(css);

/** The drawer's body and footer as the quiet sidebar renders them. */
function drawerMarkup(): string {
  const props = {
    collapsed: false,
    isMobile: true,
    navigate: () => {},
    activePath: '/',
  };
  const { container, unmount } = render(
    <>
      <div className="sidebar__body">
        <QuietSidebarPart part="places" {...props} />
        <QuietSidebarPart part="apps" {...props} />
      </div>
      <QuietSidebarPart part="footer" {...props} />
    </>,
  );
  expect(screen.getByRole('button', { name: 'Discover' })).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Customize, needs attention' }),
  ).toBeTruthy();
  const html = container.innerHTML;
  unmount();
  return html;
}

const TARGETS = [
  ['Automations', '[aria-label="Automations"]'],
  ['Daily brief', '.sidebar__board-row-main .sidebar__project-btn'],
  ['Daily brief actions', '.sidebar__board-menu-trigger'],
  ['Discover', '[aria-label="Discover"]'],
  ['Customize', '[aria-label="Customize, needs attention"]'],
  ['Settings', '[aria-label="Settings"]'],
  ['Updates', '.sidebar__update .updates-control'],
  ['Account', '.sidebar__account'],
] as const;

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)(
  'the quiet sidebar in the phone drawer, in a real engine',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    beforeAll(async () => {
      browser = await chromium.launch();
    });
    afterAll(async () => {
      await browser?.close();
    });
    afterEach(cleanup);

    test.each([
      { hasTouch: true, width: 390 },
      { hasTouch: false, width: 390 },
    ])(
      'every row and control is a 44px target and none overlaps (touch=$hasTouch)',
      async ({ hasTouch, width }) => {
        const context = await browser.newContext({
          viewport: { width, height: 844 },
          hasTouch,
        });
        try {
          const page = await context.newPage();
          await page.setContent(
            `<style>${css}</style><nav class="sidebar sidebar--expanded">${drawerMarkup()}</nav>`,
          );
          const boxes = await page.evaluate(
            (targets) =>
              targets.map(([name, selector]) => {
                const node = document.querySelector(selector);
                if (!node) throw new Error(`${name} did not render`);
                const box = node.getBoundingClientRect();
                return {
                  name,
                  top: box.top,
                  bottom: box.bottom,
                  left: box.left,
                  right: box.right,
                  width: box.width,
                  height: box.height,
                };
              }),
            TARGETS.map(([name, selector]) => [name, selector]),
          );
          for (const box of boxes) {
            expect(box.height, box.name).toBeGreaterThanOrEqual(44);
            expect(box.width, box.name).toBeGreaterThanOrEqual(44);
          }
          for (const [index, box] of boxes.entries()) {
            for (const other of boxes.slice(index + 1)) {
              const overlaps =
                box.left < other.right &&
                other.left < box.right &&
                box.top < other.bottom &&
                other.top < box.bottom;
              expect(overlaps, `${box.name} overlaps ${other.name}`).toBe(
                false,
              );
            }
          }
        } finally {
          await context.close();
        }
      },
      120_000,
    );
  },
);
