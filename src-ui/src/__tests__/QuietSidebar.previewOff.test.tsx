/**
 * @vitest-environment jsdom
 */

/**
 * With the `quiet-sidebar` preview off, the sidebar is the one it was. Each of
 * its forms (expanded with and without Projects and Boards, the collapsed rail, the phone drawer) is
 * rendered from the real `ProjectSidebar` and compared, byte for byte, with
 * the markup the base sidebar produced for the same data. The fixtures under
 * `fixtures/quiet-sidebar-preview-off/` were written from the sidebar files of
 * the base this slice started from, before any of its changes, so a change
 * that leaks into the preview-off sidebar fails here. React's generated ids
 * are masked; nothing else is.
 *
 * The fresh form has no Projects and no Boards, so the empty Boards line is
 * in it. Two ways of being off are checked against the same markup: the read says
 * off, and the read has not answered on a device with no remembered answer.
 *
 * This test and its fixtures are deleted with the old sidebar, when the quiet
 * sidebar is turned on for everyone (slice 1.12). Until then, a deliberate
 * change to the old sidebar refreshes the fixtures by running this file with
 * `UPDATE_QUIET_SIDEBAR_FIXTURES=1`: the "read says off" cases write the
 * rendered markup instead of comparing it, and the "not answered" cases still
 * compare against what was just written. It refuses to write when `CI` is set.
 * Review the fixture diff like any other change.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { name: 'Ada Lovelace' } }),
}));
vi.mock('../contexts/useShowSurface', () => ({
  useShowSurface: () => vi.fn(),
  useShowSurfacePage: () => vi.fn(),
}));
vi.mock('../contexts/RegionModelContext', () => ({
  useRegionModelOptional: () => null,
}));

const state = vi.hoisted(() => ({
  previews: [] as Array<{ id: string; enabled: boolean }> | undefined,
  isMobile: false,
  /** A fresh install: no Projects and no Boards. */
  fresh: false,
}));

vi.mock('../contexts/ProjectsContext', () => ({
  useProjects: () => ({
    projects: state.fresh
      ? []
      : [
          { id: 'p1', slug: 'acme-web', name: 'Acme Web' },
          { id: 'p2', slug: 'notes-api', name: 'Notes API' },
        ],
    isLoading: false,
  }),
}));
vi.mock('../contexts/AgentsContext', () => ({ useAgents: () => [] }));
vi.mock('../contexts/NavigationContext', () => {
  const navigation = () => ({
    selectedProject: null,
    selectedProjectLayout: null,
    navigate: vi.fn(),
    setProject: vi.fn(),
    setLayout: vi.fn(),
    setDockState: vi.fn(),
    pathname: '/',
  });
  return {
    useNavigation: (
      selector?: (value: ReturnType<typeof navigation>) => unknown,
    ) => (selector ? selector(navigation()) : navigation()),
    useNavigationActions: navigation,
  };
});
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://test.local' }),
  useHostRequestAuthorityScope: () => undefined,
}));
vi.mock('../hooks/useBranding', () => ({
  useBranding: () => ({ appName: 'Station' }),
}));
vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ isTauri: false }),
}));
vi.mock('../hooks/useIsMobile', async (importActual) => ({
  ...(await importActual<typeof import('../hooks/useIsMobile')>()),
  useIsMobile: () => state.isMobile,
}));
vi.mock('../hooks/useConnectedServerUpdateContext', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../hooks/useConnectedServerUpdateContext')
  >()),
  useConnectedServerUpdateContext: () => ({
    apiBase: '',
    scopeKey: 'quiet-sidebar-off',
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
vi.mock('@kontourai/station-sdk', () => ({
  useFeaturePreviewsQuery: () => ({ data: state.previews }),
  useOrchestrationSessionsQuery: () => ({ data: [] }),
  useCoreUpdateStatusQuery: () => ({ data: undefined }),
  useProjectLayoutsQuery: () => ({ data: [] }),
  useReorderProjectsMutation: () => ({ mutate: vi.fn() }),
  useBoardAvailabilityQuery: () => ({ data: undefined }),
  useAttentionQuery: () => ({ data: { pendingCount: 0 } }),
  usePersonalLayoutsQuery: () => ({
    data: state.fresh
      ? []
      : [
          { id: 'b1', slug: 'daily-brief', name: 'Daily brief', icon: '☀' },
          { id: 'b2', slug: 'release-desk', name: 'Release desk' },
        ],
  }),
  useCreatePersonalLayoutMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useUpdatePersonalLayoutMutation: () => ({ mutate: vi.fn() }),
  useDeletePersonalLayoutMutation: () => ({ mutate: vi.fn() }),
  usePromotePersonalLayoutMutation: () => ({ mutate: vi.fn() }),
}));

import { ProjectSidebar } from '../components/project-sidebar/ProjectSidebar';
import { KeyboardShortcutsProvider } from '../contexts/KeyboardShortcutsContext';
import { deviceSettingsStore } from '../lib/device-settings-store';

const FIXTURES = resolve(
  import.meta.dirname,
  'fixtures/quiet-sidebar-preview-off',
);

type Form = 'expanded' | 'fresh' | 'rail' | 'drawer';

async function renderForm(form: Form): Promise<string> {
  state.isMobile = form === 'drawer';
  state.fresh = form === 'fresh';
  if (form === 'rail') deviceSettingsStore.set('projectSidebarCollapsed', true);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const { container, unmount } = render(
    <QueryClientProvider client={queryClient}>
      <KeyboardShortcutsProvider>
        <ProjectSidebar />
      </KeyboardShortcutsProvider>
    </QueryClientProvider>,
  );
  if (form === 'drawer')
    act(() => {
      window.dispatchEvent(new CustomEvent('toggle-sidebar'));
    });
  // Both lazy parts have arrived: the Boards section and the footer.
  await screen.findByRole('button', {
    name: form === 'rail' ? 'Apps' : 'New Board',
  });
  await screen.findByRole('button', { name: /^Profile and settings/ });
  await waitFor(() =>
    expect(container.querySelector('.lazy-boundary')).toBeNull(),
  );
  const html = container.innerHTML.replace(
    /_r_[0-9a-z]+_|:r[0-9a-z]+:/g,
    '«id»',
  );
  unmount();
  return html;
}

const UPDATE = process.env.UPDATE_QUIET_SIDEBAR_FIXTURES === '1';
if (UPDATE && process.env.CI)
  throw new Error(
    'UPDATE_QUIET_SIDEBAR_FIXTURES refreshes fixtures locally; it is refused in CI.',
  );

function fixture(form: Form): string {
  return readFileSync(resolve(FIXTURES, `${form}.html`), 'utf8');
}

beforeEach(() => {
  state.isMobile = false;
  window.localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
});

describe.each([
  ['the read says off', [{ id: 'quiet-sidebar', enabled: false }]],
  ['the read has not answered and nothing is remembered', undefined],
])('with the quiet sidebar off (%s)', (_label, previews) => {
  test.each(['expanded', 'fresh', 'rail', 'drawer'] as const)(
    'the %s sidebar is the base markup',
    async (form) => {
      state.previews = previews;
      const html = await renderForm(form);
      if (UPDATE && previews !== undefined)
        writeFileSync(resolve(FIXTURES, `${form}.html`), html);
      else expect(html).toBe(fixture(form));
    },
  );
});
