/** @vitest-environment jsdom */

import {
  DEFAULT_NOTIFICATION_SOUND_PREFERENCES,
  DEVICE_SETTINGS_REGISTRY,
} from '@kontourai/station-contracts/device-settings';
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
  APP_DESTINATION_REGISTRY,
  DEVELOPER_TOOLS_FLAG,
} from '../app-shell/destination-registry';
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
  useInvalidateQuery: () => invalidateQuery,
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
// Returns a promise, because the save path AWAITS the project refetch before
// clearing the override draft. A test can hand back one that never settles.
const invalidateQuery = vi.fn((_key: unknown) => Promise.resolve());
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
const resetDeviceSettings = vi.fn();
/**
 * #2144 slice 6 item D: what the disclosure query reports about a telemetry
 * DESTINATION. Partial mock — only the shared hook is replaced, so the real
 * `UsageTelemetryDisclosure` card and the real summary function still run.
 */
let telemetryEndpointConfigured: boolean | undefined;
/** The read's own state, which the row must not speak ahead of. */
let telemetryDisclosureSettled = true;
let telemetryDisclosureIsError = false;
vi.mock('../components/UsageTelemetryDisclosure', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../components/UsageTelemetryDisclosure')
    >();
  return {
    ...actual,
    useUsageTelemetryDisclosureState: () => ({
      data:
        telemetryEndpointConfigured === undefined
          ? undefined
          : { endpointConfigured: telemetryEndpointConfigured },
      isError: telemetryDisclosureIsError,
      settled: telemetryDisclosureSettled,
      outstanding: false,
    }),
  };
});

/**
 * The device store folds registry defaults in, so the harness starts from
 * the real default object rather than `{}` — an empty object is a device
 * that differs from its defaults in every field, which is not what an
 * untouched device looks like (#2144 slice 6 items B and F).
 */
const DEFAULT_DEVICE_FEATURE_SETTINGS = DEVICE_SETTINGS_REGISTRY.find(
  (definition) => definition.key === 'featureSettings',
)!.defaultValue as unknown as Record<string, unknown>;
let deviceFeatureSettings: Record<string, unknown> =
  DEFAULT_DEVICE_FEATURE_SETTINGS;
/**
 * #2144 slice 4: the five chat rows that had a device-settings contract row
 * and no Settings row. Seeded from the REGISTRY's own defaults rather than
 * hand-written literals, so the fixture is the shape the real store hands a
 * device nobody has touched — a hand-picked `true` here would make a row that
 * silently ignores its stored value look correct.
 */
function deviceDefault<T>(key: string): T {
  return DEVICE_SETTINGS_REGISTRY.find((definition) => definition.key === key)!
    .defaultValue as unknown as T;
}
let deviceChatSettings = {
  chatShowReasoning: deviceDefault<boolean>('chatShowReasoning'),
  chatShowToolDetails: deviceDefault<boolean>('chatShowToolDetails'),
  chatDockAutoHide: deviceDefault<boolean>('chatDockAutoHide'),
  diffStyle: deviceDefault<'unified' | 'split'>('diffStyle'),
  diffWrap: deviceDefault<boolean>('diffWrap'),
};
vi.mock('../contexts/DeviceSettingsContext', () => ({
  useDeviceSettings: () => ({
    chatFontSize: deviceChatFontSize,
    ...deviceChatSettings,
    // #2144 slice 6 item B: the Answer delivery row reads this.
    featureSettings: deviceFeatureSettings,
    hapticsEnabled: true,
    accentColor: null,
    developerToolsEnabled: false,
    // #2144 slice 6 item E: the Confirmations group in Appearance.
    confirmConversationDelete: true,
    sidebarSections: {
      openChatsCollapsed: false,
      openChatsHidden: false,
      draftsCollapsed: false,
      draftsHidden: false,
    },
  }),
  useDeviceSettingsActions: () => ({
    setDeviceSetting,
    resetDeviceSetting,
    resetDeviceSettings,
  }),
}));
let isMobile = false;
let isDesktop = false;
vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ isMobile, isDesktop }),
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
  // #2059: the page's nav-only rows navigate to other DESTINATIONS (Agents,
  // Skills, Engines & Models, …) rather than to a `?view=` section of this
  // page, so the section nav reads the navigation actions directly. Where
  // those rows sit and where they point is covered by
  // `SettingsSectionNav.test.tsx` and `developer-reachable.test.ts`; here the
  // nav only has to mount.
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
    invalidateQuery.mockReset();
    invalidateQuery.mockImplementation(() => Promise.resolve());
    deviceChatFontSize = 14;
    deviceFeatureSettings = DEFAULT_DEVICE_FEATURE_SETTINGS;
    deviceChatSettings = {
      chatShowReasoning: deviceDefault<boolean>('chatShowReasoning'),
      chatShowToolDetails: deviceDefault<boolean>('chatShowToolDetails'),
      chatDockAutoHide: deviceDefault<boolean>('chatDockAutoHide'),
      diffStyle: deviceDefault<'unified' | 'split'>('diffStyle'),
      diffWrap: deviceDefault<boolean>('diffWrap'),
    };
    telemetryEndpointConfigured = undefined;
    telemetryDisclosureSettled = true;
    telemetryDisclosureIsError = false;
    setDeviceSetting.mockClear();
    resetDeviceSetting.mockClear();
    resetDeviceSettings.mockClear();
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
    // added up. #2144 slice 6: +4 (default-approval-mode,
    // telemetry-destination, confirm-conversation-delete,
    // reset-device-defaults). #2144 slice 4: +5 — the five chat rows that had
    // a device-settings contract row and no catalog row, so the in-chat gear
    // was their only surface (chat-show-reasoning, chat-show-tool-details,
    // chat-dock-auto-hide, diff-style, diff-wrap). The two Appearance rows
    // that MOVED into the new chat section are not a change to this count:
    // the same ids, in a different `view`.
    expect(SETTINGS_CATALOG).toHaveLength(54);
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
      '/settings?view=chat&highlight=chat-font-size',
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
      '/settings?view=chat&highlight=chat-font-size',
    );
    fireEvent(window, new PopStateEvent('popstate'));
    await waitFor(() =>
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(2),
    );
    expect(window.location.search).toBe('?view=chat');
  });

  // #2144 slice 4 moved `chat-font-size` and `smooth-answer-reveal` out of
  // Appearance into the new Chat section. Their IDS did not change, so every
  // recorded link and every palette entry still names a row that exists — but
  // an old link names the wrong `view`. This is the documented soft break, and
  // what it must NOT do is strand the reader on a section the row is not in:
  // the stale view is corrected to the row's own, and the row is revealed.
  test.each([
    ['chat-font-size', '#chatFontSize'],
    ['smooth-answer-reveal', '[data-catalog-id="smooth-answer-reveal"]'],
  ])(
    'a pre-move link to ?view=appearance&highlight=%s still lands on the row',
    async (highlight, selector) => {
      window.history.replaceState(
        {},
        '',
        `/settings?view=appearance&highlight=${highlight}`,
      );
      const { container } = await renderSettings();

      await waitFor(() =>
        expect(container.querySelector(selector)).toBeTruthy(),
      );
      await waitFor(() => expect(window.location.search).toBe('?view=chat'));
      // And it is not merely that some element matched: Appearance's own rows
      // are not on screen, so the page really did move to the Chat section.
      expect(container.querySelector('#section-appearance')).toBeNull();
      expect(container.querySelector('#section-chat')).toBeTruthy();
    },
  );

  // The reverse of the case above, and not covered by it: the healing is
  // driven by the ENTRY's own section, so a link that names `chat` for a row
  // that lives in Appearance has to be corrected the other way. A fix that
  // only ever moved a reader towards `chat` — the direction #2144's move
  // went — would satisfy the pair above and fail here.
  test('a link naming ?view=chat for a row that lives in Appearance lands on Appearance', async () => {
    window.history.replaceState({}, '', '/settings?view=chat&highlight=theme');
    const { container } = await renderSettings();

    await waitFor(() =>
      expect(container.querySelector('[data-catalog-id="theme"]')).toBeTruthy(),
    );
    await waitFor(() =>
      expect(window.location.search).toBe('?view=appearance'),
    );
    expect(container.querySelector('#section-chat')).toBeNull();
    expect(container.querySelector('#section-appearance')).toBeTruthy();
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

  // #2144 slice 4. Turning developer tools on changes nothing where the switch
  // is: it adds a row to the navigation strip at the top of the page, under a
  // different group heading, in a strip that scrolls sideways. So the row has
  // to say where to look — and the sentence has to be checked against the
  // placement, or it goes on describing the old one after a move.
  //
  // The heading half is DERIVED: the projection below is built by the
  // production `getSettingsNav` and `settingsSectionNavItems` against the real
  // registry, then walked back to the group label the row would sit under.
  // The flag set is synthetic because this render has developer tools OFF —
  // the page as rendered here has no Developer row at all, which is the state
  // a reader is in when they read this description.
  //
  // That the row is FIRST within the group is not asserted here; it is pinned
  // in `SettingsSectionNav.test.tsx` ('opens each group at its first item').
  test('the developer-tools row names the row it reveals and the group it opens', async () => {
    window.history.replaceState({}, '', '/settings?view=developer-tools');
    const { settingsSectionNavItems } = await import('../views/SettingsView');
    const { container, unmount } = await renderSettings();

    const withDeveloper = APP_DESTINATION_REGISTRY.getSettingsNav(
      new Set([DEVELOPER_TOOLS_FLAG]),
    );
    const developer = withDeveloper.find((entry) => entry.id === 'developer');
    expect(developer).toBeTruthy();
    const navItems = settingsSectionNavItems(
      (section) => `/settings?view=${section}`,
      withDeveloper,
    );
    const index = navItems.findIndex((item) => item.href === developer!.route);
    expect(index).toBeGreaterThan(-1);
    let groupLabel: string | undefined;
    for (let cursor = index; cursor >= 0 && !groupLabel; cursor -= 1) {
      groupLabel = navItems[cursor]!.groupLabel;
    }
    expect(groupLabel).toBeTruthy();

    const description = container.querySelector(
      '[data-catalog-id="enable-developer-tools"] .page-row__description',
    );
    expect(description).toBeTruthy();
    expect(description!.textContent).toContain(developer!.label);
    expect(description!.textContent).toContain(groupLabel!);
    unmount();
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

  // Both halves of the link wrong at once, which is what a bookmark from two
  // renames ago looks like. Neither correction can lean on the other here: the
  // view is not in the section vocabulary, so the resolver drops it rather
  // than opening it, and the id is not in the catalog, so there is no entry to
  // heal the view towards. The page lands on overview — not blank, not on a
  // section that does not exist — and says the target is gone.
  test('drops a retired highlight and the retired view named beside it', async () => {
    window.history.replaceState(
      {},
      '',
      '/settings?view=manage&highlight=retired-control',
    );
    const { container } = await renderSettings();

    await waitFor(() =>
      expect(container.textContent).toContain(
        'That Settings target is no longer available.',
      ),
    );
    await waitFor(() => expect(window.location.search).toBe(''));
    // Overview: every section on screen, rather than the reader stranded on
    // the one the dead `view` named.
    expect(container.querySelector('#section-appearance')).toBeTruthy();
    expect(container.querySelector('#section-chat')).toBeTruthy();
  });

  // #2144 slice 4 renamed these, and nothing asserted them — so the rename was
  // free. Each box also opens with a caption stating its rule in words
  // (`tests/settings.spec.ts` pins those); the landmark name is what a reader
  // moving by region hears WITHOUT entering the box, which is the only way to
  // tell which run of sections you are about to walk into. Two of the four
  // name something other than a storage location: `Control` is an authority
  // relationship and `Knowledge` is a topic.
  test('each scope group is a landmark named for what it holds', async () => {
    window.history.replaceState({}, '', '/settings');
    const { container } = await renderSettings();

    await waitFor(() =>
      expect(container.querySelector('.settings__scope-group')).toBeTruthy(),
    );
    const groups = [
      ...container.querySelectorAll<HTMLElement>('.settings__scope-group'),
    ];
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual([
      'This Station settings',
      'Control settings',
      'This device settings',
      'Knowledge settings',
    ]);
    // Named regions, not styling wrappers: the name has to reach the
    // accessibility tree or it is decoration.
    for (const group of groups) {
      expect(
        screen.getByRole('region', {
          name: group.getAttribute('aria-label')!,
        }),
      ).toBe(group);
    }
  });

  test('does not steal focus from a person while a config-gated target mounts', async () => {
    window.history.replaceState(
      {},
      '',
      '/settings?view=chat&highlight=chat-font-size',
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

  // The persistence behaviour `settings-save-model.test.ts` used to guard by
  // scanning SettingsView source for a call with an exact indentation. That
  // pinned formatting, not behaviour: nesting the control one level deeper
  // reddened Nightly while the call itself was untouched and correct. The
  // property is asserted here instead, where the control is really driven.
  test('the Appearance font-size control persists through device settings', async () => {
    window.history.replaceState({}, '', '/settings?view=chat');
    const { container } = await renderSettings();
    const input = await waitFor(() => {
      const found = container.querySelector<HTMLInputElement>('#chatFontSize');
      if (!found) throw new Error('font-size control never mounted');
      return found;
    });

    fireEvent.change(input, { target: { value: '18' } });

    // The number matters as much as the key: an earlier shape wrote the
    // Station-wide `defaultChatFontSize` through updateConfig instead, so a
    // device-scoped write with a parsed integer is the whole property.
    expect(setDeviceSetting).toHaveBeenCalledWith('chatFontSize', 18);
    expect(updateConfig).not.toHaveBeenCalled();
  });

  test('a cold section choice cancels its pending leaf before config mounts', async () => {
    configSnapshot = { config: null, dataUpdatedAt: 0 };
    window.history.replaceState(
      {},
      '',
      '/settings?view=system&highlight=log-level',
    );
    const { container, applyServerSnapshot } = await renderSettings();
    fireEvent.click(screen.getByRole('link', { name: 'Chat' }));
    await waitFor(() => expect(window.location.search).toBe('?view=chat'));
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
   * #585 / #2144 slice 6 item B. The chat gear panel's half of this is in
   * ChatSettingsPanel.test.tsx; this is the Settings row, and the point of
   * having both is that they write the SAME device key with the same
   * meaning rather than two controls that happen to look alike.
   */
  /**
   * #2144 slice 4. Each of these five had a device-settings contract row and
   * no Settings row, so nothing on this page could change them. Three of them
   * (`chatShowReasoning`, `chatShowToolDetails`, `chatDockAutoHide`) were
   * reachable only from the in-chat gear panel; the two diff keys were
   * reachable only from `DiffPanel`'s own toolbar, which is why this file
   * covers both directions for every one of them rather than trusting the
   * other surface's test. Both directions per row, because either half alone
   * passes for a broken control: a write-only assertion passes for a row
   * that ignores what is stored, and a read-only one passes for a row that
   * writes NOTHING — or, the failure an orchestrator injection actually
   * produced here, writes its NEIGHBOUR's key, which every other test in this
   * file was blind to.
   */
  describe('Chat section device rows', () => {
    test.each([
      // label, stored value to seed, device key, value the click must write
      ['Show reasoning', 'chatShowReasoning', false, true],
      ['Show tool details', 'chatShowToolDetails', false, true],
      ['Auto-hide chat dock', 'chatDockAutoHide', true, false],
      ['Diff line wrap', 'diffWrap', true, false],
    ] as const)(
      '%s reads %s and writes it back',
      async (label, key, stored, written) => {
        deviceChatSettings = { ...deviceChatSettings, [key]: stored };
        const { unmount } = await renderSettings();

        const toggle = screen.getByRole('switch', { name: label });
        // Read direction: the control shows what is STORED, not a literal.
        expect(toggle.getAttribute('aria-checked')).toBe(String(stored));

        fireEvent.click(toggle);
        // Write direction, keyed: `toHaveBeenCalledWith` alone would pass for
        // a row writing a sibling's key with the same boolean.
        expect(setDeviceSetting.mock.calls).toEqual([[key, written]]);
        unmount();
      },
    );

    test('Diff view style reads and writes diffStyle in both directions', async () => {
      deviceChatSettings = { ...deviceChatSettings, diffStyle: 'split' };
      const { unmount } = await renderSettings();

      const select = screen.getByLabelText(
        'Diff view style',
      ) as HTMLSelectElement;
      expect(select.value).toBe('split');
      expect([...select.options].map((option) => option.value)).toEqual([
        'unified',
        'split',
      ]);

      fireEvent.change(select, { target: { value: 'unified' } });
      expect(setDeviceSetting.mock.calls).toEqual([['diffStyle', 'unified']]);
      unmount();

      setDeviceSetting.mockClear();
      deviceChatSettings = { ...deviceChatSettings, diffStyle: 'unified' };
      const second = await renderSettings();
      const reopened = screen.getByLabelText(
        'Diff view style',
      ) as HTMLSelectElement;
      expect(reopened.value).toBe('unified');
      fireEvent.change(reopened, { target: { value: 'split' } });
      expect(setDeviceSetting.mock.calls).toEqual([['diffStyle', 'split']]);
      second.unmount();
    });

    test('the two rows that moved out of Appearance render under Chat, not Appearance', async () => {
      window.history.replaceState({}, '', '/settings?view=chat');
      const { container, unmount } = await renderSettings();
      const chat = container.querySelector('#section-chat')!;
      expect(container.querySelector('#section-appearance')).toBeNull();
      for (const id of ['chat-font-size', 'smooth-answer-reveal']) {
        expect(chat.querySelector(`[data-catalog-id="${id}"]`)).toBeTruthy();
      }
      unmount();
    });
  });

  describe('Answer delivery', () => {
    test('writes smoothReveal in both directions from the Chat row', async () => {
      const { unmount } = await renderSettings();
      const select = screen.getByLabelText(
        'Answer delivery',
      ) as HTMLSelectElement;
      expect(select.value).toBe('token');

      fireEvent.change(select, { target: { value: 'smooth' } });
      expect(setDeviceSetting).toHaveBeenCalledWith(
        'featureSettings',
        expect.objectContaining({ smoothReveal: true }),
      );

      setDeviceSetting.mockClear();
      deviceFeatureSettings = { smoothReveal: true };
      unmount();
      const second = await renderSettings();
      const reopened = screen.getByLabelText(
        'Answer delivery',
      ) as HTMLSelectElement;
      expect(reopened.value).toBe('smooth');
      fireEvent.change(reopened, { target: { value: 'token' } });
      expect(setDeviceSetting).toHaveBeenCalledWith(
        'featureSettings',
        expect.objectContaining({ smoothReveal: false }),
      );
      second.unmount();
    });

    test('the retired mechanism-named toggle is gone', async () => {
      await renderSettings();
      expect(
        screen.queryByRole('switch', { name: 'Smooth answer reveal' }),
      ).toBeNull();
    });
  });

  /**
   * #2144 slice 6 item D. The toggle beside this row decides whether Station
   * WOULD send; this row says whether there is anywhere to send to. Both
   * answers are the host's, and the host itself is never named.
   */
  describe('Telemetry destination', () => {
    test('reports a configured destination without naming it', async () => {
      telemetryEndpointConfigured = true;
      await renderSettings();
      expect(
        screen.getByText('Destination: configured by the operator.'),
      ).toBeTruthy();
    });

    test('reports that nothing is sent when no destination exists', async () => {
      telemetryEndpointConfigured = false;
      await renderSettings();
      expect(
        screen.getByText('No destination configured; nothing is sent.'),
      ).toBeTruthy();
    });

    test('a host that did not report the field is not folded into either answer', async () => {
      telemetryEndpointConfigured = undefined;
      await renderSettings();
      expect(
        screen.getByText(
          'This Station has not reported whether a destination is configured.',
        ),
      ).toBeTruthy();
      expect(
        screen.queryByText('No destination configured; nothing is sent.'),
      ).toBeNull();
    });

    test('an in-flight read claims nothing about the host', async () => {
      // Fix round 1: every fresh Settings mount starts here, and the row
      // used to state "has not reported" before the request had landed.
      telemetryDisclosureSettled = false;
      telemetryEndpointConfigured = undefined;
      const { container } = await renderSettings();

      expect(
        screen.queryByText(
          'This Station has not reported whether a destination is configured.',
        ),
      ).toBeNull();
      expect(
        screen.queryByText('No destination configured; nothing is sent.'),
      ).toBeNull();
      // The row itself stays, so the catalog still enumerates it.
      expect(
        container.querySelector('[data-catalog-id="telemetry-destination"]'),
      ).toBeTruthy();
    });

    test('a failed read says the read failed, not what the host holds', async () => {
      telemetryDisclosureIsError = true;
      telemetryEndpointConfigured = undefined;
      await renderSettings();

      expect(
        screen.getByText('Could not read whether a destination is configured.'),
      ).toBeTruthy();
      expect(
        screen.queryByText(
          'This Station has not reported whether a destination is configured.',
        ),
      ).toBeNull();
    });
  });

  /**
   * #2144 slice 6 item E. The consumer half — that ConversationHistory
   * actually skips the modal — is in ConversationHistory.test.tsx; this is
   * the control that writes it.
   */
  describe('Ask before deleting a conversation', () => {
    test('renders on by default under a Confirmations group and round-trips', async () => {
      const { container } = await renderSettings();
      expect(
        [...container.querySelectorAll('.settings__group-title')].map(
          (node) => node.textContent,
        ),
      ).toContain('Confirmations');
      const toggle = screen.getByRole('switch', {
        name: 'Ask before deleting a conversation',
      });
      expect(toggle.getAttribute('aria-checked')).toBe('true');
      fireEvent.click(toggle);
      expect(setDeviceSetting).toHaveBeenCalledWith(
        'confirmConversationDelete',
        false,
      );
    });
  });

  /**
   * #2144 slice 6 item F. The plan builder's own cases are in
   * settings-station-reset.test.ts; these assert the wiring — the button
   * reflects the plan, names it in the dialog, and confirming reaches the
   * device store once per listed key.
   */
  describe('Restore device defaults', () => {
    function button() {
      return screen.getByRole('button', {
        name: 'Restore device defaults',
      }) as HTMLButtonElement;
    }

    test('is refused, and says so, on a device that has changed nothing', async () => {
      deviceChatFontSize = null as unknown as number;
      await renderSettings();
      expect(button().disabled).toBe(true);
      // Scoped to what the plan computes (PREFERENCE_DEVICE_KEYS), not to
      // every setting the device holds.
      expect(
        screen.getByText(
          'Every setting you can restore here is already at its default.',
        ),
      ).toBeTruthy();
    });

    test('names exactly the changed settings and restores each one', async () => {
      // This device follows its defaults everywhere except the chat font.
      deviceChatFontSize = 20;
      await renderSettings();
      expect(button().disabled).toBe(false);

      fireEvent.click(button());
      const dialog = screen.getByText(/This restores 1 setting on this device/);
      expect(dialog.textContent).toContain('Chat font size');
      // Not a list of everything: a plan that over-reported would promise to
      // undo choices nobody made.
      expect(dialog.textContent).not.toContain('Theme');
      expect(dialog.textContent).not.toContain('Chat dock height');

      fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
      // One envelope write for the whole plan, not one per key.
      expect(resetDeviceSettings.mock.calls).toEqual([[['chatFontSize']]]);
    });

    test('a multi-setting plan reads as plural in the dialog', async () => {
      deviceChatFontSize = 20;
      deviceFeatureSettings = {
        ...DEFAULT_DEVICE_FEATURE_SETTINGS,
        mobilePairingEnabled: true,
      };
      await renderSettings();

      fireEvent.click(button());
      const dialog = screen.getByText(
        /This restores 2 settings on this device to their defaults/,
      );
      // The composite names the member a reader would not expect it to
      // restore.
      expect(dialog.textContent).toContain(
        'Features, including notification sounds',
      );
    });

    test('cancelling restores nothing', async () => {
      deviceChatFontSize = 20;
      await renderSettings();
      fireEvent.click(button());
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(resetDeviceSettings).not.toHaveBeenCalled();
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
      // #2144 slice 7: a plain Station row inside the box captioned "Saved
      // to this Station" prints NO scope chip — the caption said it once for
      // the whole box. The project-overridden row above still says Project,
      // because that IS a difference from the caption.
      const stationRow = screen
        .getByLabelText('Registry URL')
        .closest('.page-row')!;
      expect(
        stationRow.querySelector('.setting-row-status')!.textContent,
      ).not.toContain('Station');
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

      // One edit per draft, so each half has its own witness.
      fireEvent.change(workspace, { target: { value: 'shared' } });
      const registry = screen.getByLabelText(
        'Registry URL',
      ) as HTMLInputElement;
      fireEvent.change(registry, { target: { value: 'https://two.test' } });
      expect(screen.getByText('Unsaved changes')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

      // The project row is back to its SAVED override and the Station row is
      // back to `savedConfig`; the pill going means BOTH drafts are empty,
      // not merely that one of them is.
      await waitFor(() => expect(workspace.value).toBe('worktree'));
      expect(registry.value).toBe('');
      expect(screen.queryByText('Unsaved changes')).toBeNull();
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

    test('a project refetch that never settles still lets Save finish', async () => {
      configSnapshot = {
        config: { ...INITIAL_CONFIG, defaultWorkspaceIsolation: 'shared' },
        dataUpdatedAt: 1,
      };
      projectRecord = { slug: 'atlas' };
      // The write LANDS; only the re-read never comes back. Waiting on it
      // happens after the save deadline's race is already decided, so
      // without its own deadline `Save` would spin with nothing left to
      // wait for.
      invalidateQuery.mockImplementation((key) =>
        Array.isArray(key) && key[0] === 'projects'
          ? new Promise<void>(() => {})
          : Promise.resolve(),
      );
      await renderSettings();

      selectAtlas();
      fireEvent.change(screen.getByLabelText(WORKSPACE_ROW), {
        target: { value: 'worktree' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(updateProjectAsync).toHaveBeenCalledTimes(1));
      // The button comes back and the draft clears against a record this page
      // never re-read. This exercises the SLOW case only: the invalidation
      // never settles, so the deadline is what releases Save. A refetch that
      // FAILS settles on its own (errors included) and never reaches the
      // deadline, yet leaves the same picture — the pre-save value with no
      // pill and no error until something else refetches the project. That
      // gap is the accepted cost of not stranding Save forever.
      await waitFor(
        () => expect(screen.queryByText('Unsaved changes')).toBeNull(),
        { timeout: 8000 },
      );
    }, 20000);

    test('a clean override draft issues no project write, however dirty the Station draft is', async () => {
      configSnapshot = {
        config: { ...INITIAL_CONFIG, registryUrl: 'https://one.test' },
        dataUpdatedAt: 1,
      };
      // Settled, and carrying a real override — so "nothing was sent" cannot
      // be explained by an unread record or by there being nothing to send.
      projectRecord = { slug: 'atlas', defaultWorkspaceIsolation: 'worktree' };
      projectProvenance = {
        defaultWorkspaceIsolation: { source: 'file', scope: 'project' },
      };
      updateConfig.mockResolvedValueOnce({ data: {} });
      await renderSettings();

      selectAtlas();
      const workspace = screen.getByLabelText(
        WORKSPACE_ROW,
      ) as HTMLSelectElement;
      await waitFor(() => expect(workspace.value).toBe('worktree'));

      // Touched and put BACK. An untouched row would make "no project write"
      // true by construction; this reaches the delta's equality
      // normalisation, which is the thing that has to hold.
      fireEvent.change(workspace, { target: { value: 'shared' } });
      expect(screen.getByText('Unsaved changes')).toBeTruthy();
      fireEvent.change(workspace, { target: { value: 'worktree' } });

      fireEvent.change(screen.getByLabelText('Registry URL'), {
        target: { value: 'https://two.test' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(updateConfig).toHaveBeenCalledTimes(1));
      expect(updateConfig).toHaveBeenCalledWith({
        registryUrl: 'https://two.test',
      });
      // Re-writing an unchanged override would restate the project's values
      // on every unrelated Station save.
      expect(updateProjectAsync).not.toHaveBeenCalled();
    });

    test('an unsaved override makes the row’s own popover say so', async () => {
      // The whole path, once: SettingsView derives the pending map,
      // StationConfigSection routes it per key, registry-row hands it to the
      // status strip, and the lazily-loaded layer list withholds its "in
      // effect" claim. Every layer of that is unit-tested; nothing else
      // proves they are actually wired to each other.
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

      const trigger = within(workspace.closest('.page-row')!).getByRole(
        'button',
        { name: `Where ${WORKSPACE_ROW} comes from` },
      );

      // Saved state first: the project layer is claimed as in effect.
      fireEvent.click(trigger);
      expect(await screen.findByText('in effect')).toBeTruthy();
      fireEvent.click(trigger);

      fireEvent.change(workspace, { target: { value: 'shared' } });
      fireEvent.click(trigger);
      expect(
        await screen.findByText(
          'Unsaved change: the layers above describe what is saved.',
        ),
      ).toBeTruthy();
      expect(screen.queryByText('in effect')).toBeNull();
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
