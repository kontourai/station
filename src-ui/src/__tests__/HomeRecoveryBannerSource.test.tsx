// @vitest-environment jsdom
import type { HomeRecoveryDisclosure } from '@kontourai/station-contracts/system-status';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { HomeRecoveryBannerSource } from '../components/notifications/HomeRecoveryBannerSource';
import {
  StationDetailsHost,
  WorkspaceStationState,
} from '../components/notifications/StationConditions';
import { bannerStore } from '../contexts/banner-store';

const state = vi.hoisted(() => ({
  apiBase: 'https://source.example.test',
  fetched: true,
  recovery: undefined as HomeRecoveryDisclosure | undefined,
}));
vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({ apiBase: state.apiBase }),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useSystemStatusForApiBaseQuery: () => ({
    isFetchedAfterMount: state.fetched,
    isError: false,
    data: { homeRecovery: state.recovery },
  }),
}));
afterEach(() => {
  cleanup();
  act(() => bannerStore.reset());
  state.apiBase = 'https://source.example.test';
  state.fetched = true;
  state.recovery = undefined;
});
const view = () => (
  <>
    <HomeRecoveryBannerSource />
    <WorkspaceStationState />
    <StationDetailsHost />
  </>
);
const recovered: HomeRecoveryDisclosure = {
  kind: 'recovered-from-copy',
  recoveryId: 'copy-1',
  snapshotCreatedAt: '2026-09-05T00:00:00.000Z',
  authorityTransferred: false,
};

test('shows the recovered snapshot in the workspace and retains authority disclosure in Station details', () => {
  state.recovery = recovered;
  render(view());
  const workspace = screen.getByRole('status');
  expect(workspace.textContent).toContain(
    new Date('2026-09-05T00:00:00.000Z').toLocaleString(),
  );
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(
    within(workspace).getByRole('button', { name: 'Review Station' }),
  );
  const details = screen.getByRole('dialog', { name: 'Station details' });
  expect(
    within(details).getByText(/Work after that snapshot may be missing/)
      .textContent,
  ).toContain('Restoring this copy did not transfer execution authority.');
  expect(
    within(details).queryByRole('button', { name: /dismiss/i }),
  ).toBeNull();
  fireEvent.click(
    within(details).getByRole('button', { name: 'Close Station details' }),
  );
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(workspace.textContent).toContain('Recovered from a copy saved');
  fireEvent.click(
    within(workspace).getByRole('button', { name: 'Review Station' }),
  );
  expect(
    within(screen.getByRole('dialog')).getByText(
      /did not transfer execution authority/,
    ),
  ).toBeTruthy();
});

test('withdraws prior-host recovery on selection change and explains unavailable evidence without claiming ownership', () => {
  state.recovery = recovered;
  const mounted = render(view());
  fireEvent.click(screen.getByRole('button', { name: 'Review Station' }));
  state.apiBase = 'https://other.example.test';
  state.fetched = false;
  mounted.rerender(view());
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByText(/Recovered from a copy saved/)).toBeNull();
  state.fetched = true;
  state.recovery = { kind: 'unavailable' };
  mounted.rerender(view());
  expect(screen.getByRole('status').textContent).toMatch(
    /recovery record could not be verified/,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Review Station' }));
  expect(
    within(screen.getByRole('dialog')).getByText(
      /does not establish execution ownership/,
    ),
  ).toBeTruthy();
  state.recovery = { kind: 'not-restored' };
  mounted.rerender(view());
  expect(
    screen.queryByText(/recovery record could not be verified/),
  ).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
});
