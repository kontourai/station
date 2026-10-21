/** @vitest-environment jsdom */
import type {
  AccountPreferencesPatch,
  AccountPreferencesView,
} from '@kontourai/station-contracts/account-preferences';
import { StationHttpError } from '@kontourai/station-sdk/client';
import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Toggle } from '../../components/Toggle';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import {
  readModelPickerPreferences,
  updateModelPickerPreferences,
} from '../../settings/modelPickerPreferences';
import { AccountPreferencesSection } from '../../views/settings/AccountPreferencesSection';
import { SettingsPageRow } from '../../views/settings/SettingsPageRow';
import { settingsRow } from '../../views/settings/settings-catalog';
import { AccountPreferencesProvider } from '../AccountPreferencesProvider';
import { activeChatsStore } from '../active-chats-store';
import {
  useDeviceSettings,
  useDeviceSettingsActions,
} from '../DeviceSettingsContext';

const fixture = vi.hoisted(() => ({
  namespace: 'person-a' as string | null,
  status: undefined as 'verified' | 'unverified' | 'unavailable' | undefined,
  refused: false,
  get: vi.fn<(...args: unknown[]) => Promise<AccountPreferencesView>>(),
  patch: vi.fn<(...args: unknown[]) => Promise<AccountPreferencesView>>(),
  scope: { isCurrent: () => true, apiBase: 'https://station.test' },
}));
vi.mock('@kontourai/station-sdk/client', async (original) => ({
  ...(await original<typeof import('@kontourai/station-sdk/client')>()),
  getAccountPreferences: (...args: unknown[]) => fixture.get(...args),
  patchAccountPreferences: (...args: unknown[]) => fixture.patch(...args),
}));
vi.mock('../ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'https://station.test' }),
  useHostRequestAuthorityScope: () => fixture.scope,
}));
vi.mock('../AuthorityPersistenceContext', () => ({
  useAuthorityPersistence: () => ({
    status: fixture.status ?? (fixture.namespace ? 'verified' : 'unverified'),
    refused: fixture.refused,
    namespace: fixture.namespace,
    observation: {
      principal: { kind: 'human', id: `human:fixture:${fixture.namespace}` },
    },
  }),
}));

function Probe() {
  const settings = useDeviceSettings();
  const { setDeviceSetting } = useDeviceSettingsActions();
  return (
    <>
      <output aria-label="Current theme">{settings.theme}</output>
      <button type="button" onClick={() => setDeviceSetting('theme', 'light')}>
        Choose light
      </button>
      <AccountPreferencesSection />
      <SettingsPageRow {...settingsRow('theme')} control={null} />
      <SettingsPageRow
        {...settingsRow('smooth-answer-reveal')}
        control={null}
      />
      <SettingsPageRow
        {...settingsRow('diff-wrap')}
        control={
          <Toggle
            label="Diff line wrap"
            checked={settings.diffWrap}
            onChange={(enabled) => setDeviceSetting('diffWrap', enabled)}
          />
        }
      />
    </>
  );
}
function tree(client: QueryClient) {
  return (
    <QueryClientProvider client={client}>
      <AccountPreferencesProvider>
        <Probe />
      </AccountPreferencesProvider>
    </QueryClientProvider>
  );
}
const clients: QueryClient[] = [];
beforeEach(() => {
  localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  fixture.namespace = 'person-a';
  fixture.status = undefined;
  fixture.refused = false;
  fixture.get
    .mockReset()
    .mockResolvedValue({ schemaVersion: 1, values: { theme: 'dark' } });
  fixture.patch.mockReset();
});
afterEach(() => {
  onlineManager.setOnline(true);
  for (const client of clients.splice(0)) client.clear();
});
function client() {
  const result = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(result);
  return result;
}

test('a real preference control saves account scope and preserves device storage; failure keeps the saved value', async () => {
  const qc = client();
  const view = render(tree(qc));
  await screen.findByRole('button', { name: 'Choose light' });
  const local = localStorage.getItem('station-device-settings-v1');
  fixture.patch.mockResolvedValueOnce({
    schemaVersion: 1,
    values: { theme: 'light' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Choose light' }));
  await waitFor(() =>
    expect(screen.getByLabelText('Current theme').textContent).toBe('light'),
  );
  expect(fixture.patch.mock.calls[0]?.[1]).toEqual({ theme: 'light' });
  expect(localStorage.getItem('station-device-settings-v1')).toBe(local);
  fixture.patch.mockRejectedValueOnce(new Error('Offline'));
  fireEvent.change(screen.getByLabelText('New codex chats approval mode'), {
    target: { value: 'auto' },
  });
  await screen.findByRole('alert');
  expect(
    (
      screen.getByLabelText(
        'New codex chats approval mode',
      ) as HTMLSelectElement
    ).value,
  ).toBe('connection-default');
  expect(screen.getByLabelText('Current theme').textContent).toBe('light');
  view.unmount();
});

test('switching accounts quarantines a late read and cannot import the previous account into the next', async () => {
  let finishA!: (value: AccountPreferencesView) => void;
  fixture.get.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishA = resolve;
      }),
  );
  const qc = client();
  const view = render(tree(qc));
  await waitFor(() => expect(fixture.get).toHaveBeenCalledTimes(1));
  fixture.namespace = 'person-b';
  fixture.get.mockResolvedValueOnce({
    schemaVersion: 1,
    values: { theme: 'dark' },
  });
  view.rerender(tree(qc));
  await screen.findByRole('button', { name: 'Choose light' });
  await act(async () =>
    finishA({ schemaVersion: 1, values: { theme: 'light' } }),
  );
  expect(screen.getByLabelText('Current theme').textContent).toBe('dark');
  expect(fixture.patch).not.toHaveBeenCalled();
  view.unmount();
});

test('previous preferences import is explicit and cannot overwrite a saved account choice or copy hardware state', async () => {
  deviceSettingsStore.merge({
    theme: 'light',
    diffWrap: true,
    chatDockWidth: 600,
    ttsProvider: 'device-voice',
  });
  fixture.patch.mockImplementation(
    async (_base, input) =>
      ({
        schemaVersion: 1,
        values: { theme: 'dark', ...(input as AccountPreferencesPatch) },
      }) as AccountPreferencesView,
  );
  const view = render(tree(client()));
  await screen.findByRole('button', { name: 'Import previous preferences' });
  expect(fixture.patch).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole('button', { name: 'Import previous preferences' }),
  );
  await waitFor(() => expect(fixture.patch).toHaveBeenCalledTimes(1));
  expect(fixture.patch.mock.calls[0]?.[1]).toEqual({ diffWrap: true });
  view.unmount();
  expect(deviceSettingsStore.get('chatDockWidth')).toBe(600);
  expect(deviceSettingsStore.get('ttsProvider')).toBe('device-voice');
});

test('rapid favorite actions compose while the first save is pending', async () => {
  const empty = { favorites: [], recents: [], hidden: [], order: [] };
  fixture.get.mockResolvedValueOnce({
    schemaVersion: 1,
    values: { modelPickerPreferences: empty },
    revision: 'initial',
  });
  let finishFirst!: (value: AccountPreferencesView) => void;
  fixture.patch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishFirst = resolve;
      }),
  );
  fixture.patch.mockImplementationOnce(async (_base, patch) => ({
    schemaVersion: 1,
    values: patch as AccountPreferencesView['values'],
    revision: 'second',
  }));
  const view = render(tree(client()));
  await screen.findByRole('button', { name: 'Choose light' });
  act(() => {
    updateModelPickerPreferences((value) => ({
      ...value,
      favorites: [...value.favorites, 'a'],
    }));
    updateModelPickerPreferences((value) => ({
      ...value,
      favorites: [...value.favorites, 'b'],
    }));
  });
  await waitFor(() => expect(fixture.patch).toHaveBeenCalledTimes(1));
  expect(readModelPickerPreferences().favorites).toEqual(['a', 'b']);
  await act(async () =>
    finishFirst({
      schemaVersion: 1,
      values: { modelPickerPreferences: { ...empty, favorites: ['a'] } },
      revision: 'first',
    }),
  );
  await waitFor(() => expect(fixture.patch).toHaveBeenCalledTimes(2));
  expect(fixture.patch.mock.calls[1]?.[1]).toMatchObject({
    modelPickerPreferences: { favorites: ['a', 'b'] },
  });
  expect(fixture.patch.mock.calls[1]?.[2]).toMatchObject({
    headers: { 'If-Match': 'first' },
  });
  await waitFor(() =>
    expect(readModelPickerPreferences().favorites).toEqual(['a', 'b']),
  );
  view.unmount();
});

test('a cached mount re-reads saved preferences even when the app default disables refetchOnMount', async () => {
  const qc = client();
  qc.setDefaultOptions({ queries: { retry: false, refetchOnMount: false } });
  qc.setQueryData(['account-preferences', 'person-a', undefined], {
    schemaVersion: 1,
    values: { theme: 'light' },
  });
  fixture.get.mockResolvedValueOnce({
    schemaVersion: 1,
    values: { theme: 'dark' },
  });
  const view = render(tree(qc));
  await waitFor(() => expect(fixture.get).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(screen.getByLabelText('Current theme').textContent).toBe('dark'),
  );
  view.unmount();
});

test('unknown authority holds an inherited choice; a different verified account retires it', async () => {
  activeChatsStore.initChat('inherited-default');
  activeChatsStore.updateChat('inherited-default', {
    queuedApprovalMode: 'never',
    queuedApprovalDefaultNamespace: 'person-a',
  });
  fixture.namespace = null;
  const qc = client();
  const view = render(tree(qc));
  expect(
    activeChatsStore.getSnapshot()['inherited-default']?.queuedApprovalMode,
  ).toBe('never');
  fixture.namespace = 'person-b';
  view.rerender(tree(qc));
  await screen.findByRole('button', { name: 'Choose light' });
  expect(
    activeChatsStore.getSnapshot()['inherited-default']?.queuedApprovalMode,
  ).toBeUndefined();
  view.unmount();
});

test('value controls can reset while boolean preferences use their toggle without changing the device record', async () => {
  deviceSettingsStore.merge({ theme: 'light' });
  fixture.get.mockResolvedValueOnce({
    schemaVersion: 1,
    values: {
      theme: 'light',
      smoothReveal: true,
      bufferedDelivery: true,
      diffWrap: true,
    },
  });
  fixture.patch
    .mockResolvedValueOnce({
      schemaVersion: 1,
      values: { smoothReveal: true, bufferedDelivery: true, diffWrap: true },
    })
    .mockResolvedValueOnce({ schemaVersion: 1, values: { diffWrap: true } })
    .mockResolvedValueOnce({ schemaVersion: 1, values: { diffWrap: false } });
  const view = render(tree(client()));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Reset Theme to default' }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText('Current theme').textContent).toBe('dark'),
  );
  expect(
    screen.queryByRole('button', { name: 'Reset Diff line wrap to default' }),
  ).toBeNull();
  expect(fixture.patch.mock.calls[0]?.[1]).toEqual({ theme: null });
  fireEvent.click(
    screen.getByRole('button', { name: 'Reset Answer delivery to default' }),
  );
  await waitFor(() => expect(fixture.patch).toHaveBeenCalledTimes(2));
  expect(fixture.patch.mock.calls[1]?.[1]).toEqual({
    smoothReveal: null,
    bufferedDelivery: null,
  });
  await waitFor(() =>
    expect(
      screen.queryByRole('button', {
        name: 'Reset Answer delivery to default',
      }),
    ).toBeNull(),
  );
  fireEvent.click(screen.getByRole('switch', { name: 'Diff line wrap' }));
  await waitFor(() =>
    expect(
      screen
        .getByRole('switch', { name: 'Diff line wrap' })
        .getAttribute('aria-checked'),
    ).toBe('false'),
  );
  expect(fixture.patch.mock.calls[2]?.[1]).toEqual({ diffWrap: false });
  view.unmount();
  // The device record is untouched. (The resolved theme right after the
  // boundary unmounts is the account's, held until a definite no-person
  // answer; releasing it shows the device record again.)
  expect(deviceSettingsStore.getEnvelope().values.theme).toBe('light');
  deviceSettingsStore.releaseBootAppearance();
  expect(deviceSettingsStore.get('theme')).toBe('light');
});

test('an offline preference waits visibly and saves after reconnect', async () => {
  const view = render(tree(client()));
  await screen.findByRole('button', { name: 'Choose light' });
  onlineManager.setOnline(false);
  fireEvent.click(screen.getByRole('button', { name: 'Choose light' }));
  await screen.findByText('Waiting for connection. Changes aren’t saved yet.');
  expect(fixture.patch).not.toHaveBeenCalled();
  fixture.patch.mockResolvedValueOnce({
    schemaVersion: 1,
    values: { theme: 'light' },
  });
  act(() => onlineManager.setOnline(true));
  await waitFor(() => expect(fixture.patch).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(screen.queryByText('Saving account preferences…')).toBeNull(),
  );
  expect(screen.getByLabelText('Current theme').textContent).toBe('light');
  view.unmount();
});

test('a cross-device conflict explains recovery and reloads the saved choice', async () => {
  fixture.patch.mockRejectedValueOnce(new StationHttpError(409));
  const view = render(tree(client()));
  await screen.findByRole('button', { name: 'Choose light' });
  act(() => {
    updateModelPickerPreferences((value) => ({
      ...value,
      favorites: ['stale-choice'],
    }));
  });
  await screen.findByText(
    'Changed on another device. Reload before trying again.',
  );
  fixture.get.mockResolvedValueOnce({
    schemaVersion: 1,
    values: {
      modelPickerPreferences: {
        favorites: ['other-device'],
        hidden: [],
        order: [],
        recents: [],
      },
    },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Reload saved preferences' }),
  );
  await waitFor(() =>
    expect(readModelPickerPreferences().favorites).toEqual(['other-device']),
  );
  expect(
    screen.queryByText(
      'Changed on another device. Reload before trying again.',
    ),
  ).toBeNull();
  view.unmount();
});

test("only a refused credential releases the previous account's cached appearance; pending and unverified authority keep it", () => {
  const seed = () => {
    localStorage.setItem(
      'station-appearance-v1',
      JSON.stringify({
        version: 1,
        source: 'account',
        theme: 'light',
        colorTheme: 'nord',
        colorThemeFlavor: null,
        colorThemeAccent: null,
      }),
    );
    deviceSettingsStore.reloadFromStorage();
  };
  fixture.namespace = null;
  // Offline or an older server, and a native relay account not ready yet (no
  // request scope, reported 'unavailable'): possibly the same person.
  for (const status of ['unverified', 'unavailable'] as const) {
    seed();
    fixture.status = status;
    fixture.refused = false;
    const view = render(tree(client()));
    expect(deviceSettingsStore.getAppearanceSource(), status).toBe('cache');
    expect(screen.getByLabelText('Current theme').textContent).toBe('light');
    view.unmount();
  }
  // A 401: no person.
  seed();
  fixture.status = 'unavailable';
  fixture.refused = true;
  const view = render(tree(client()));
  expect(deviceSettingsStore.getAppearanceSource()).toBe('device');
  expect(screen.getByLabelText('Current theme').textContent).toBe('dark');
  view.unmount();
});

test('a dropped connection that remounts the account boundary keeps the account appearance throughout', async () => {
  // AuthorityQueryProvider swaps its subtree for "Checking Station access"
  // while it re-observes after a network blip, unmounting this boundary, then
  // remounts it and the preferences refetch. Nothing in that is "no person":
  // mode and color theme stay the account's the whole way.
  fixture.get.mockResolvedValue({
    schemaVersion: 1,
    values: { theme: 'light', colorTheme: 'catppuccin' },
  });
  const seen = () => {
    const { theme, colorTheme } = deviceSettingsStore.getSnapshot();
    return { theme, colorTheme };
  };
  const qc = client();
  const view = render(tree(qc));
  await screen.findByRole('button', { name: 'Choose light' });
  await waitFor(() =>
    expect(seen()).toEqual({ theme: 'light', colorTheme: 'catppuccin' }),
  );
  expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  // The blip: the boundary is gone.
  view.unmount();
  expect(seen()).toEqual({ theme: 'light', colorTheme: 'catppuccin' });
  // Back, with the preferences still loading.
  let answer: (value: AccountPreferencesView) => void = () => {};
  fixture.get.mockImplementation(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  const again = render(tree(client()));
  expect(seen()).toEqual({ theme: 'light', colorTheme: 'catppuccin' });
  expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  await act(async () =>
    answer({
      schemaVersion: 1,
      values: { theme: 'light', colorTheme: 'catppuccin' },
    }),
  );
  await screen.findByRole('button', { name: 'Choose light' });
  expect(seen()).toEqual({ theme: 'light', colorTheme: 'catppuccin' });
  again.unmount();
  deviceSettingsStore.releaseBootAppearance();
});

test('a held appearance belongs to its account: switching person drops it', async () => {
  fixture.get.mockResolvedValue({
    schemaVersion: 1,
    values: { theme: 'light', colorTheme: 'catppuccin' },
  });
  const seen = () => {
    const { theme, colorTheme } = deviceSettingsStore.getSnapshot();
    return { theme, colorTheme };
  };
  const view = render(tree(client()));
  await waitFor(() =>
    expect(seen()).toEqual({ theme: 'light', colorTheme: 'catppuccin' }),
  );
  view.unmount();
  // Person B's preferences never arrive.
  fixture.namespace = 'person-b';
  fixture.get.mockRejectedValue(new Error('preferences unavailable'));
  const other = render(tree(client()));
  // B never sees A's appearance; B has the device's own until B's arrive.
  expect(seen()).toEqual({ theme: 'dark', colorTheme: 'station' });
  await waitFor(() => expect(fixture.get).toHaveBeenCalled());
  expect(seen()).toEqual({ theme: 'dark', colorTheme: 'station' });
  expect(deviceSettingsStore.getAppearanceSource()).not.toBe('cache');
  other.unmount();
});
