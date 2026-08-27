// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

let integrations: unknown[] = [];
let integrationsError: Error | null = null;
const refetchIntegrations = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
  useIntegrationsQuery: () => ({
    data: integrations,
    isLoading: false,
    error: integrationsError,
    refetch: refetchIntegrations,
  }),
  useIntegrationQuery: () => ({ data: undefined }),
  useSaveIntegrationMutation: () => ({ mutate: vi.fn(), reset: vi.fn() }),
  useDeleteIntegrationMutation: () => ({ mutate: vi.fn() }),
  useReconnectIntegrationMutation: () => ({ mutate: vi.fn() }),
  useSetIntegrationRenderPermissionMutation: () => ({ mutate: vi.fn() }),
  useSetIntegrationEnabledMutation: () => ({ mutate: vi.fn() }),
  useApplyIntegrationToolsMutation: () => ({ mutate: vi.fn() }),
}));

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    pathname: '/connections/tools',
    navigate: vi.fn(),
  }),
}));

vi.mock('../components/LazyBoundary', () => ({
  LazyBoundary: () => null,
}));

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
 * station#771 regression. `IntegrationsView`'s `SplitPaneLayout` only wired
 * `loading={isLoading}`, not `error`/`onRetry` — a settled read failure
 * rendered the same "No tool servers yet" empty state as a host with none
 * configured, with no error and no retry.
 */
describe('IntegrationsView (#771)', () => {
  beforeEach(() => {
    integrations = [];
    integrationsError = null;
    refetchIntegrations.mockReset();
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
});
