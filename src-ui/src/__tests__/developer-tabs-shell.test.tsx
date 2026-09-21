/**
 * @vitest-environment jsdom
 *
 * archive#2645: every Developer tab renders under ONE h1 owned by the tab
 * wrapper — embedded views must not bring their own page heading (the
 * double-heading / emoji-heading drift the owner reported). Iterates all
 * five read-only tabs with their data layers mocked.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { PageFrame } from '../components/page-frame';

// `RegionModelProvider` wraps the whole application, so `useShowSurface`
// requires it. This harness mounts a fragment of that tree, and nothing
// here asserts a surface reveal, so the command hook is supplied directly.
const showSurfaceStub = vi.hoisted(() => vi.fn());
// This fragment has no active connection; scoped Project reads stay disabled.
vi.mock('../contexts/ApiBaseContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../contexts/ApiBaseContext')>()),
  useHostRequestAuthorityScope: () => undefined,
}));

vi.mock('../contexts/useShowSurface', () => ({
  useShowSurface: () => showSurfaceStub,
}));

vi.mock('@kontourai/station-sdk', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const q = { data: undefined, isLoading: false, isError: false };
  return {
    ...actual,
    useConfigQuery: () => ({ data: undefined, isLoading: false }),
    useConfigProvenanceQuery: () => q,
    useUpdateConfigMutation: () => ({ mutate: vi.fn() }),
    useSystemStatusForApiBaseQuery: () => q,
    useGlobalKnowledgeStatusQuery: () => q,
  };
});

vi.mock('@kontourai/station-sdk/developer-runtime', () => ({
  useBootHistoryQuery: () => ({
    data: undefined,
    isLoading: false,
    isError: false,
  }),
  useSystemInstanceQuery: () => ({ data: undefined, isLoading: false }),
  useServerLogsQuery: () => ({
    data: undefined,
    isLoading: false,
    isError: false,
  }),
}));

vi.mock('@kontourai/station-connect', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  useConnections: () => ({ activeConnection: null, connections: [] }),
  useConnectionStatus: () => ({
    status: 'connected',
    reason: null,
    failureStreak: 0,
    failureWindows: [],
  }),
}));

vi.mock('../lib/serverHealth', () => ({
  checkServerHealth: vi.fn(),
  probeServerConnection: vi.fn(),
}));

vi.mock('../contexts/NavigationContext', () => {
  // NavigationContext publishes two read hooks: `useNavigation` (subscribes to
  // the store, optionally through a selector) and `useNavigationActions` (the
  // memoized actions, no subscription). This mock answers both from one value.
  const navigation = () => ({ navigate: vi.fn() });
  return {
    useNavigation: (
      selector?: (state: ReturnType<typeof navigation>) => unknown,
    ) => (selector ? selector(navigation()) : navigation()),
    useNavigationActions: navigation,
  };
});

vi.mock('../views/settings/BuildProvenance', () => ({
  BuildProvenance: () => null,
}));

// Heavy embedded views: the shell convention is what is under test, not
// their internals — replace each with a heading-free stub.
vi.mock('../views/IntegrationsView', () => ({
  IntegrationsView: () => <div data-testid="embedded-view" />,
}));
vi.mock('../views/KnowledgeConnectionView', () => ({
  KnowledgeConnectionView: () => <div data-testid="embedded-view" />,
  default: () => <div data-testid="embedded-view" />,
}));
vi.mock('../views/MonitoringView', () => ({
  MonitoringViewWithBoundary: () => <div data-testid="embedded-view" />,
  default: () => <div data-testid="embedded-view" />,
}));
vi.mock('../views/settings/StationConfigSection', () => ({
  StationConfigSection: () => <div data-testid="embedded-view" />,
}));

afterEach(cleanup);

const TABS: Array<
  [string, () => Promise<{ default: React.ComponentType<{ apiBase: string }> }>]
> = [
  ['Logs', () => import('../views/developer/LogsTab')],
  ['System', () => import('../views/developer/SystemTab')],
  ['Telemetry', () => import('../views/developer/TelemetryTab')],
  ['Memory', () => import('../views/developer/MemoryTab')],
  ['Archive', () => import('../views/developer/ArchiveTab')],
];

describe('Developer tabs render exactly one h1 (station#2645)', () => {
  test('StationConfigSection embedded suppresses its own heading (real component)', async () => {
    const { StationConfigSection } = await vi.importActual<
      typeof import('../views/settings/StationConfigSection')
    >('../views/settings/StationConfigSection');
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <StationConfigSection
          containerScope="station"
          section="sources"
          config={{} as never}
          onChange={() => {}}
          embedded
        />
      </QueryClientProvider>,
    );
    // #2182: the string this used to look for ("Station configuration") no
    // longer exists anywhere, so asserting its absence would pass for any
    // reason at all. The contract is what it always was — an embedded mount
    // contributes NO heading of its own — so that is what is asserted now,
    // and a control the section does render pins that something rendered.
    expect(screen.queryAllByRole('heading')).toEqual([]);
    // A control the section does render, so "no heading" is not satisfied by
    // "nothing rendered". Sources is used rather than a section whose rows
    // are deferred composite editors, which render nothing in this harness.
    expect(screen.getByRole('textbox', { name: 'Registry URL' })).toBeTruthy();
  });

  // archive#2645's contract is unchanged; its OWNER moved. The Developer
  // route's title is now the page frame's `<h1>` (published per tab by
  // `DeveloperView`), so each tab must contribute exactly zero of its own and
  // the framed total must still be exactly one.
  //
  // `spec.eyebrow: 'Developer'` below is a FIXTURE for this describe block's
  // own contract (a tab body contributes no heading of its own) — it does not
  // exercise `DeveloperView`, which is not mounted here, so it is not a claim
  // about `DeveloperView`'s real eyebrow (a linked `PageEyebrowTrail`,
  // archive#4463). That behavior is asserted directly in
  // `DeveloperView.test.tsx`, the file that actually mounts the component.
  for (const [name, load] of TABS) {
    test(`${name} tab`, async () => {
      const { default: Tab } = await load();
      const { container } = render(
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <PageFrame
            spec={{ eyebrow: 'Developer', title: name }}
            routeIdentity={`developer:${name}`}
          >
            <Suspense fallback={null}>
              <Tab apiBase="http://station.test" />
            </Suspense>
          </PageFrame>
        </QueryClientProvider>,
      );
      const h1s = await screen.findAllByRole('heading', { level: 1 });
      expect(h1s.length).toBe(1);
      expect(h1s[0].textContent).toBe(name);
      expect(h1s[0].classList.contains('page__title')).toBe(true);
      if (name === 'Telemetry')
        expect(screen.getByTestId('embedded-view')).toBeTruthy();
      // The tab body itself contributes none.
      expect(container.querySelectorAll('.page-frame__body h1').length).toBe(0);
    });
  }
});
