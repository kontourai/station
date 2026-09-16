/** @vitest-environment jsdom */

import { DEFAULT_NOTIFICATION_SOUND_PREFERENCES } from '@kontourai/station-contracts/device-settings';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  SETTINGS_CATALOG,
  visibleCatalogIds,
} from '../views/settings/settings-catalog';

vi.mock('@kontourai/station-connect', () => ({
  QRDisplay: () => <div />,
  useConnections: () => ({
    activeConnection: {
      name: 'Local',
      ownerId: null,
      accessMethods: [],
      selectedAccessMethodId: null,
    },
    apiBase: 'http://station.test',
    captureCredentialEvidence: () => null,
    isCredentialEvidenceCurrent: () => false,
  }),
  useHostUrl: () => ({ hostUrl: 'http://station.test', isDetecting: false }),
  // The settings view tree now reaches ConnectedServerUpdates → its context
  // hook's health composition; the catalog under test is the enumeration, so
  // a stable connected status is the neutral answer here.
  useConnectionStatus: () => ({ status: 'connected' }),
}));
vi.mock('@kontourai/station-sdk', () => ({
  authenticatedFetch: vi.fn(),
  StationReadOnlyError: class extends Error {},
  useEngineConnectionsQuery: () => ({ data: [] }),
  useAnswerSharesQuery: () => ({ data: [] }),
  // #2067: the plugin-visibility section. The ORDINARY operator case — a
  // directory in hand with one paired person — because the state under test
  // here is the settings catalog, and a refusal would legitimately render
  // nothing and make the enumeration disagree for a reason unrelated to the
  // catalog.
  usePluginVisibilityQuery: () => ({
    data: {
      principals: [
        {
          id: 'human:device:paired',
          display: 'Paired device',
          revoked: false,
          plugins: [],
          operator: false,
        },
      ],
    },
  }),
  usePluginsQuery: () => ({ data: [] }),
  useSetPluginVisibilityMutation: () => ({ mutate: vi.fn(), isError: false }),
  isPluginVisibilityForbidden: () => false,
  useRevokeAnswerShareMutation: () => ({ mutate: vi.fn(), isError: false }),
  // #2144 slice 3: the hook takes the selected project's slug, and the
  // server reports DIFFERENT provenance for a scoped read (`scope: 'project'`
  // on whatever the project overrides). The mock keys on the slug for the
  // same reason the cache does — serving the Station answer for a project
  // read is the exact confusion the key exists to prevent.
  useConfigProvenanceQuery: (slug?: string) => ({
    data: slug ? projectProvenance : configProvenance,
  }),
  useProjectsQuery: () => ({ data: projectList }),
  useProjectQuery: (slug: string) => ({
    data: slug ? projectRecord : undefined,
  }),
  useUpdateProjectMutation: () => ({ mutateAsync: updateProjectAsync }),
  // Settings mounts `UsageTelemetryDisclosure`, and #1608 made its decision
  // hook read the shared `['config']` query and its write path so the offered
  // choice cannot contradict a setting changed since the inventory was
  // fetched. Both are reached before the disclosure's own early return, so
  // this factory has to answer them even though the surface renders nothing
  // in this file. The shapes are the ORDINARY case — config in hand, nothing
  // in flight, no error — because the state under test here is the settings
  // catalog, and a loading or failed telemetry read would make the decision
  // hook derive an unsettled state that is not what any assertion below is
  // about.
  useConfigQuery: () => ({ data: { telemetryEnabled: true } }),
  useUpdateConfigMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useInvalidateQuery: () => vi.fn(),
  useSystemStatusForApiBaseQuery: () => ({
    data: {
      build: {},
      prerequisites: [
        {
          id: 'node',
          name: 'Node',
          description: 'ready',
          status: 'installed',
          category: 'required',
        },
      ],
    },
    isLoading: false,
  }),
  useFeaturePreviewsQuery: () => ({
    isLoading: false,
    error: null,
    data: [
      {
        id: 'probe-preview',
        label: 'Probe preview',
        description: 'An engine-offered preview.',
        enabled: false,
      },
    ],
    refetch: vi.fn(),
  }),
  useUpdateFeaturePreviewMutation: () => ({
    isPending: false,
    error: null,
    mutate: vi.fn(),
  }),
  useKnowledgeAdaptersQuery: () => ({ data: [] }),
  useKnowledgeRootsQuery: () => ({ data: [] }),
  useCreateKnowledgeRootMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
  }),
  useValidateKnowledgeRootMutation: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));
const updateAppLogLevel = vi.fn();
vi.mock('@kontourai/station-sdk/app-config', () => ({ updateAppLogLevel }));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
  // This catalog fixture has no request-scoped account administration authority.
  useHostRequestAuthorityScope: () => null,
}));
const updateConfig = vi.fn();
const INITIAL_CONFIG = { logLevel: 'info', templateVariables: [] };
// Per-field provenance. Mutable because "which settings are stored" is what
// decides what a reset clears, and it has to differ between tests.
let configProvenance: Record<string, { source: string }> = {};
// #2144 slice 3: what a `?project=<slug>` read reports, and the project the
// selector offers. Mutable for the same reason `configProvenance` is — which
// keys a project overrides is what every assertion below varies.
let projectProvenance: Record<string, { source: string; scope?: string }> = {};
let projectList: { slug: string; name?: string }[] = [];
let projectRecord: Record<string, unknown> | undefined;
const updateProjectAsync = vi.fn(async () => ({}));
// The reconciliation effect reads the fetch generation, not just the values, so
// tests drive both: `config` is what the server last returned and
// `dataUpdatedAt` is when that fetch succeeded.
let configSnapshot: {
  config: Record<string, unknown> | null;
  dataUpdatedAt: number;
  error?: unknown;
  retry?: () => void;
};
vi.mock('../contexts/ConfigContext', () => ({
  useConfigSnapshot: () => configSnapshot,
  useConfig: () => configSnapshot.config,
  useConfigActions: () => ({ updateConfig, isSaving: false }),
}));
// `chatFontSize` is mutable because `null` (no device value) and a number
// are two different rows: the "Use Station default" action exists only in
// the second. `setDeviceSetting`/`resetDeviceSetting` are module-level spies
// rather than fresh `vi.fn()`s per call, so a test can assert what a click
// actually reached.
let deviceChatFontSize: number | null = 14;
const setDeviceSetting = vi.fn();
const resetDeviceSetting = vi.fn();
vi.mock('../contexts/DeviceSettingsContext', () => ({
  useDeviceSettings: () => ({
    chatFontSize: deviceChatFontSize,
    hapticsEnabled: true,
    accentColor: null,
    developerToolsEnabled: false,
    sidebarSections: {
      openChatsCollapsed: false,
      openChatsHidden: false,
      draftsCollapsed: false,
      draftsHidden: false,
    },
  }),
  useDeviceSettingsActions: () => ({ setDeviceSetting, resetDeviceSetting }),
}));
let isMobile = false;
let isDesktop = false;
vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ isMobile, isDesktop }),
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
  // #2059: the page's Manage group navigates to other DESTINATIONS (Agents,
  // Connections, …) rather than to a `?view=` section of this page, so it
  // reads the navigation actions directly. Its own behaviour is covered by
  // SettingsManageSection.test.tsx; here it only has to mount.
  useNavigationActions: () => ({ navigate: vi.fn() }),
}));
vi.mock('../contexts/KeyboardShortcutsContext', () => {
  const store = {
    getAllShortcuts: () => [],
    getDisplay: () => '',
    isMac: true,
    restoreBinding: vi.fn(),
    setBinding: vi.fn(),
    register: () => vi.fn(),
  };
  return {
    useKeyboardShortcuts: () => store,
    useShortcutRegistry: () => store,
  };
});
vi.mock('../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../hooks/useFeatureSettings', () => ({
  useFeatureSettings: () => ({
    settings: {
      voiceS2SEnabled: false,
      mobilePairingEnabled: false,
      ttsReadbackEnabled: false,
      pushNotificationsEnabled: false,
      notificationSounds: DEFAULT_NOTIFICATION_SOUND_PREFERENCES,
    },
    toggle: vi.fn(),
  }),
}));
vi.mock('../hooks/usePushNotifications', () => ({
  usePushNotifications: () => ({ supported: false }),
}));
vi.mock('../contexts/VoiceProviderContext', () => ({
  useVoiceProviderContext: () => ({
    availableSTT: [],
    availableTTS: [],
    activeSTT: null,
    activeTTS: null,
    setSTTProvider: vi.fn(),
    setTTSProvider: vi.fn(),
  }),
}));
vi.mock('../contexts/MessageContextContext', () => ({
  useMessageContextContext: () => ({ providers: [], toggleProvider: vi.fn() }),
}));
vi.mock('../components/ModelSelector', () => ({
  ModelSelector: () => <input aria-label="Default Model" readOnly />,
}));
vi.mock('../components/header/ThemeToggle', () => ({
  ThemeToggle: () => <button type="button">theme</button>,
}));
vi.mock('../views/settings/CoreUpdateCheck', () => ({
  CoreUpdateCheck: () => <button type="button">check</button>,
}));

describe('settings catalog completeness', () => {
  beforeEach(() => {
    isMobile = false;
    isDesktop = false;
    updateConfig.mockReset();
    updateAppLogLevel.mockReset();
    configSnapshot = { config: { ...INITIAL_CONFIG }, dataUpdatedAt: 1 };
    configProvenance = {};
    projectProvenance = {};
    projectList = [{ slug: 'atlas', name: 'Atlas' }];
    projectRecord = undefined;
    updateProjectAsync.mockClear();
    deviceChatFontSize = 14;
    setDeviceSetting.mockClear();
    resetDeviceSetting.mockClear();
    window.history.replaceState({}, '', '/settings');
  });

  async function renderSettings() {
    const { SettingsView } = await import('../views/SettingsView');
    const client = new QueryClient();
    // A fresh element every time: React bails out of re-rendering when handed
    // the identical element object, which would make `applyServerSnapshot` a
    // no-op.
    const tree = () => (
      <QueryClientProvider client={client}>
        <SettingsView onBack={vi.fn()} />
      </QueryClientProvider>
    );
    const result = render(tree());
    return {
      container: result.container,
      unmount: result.unmount,
      /** Re-renders with the current `configSnapshot`, as a refetch would. */
      applyServerSnapshot: () => act(() => result.rerender(tree())),
    };
  }

  async function renderedCatalogIds(): Promise<string[]> {
    const { container } = await renderSettings();
    await waitFor(() => expect(container.outerHTML).toContain('settings'));
    return [
      ...container.querySelectorAll<HTMLElement>('[data-catalog-id]'),
    ].map((node) => node.dataset.catalogId!);
  }

  function expectExactCatalog(rendered: string[], expected: string[]) {
    const renderedWithoutCatalog = rendered.filter(
      (id) => !expected.includes(id),
    );
    const catalogWithoutRendered = expected.filter(
      (id) => !rendered.includes(id),
    );
    expect(
      { renderedWithoutCatalog, catalogWithoutRendered },
      `Settings catalog mismatch: rendered without catalog=[${renderedWithoutCatalog.join(', ')}]; catalog without rendered=[${catalogWithoutRendered.join(', ')}]`,
    ).toEqual({ renderedWithoutCatalog: [], catalogWithoutRendered: [] });
    expect(rendered).toHaveLength(expected.length);
  }

  // `useConfigSnapshot` logged the config query's error and
  // returned `config: null` — the same shape an in-flight read has — so the
  // `if (!configData)` branch below drew the loading skeleton FOREVER on a
  // failed initial read. A page that cannot say "this failed" says "still
  // loading" instead, indefinitely.
  test('a failed config read renders the failure, not a permanent skeleton', async () => {
    const retry = vi.fn();
    configSnapshot = {
      config: null,
      dataUpdatedAt: 0,
      error: new Error('config read failed'),
      retry,
    };

    const { container } = await renderSettings();

    expect(container.querySelector('.settings__skeleton')).toBeNull();
    expect(screen.getByText('Unable to load settings')).toBeTruthy();
    expect(screen.getByText('config read failed')).toBeTruthy();
    // 6-OPS-23: the frame the page owns does not depend on the read — the
    // title is the page frame's (page-frame-registry.ts), rendered by the
    // shell above this body, so the page itself renders only the failure.

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test('an in-flight config read still renders the skeleton, not a failure', async () => {
    configSnapshot = { config: null, dataUpdatedAt: 0 };

    const { container } = await renderSettings();

    expect(container.querySelector('.settings__skeleton')).toBeTruthy();
    expect(screen.queryByText('Unable to load settings')).toBeNull();
  });

  test('the rendered desktop Settings view and catalog enumerate the same exact ids', async () => {
    const { SettingsView } = await import('../views/SettingsView');
    expect(String(SettingsView)).toContain('configData');
    const rendered = await renderedCatalogIds();
    const expected = visibleCatalogIds({
      isMobile: false,
      isDesktop,
      isOperator: true,
    });
    expectExactCatalog(rendered, expected);
    // 37 at the merge base; +2 from archive#3313 (feature-previews,
    // enable-developer-tools) and +1 from the chat-dock lane's
    // sidebar-sections, +1 from station#585 smooth answer reveal, +1 from the
    // update-ownership split (desktop-app-updates). This slice: -1
    // (knowledge-stores-preview, whose setting changes nothing and is no
    // longer user-facing) and +2 (workspace-checkpoints,
    // default-chat-font-size). #2144 slice 2: +1
    // (default-workspace-isolation). Counted from the merged catalog, not
    // added up.
    expect(SETTINGS_CATALOG).toHaveLength(45);
  });

  test('the rendered mobile Settings view and catalog enumerate the same exact ids', async () => {
    isMobile = true;
    const rendered = await renderedCatalogIds();
    const expected = visibleCatalogIds({
      isMobile: true,
      isDesktop,
      isOperator: true,
    });
    expectExactCatalog(rendered, expected);
    expect(rendered).toContain('haptic-feedback');
  });

  test('a rejected save preserves its draft and Retry sends that draft again', async () => {
    const sdk = await import('@kontourai/station-sdk/app-config');
    vi.mocked(sdk.updateAppLogLevel).mockRejectedValueOnce(
      new Error('unreachable'),
    );
    vi.mocked(sdk.updateAppLogLevel).mockResolvedValueOnce({
      value: 'debug',
      revision: 'revision-2',
      operationId: 'config-edit-00000001',
    });
    await renderedCatalogIds();

    const logLevel = screen.getByLabelText('Log Level');
    fireEvent.change(logLevel, { target: { value: 'debug' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText(
        'Log Level could not be saved. Other settings were saved; your Log Level change is kept here until you retry.',
      ),
    ).toBeTruthy();
    expect((logLevel as HTMLSelectElement).value).toBe('debug');
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    expect(updateConfig).not.toHaveBeenCalled();
    expect(sdk.updateAppLogLevel).toHaveBeenLastCalledWith(
      'http://station.test',
      'debug',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(sdk.updateAppLogLevel).toHaveBeenCalledTimes(2));
    expect(updateConfig).not.toHaveBeenCalled();
  });

  test('saves ordinary settings when Log Level fails and keeps only the Log Level draft', async () => {
    const sdk = await import('@kontourai/station-sdk/app-config');
    updateConfig.mockResolvedValueOnce(undefined);
    vi.mocked(sdk.updateAppLogLevel).mockRejectedValueOnce(
      new Error('internal route contract'),
    );
    await renderedCatalogIds();

    fireEvent.change(screen.getByLabelText('Log Level'), {
      target: { value: 'debug' },
    });
    fireEvent.change(screen.getByLabelText('Default max turns'), {
      target: { value: '201' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText(
        'Log Level could not be saved. Other settings were saved; your Log Level change is kept here until you retry.',
      ),
    ).toBeTruthy();
    expect(updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ defaultMaxTurns: 201 }),
    );
    expect(sdk.updateAppLogLevel).toHaveBeenCalledWith(
      'http://station.test',
      'debug',
    );
    expect(
      (screen.getByLabelText('Log Level') as HTMLSelectElement).value,
    ).toBe('debug');

    vi.mocked(sdk.updateAppLogLevel).mockResolvedValueOnce({
      value: 'debug',
      revision: 'revision-2',
      operationId: 'config-edit-00000001',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(sdk.updateAppLogLevel).toHaveBeenCalledTimes(2));
    expect(updateConfig).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  test('retries only the plain subset after Log Level saves', async () => {
    const sdk = await import('@kontourai/station-sdk/app-config');
    updateConfig.mockRejectedValueOnce(new Error('plain failure'));
    updateConfig.mockResolvedValueOnce(undefined);
    vi.mocked(sdk.updateAppLogLevel).mockResolvedValueOnce({
      value: 'debug',
      revision: 'revision-2',
      operationId: 'config-edit-00000001',
    });
    await renderedCatalogIds();

    fireEvent.change(screen.getByLabelText('Log Level'), {
      target: { value: 'debug' },
    });
    fireEvent.change(screen.getByLabelText('Default max turns'), {
      target: { value: '201' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByText(/Some settings could not be saved\./);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(updateConfig).toHaveBeenCalledTimes(2));
    expect(sdk.updateAppLogLevel).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  test('names both outcomes when both save requests fail', async () => {
    const sdk = await import('@kontourai/station-sdk/app-config');
    updateConfig.mockRejectedValueOnce(new Error('plain failure'));
    vi.mocked(sdk.updateAppLogLevel).mockRejectedValueOnce(
      new Error('log failure'),
    );
    await renderedCatalogIds();

    fireEvent.change(screen.getByLabelText('Log Level'), {
      target: { value: 'debug' },
    });
    fireEvent.change(screen.getByLabelText('Default max turns'), {
      target: { value: '201' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText(
        'Log Level and other settings could not be saved. Your changes are kept here until you retry.',
      ),
    ).toBeTruthy();
  });

  test('prevents a second Log Level-only save while the first is pending', async () => {
    const sdk = await import('@kontourai/station-sdk/app-config');
    let release:
      | ((value: {
          value: 'debug';
          revision: string;
          operationId: string;
        }) => void)
      | undefined;
    vi.mocked(sdk.updateAppLogLevel).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await renderedCatalogIds();
    fireEvent.change(screen.getByLabelText('Log Level'), {
      target: { value: 'debug' },
    });

    const save = screen.getByRole('button', { name: 'Save' });
    fireEvent.click(save);
    fireEvent.click(save);
    expect(sdk.updateAppLogLevel).toHaveBeenCalledTimes(1);
    expect(
      (screen.getByRole('button', { name: 'Saving…' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    release?.({
      value: 'debug',
      revision: 'revision-2',
      operationId: 'config-edit-00000001',
    });
    await waitFor(() =>
      expect(screen.queryByText('Unsaved changes')).toBeNull(),
    );
  });

  test('a plain-only save goes through the standard config document, not the log-level endpoint', async () => {
    const sdk = await import('@kontourai/station-sdk/app-config');
    updateConfig.mockResolvedValueOnce(undefined);
    await renderedCatalogIds();

    fireEvent.change(screen.getByLabelText('Default max turns'), {
      target: { value: '201' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateConfig).toHaveBeenCalledTimes(1));
    expect(updateConfig).toHaveBeenCalledWith({ defaultMaxTurns: 201 });
    expect(sdk.updateAppLogLevel).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByText('Unsaved changes')).toBeNull(),
    );
  });

  test('a snapshot that arrives while the form is dirty is adopted once it is clean', async () => {
    const sdk = await import('@kontourai/station-sdk/app-config');
    configSnapshot = {
      config: { ...INITIAL_CONFIG, defaultMaxTurns: 100 },
      dataUpdatedAt: 1000,
    };
    vi.mocked(sdk.updateAppLogLevel).mockRejectedValueOnce(
      new Error('unreachable'),
    );
    const { applyServerSnapshot } = await renderSettings();

    fireEvent.change(screen.getByLabelText('Log Level'), {
      target: { value: 'debug' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Log Level could not be saved/);

    // Another client edits a key this form never touched, while the draft is
    // still pending. The snapshot must be remembered, not consumed.
    configSnapshot = {
      config: { ...INITIAL_CONFIG, defaultMaxTurns: 500 },
      dataUpdatedAt: 2000,
    };
    applyServerSnapshot();
    expect(
      (screen.getByLabelText('Log Level') as HTMLSelectElement).value,
    ).toBe('debug');
    expect(
      (screen.getByLabelText('Default max turns') as HTMLInputElement).value,
    ).toBe('100');

    vi.mocked(sdk.updateAppLogLevel).mockResolvedValueOnce({
      value: 'debug',
      revision: 'revision-2',
      operationId: 'config-edit-00000001',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() =>
      expect(
        (screen.getByLabelText('Default max turns') as HTMLInputElement).value,
      ).toBe('500'),
    );
    // The retry's own write is newer than that snapshot, so it survives it.
    expect(
      (screen.getByLabelText('Log Level') as HTMLSelectElement).value,
    ).toBe('debug');
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  test('adopts a newer snapshot whose values equal an older one', async () => {
    const now = Date.now();
    configSnapshot = {
      config: { ...INITIAL_CONFIG, defaultMaxTurns: 100 },
      dataUpdatedAt: now - 60_000,
    };
    updateConfig.mockResolvedValueOnce(undefined);
    const { applyServerSnapshot } = await renderSettings();

    fireEvent.change(screen.getByLabelText('Default max turns'), {
      target: { value: '201' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(screen.queryByText('Unsaved changes')).toBeNull(),
    );
    expect(
      (screen.getByLabelText('Default max turns') as HTMLInputElement).value,
    ).toBe('201');

    // Another client restores the original value. The payload is byte-identical
    // to the first snapshot, so only the fetch generation says it is new.
    configSnapshot = {
      config: { ...INITIAL_CONFIG, defaultMaxTurns: 100 },
      dataUpdatedAt: now + 60_000,
    };
    applyServerSnapshot();

    await waitFor(() =>
      expect(
        (screen.getByLabelText('Default max turns') as HTMLInputElement).value,
      ).toBe('100'),
    );
  });

  test('a save that never settles is released at the deadline with its drafts kept', async () => {
    vi.useFakeTimers();
    try {
      const sdk = await import('@kontourai/station-sdk/app-config');
      const { SETTINGS_SAVE_DEADLINE_MS } = await import(
        '../views/SettingsView'
      );
      vi.mocked(sdk.updateAppLogLevel).mockImplementationOnce(
        () => new Promise(() => {}),
      );
      await renderSettings();

      fireEvent.change(screen.getByLabelText('Log Level'), {
        target: { value: 'debug' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(
        (screen.getByRole('button', { name: 'Saving…' }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEADLINE_MS);
      });

      expect(screen.getByText(/Save timed out/)).toBeTruthy();
      expect(
        (screen.getByLabelText('Log Level') as HTMLSelectElement).value,
      ).toBe('debug');
      expect(screen.getByText('Unsaved changes')).toBeTruthy();
      expect(
        (screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test('Discard restores the partial-save baseline instead of stale config data', async () => {
    const sdk = await import('@kontourai/station-sdk/app-config');
    updateConfig.mockResolvedValueOnce(undefined);
    vi.mocked(sdk.updateAppLogLevel).mockRejectedValueOnce(
      new Error('log failure'),
    );
    await renderedCatalogIds();
    fireEvent.change(screen.getByLabelText('Log Level'), {
      target: { value: 'debug' },
    });
    fireEvent.change(screen.getByLabelText('Default max turns'), {
      target: { value: '201' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Log Level could not be saved/);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(
      (screen.getByLabelText('Log Level') as HTMLSelectElement).value,
    ).toBe('info');
    expect(
      (screen.getByLabelText('Default max turns') as HTMLInputElement).value,
    ).toBe('201');
  });

  // archive#3313: nothing pinned that `?view=` resolves at all. The
  // test below passes `view=system` but asserts only the `highlight`
  // behaviour, so making `?view=` a no-op left 161 tests green — and this
  // branch retires the standalone /feature-previews route in favour of a
  // redirect to `/settings?view=feature-previews`, which makes the query the
  // ONLY way to reach that surface directly.
  test('?view= narrows the page to that one section and focuses it', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    window.history.replaceState({}, '', '/settings?view=feature-previews');
    const rendered = await renderedCatalogIds();

    // Narrowed: the section the query names, and nothing else.
    expect(rendered).toEqual(['feature-previews']);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        document.getElementById('section-feature-previews'),
      ),
    );
  });

  test('an unknown ?view= falls back to the overview and strips itself', async () => {
    window.history.replaceState({}, '', '/settings?view=not-a-section');
    const rendered = await renderedCatalogIds();
    expectExactCatalog(
      rendered,
      visibleCatalogIds({ isMobile: false, isDesktop, isOperator: true }),
    );
    expect(window.location.search).toBe('');
  });

  test('a row deep link focuses once and strips only highlight', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: true }),
    });
    Element.prototype.scrollIntoView = vi.fn();
    window.history.replaceState(
      {},
      '',
      '/settings?keep=1&section=appearance&view=system&highlight=core-app-updates',
    );
    const { SettingsView } = await import('../views/SettingsView');
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <SettingsView onBack={vi.fn()} />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        container.querySelector('#core-app-updates'),
      ),
    );
    expect(window.location.search).toBe('?keep=1&view=system');
    expect(
      container
        .querySelector('#core-app-updates')
        ?.classList.contains('settings__highlight-pulse'),
    ).toBe(true);
  });

  test('the desktop-only update row deep-links and pulses when desktop', async () => {
    isDesktop = true;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: true }),
    });
    Element.prototype.scrollIntoView = vi.fn();
    window.history.replaceState(
      {},
      '',
      '/settings?keep=1&view=system&highlight=desktop-app-updates',
    );
    const { SettingsView } = await import('../views/SettingsView');
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <SettingsView onBack={vi.fn()} />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        container.querySelector('#desktop-app-updates'),
      ),
    );
    expect(
      container
        .querySelector('#desktop-app-updates')
        ?.classList.contains('settings__highlight-pulse'),
    ).toBe(true);
  });

  test('the tray update destinations land on their catalog highlights through the real navigation store', async () => {
    isDesktop = true;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: true }),
    });
    Element.prototype.scrollIntoView = vi.fn();
    const { trayNavigationTarget } = await import('../lib/trayNavigation');
    const { navigationStore } = await import('../contexts/navigation-store');
    const { container } = await renderSettings();

    // The tray emits closed destinations, not URLs. Drive the canonical
    // store exactly as DeferredAppOverlays' navigate does and require both
    // update rows to resolve: the desktop row is desktop-only, so this also
    // proves the desktop-platform mock shape renders it.
    for (const [destination, id] of [
      ['desktopUpdates', 'desktop-app-updates'],
      ['serverUpdates', 'core-app-updates'],
    ] as const) {
      const target = trayNavigationTarget(destination);
      expect(target?.pathname).toBe('/settings');
      navigationStore.navigate(target!.pathname, target!.params);
      await waitFor(() =>
        expect(document.activeElement).toBe(container.querySelector(`#${id}`)),
      );
      expect(
        container
          .querySelector(`#${id}`)
          ?.classList.contains('settings__highlight-pulse'),
      ).toBe(true);
    }
    await waitFor(() => expect(window.location.search).toBe('?view=system'));
  });

  test('a desktop-only row highlight outside the desktop shell strips itself with the honest reason', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    window.history.replaceState(
      {},
      '',
      '/settings?view=system&highlight=desktop-app-updates',
    );
    const { SettingsView } = await import('../views/SettingsView');
    const { container } = await render(
      <QueryClientProvider client={new QueryClient()}>
        <SettingsView onBack={vi.fn()} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(window.location.search).toBe('?view=system'));
    expect(container.querySelector('#desktop-app-updates')).toBeNull();
    expect(screen.getByText('Available in the desktop app.')).toBeTruthy();
  });

  test('repeats the same mounted leaf request and focuses its editable control', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    window.history.replaceState(
      {},
      '',
      '/settings?view=appearance&highlight=chat-font-size',
    );
    const { container } = await renderSettings();

    await waitFor(() =>
      expect(document.activeElement).toBe(
        container.querySelector<HTMLInputElement>('#chatFontSize'),
      ),
    );
    window.history.pushState(
      {},
      '',
      '/settings?view=appearance&highlight=chat-font-size',
    );
    fireEvent(window, new PopStateEvent('popstate'));
    await waitFor(() =>
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(2),
    );
    expect(window.location.search).toBe('?view=appearance');
  });

  test('focuses a deep-linked editable field in the Defaults section', async () => {
    // The `.agent-defaults__disclosure` assertion that used to close this
    // test is gone with the disclosure itself: these fields render directly
    // under the section intro, so there is nothing left to open. The focus
    // assertion is the part that was ever about the deep link.
    window.history.replaceState(
      {},
      '',
      '/settings?view=agent-defaults&highlight=default-region',
    );
    const { container } = await renderSettings();

    await waitFor(() =>
      expect(document.activeElement).toBe(
        container.querySelector<HTMLInputElement>('#region'),
      ),
    );
    expect(container.querySelector('.agent-defaults__disclosure')).toBeNull();
  });

  test('removes an invalid highlight without disturbing route and shell query state', async () => {
    window.history.replaceState(
      {},
      '',
      '/settings?dock=true&locale=fr&view=appearance&highlight=retired-control',
    );
    const { container } = await renderSettings();

    await waitFor(() =>
      expect(container.textContent).toContain(
        'That Settings target is no longer available.',
      ),
    );
    expect(window.location.search).toBe('?dock=true&locale=fr&view=appearance');
  });

  test('does not steal focus from a person while a config-gated target mounts', async () => {
    window.history.replaceState(
      {},
      '',
      '/settings?view=appearance&highlight=chat-font-size',
    );
    configSnapshot = { config: null, dataUpdatedAt: 0 };
    const { container, applyServerSnapshot } = await renderSettings();
    const person = document.createElement('input');
    document.body.append(person);
    person.focus();
    configSnapshot = { config: { ...INITIAL_CONFIG }, dataUpdatedAt: 1 };
    applyServerSnapshot();

    await waitFor(() =>
      expect(container.querySelector('#chatFontSize')).toBeTruthy(),
    );
    expect(document.activeElement).toBe(person);
    person.remove();
  });

  test('a cold section choice cancels its pending leaf before config mounts', async () => {
    configSnapshot = { config: null, dataUpdatedAt: 0 };
    window.history.replaceState(
      {},
      '',
      '/settings?view=system&highlight=log-level',
    );
    const { container, applyServerSnapshot } = await renderSettings();
    fireEvent.click(screen.getByRole('link', { name: 'Appearance' }));
    await waitFor(() =>
      expect(window.location.search).toBe('?view=appearance'),
    );
    configSnapshot = { config: { ...INITIAL_CONFIG }, dataUpdatedAt: 1 };
    applyServerSnapshot();

    await waitFor(() =>
      expect(container.querySelector('#chatFontSize')).toBeTruthy(),
    );
    expect(container.querySelector('#log-level')).toBeNull();
    expect(container.querySelector('.settings__highlight-pulse')).toBeNull();
  });

  test('keeps an unsaved draft through a target switch and browser Back', async () => {
    window.history.replaceState({}, '', '/settings?view=system');
    await renderSettings();
    fireEvent.change(screen.getByLabelText('Log Level'), {
      target: { value: 'debug' },
    });
    window.history.pushState(
      {},
      '',
      '/settings?view=station-config&highlight=default-max-turns',
    );
    fireEvent(window, new PopStateEvent('popstate'));
    await waitFor(() =>
      expect(window.location.search).toBe('?view=station-config'),
    );
    // Simulate the browser restoring the previous same-page history entry.
    // The Settings instance remains mounted, so its draft must remain local.
    window.history.replaceState({}, '', '/settings?view=system');
    fireEvent(window, new PopStateEvent('popstate'));
    await waitFor(() =>
      expect(
        (screen.getByLabelText('Log Level') as HTMLSelectElement).value,
      ).toBe('debug'),
    );
  });

  test('honestly consumes unavailable mobile haptics without inventing a target', async () => {
    isMobile = false;
    window.history.replaceState(
      {},
      '',
      '/settings?view=appearance&highlight=haptic-feedback',
    );
    const { container } = await renderSettings();

    await waitFor(() =>
      expect(container.textContent).toContain(
        'Available on a mobile device with haptic feedback support.',
      ),
    );
    expect(window.location.search).toBe('?view=appearance');
    expect(container.querySelector('#haptic-feedback')).toBeNull();
  });

  test('keeps unavailable mobile feedback visible while Settings is still loading', async () => {
    isMobile = false;
    configSnapshot = { config: null, dataUpdatedAt: 0 };
    window.history.replaceState(
      {},
      '',
      '/settings?view=appearance&highlight=haptic-feedback',
    );
    const { container } = await renderSettings();

    expect(
      await screen.findByText(
        'Available on a mobile device with haptic feedback support.',
      ),
    ).toBeTruthy();
    expect(container.querySelector('.settings__skeleton')).toBeTruthy();
  });

  test('keeps a cold target timeout visible while Settings is still loading', async () => {
    vi.useFakeTimers();
    try {
      configSnapshot = { config: null, dataUpdatedAt: 0 };
      window.history.replaceState(
        {},
        '',
        '/settings?view=system&highlight=log-level',
      );
      const { container } = await renderSettings();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_100);
      });

      expect(container.textContent).toContain(
        'This Settings control is not available yet. Try again or search Settings.',
      );
      expect(container.querySelector('.settings__skeleton')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  test('can reveal the persistent host-runtime status row', async () => {
    window.history.replaceState(
      {},
      '',
      '/settings?view=host-runtime&highlight=host-runtime',
    );
    const { container } = await renderSettings();

    await waitFor(() =>
      expect(document.activeElement).toBe(
        container.querySelector('#host-runtime'),
      ),
    );
    expect(window.location.search).toBe('?view=host-runtime');
  });

  // The reset button used to send `updateConfig({})`: an empty body the route
  // sanitizes to an empty accepted set, so the dialog promised a factory reset
  // and the request wrote nothing. These two assert the wiring — the button
  // reaches the delta builder, and the delta reaches the write.
  describe('Reset Station settings', () => {
    test('clears the stored Station settings and nothing else', async () => {
      configProvenance = {
        terminalShell: { source: 'file' },
        systemPrompt: { source: 'file' },
        // Already the factory resolution; clearing it would change nothing.
        mcpUiHost: { source: 'default' },
        // Required: the sanitizer refuses `null` for it.
        defaultModel: { source: 'file' },
      };
      updateConfig.mockResolvedValueOnce({ data: {} });
      await renderSettings();

      fireEvent.click(
        screen.getByRole('button', { name: 'Reset Station settings' }),
      );
      // A bare string name is an exact full-string match in RTL, so this is
      // the danger button and not `Close Reset Station settings`.
      fireEvent.click(screen.getByRole('button', { name: 'Reset' }));

      await waitFor(() => expect(updateConfig).toHaveBeenCalledTimes(1));
      expect(updateConfig).toHaveBeenCalledWith({
        terminalShell: null,
        systemPrompt: null,
      });
    });

    test('is refused while the form holds an unsaved draft', async () => {
      // A reset writes what the SERVER stores; the draft is not part of it,
      // so a Save afterwards would re-store the very values just cleared.
      configProvenance = { terminalShell: { source: 'file' } };
      await renderSettings();

      fireEvent.change(screen.getByLabelText('Default max turns'), {
        target: { value: '201' },
      });
      await waitFor(() => expect(screen.getByText('Unsaved changes')));

      const reset = screen.getByRole('button', {
        name: 'Reset Station settings',
      }) as HTMLButtonElement;
      expect(reset.disabled).toBe(true);
      expect(
        screen.getByText(
          'Save or discard your unsaved changes first. Discard is always available.',
        ),
      ).toBeTruthy();
      fireEvent.click(reset);
      expect(updateConfig).not.toHaveBeenCalled();
    });

    test('refuses to confirm when no Station setting is stored', async () => {
      await renderSettings();

      fireEvent.click(
        screen.getByRole('button', { name: 'Reset Station settings' }),
      );
      const confirm = screen.getByRole('button', {
        name: 'Reset',
      }) as HTMLButtonElement;
      expect(confirm.disabled).toBe(true);
      fireEvent.click(confirm);
      expect(updateConfig).not.toHaveBeenCalled();
    });
  });

  /**
   * The Appearance slider writes a DEVICE value that then shadows the
   * Station default for this browser alone. "Use Station default" is the
   * only way back, and it is meaningless before a device value exists — so
   * the row offers it only then.
   */
  describe('Use Station default', () => {
    test('is absent while this device follows the Station default', async () => {
      deviceChatFontSize = null;
      const { container } = await renderSettings();

      expect(container.querySelector('#chatFontSize')).toBeTruthy();
      expect(
        screen.queryByRole('button', { name: 'Use Station default' }),
      ).toBeNull();
    });

    test('appears once this device has its own size, and clears it', async () => {
      deviceChatFontSize = 18;
      await renderSettings();

      const button = screen.getByRole('button', {
        name: 'Use Station default',
      });
      fireEvent.click(button);

      // `reset`, not `setDeviceSetting(…, 14)`: writing the Station's
      // current value would pin this device to today's number and stop it
      // following a later change to the Station default.
      expect(resetDeviceSetting).toHaveBeenCalledTimes(1);
      expect(resetDeviceSetting).toHaveBeenCalledWith('chatFontSize');
      expect(setDeviceSetting).not.toHaveBeenCalled();
    });
  });

  /**
   * #2144 slice 3 — the project scope selector and the override draft it
   * owns. `defaultWorkspaceIsolation` is the exercised row because it is the
   * one overridable key that renders through the generic registry row; the
   * setting-key-to-record-field mapping the other two need is proven in
   * `project-override-draft.test.ts`, which is where that rule lives.
   */
  describe('project scope', () => {
    const WORKSPACE_ROW = 'New chat workspace';

    function selectAtlas() {
      fireEvent.change(screen.getByLabelText('Show settings for:'), {
        target: { value: 'atlas' },
      });
    }

    test('changing the selector with a dirty Station draft asks before discarding', async () => {
      configSnapshot = {
        config: { ...INITIAL_CONFIG, registryUrl: 'https://one.test' },
        dataUpdatedAt: 1,
      };
      await renderSettings();

      const registry = screen.getByLabelText('Registry URL');
      fireEvent.change(registry, { target: { value: 'https://two.test' } });
      expect(screen.getByText('Unsaved changes')).toBeTruthy();

      selectAtlas();
      // The selector is a LOCAL state change, so it arbitrates through the
      // guard's explicit callback rather than the navigation store.
      expect(screen.getByText('Unsaved Changes')).toBeTruthy();
      expect(
        (screen.getByLabelText('Show settings for:') as HTMLSelectElement)
          .value,
      ).toBe('');

      // The page's save pill also offers "Discard"; this one is the modal's.
      fireEvent.click(
        within(screen.getByRole('dialog')).getByRole('button', {
          name: 'Discard',
        }),
      );
      await waitFor(() =>
        expect(
          (screen.getByLabelText('Show settings for:') as HTMLSelectElement)
            .value,
        ).toBe('atlas'),
      );
      expect((registry as HTMLInputElement).value).toBe('https://one.test');
    });

    test('an overridden row reads the project’s value and says the project owns it', async () => {
      configSnapshot = {
        config: { ...INITIAL_CONFIG, defaultWorkspaceIsolation: 'shared' },
        dataUpdatedAt: 1,
      };
      projectRecord = { slug: 'atlas', defaultWorkspaceIsolation: 'worktree' };
      projectProvenance = {
        defaultWorkspaceIsolation: { source: 'file', scope: 'project' },
        registryUrl: { source: 'file', scope: 'station' },
      };
      await renderSettings();

      const workspace = screen.getByLabelText(
        WORKSPACE_ROW,
      ) as HTMLSelectElement;
      expect(workspace.value).toBe('shared');

      selectAtlas();

      await waitFor(() => expect(workspace.value).toBe('worktree'));
      const row = workspace.closest('.page-row')!;
      expect(row.querySelector('.setting-row-status')!.textContent).toContain(
        'Project',
      );
      const stationRow = screen
        .getByLabelText('Registry URL')
        .closest('.page-row')!;
      expect(
        stationRow.querySelector('.setting-row-status')!.textContent,
      ).toContain('Station');
    });

    test('an override edit saves to the project, not to the Station config', async () => {
      configSnapshot = {
        config: { ...INITIAL_CONFIG, defaultWorkspaceIsolation: 'shared' },
        dataUpdatedAt: 1,
      };
      projectRecord = { slug: 'atlas' };
      projectProvenance = {};
      await renderSettings();

      selectAtlas();
      fireEvent.change(screen.getByLabelText(WORKSPACE_ROW), {
        target: { value: 'worktree' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(updateProjectAsync).toHaveBeenCalledTimes(1));
      expect(updateProjectAsync).toHaveBeenCalledWith({
        slug: 'atlas',
        defaultWorkspaceIsolation: 'worktree',
      });
      // The Station document is untouched: the edit was the project's.
      expect(updateConfig).not.toHaveBeenCalled();
    });

    test('reset to inherited sends null, which is what drops the override', async () => {
      configSnapshot = {
        config: { ...INITIAL_CONFIG, defaultWorkspaceIsolation: 'shared' },
        dataUpdatedAt: 1,
      };
      projectRecord = { slug: 'atlas', defaultWorkspaceIsolation: 'worktree' };
      projectProvenance = {
        defaultWorkspaceIsolation: { source: 'file', scope: 'project' },
      };
      await renderSettings();

      selectAtlas();
      const resets = await screen.findAllByRole('button', {
        name: 'Reset to inherited',
      });
      expect(resets).toHaveLength(1);
      fireEvent.click(resets[0]);
      // Pending, not applied: the row falls back to the Station value and the
      // save pill arms.
      await waitFor(() =>
        expect(
          (screen.getByLabelText(WORKSPACE_ROW) as HTMLSelectElement).value,
        ).toBe('shared'),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(updateProjectAsync).toHaveBeenCalledTimes(1));
      expect(updateProjectAsync).toHaveBeenCalledWith({
        slug: 'atlas',
        defaultWorkspaceIsolation: null,
      });
    });

    test('a Station reset never offers a project override as a stored Station value', async () => {
      // The Station stores NOTHING for the workspace key; the project
      // overrides it. A scoped provenance read reports that override as
      // `{ source: 'file' }` for the same key, so a reset plan built from it
      // would list a Station setting nobody stored and send `null` for it to
      // the Station document.
      configSnapshot = { config: { ...INITIAL_CONFIG }, dataUpdatedAt: 1 };
      configProvenance = { terminalShell: { source: 'file' } };
      projectProvenance = {
        terminalShell: { source: 'file', scope: 'station' },
        defaultWorkspaceIsolation: { source: 'file', scope: 'project' },
      };
      projectRecord = { slug: 'atlas', defaultWorkspaceIsolation: 'worktree' };
      updateConfig.mockResolvedValueOnce({ data: {} });
      await renderSettings();

      selectAtlas();
      await waitFor(() =>
        expect(
          (screen.getByLabelText(WORKSPACE_ROW) as HTMLSelectElement).value,
        ).toBe('worktree'),
      );

      fireEvent.click(
        screen.getByRole('button', { name: 'Reset Station settings' }),
      );
      const dialog = screen.getByRole('dialog');
      expect(dialog.textContent).not.toContain(WORKSPACE_ROW);
      fireEvent.click(screen.getByRole('button', { name: 'Reset' }));

      await waitFor(() => expect(updateConfig).toHaveBeenCalledTimes(1));
      expect(updateConfig).toHaveBeenCalledWith({ terminalShell: null });
    });

    test('Discard clears the project draft as well as the Station draft', async () => {
      configSnapshot = {
        config: { ...INITIAL_CONFIG, defaultWorkspaceIsolation: 'shared' },
        dataUpdatedAt: 1,
      };
      projectRecord = { slug: 'atlas', defaultWorkspaceIsolation: 'worktree' };
      projectProvenance = {
        defaultWorkspaceIsolation: { source: 'file', scope: 'project' },
      };
      await renderSettings();

      selectAtlas();
      const workspace = screen.getByLabelText(
        WORKSPACE_ROW,
      ) as HTMLSelectElement;
      await waitFor(() => expect(workspace.value).toBe('worktree'));
      fireEvent.change(workspace, { target: { value: 'shared' } });
      expect(screen.getByText('Unsaved changes')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

      // Back to the project's SAVED override, and the pill is gone — the
      // override draft is empty, not merely invisible.
      await waitFor(() => expect(workspace.value).toBe('worktree'));
      expect(screen.queryByText('Unsaved changes')).toBeNull();
      fireEvent.click(
        screen.getByRole('button', { name: 'Reset Station settings' }),
      );
      expect(
        (screen.getByRole('button', { name: 'Reset' }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    });

    test('a refused project write keeps its draft while the Station write still lands', async () => {
      configSnapshot = {
        config: { ...INITIAL_CONFIG, defaultWorkspaceIsolation: 'shared' },
        dataUpdatedAt: 1,
      };
      projectRecord = { slug: 'atlas' };
      updateConfig.mockResolvedValueOnce({ data: {} });
      updateProjectAsync.mockRejectedValueOnce(
        new Error('project write failed'),
      );
      await renderSettings();

      selectAtlas();
      fireEvent.change(screen.getByLabelText(WORKSPACE_ROW), {
        target: { value: 'worktree' },
      });
      fireEvent.change(screen.getByLabelText('Registry URL'), {
        target: { value: 'https://two.test' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(
          screen.getByText(
            "This project's overrides could not be saved. Your changes to them are kept here until you retry.",
          ),
        ).toBeTruthy(),
      );
      // The Station document was written; only the project's was refused.
      expect(updateConfig).toHaveBeenCalledWith({
        registryUrl: 'https://two.test',
      });
      // And the refused edit is still here to retry, not silently dropped.
      expect(
        (screen.getByLabelText(WORKSPACE_ROW) as HTMLSelectElement).value,
      ).toBe('worktree');
      expect(screen.getByText('Unsaved changes')).toBeTruthy();
    });

    test('reset to inherited disappears once the draft already resets the key', async () => {
      configSnapshot = {
        config: { ...INITIAL_CONFIG, defaultWorkspaceIsolation: 'shared' },
        dataUpdatedAt: 1,
      };
      projectRecord = { slug: 'atlas', defaultWorkspaceIsolation: 'worktree' };
      projectProvenance = {
        defaultWorkspaceIsolation: { source: 'file', scope: 'project' },
      };
      await renderSettings();

      selectAtlas();
      const reset = await screen.findByRole('button', {
        name: 'Reset to inherited',
      });
      fireEvent.click(reset);

      // The row already shows the inherited value; a second click would write
      // the same `null` again and report an action with no work to do.
      await waitFor(() =>
        expect(
          screen.queryByRole('button', { name: 'Reset to inherited' }),
        ).toBeNull(),
      );
    });

    test('an unsettled project read never becomes "this project overrides nothing"', async () => {
      configSnapshot = {
        config: { ...INITIAL_CONFIG, defaultWorkspaceIsolation: 'shared' },
        dataUpdatedAt: 1,
      };
      // The record has not arrived. `savedOverrides` is derived from it, so
      // writing now would compare a real draft against an empty baseline.
      projectRecord = undefined;
      await renderSettings();

      selectAtlas();
      fireEvent.change(screen.getByLabelText(WORKSPACE_ROW), {
        target: { value: 'worktree' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(screen.queryByText('Saving…')).toBeNull());
      expect(updateProjectAsync).not.toHaveBeenCalled();
    });
  });

  test('falls back to the labeled Backup and Reset rows, never hidden or destructive controls', async () => {
    for (const target of ['backup-restore', 'reset-defaults'] as const) {
      window.history.replaceState(
        {},
        '',
        `/settings?view=system&highlight=${target}`,
      );
      const { container, unmount } = await renderSettings();
      const row = container.querySelector<HTMLElement>(`#${target}`)!;
      await waitFor(() => expect(document.activeElement).toBe(row));
      expect(row.querySelector('input[type="file"]')).not.toBe(
        document.activeElement,
      );
      expect(row.querySelector('button')).not.toBe(document.activeElement);
      unmount();
    }
  });
});
