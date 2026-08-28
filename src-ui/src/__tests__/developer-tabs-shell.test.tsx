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

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

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
vi.mock('../components/monitoring/MonitoringView', () => ({
  MonitoringView: () => <div data-testid="embedded-view" />,
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
          config={{} as never}
          onChange={() => {}}
          embedded
        />
      </QueryClientProvider>,
    );
    expect(screen.queryByText('Station configuration')).toBeNull();
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
// The tab body itself contributes none.
      expect(container.querySelectorAll('.page-frame__body h1').length).toBe(0);
    });
  }
});
