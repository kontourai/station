// @vitest-environment jsdom

/**
 * #1970: the Device pane's picker — grouped by platform, running first,
 * Open or Start per row, platform hints for an empty group, and the setup
 * slot the toolchain lane's wizard mounts into.
 */

import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const activeProject: { slug: string | null } = vi.hoisted(() => ({
  slug: null,
}));
vi.mock('../../hooks/useActiveProject', () => ({
  useActiveProject: () => ({
    projectSlug: activeProject.slug,
    projectName: null,
    workingDirectory: null,
  }),
}));

vi.mock('../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'authority-1',
  }),
}));

import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { DeviceWorkspacePane } from '../DeviceWorkspacePane';
import {
  ANDROID_DEVICE,
  authorizeScope,
  click,
  IOS_DEVICE,
  partialInventory,
  readyInventory,
  renderInQueryClient,
  STOPPED_AVD,
  stubDeviceFetch,
  unavailableInventory,
} from './deviceWorkspacePaneHarness';

beforeEach(() => authorizeScope());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setClientCredentialResolver();
  localStorage.clear();
});

function group(name: RegExp) {
  return screen.getByRole('region', { name });
}

describe('the device picker (#1970)', () => {
  test('groups devices under iOS Simulators and Android Emulators, running first', async () => {
    // The stopped AVD is listed FIRST by this (older-host) fixture; the
    // picker still puts the running emulator above it.
    stubDeviceFetch({
      inventory: readyInventory([STOPPED_AVD, IOS_DEVICE, ANDROID_DEVICE]),
    });
    renderInQueryClient(<DeviceWorkspacePane />);
    await screen.findByRole('heading', { name: 'iOS Simulators' });
    const android = group(/Android Emulators/);
    const rows = within(android).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Pixel 10 Pro XL'),
      expect.stringContaining('station-test'),
    ]);
    expect(rows[0]!.textContent).toContain('Running');
    expect(rows[1]!.textContent).toContain('Stopped');
    expect(
      within(group(/iOS Simulators/)).getByText(/iOS · iOS 26\.5 · Running/),
    ).toBeTruthy();
  });

  test('a running device offers Open and a stopped one offers Start', async () => {
    stubDeviceFetch({ inventory: readyInventory([IOS_DEVICE, STOPPED_AVD]) });
    renderInQueryClient(<DeviceWorkspacePane />);
    expect(
      await screen.findByRole('button', { name: 'Open iPhone 17 Pro' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Start station-test' }),
    ).toBeTruthy();
  });

  test('an empty platform gets its own hint, not a blank group', async () => {
    stubDeviceFetch({ inventory: readyInventory([IOS_DEVICE]) });
    renderInQueryClient(<DeviceWorkspacePane />);
    await screen.findByRole('heading', { name: 'Android Emulators' });
    const android = within(group(/Android Emulators/));
    expect(android.getByText('No Android emulators found.')).toBeTruthy();
    expect(android.getByText(/Create an emulator \(an AVD\)/)).toBeTruthy();
    expect(screen.queryByText(/No iOS simulators found/)).toBeNull();
  });

  test('no devices at all: both platform hints', async () => {
    stubDeviceFetch({ inventory: readyInventory([]) });
    renderInQueryClient(<DeviceWorkspacePane />);
    expect(await screen.findByText(/No iOS simulators found/)).toBeTruthy();
    expect(screen.getByText(/Install Xcode/)).toBeTruthy();
    expect(screen.getByText(/No Android emulators found/)).toBeTruthy();
  });

  test('Refresh devices re-reads the list', async () => {
    const log = stubDeviceFetch({ inventory: readyInventory() });
    renderInQueryClient(<DeviceWorkspacePane />);
    const refresh = await screen.findByRole('button', {
      name: 'Refresh devices',
    });
    const before = log.inventoryReads;
    await click(refresh);
    await waitFor(() => expect(log.inventoryReads).toBe(before + 1));
  });

  test('a partial list says discovery was incomplete', async () => {
    stubDeviceFetch({ inventory: partialInventory() });
    renderInQueryClient(<DeviceWorkspacePane />);
    expect(await screen.findByText(/may be incomplete/)).toBeTruthy();
  });

  test('an unconfigured host renders the setup slot, with no retry', async () => {
    stubDeviceFetch({ inventory: unavailableInventory('not-configured') });
    const { container } = renderInQueryClient(<DeviceWorkspacePane />);
    expect(await screen.findByText(/Set up device inspection/)).toBeTruthy();
    expect(
      container.querySelector('[data-slot="device-setup"]'),
    ).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Refresh/ })).toBeNull();
  });

  test('an unanswering helper is an error with Refresh devices', async () => {
    stubDeviceFetch({ inventory: unavailableInventory('hub-unavailable') });
    renderInQueryClient(<DeviceWorkspacePane />);
    expect(await screen.findByText(/did not answer/)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Refresh devices' }),
    ).toBeTruthy();
  });

  test('a refused read renders an error, not an empty', async () => {
    stubDeviceFetch({ inventoryStatus: 503 });
    renderInQueryClient(<DeviceWorkspacePane />);
    await waitFor(() =>
      expect(screen.getByText(/device list could not be read/)).toBeTruthy(),
    );
    expect(
      screen.queryByRole('heading', { name: 'iOS Simulators' }),
    ).toBeNull();
  });
});
