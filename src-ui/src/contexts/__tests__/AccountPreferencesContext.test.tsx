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

test('personal display overrides can return to built-in defaults without changing the device record', async () => {
  deviceSettingsStore.merge({ theme: 'light' });
  fixture.get.mockResolvedValueOnce({
    schemaVersion: 1,
    values: { theme: 'light', smoothReveal: true, bufferedDelivery: true },
  });
  fixture.patch
    .mockResolvedValueOnce({
      schemaVersion: 1,
      values: { smoothReveal: true, bufferedDelivery: true },
    })
    .mockResolvedValueOnce({ schemaVersion: 1, values: {} });
  const view = render(tree(client()));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Use default for Theme' }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText('Current theme').textContent).toBe('dark'),
  );
  expect(fixture.patch.mock.calls[0]?.[1]).toEqual({ theme: null });
  fireEvent.click(
    screen.getByRole('button', { name: 'Use default for Answer delivery' }),
  );
  await waitFor(() => expect(fixture.patch).toHaveBeenCalledTimes(2));
  expect(fixture.patch.mock.calls[1]?.[1]).toEqual({
    smoothReveal: null,
    bufferedDelivery: null,
  });
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: 'Use default for Answer delivery' }),
    ).toBeNull(),
  );
  view.unmount();
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

test("a refused credential releases the previous account's cached appearance; an unverified authority keeps it", () => {
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
  // Offline or an older server: possibly the same person, so the cache holds.
  seed();
  fixture.namespace = null;
  fixture.status = 'unverified';
  let view = render(tree(client()));
  expect(deviceSettingsStore.getAppearanceSource()).toBe('cache');
  expect(screen.getByLabelText('Current theme').textContent).toBe('light');
  view.unmount();
  // A 401 (or no connection at all) reports 'unavailable': no person.
  seed();
  fixture.status = 'unavailable';
  view = render(tree(client()));
  expect(deviceSettingsStore.getAppearanceSource()).toBe('device');
  expect(screen.getByLabelText('Current theme').textContent).toBe('dark');
  view.unmount();
});
