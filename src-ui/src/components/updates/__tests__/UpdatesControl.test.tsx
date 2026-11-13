/** @vitest-environment jsdom */
import type { ServerUpdateState } from '@kontourai/station-contracts/system-status';
import type { CoreUpdateStatus } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render as renderUi,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ConnectedServerUpdateContext } from '../../../hooks/useConnectedServerUpdateContext';
import { deviceSettingsStore } from '../../../lib/device-settings-store';
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

const clients: QueryClient[] = [];
function render(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  clients.push(client);
  return renderUi(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock('../../../build-info', async (importActual) => ({
  ...(await importActual<typeof import('../../../build-info')>()),
  readClientReleaseVersion: () => '0.1.11-nightly.20261105.1',
}));
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
const coreApply = vi.fn();
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
    mutate: coreApply,
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
  localStorage.clear();
  deviceSettingsStore.reset('showReleaseNotesAfterUpdate');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 404 })),
  );
  profile.isDesktop = true;
  profile.isMobile = false;
  profile.isDevBuild = false;
  profile.channel = 'beta';
  context.kind = 'installed-local-service';
  serverState.progress = { state: 'idle' };
  status.stagedUpdates = true;
  serviceProgress.data = undefined;
  following = false;
  serverAction.mockImplementation((_request, options) =>
    options?.onSuccess?.({ requestId: 'update-request' }),
  );
});
afterEach(async () => {
  act(() => clearUpdateNotice('mobile-release'));
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.unstubAllGlobals();
  // Match the dialog surface suite: drain jsdom's chained traversal tasks so
  // an unmount's pending Back cannot consume the next test's history entry.
  for (let turn = 0; turn < 4; turn += 1) {
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  }
});

async function closeUpdates(
  historyBeforeOpen: unknown,
  via: 'Close Updates' | 'browser Back' = 'Close Updates',
) {
  // The lazy loading dialog can leave an entry that Back skips automatically.
  // One popstate is not necessarily the completed traversal to the base entry.
  if (via === 'browser Back') act(() => window.history.back());
  else {
    fireEvent.click(
      screen.getByRole('button', { name: 'Close Updates', hidden: true }),
    );
  }
  await waitFor(() => {
    expect(window.history.state).toEqual(historyBeforeOpen);
    expect(screen.queryByRole('dialog', { name: 'Updates' })).toBeNull();
  });
}

test('an informational server notice does not advertise an available update on the sidebar', async () => {
  installFakeNativeUpdater(native, desktopUpdateFixture('upToDate'));
  render(<UpdatesControl collapsed onNavigate={vi.fn()} />);
  act(() =>
    publishUpdateNotice({
      id: 'mobile-release',
      target: 'server',
      message: 'App and server use separate release channels.',
    }),
  );
  await waitFor(() => expect(native.invoke).toHaveBeenCalled());
  expect(screen.getByRole('button', { name: 'Updates' })).toBeTruthy();
  act(() =>
    publishUpdateNotice({
      id: 'mobile-release',
      target: 'server',
      message: 'Server update available.',
      updateAvailable: true,
    }),
  );
  expect(
    screen.getByRole('button', { name: 'Updates: Update available' }),
  ).toBeTruthy();
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
    within(panel).getByRole('heading', { name: 'Server · Test Station' }),
  ).toBeTruthy();
  expect(within(panel).queryByLabelText('Automatic download')).toBeNull();
  fireEvent.click(
    within(panel).getByRole('button', { name: 'Download server update' }),
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
    within(panel).queryByRole('button', { name: 'Download server update' }),
  ).toBeNull();
  expect(within(panel).getByText('Source installation details')).toBeTruthy();
});

test.each([false, true])(
  'the collapsed browser/mobile control opens server updates without native updater access (mobile=%s)',
  async (isMobile) => {
    profile.isDesktop = false;
    profile.isMobile = isMobile;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          tag_name: 'desktop-v0.9.0-nightly.2500',
          name: 'Station app release',
          body: '- Mobile release features',
          draft: false,
        }),
      ),
    );
    render(<UpdatesControl collapsed onNavigate={vi.fn()} />);
    act(() =>
      publishUpdateNotice({
        id: 'mobile-release',
        target: 'desktop',
        message: 'Station 0.9.0-nightly.2500 is available.',
        releaseVersion: '0.9.0-nightly.2500',
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
    expect(
      await within(panel).findByText('Mobile release features'),
    ).toBeTruthy();
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
  const historyBeforeOpen = window.history.state;
  fireEvent.click(screen.getByRole('button', { name: 'Updates' }));
  await screen.findByRole('button', {
    name: 'Restart server',
  });
  fireEvent.click(
    screen.getByRole('button', {
      name: 'Restart server',
    }),
  );
  expect(serverAction).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Restart now' }));
  expect(serverAction.mock.calls[0]?.[0]).toEqual({
    action: 'apply',
    version: '0.8.0-preview.2',
  });
  expect(following).toBe(true);
  await closeUpdates(historyBeforeOpen);
  expect(screen.queryByRole('dialog', { name: 'Updates' })).toBeNull();
  expect(following).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Updates' }));
  await screen.findByRole('dialog', { name: 'Updates' });
  expect(following).toBe(true);
  expect(screen.queryByRole('alertdialog')).toBeNull();
  await closeUpdates(historyBeforeOpen);
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

test.each(
  ['desktop', 'staged-server', 'direct-server'].flatMap((target) =>
    (['Close Updates', 'browser Back'] as const).map((close) => ({
      target,
      close,
    })),
  ),
)(
  '$close abandons an unsubmitted $target confirmation until explicitly reopened',
  async ({ target, close }) => {
    const desktop = target === 'desktop';
    profile.isDesktop = desktop;
    status.stagedUpdates = target === 'direct-server' ? undefined : true;
    if (target === 'staged-server') {
      serverState.progress = {
        state: 'staged',
        requestId: 'download-request',
        version: '0.8.0-preview.2',
        stagedAt: '2026-10-22T20:00:00Z',
      };
    }
    const fake = desktop
      ? installFakeNativeUpdater(native, desktopUpdateFixture('ready'))
      : null;
    const offer = desktop
      ? 'Restart to update…'
      : target === 'staged-server'
        ? 'Restart server'
        : 'Update server';
    const confirmationTitle = desktop
      ? 'Restart Station to install 0.1.12?'
      : target === 'staged-server'
        ? 'Restart the server into 0.8.0-preview.2?'
        : 'Update and restart the server?';
    const confirmationRole = desktop ? 'dialog' : 'alertdialog';
    const confirmLabel =
      target === 'direct-server' ? 'Update and restart' : 'Restart now';
    render(<UpdatesControl onNavigate={vi.fn()} />);
    const historyBeforeOpen = window.history.state;
    fireEvent.click(screen.getByRole('button', { name: /^Updates/ }));
    fireEvent.click(await screen.findByRole('button', { name: offer }));
    await screen.findByRole(confirmationRole, { name: confirmationTitle });

    await closeUpdates(historyBeforeOpen, close);
    expect(screen.queryByRole('dialog', { name: 'Updates' })).toBeNull();
    expect(
      screen.queryByRole(confirmationRole, { name: confirmationTitle }),
    ).toBeNull();
    expect(serverAction).not.toHaveBeenCalled();
    expect(coreApply).not.toHaveBeenCalled();
    if (fake) expect(fake.commands()).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: /^Updates/ }));
    await screen.findByRole('button', { name: offer });
    expect(
      screen.queryByRole(confirmationRole, { name: confirmationTitle }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: confirmLabel })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: offer }));
    const confirmation = await screen.findByRole(confirmationRole, {
      name: confirmationTitle,
    });
    fireEvent.click(
      within(confirmation).getByRole('button', { name: confirmLabel }),
    );
    if (fake) {
      await waitFor(() =>
        expect(fake.commands()).toEqual(['desktop_update_install']),
      );
    } else if (target === 'staged-server') {
      expect(serverAction).toHaveBeenCalledExactlyOnceWith(
        { action: 'apply', version: '0.8.0-preview.2' },
        expect.any(Object),
      );
    } else {
      expect(coreApply).toHaveBeenCalledExactlyOnceWith();
    }
    await closeUpdates(historyBeforeOpen);
  },
);

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

test.each([false, true])(
  'the sidebar progress ring follows native bytes and clears when ready (collapsed=%s)',
  async (collapsed) => {
    const downloading = desktopUpdateFixture('downloading');
    const fake = installFakeNativeUpdater(native, downloading);
    render(<UpdatesControl collapsed={collapsed} onNavigate={vi.fn()} />);
    const ring = await screen.findByRole('progressbar', {
      name: 'Downloading app update',
    });
    expect(ring.getAttribute('aria-valuenow')).toBe('42');
    expect(
      ring
        .querySelector('circle[pathLength]')
        ?.getAttribute('stroke-dashoffset'),
    ).toBe('58');
    const phase = downloading.phase;
    if (phase.status !== 'downloading') throw new Error('wrong fixture');
    act(() =>
      fake.emit({
        ...downloading,
        phase: { ...phase, totalBytes: null },
      }),
    );
    expect(ring.hasAttribute('aria-valuenow')).toBe(false);
    act(() => fake.emit(desktopUpdateFixture('ready')));
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(
      await screen.findByRole('button', {
        name: 'Updates: App ready to restart',
      }),
    ).toBeTruthy();
  },
);

test.each([false, true])(
  'an upgrade shows its installed changelog once and remembers the preference (optOut=%s)',
  async (optOut) => {
    localStorage.setItem('station.release-notes.last-version', '0.1.10');
    const current = desktopUpdateFixture('idle');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          tag_name: `v${current.currentVersion}`,
          name: 'Station release',
          body: '- New workspace features',
          draft: false,
        }),
      ),
    );
    installFakeNativeUpdater(native, current);
    const first = render(<UpdatesControl onNavigate={vi.fn()} />);
    expect(await screen.findByText('New workspace features')).toBeTruthy();
    const dialog = screen.getByRole('dialog', {
      name: `Updated to Station ${current.currentVersion}`,
    });
    const preference = within(dialog).getByRole('switch', {
      name: 'Show changelog after updates',
    });
    expect(preference.getAttribute('aria-checked')).toBe('true');
    if (optOut) fireEvent.click(preference);
    expect(deviceSettingsStore.get('showReleaseNotesAfterUpdate')).toBe(
      !optOut,
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    first.unmount();
    const second = render(<UpdatesControl onNavigate={vi.fn()} />);
    await waitFor(() =>
      expect(localStorage.getItem('station.release-notes.last-version')).toBe(
        current.currentVersion,
      ),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    second.unmount();
    const next = { ...current, currentVersion: '0.1.13' };
    installFakeNativeUpdater(native, next);
    render(<UpdatesControl onNavigate={vi.fn()} />);
    await waitFor(() =>
      expect(localStorage.getItem('station.release-notes.last-version')).toBe(
        '0.1.13',
      ),
    );
    if (optOut) expect(screen.queryByRole('dialog')).toBeNull();
    else
      expect(
        await screen.findByRole('dialog', {
          name: 'Updated to Station 0.1.13',
        }),
      ).toBeTruthy();
  },
);

test('a server download continues to drive the sidebar ring after Updates closes', async () => {
  profile.isDesktop = false;
  serverState.progress = {
    state: 'staging',
    requestId: 'server-download',
    intent: 'stage',
    stagePhase: 'downloading',
    downloadedBytes: 25_000_000,
    totalBytes: 100_000_000,
  };
  render(<UpdatesControl collapsed onNavigate={vi.fn()} />);
  const historyBeforeOpen = window.history.state;
  fireEvent.click(screen.getByRole('button', { name: 'Updates' }));
  const ring = await screen.findByRole('progressbar', {
    name: 'Downloading server update',
  });
  expect(ring.getAttribute('aria-valuenow')).toBe('25');
  await closeUpdates(historyBeforeOpen);
  expect(
    screen
      .getByRole('progressbar', { name: 'Downloading server update' })
      .getAttribute('aria-valuenow'),
  ).toBe('25');
});

test('development desktop versions never trigger the automatic upgrade dialog', async () => {
  profile.isDevBuild = true;
  localStorage.setItem('station.release-notes.last-version', '0.1.10');
  const fake = installFakeNativeUpdater(
    native,
    desktopUpdateFixture('disabled'),
  );
  render(<UpdatesControl onNavigate={vi.fn()} />);
  await waitFor(() => expect(fake.listenerCount()).toBe(1));
  await act(async () => {});
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(localStorage.getItem('station.release-notes.last-version')).toBe(
    '0.1.10',
  );
});

test('mobile keeps its installed version and channel when no app update is available', async () => {
  profile.isDesktop = false;
  profile.isMobile = true;
  profile.channel = 'nightly';
  render(<UpdatesControl onNavigate={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Updates' }));
  expect(
    await screen.findByRole('heading', { name: 'Station app · nightly' }),
  ).toBeTruthy();
  const panel = screen.getByRole('dialog', { name: 'Updates' });
  expect(within(panel).getByText('0.1.11-nightly.20261105.1')).toBeTruthy();
  expect(
    within(panel).queryByRole('button', {
      name: 'Check for desktop app updates',
    }),
  ).toBeNull();
});

test('server upgrades open the installed server changelog and another server never inherits it', async () => {
  const key = `station.release-notes.last-version.server:${context.apiBase}:${identity.instanceId}`;
  localStorage.setItem(key, '0.7.0-preview.1');
  installFakeNativeUpdater(native, desktopUpdateFixture('idle'));
  const fetcher = vi.fn(async () =>
    Response.json({
      tag_name: 'v0.8.0-preview.1',
      name: 'Server release',
      body: '- Installed server changes',
      draft: false,
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  const view = render(<UpdatesControl onNavigate={vi.fn()} />);
  expect(
    await screen.findByRole('dialog', {
      name: 'Updated server 0.8.0-preview.1',
    }),
  ).toBeTruthy();
  expect(await screen.findByText('Installed server changes')).toBeTruthy();
  expect(fetcher).toHaveBeenCalledWith(
    'https://api.github.com/repos/kontourai/station/releases/tags/v0.8.0-preview.1',
    expect.objectContaining({ credentials: 'omit' }),
  );
  const original = context.apiBase;
  context.apiBase = 'https://other.example.test';
  view.rerender(
    <QueryClientProvider client={clients[clients.length - 1]}>
      <UpdatesControl onNavigate={vi.fn()} />
    </QueryClientProvider>,
  );
  expect(
    screen.queryByRole('dialog', { name: 'Updated server 0.8.0-preview.1' }),
  ).toBeNull();
  context.apiBase = original;
});

test('Updates shows the installed server changelog alongside an offered release', async () => {
  installFakeNativeUpdater(native, desktopUpdateFixture('idle'));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const installed = url.endsWith('v0.8.0-preview.1');
      return Response.json({
        tag_name: installed ? 'v0.8.0-preview.1' : 'v0.8.0-preview.2',
        body: installed
          ? '- Installed server fixes'
          : '- Available server fixes',
        draft: false,
      });
    }),
  );
  render(<UpdatesControl onNavigate={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: /^Updates$/ }));
  expect(await screen.findByText('Installed server fixes')).toBeTruthy();
  expect(await screen.findByText('Available server fixes')).toBeTruthy();
});

test('simultaneous app and server upgrades mount one changelog dialog at a time', async () => {
  const app = desktopUpdateFixture('idle');
  installFakeNativeUpdater(native, app);
  localStorage.setItem('station.release-notes.last-version', '0.1.10');
  localStorage.setItem(
    `station.release-notes.last-version.server:${context.apiBase}:${identity.instanceId}`,
    '0.7.0-preview.1',
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const tag = decodeURIComponent(new URL(url).pathname.split('/').at(-1)!);
      return Response.json({
        tag_name: tag,
        draft: false,
        body:
          tag === 'v0.8.0-preview.1'
            ? '- Queued server changes'
            : '- App changes',
      });
    }),
  );
  render(<UpdatesControl onNavigate={vi.fn()} />);
  await screen.findByText('App changes');
  const appDialog = screen.getByRole('dialog', {
    name: `Updated to Station ${app.currentVersion}`,
  });
  expect(
    screen.queryByRole('dialog', { name: 'Updated server 0.8.0-preview.1' }),
  ).toBeNull();
  fireEvent.click(
    await within(appDialog).findByRole('button', { name: /^Done$/ }),
  );
  await screen.findByText('Queued server changes');
  const serverDialog = screen.getByRole('dialog', {
    name: 'Updated server 0.8.0-preview.1',
  });
  expect(within(serverDialog).getByText('Queued server changes')).toBeTruthy();
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
});

test.each(['version', 'origin'])(
  'browser upgrades show one popup when sharing server %s',
  async (seam) => {
    profile.isDesktop = false;
    profile.isTauri = false;
    const oldVersion = status.currentVersion,
      oldApi = context.apiBase;
    status.currentVersion =
      seam === 'version' ? '0.1.11-nightly.20261105.1' : '0.8.0-preview.1';
    if (seam === 'origin') context.apiBase = window.location.origin;
    try {
      localStorage.setItem('station.release-notes.last-version', '0.1.10');
      localStorage.setItem(
        `station.release-notes.last-version.server:${context.apiBase}:${identity.instanceId}`,
        '0.0.1',
      );
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) =>
          Response.json({
            tag_name: decodeURIComponent(
              new URL(url).pathname.split('/').at(-1)!,
            ),
            draft: false,
            body: '- Browser upgrade changes',
          }),
        ),
      );
      render(<UpdatesControl onNavigate={vi.fn()} />);
      await screen.findByRole('dialog', {
        name: 'Updated to Station 0.1.11-nightly.20261105.1',
      });
      await screen.findByText('Browser upgrade changes');
      fireEvent.click(
        within(
          screen.getByRole('dialog', {
            name: 'Updated to Station 0.1.11-nightly.20261105.1',
          }),
        ).getByRole('button', { name: /^Done$/ }),
      );
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    } finally {
      status.currentVersion = oldVersion;
      context.apiBase = oldApi;
      profile.isTauri = true;
    }
  },
);
