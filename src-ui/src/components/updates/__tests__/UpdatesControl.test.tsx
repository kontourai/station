/** @vitest-environment jsdom */
import type { ServerUpdateState } from '@kontourai/station-contracts/system-status';
import type { CoreUpdateStatus } from '@kontourai/station-sdk';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ConnectedServerUpdateContext } from '../../../hooks/useConnectedServerUpdateContext';
import type { PlatformProfile } from '../../../platform/PlatformProfileContext';
import {
  desktopUpdateFixture,
  installFakeNativeUpdater,
} from '../../desktop-update/__tests__/fakeNativeUpdater';
import { UpdatesControl } from '../UpdatesControl';
import {
  clearUpdateNotice,
  openUpdates,
  publishUpdateNotice,
} from '../updatesEvents';

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: native.listen }));
vi.mock('../../../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => profile,
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: context.apiBase }),
}));
vi.mock('../../../platform/useBundledServerStatus', () => ({
  useBundledServerStatus: () => ({
    ownership: context.kind === 'embedded-sidecar' ? 'sidecar' : 'service',
    apiBase: context.apiBase,
  }),
}));
vi.mock(
  '../../../hooks/useConnectedServerUpdateContext',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../../../hooks/useConnectedServerUpdateContext')
    >()),
    useConnectedServerUpdateContext: () => context,
  }),
);

const profile: PlatformProfile = {
  isDesktop: true,
  isMobile: false,
  isTauri: true,
  target: 'macos',
  supervisesBundledServer: true,
  isDevBuild: false,
  channel: 'beta',
};
const identity = {
  instanceId: 'updates-test',
  bootId: '11111111-1111-4111-8111-111111111111',
  sha: 'a'.repeat(40),
};
const context: ConnectedServerUpdateContext = {
  apiBase: 'http://127.0.0.1:4311',
  scopeKey: 'updates-test',
  connectionName: 'Test Station',
  kind: 'installed-local-service',
  reachability: 'connected',
  identity,
  identityReady: true,
  identitySettled: true,
  nativeObservationPending: false,
  claimedOwnerUnresolved: false,
  isCurrent: () => true,
};
const status: CoreUpdateStatus = {
  installKind: 'archive-service',
  applyMethod: 'service-update',
  currentVersion: '0.8.0-preview.1',
  latestVersion: '0.8.0-preview.2',
  channel: 'beta',
  releaseCheck: 'verified',
  updateAvailable: true,
  serverIdentity: { ...identity, shaSource: 'build-stamp' },
  stagedUpdates: true,
};
const serverState: ServerUpdateState = {
  supported: true,
  currentVersion: '0.8.0-preview.1',
  availability: null,
  progress: { state: 'idle' },
  downloadPolicy: 'never',
  autoDownloadAt: null,
  applyWhenIdle: null,
};
const serverAction = vi.fn();
const refetch = vi.fn();
const reset = vi.fn();
const serviceProgress: {
  data: ServerUpdateState['progress'] | undefined;
  isError: boolean;
} = { data: undefined, isError: false };
let following = false;
vi.mock('@kontourai/station-sdk', () => ({
  useCoreUpdateStatusQuery: () => ({
    data: status,
    isFetching: false,
    error: null,
    refetch,
    dataUpdatedAt: 1,
  }),
  useServerUpdateStateQuery: () => ({ data: serverState, refetch }),
  useServiceUpdateProgressQuery: (
    _apiBase: string,
    options: { enabled: boolean },
  ) => {
    following = options.enabled;
    return serviceProgress;
  },
  useServerUpdateActionMutation: () => ({
    mutate: serverAction,
    isPending: false,
    error: null,
  }),
  useApplyCoreUpdateMutation: () => ({
    mutate: vi.fn(),
    reset,
    isPending: false,
    error: null,
  }),
  useOrchestrationSessionsQuery: () => ({
    data: [],
    isError: false,
    isFetching: false,
    refetch,
  }),
  useServerUpdateRunningTurnsQuery: () => ({
    data: { turns: [], hiddenCount: 0 },
    isPending: false,
    isError: false,
    isSuccess: true,
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  profile.isDesktop = true;
  profile.isMobile = false;
  context.kind = 'installed-local-service';
  serverState.progress = { state: 'idle' };
  serviceProgress.data = undefined;
  following = false;
  serverAction.mockImplementation((_request, options) =>
    options?.onSuccess?.({ requestId: 'update-request' }),
  );
});
afterEach(() => {
  act(() => clearUpdateNotice('mobile-release'));
});

test('one panel offers independently labelled app and server downloads, and opening it starts neither', async () => {
  const fake = installFakeNativeUpdater(
    native,
    desktopUpdateFixture('available'),
  );
  render(<UpdatesControl onNavigate={vi.fn()} />);
  fireEvent.click(
    await screen.findByRole('button', {
      name: 'Updates: App update available',
    }),
  );
  await screen.findByRole('heading', { name: 'Desktop app' });
  const panel = screen.getByRole('dialog', { name: 'Updates' });
  expect(fake.commands()).toEqual([]);
  expect(serverAction).not.toHaveBeenCalled();
  expect(
    within(panel).getByRole('heading', { name: 'Desktop app' }),
  ).toBeTruthy();
  expect(
    within(panel).getByRole('heading', { name: 'Connected server' }),
  ).toBeTruthy();
  expect(within(panel).queryByLabelText('Automatic download')).toBeNull();
  fireEvent.click(
    within(panel).getByRole('button', { name: 'Download 0.8.0-preview.2' }),
  );
  expect(serverAction.mock.calls[0]?.[0]).toEqual({ action: 'stage' });
  expect(fake.commands()).toEqual([]);
  fireEvent.click(
    await within(panel).findByRole('button', { name: 'Download update' }),
  );
  await waitFor(() =>
    expect(fake.commands()).toEqual(['desktop_update_download']),
  );
  act(() => fake.emit(desktopUpdateFixture('downloading')));
  expect(
    await screen.findByRole('progressbar', {
      name: 'Downloading Station 0.1.12',
    }),
  ).toBeTruthy();
  act(() => fake.emit(desktopUpdateFixture('ready')));
  expect(
    await screen.findByRole('button', { name: 'Restart to update…' }),
  ).toBeTruthy();
  expect(fake.commands()).toEqual(['desktop_update_download']);
});

test('the built-in server has one app update path and retains source installation details', async () => {
  context.kind = 'embedded-sidecar';
  installFakeNativeUpdater(native, desktopUpdateFixture('available'));
  render(<UpdatesControl collapsed onNavigate={vi.fn()} />);
  act(() => openUpdates('server'));
  await screen.findByText('Built-in server — updated with this desktop app.');
  const panel = screen.getByRole('dialog', { name: 'Updates' });
  expect(
    within(panel).getByText('Built-in server — updated with this desktop app.'),
  ).toBeTruthy();
  expect(
    await within(panel).findByText(/including the built-in server/),
  ).toBeTruthy();
  expect(
    within(panel).queryByRole('button', { name: /Download 0.8/ }),
  ).toBeNull();
  expect(within(panel).getByText('Source installation details')).toBeTruthy();
});

test.each([false, true])(
  'the collapsed browser/mobile control opens server updates without native updater access (mobile=%s)',
  async (isMobile) => {
    profile.isDesktop = false;
    profile.isMobile = isMobile;
    render(<UpdatesControl collapsed onNavigate={vi.fn()} />);
    act(() =>
      publishUpdateNotice({
        id: 'mobile-release',
        target: 'desktop',
        message: 'Station 0.9.0 is available.',
        detail: 'Install from the release page.',
        href: 'https://example.test/releases/0.9.0',
        actionLabel: 'View app release',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Updates/ }));
    await screen.findByRole('button', { name: 'Check for server updates' });
    const panel = screen.getByRole('dialog', { name: 'Updates' });
    expect(
      within(panel).getByRole('button', { name: 'Check for server updates' }),
    ).toBeTruthy();
    expect(
      within(panel).queryByRole('button', {
        name: 'Check for desktop app updates',
      }),
    ).toBeNull();
    expect(
      within(panel)
        .getByRole('link', { name: 'View app release' })
        .getAttribute('href'),
    ).toBe('https://example.test/releases/0.9.0');
    expect(native.invoke).not.toHaveBeenCalled();
    expect(native.listen).not.toHaveBeenCalled();
  },
);

test('a consumed open request does not reopen Updates after the sidebar remounts', async () => {
  profile.isDesktop = false;
  const first = render(<UpdatesControl onNavigate={vi.fn()} />);
  act(() => openUpdates('server'));
  await screen.findByRole('button', { name: 'Check for server updates' });
  fireEvent.click(screen.getByRole('button', { name: 'Close Updates' }));
  first.unmount();
  render(<UpdatesControl onNavigate={vi.fn()} />);
  expect(screen.queryByRole('dialog', { name: 'Updates' })).toBeNull();
});

test('closing Updates retains the server request follower and rechecks its outcome while hidden', async () => {
  profile.isDesktop = false;
  serverState.progress = {
    state: 'staged',
    requestId: 'download-request',
    version: '0.8.0-preview.2',
    stagedAt: '2026-10-22T20:00:00Z',
  };
  render(<UpdatesControl onNavigate={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Updates' }));
  await screen.findByRole('button', {
    name: 'Restart server to update to 0.8.0-preview.2',
  });
  fireEvent.click(
    screen.getByRole('button', {
      name: 'Restart server to update to 0.8.0-preview.2',
    }),
  );
  expect(serverAction).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Restart now' }));
  expect(serverAction.mock.calls[0]?.[0]).toEqual({
    action: 'apply',
    version: '0.8.0-preview.2',
  });
  expect(following).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Close Updates' }));
  expect(screen.queryByRole('dialog', { name: 'Updates' })).toBeNull();
  refetch.mockClear();
  serviceProgress.data = {
    state: 'committed',
    requestId: 'update-request',
    fromVersion: '0.8.0-preview.1',
    targetVersion: '0.8.0-preview.2',
    finishedAt: '2026-10-22T20:05:00Z',
  };
  act(() =>
    publishUpdateNotice({
      id: 'mobile-release',
      target: 'server',
      message: 'Server update outcome available.',
    }),
  );
  await waitFor(() => expect(refetch).toHaveBeenCalled());
  expect(following).toBe(false);
});

test('native events that arrive before the pulled snapshot keep their newer progress', async () => {
  let releasePull!: () => void;
  const fake = installFakeNativeUpdater(native, desktopUpdateFixture('idle'));
  const answer = native.invoke.getMockImplementation()!;
  native.invoke.mockImplementation(async (command: string) => {
    if (command !== 'desktop_update_state') return answer(command);
    const stale = desktopUpdateFixture('idle');
    await new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    return stale;
  });
  render(<UpdatesControl onNavigate={vi.fn()} />);
  await waitFor(() => expect(fake.listenerCount()).toBe(1));
  await waitFor(() => expect(releasePull).toBeTypeOf('function'));
  act(() => fake.emit(desktopUpdateFixture('ready')));
  await act(async () => releasePull());
  expect(
    screen.getByRole('button', { name: 'Updates: App ready to restart' }),
  ).toBeTruthy();
  act(() =>
    fake.emitAsIs({ ...desktopUpdateFixture('downloading'), sequence: 1 }),
  );
  expect(
    screen.getByRole('button', { name: 'Updates: App ready to restart' }),
  ).toBeTruthy();
});
