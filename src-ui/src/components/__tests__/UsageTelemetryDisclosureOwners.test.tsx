/**
 * #481 recovery composition — protected-tree owners of the shared
 * usage-telemetry disclosure.
 *
 * `UsageTelemetryDisclosure` (Settings section) and
 * `UsageTelemetryDisclosureStep` (first-run chapter) render INSIDE the
 * protected authority tree, where there is NO `RecoveryQueryBoundary`
 * above them (the boundary is a sibling of `AuthorityQueryProvider` in
 * `main.tsx`, wrapping only the connection-recovery gate). These tests
 * therefore render with NO recovery wrapper on purpose: wrapping them
 * would supply a scope the production tree never provides and hide the
 * real regression (the decision hook throwing outside the boundary).
 *
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

const { authenticatedFetch, updateConfig, appConfig } = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
  updateConfig: vi.fn(),
  appConfig: {
    current: undefined as { telemetryEnabled?: boolean } | undefined,
  },
}));

vi.mock('@kontourai/station-sdk', () => ({
  authenticatedFetch,
  useConfigQuery: () => ({ data: appConfig.current }),
  useUpdateConfigMutation: () => ({
    isPending: false,
    mutate: (
      variables: Record<string, unknown>,
      handlers?: {
        onSuccess?: (result: {
          ignoredKeys?: { key: string; reason: string }[];
        }) => void;
        onError?: (error: unknown) => void;
      },
    ) => updateConfig(variables, handlers),
  }),
}));
vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));

// Deliberately NO mock for '../../contexts/RecoveryQueryBoundary': the
// protected tree has no such provider, and the hook must degrade to the
// protected client/context path instead of throwing.

import {
  UsageTelemetryDisclosure,
  UsageTelemetryDisclosureStep,
  resetUsageTelemetryDisclosureDismissal,
} from '../UsageTelemetryDisclosure';

const DISCLOSURE_BODY = {
  acknowledged: false,
  inventoryRevision: 'rev-owners',
  endpointConfigured: false,
  telemetryEnabled: false,
  enabledSource: 'config',
  events: {
    station_started: {
      description: 'Station completed startup.',
      properties: { platform: { domain: ['linux'] } },
    },
  },
};

function disclosureResponse(body: unknown): Response {
  return new Response(JSON.stringify({ data: body }), { status: 200 });
}

beforeEach(() => {
  resetUsageTelemetryDisclosureDismissal();
  appConfig.current = { telemetryEnabled: false };
  authenticatedFetch.mockReset();
  updateConfig.mockReset();
  authenticatedFetch.mockResolvedValue(disclosureResponse(DISCLOSURE_BODY));
});

function renderSettingsSection() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <UsageTelemetryDisclosure />
    </QueryClientProvider>,
  );
}

test('OWNERS REGRESSION: Settings disclosure renders outside any recovery boundary', async () => {
  const { unmount } = renderSettingsSection();
  await waitFor(() =>
    expect(
      screen.getByText('Keep usage telemetry off').textContent,
    ).toBe('Keep usage telemetry off'),
  );
  expect(screen.getByText('What Station sends')).not.toBeNull();
  unmount();
});

test('OWNERS REGRESSION: first-run disclosure step renders outside any recovery boundary', async () => {
  const advance = vi.fn();
  const { unmount } = render(
    <QueryClientProvider client={new QueryClient()}>
      <UsageTelemetryDisclosureStep onAdvance={advance} />
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(
      screen.getByText('Keep usage telemetry off').textContent,
    ).toBe('Keep usage telemetry off'),
  );
  expect(screen.getByTestId('first-run-disclosure')).not.toBeNull();
  unmount();
});

test('OWNERS CONTRACT: protected decision writes through the existing Settings config path', async () => {
  updateConfig.mockImplementation(
    (
      _variables: Record<string, unknown>,
      handlers?: { onSuccess?: (result: object) => void },
    ) => {
      handlers?.onSuccess?.({ data: {}, ignoredKeys: [] });
    },
  );
  // The receipt write lands after the setting write succeeds.
  authenticatedFetch.mockResolvedValueOnce(
    disclosureResponse(DISCLOSURE_BODY),
  );
  authenticatedFetch.mockResolvedValue(
    disclosureResponse({ ...DISCLOSURE_BODY, acknowledged: true }),
  );
  const { unmount } = renderSettingsSection();
  await waitFor(() =>
    expect(screen.getByText('Turn it on')).not.toBeNull(),
  );
  fireEvent.click(screen.getByText('Turn it on'));
  await waitFor(() =>
    expect(updateConfig).toHaveBeenCalledWith(
      { telemetryEnabled: true },
      expect.anything(),
    ),
  );
  unmount();
});
