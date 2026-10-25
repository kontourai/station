// @vitest-environment jsdom
import type { DeviceAgentReveal } from '@kontourai/station-contracts/mobile-device';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

const scope = vi.hoisted(() => ({
  apiBase: 'http://station.test',
  authorityKey: 'authority-1',
  isCurrent: (): boolean => true,
}));
vi.mock('../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => scope,
}));
vi.mock('../../hooks/useActiveProject', () => ({
  useActiveProject: () => ({
    projectSlug: 'alpha',
    projectName: 'Alpha',
    workingDirectory: null,
  }),
}));

import { KeyboardShortcutsProvider } from '../../contexts/KeyboardShortcutsContext';
import {
  NavigationProvider,
  useNavigation,
} from '../../contexts/NavigationContext';
import {
  RegionModelProvider,
  useRegionModel,
} from '../../contexts/RegionModelContext';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import {
  ANDROID_DEVICE,
  authorizeScope,
  readyInventory,
  renderInQueryClient,
  sessionFor,
  stubDeviceFetch,
} from '../../workspace-panes/__tests__/deviceWorkspacePaneHarness';
import { DeviceWorkspacePane } from '../../workspace-panes/DeviceWorkspacePane';
import { readDevicePaneState } from '../../workspace-panes/devicePaneStateStorage';
import { AgentDeviceReveal } from '../AgentDeviceReveal';

let model: ReturnType<typeof useRegionModel> | undefined;
function Workspace() {
  const regions = useRegionModel();
  const navigation = useNavigation();
  useEffect(() => {
    navigation.setProject('alpha');
  }, [navigation.setProject]);
  model = regions;
  return (
    <>
      <AgentDeviceReveal projectSlug="alpha" conversationId="conversation" />
      {regions.regions.right.panes.includes('device') ? (
        <DeviceWorkspacePane />
      ) : null}
    </>
  );
}

afterEach(() => {
  cleanup();
  scope.isCurrent = () => true;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setClientCredentialResolver();
  localStorage.clear();
});

test('an Agent request survives initial polling failure, opens the real pane once, and respects dismissal and stale authority', async () => {
  localStorage.clear();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  deviceSettingsStore.reloadFromStorage();
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 1280,
  });
  authorizeScope();
  const session = sessionFor(ANDROID_DEVICE);
  const log = stubDeviceFetch({
    inventory: readyInventory([ANDROID_DEVICE]),
    sessions: [session],
  });
  const deviceFetch = globalThis.fetch;
  let reveals: DeviceAgentReveal[] = [
    { intentId: '11111111-2222-4333-8444-555555555555', session },
  ];
  let unavailable = true;
  vi.stubGlobal(
    'fetch',
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).includes('/agent-reveals?'))
        return unavailable
          ? Response.json({ success: false }, { status: 503 })
          : Response.json({ success: true, data: { reveals } });
      return deviceFetch(input, init);
    },
  );
  const { client } = renderInQueryClient(
    <KeyboardShortcutsProvider>
      <NavigationProvider>
        <RegionModelProvider>
          <Workspace />
        </RegionModelProvider>
      </NavigationProvider>
    </KeyboardShortcutsProvider>,
  );
  const key = [
    'device-agent-reveals',
    scope.apiBase,
    scope.authorityKey,
    'alpha',
    'conversation',
  ];
  await waitFor(() => expect(client.getQueryState(key)?.status).toBe('error'));
  expect(model?.regions.right.panes).not.toContain('device');
  unavailable = false;
  await act(async () => {
    await client.invalidateQueries({ queryKey: key });
  });
  await screen.findByText('Step 2 of 2: connect video');
  await waitFor(() => expect(log.streams).toHaveLength(1));
  expect(log.streams[0]!.url).toContain(encodeURIComponent(session.surfaceId));
  expect(readDevicePaneState(localStorage, scope)).toMatchObject({
    hostId: ANDROID_DEVICE.hostId,
    platform: ANDROID_DEVICE.platform,
    deviceId: ANDROID_DEVICE.deviceId,
  });
  expect(
    model?.regions.right.panes.filter((id) => id === 'device'),
  ).toHaveLength(1);
  const writes = log.requests.filter((request) => request.method === 'POST');
  expect(writes).toEqual([]);
  await act(async () => {
    await client.invalidateQueries({ queryKey: key });
  });
  expect(log.streams).toHaveLength(1);
  act(() => {
    model?.removePane('right', 'device');
  });
  expect(model?.regions.right.panes).not.toContain('device');
  await act(async () => {
    await client.invalidateQueries({ queryKey: key });
  });
  expect(model?.regions.right.panes).not.toContain('device');
  scope.isCurrent = () => false;
  reveals = [{ intentId: '22222222-2222-4333-8444-555555555555', session }];
  await act(async () => {
    client.setQueryData(key, reveals);
  });
  expect(model?.regions.right.panes).not.toContain('device');
  scope.isCurrent = () => true;
});
