// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let integrations: unknown[] = [];
let integrationsError: Error | null = null;
const refetchIntegrations = vi.fn();
let pathname = '/connections/tools';

vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  // The REAL save hook, so a refusal travels the real integrations fetcher
  // (#2708); every other hook is a stub.
  useSaveIntegrationMutation: (
    await importOriginal<typeof import('@kontourai/station-sdk')>()
  ).useSaveIntegrationMutation,
  useIntegrationsQuery: () => ({
    data: integrations,
    isLoading: false,
    error: integrationsError,
    refetch: refetchIntegrations,
  }),
  useIntegrationQuery: () => ({ data: undefined }),
  useDeleteIntegrationMutation: () => ({ mutate: vi.fn() }),
  useReconnectIntegrationMutation: () => ({ mutate: vi.fn() }),
  useSetIntegrationRenderPermissionMutation: () => ({ mutate: vi.fn() }),
  useSetIntegrationEnabledMutation: () => ({ mutate: vi.fn() }),
  useApplyIntegrationToolsMutation: () => ({ mutate: vi.fn() }),
}));

vi.mock('../contexts/NavigationContext', () => {
  // NavigationContext publishes two read hooks: `useNavigation` (subscribes to
  // the store, optionally through a selector) and `useNavigationActions` (the
  // memoized actions, no subscription). This mock answers both from one value.
  const navigation = () => ({
    pathname,
    navigate: vi.fn(),
  });
  return {
    useNavigation: (
      selector?: (state: ReturnType<typeof navigation>) => unknown,
    ) => (selector ? selector(navigation()) : navigation()),
    useNavigationActions: navigation,
  };
});

// The rendered sentence is the same whether the fetcher threw the SDK's
// StationHttpError or a plain Error carrying the reasons (A-0 made the two
// agree on purpose), so the copy alone cannot tell a reverted fetcher from a
// migrated one. What the view hands its curation helper can: the real helper
// still runs, and the test reads the error it was given.
vi.mock('../utils/errorText', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/errorText')>();
  return {
    ...actual,
    userFacingErrorMessage: vi.fn(actual.userFacingErrorMessage),
  };
});

vi.mock('../components/LazyBoundary', () => ({
  LazyBoundary: () => (
    <section aria-label="Advanced: Secret bindings">Secret bindings</section>
  ),
}));

import { userFacingErrorMessage } from '../utils/errorText';
import { IntegrationsView } from '../views/IntegrationsView';

function renderView() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <IntegrationsView />
    </QueryClientProvider>,
  );
}

/**
 * archive#771 regression. `IntegrationsView`'s `SplitPaneLayout` only wired
 * `loading={isLoading}`, not `error`/`onRetry` — a settled read failure
 * rendered the same "No tool servers yet" empty state as a host with none
 * configured, with no error and no retry.
 */
describe('IntegrationsView (#771)', () => {
  beforeEach(() => {
    integrations = [];
    integrationsError = null;
    pathname = '/connections/tools';
    refetchIntegrations.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // #2708: the save hook's fetcher throws the SDK's StationHttpError with the
  // validation `details`, and the view shows the server's reason from them —
  // not "Validation failed" and not the schema key.
  test('a refused save shows the server reason, not the field key', async () => {
    const { _setApiBase } = await vi.importActual<
      typeof import('@kontourai/station-sdk')
    >('@kontourai/station-sdk');
    _setApiBase('http://localhost');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          error: 'Validation failed',
          details: {
            formErrors: [],
            fieldErrors: {
              command: ['Command is required for stdio integrations'],
            },
          },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    pathname = '/connections/tools/new';

    renderView();
    fireEvent.change(screen.getByPlaceholderText('my-tool-server'), {
      target: { value: 'my-tool-server' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(
        screen.getByText('Command is required for stdio integrations'),
      ).toBeTruthy(),
    );
    expect(screen.queryByText(/Validation failed/)).toBeNull();
    // #2708 A-1a review gap I8: the view got the fetcher's typed refusal, with
    // its status and details, not a plain Error with the words only.
    const { StationHttpError } = await vi.importActual<
      typeof import('@kontourai/station-sdk/client')
    >('@kontourai/station-sdk/client');
    const received = vi
      .mocked(userFacingErrorMessage)
      .mock.calls.map(([error]) => error);
    expect(received).toContainEqual(expect.any(StationHttpError));
    expect(
      received.find((error) => error instanceof StationHttpError),
    ).toMatchObject({
      status: 400,
      details: {
        fieldErrors: {
          command: ['Command is required for stdio integrations'],
        },
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost/integrations',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('renders the list error state with retry when the integrations query fails', () => {
    integrationsError = new Error('tool servers unavailable');

    renderView();

    expect(screen.getByText('tool servers unavailable')).toBeTruthy();
    expect(screen.queryByText('No tool servers yet')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetchIntegrations).toHaveBeenCalledTimes(1);
  });

  test('still shows the genuine empty state when nothing errored', () => {
    renderView();

    expect(screen.getByText('No tool servers yet')).toBeTruthy();
  });

  test('renders the tool list before advanced secret bindings and uses user-facing unchecked copy', () => {
    integrations = [
      {
        id: 'station-control',
        kind: 'mcp',
        displayName: 'Station Control',
        description: '',
        enabled: true,
      },
    ];

    renderView();

    const tool = screen.getByRole('button', { name: /Station Control/i });
    const bindings = screen.getByRole('region', {
      name: 'Advanced: Secret bindings',
    });
    expect(
      tool.compareDocumentPosition(bindings) & Node.DOCUMENT_POSITION_FOLLOWING,
      'expected the tools list to render before advanced secret bindings',
    ).toBeTruthy();
    expect(screen.getByText('Not checked yet')).toBeTruthy();
    expect(screen.queryByText('Never probed')).toBeNull();
  });
});
