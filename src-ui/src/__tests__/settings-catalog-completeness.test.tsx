/** @vitest-environment jsdom */

import { DEFAULT_NOTIFICATION_SOUND_PREFERENCES } from '@kontourai/station-contracts/device-settings';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  SETTINGS_CATALOG,
  visibleCatalogIds,
} from '../views/settings/settings-catalog';

vi.mock('@kontourai/station-connect', () => ({
  QRDisplay: () => <div />,
  useConnections: () => ({ activeConnection: { name: 'Local' } }),
  useHostUrl: () => ({ hostUrl: 'http://station.test', isDetecting: false }),
}));
vi.mock('@kontourai/station-sdk', () => ({
  authenticatedFetch: vi.fn(),
  StationReadOnlyError: class extends Error {},
  useAgentConnectionsQuery: () => ({ data: [] }),
  useAnswerSharesQuery: () => ({ data: [] }),
  useRevokeAnswerShareMutation: () => ({ mutate: vi.fn(), isError: false }),
  useConfigProvenanceQuery: () => ({ data: {} }),
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
}));
const updateConfig = vi.fn();
const INITIAL_CONFIG = { logLevel: 'info', templateVariables: [] };
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
vi.mock('../contexts/DeviceSettingsContext', () => ({
  useDeviceSettings: () => ({
    chatFontSize: 14,
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
  useDeviceSettingsActions: () => ({ setDeviceSetting: vi.fn() }),
}));
let isMobile = false;
vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ isMobile }),
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
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
    updateConfig.mockReset();
    updateAppLogLevel.mockReset();
    configSnapshot = { config: { ...INITIAL_CONFIG }, dataUpdatedAt: 1 };
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

  // Review M2. `useConfigSnapshot` logged the config query's error and
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
    const expected = visibleCatalogIds({ isMobile: false });
    expectExactCatalog(rendered, expected);
    // 37 at the merge base; +2 from station#3313 (feature-previews,
    // enable-developer-tools) and +1 from the chat-dock lane's
    // sidebar-sections. Counted from the merged catalog, not added up.
    expect(SETTINGS_CATALOG).toHaveLength(40);
  });

  test('the rendered mobile Settings view and catalog enumerate the same exact ids', async () => {
    isMobile = true;
    const rendered = await renderedCatalogIds();
    const expected = visibleCatalogIds({ isMobile: true });
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

  // station#3313 review: nothing pinned that `?view=` resolves at all. The
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
    expectExactCatalog(rendered, visibleCatalogIds({ isMobile: false }));
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

  test('opens the Defaults disclosure before focusing a deep-linked editable field', async () => {
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
    expect(
      container.querySelector<HTMLDetailsElement>('.agent-defaults__disclosure')
        ?.open,
    ).toBe(true);
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
