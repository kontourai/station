// @vitest-environment jsdom
import type { HomeRecoveryDisclosure } from '@kontourai/station-contracts/system-status';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { BannerHost } from '../components/notifications/BannerHost';
import { HomeRecoveryBannerSource } from '../components/notifications/HomeRecoveryBannerSource';
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
  useSystemStatusForApiBaseQuery: (apiBase: string) => {
    expect(apiBase).toBe(state.apiBase);
    return {
      isFetchedAfterMount: state.fetched,
      isError: false,
      data: { homeRecovery: state.recovery },
    };
  },
}));
afterEach(() => {
  cleanup();
  act(() => bannerStore.reset());
  state.fetched = true;
  state.recovery = undefined;
});
const view = () => (
  <>
    <HomeRecoveryBannerSource />
    <BannerHost />
  </>
);

test('shows recovered-copy disclosure with snapshot time and no dismiss-as-normal action', () => {
  state.recovery = {
    kind: 'recovered-from-copy',
    recoveryId: 'copy-1',
    snapshotCreatedAt: '2026-09-05T00:00:00.000Z',
    authorityTransferred: false,
  };
  render(view());
  expect(screen.getByText(/Recovered from a copy saved/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Details' }));
  expect(
    screen.getByText(/Work after that snapshot may be missing/),
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull();
});

test('removes prior-host recovery on connection change and names unavailable evidence', () => {
  state.recovery = {
    kind: 'recovered-from-copy',
    recoveryId: 'copy-1',
    snapshotCreatedAt: '2026-09-05T00:00:00.000Z',
    authorityTransferred: false,
  };
  const mounted = render(view());
  expect(screen.getByText(/Recovered from a copy saved/)).toBeTruthy();
  state.apiBase = 'https://other.example.test';
  state.fetched = false;
  mounted.rerender(view());
  expect(screen.queryByText(/Recovered from a copy saved/)).toBeNull();
  state.fetched = true;
  state.recovery = { kind: 'unavailable' };
  mounted.rerender(view());
  expect(
    screen.getByText(/recovery record could not be verified/),
  ).toBeTruthy();
  state.recovery = { kind: 'not-restored' };
  mounted.rerender(view());
  expect(
    screen.queryByText(/recovery record could not be verified/),
  ).toBeNull();
});
