// @vitest-environment jsdom

/**
 * #1969/#1970: the authority that opened a device owns what is shown.
 *
 * The mobile-device guide's rule — "clear private images when the selected
 * Station/authority changes" — is kept by UNMOUNTING the surface rather than
 * by clearing a state variable: the live stream and its decoded frames go
 * with the component, and nothing has to remember to clear them.
 */

import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

let scope: { apiBase: string; authorityKey: string } | undefined = {
  apiBase: 'http://station.test',
  authorityKey: 'authority-1',
};
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
  useHostRequestAuthorityScope: () => scope,
}));

import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { mobileDeviceInventoryQueryKey } from '@kontourai/station-sdk/mobile-devices-query';
import { DeviceWorkspacePane } from '../DeviceWorkspacePane';
import { devicePaneStateStorageKey } from '../devicePaneStateStorage';
import {
  ANDROID_DEVICE_ID,
  click,
  readyInventory,
  renderInQueryClient,
  stubDeviceFetch,
} from './deviceWorkspacePaneHarness';

const FIRST = { apiBase: 'http://station.test', authorityKey: 'authority-1' };
const SECOND = { apiBase: 'http://station.test', authorityKey: 'authority-2' };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setClientCredentialResolver();
  localStorage.clear();
  scope = FIRST;
});

/** Answers for whichever authority is current, so a switch keeps working. */
function authorizeCurrentScope() {
  setClientCredentialResolver(() =>
    scope
      ? {
          origin: scope.apiBase,
          requestAuthority: { ...scope, isCurrent: () => true },
        }
      : undefined,
  );
}

describe('the Device pane under a changing authority (#1969)', () => {
  /**
   * The query key carries both scope members, so one Station's device list
   * is never served from another authority's cache. Dropping either from
   * `mobileDeviceInventoryQueryKey` reds this.
   */
  test('the inventory cache is keyed by api base and authority', () => {
    expect(mobileDeviceInventoryQueryKey(FIRST)).toEqual([
      'mobile-device-inventory',
      FIRST.apiBase,
      FIRST.authorityKey,
    ]);
    expect(mobileDeviceInventoryQueryKey(FIRST)).not.toEqual(
      mobileDeviceInventoryQueryKey(SECOND),
    );
  });

  /**
   * Removing the `key` from `DeviceWorkspacePaneSurface` reds this: the
   * surface would keep its state across the change and the previous
   * authority's live device would still be on screen.
   */
  test('changing authority drops the live stage and the stored selection', async () => {
    scope = FIRST;
    stubDeviceFetch({ inventory: readyInventory() });
    authorizeCurrentScope();
    const { rerenderWrapped } = renderInQueryClient(<DeviceWorkspacePane />);

    await click(
      await screen.findByRole('button', { name: 'Open Pixel 10 Pro XL' }),
    );
    await screen.findByRole('toolbar', { name: /controls/ });
    expect(localStorage.getItem(devicePaneStateStorageKey(FIRST))).toContain(
      ANDROID_DEVICE_ID,
    );

    scope = SECOND;
    rerenderWrapped(<DeviceWorkspacePane />);

    // Wait for the NEW authority's picker before judging the stage: the key
    // change puts the query back in flight, and an absent toolbar during
    // that moment is the skeleton, not proof that anything was dropped.
    await screen.findByRole('button', { name: 'Open Pixel 10 Pro XL' });
    expect(screen.queryByRole('toolbar', { name: /controls/ })).toBeNull();
    expect(localStorage.getItem(devicePaneStateStorageKey(FIRST))).toBeNull();
  });

  /**
   * With no authority at all the pane says so and asks for nothing. Removing
   * the guard would let the SDK refuse a scoped request that no resolver can
   * settle, which is a thrown error rather than a sentence.
   */
  test('with no authority the pane says so and makes no request', async () => {
    scope = undefined;
    const log = stubDeviceFetch({ inventory: readyInventory() });
    authorizeCurrentScope();
    renderInQueryClient(<DeviceWorkspacePane />);
    expect(screen.getByRole('alert').textContent).toContain(
      'until this Station is authorized',
    );
    expect(log.inventoryReads).toBe(0);
  });
});
