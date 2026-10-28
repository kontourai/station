/** @vitest-environment jsdom */
import type { SavedConnection } from '@kontourai/station-connect';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { StationSwitcherMenu } from '../components/header/StationSwitcherMenu';
import { navigationStore } from '../contexts/navigation-store';
import { toastStore } from '../contexts/ToastContext';
import { forgetStationProbe, recordStationUse } from '../lib/stationSwitcher';

const station: SavedConnection = {
  profileVersion: 4,
  id: 'one',
  name: 'Workstation',
  url: 'https://one.example.test',
  endpoints: [
    {
      endpointVersion: 1,
      id: 'one-endpoint',
      url: 'https://one.example.test',
      kind: 'manual',
      priority: 0,
    },
  ],
  selectedEndpointId: 'one-endpoint',
  accessMethods: [
    {
      accessVersion: 1,
      id: 'one-access',
      kind: 'direct-http',
      endpointId: 'one-endpoint',
    },
  ],
  selectedAccessMethodId: 'one-access',
  environmentId: null,
  authProtocolVersion: null,
  credentialRef: {
    credentialVersion: 1,
    kind: 'connection',
    id: 'one-credential',
  },
  capabilities: null,
  credentialState: 'saved',
};
const laptop: SavedConnection = {
  ...station,
  id: 'two',
  credentialRef: {
    credentialVersion: 1,
    kind: 'connection',
    id: 'two-credential',
  },
  name: 'Laptop',
  url: 'https://two.example.test',
  endpoints: [
    {
      endpointVersion: 1,
      id: 'two-endpoint',
      url: 'https://two.example.test',
      kind: 'manual',
      priority: 0,
    },
  ],
  selectedEndpointId: 'two-endpoint',
  accessMethods: [
    {
      accessVersion: 1,
      id: 'two-access',
      kind: 'direct-http',
      endpointId: 'two-endpoint',
    },
  ],
  selectedAccessMethodId: 'two-access',
};
const unregister: Array<() => void> = [];
const reachable = new Set<string>();
const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const origin = new URL(String(input)).origin;
  if (reachable.has(origin)) return new Response(null, { status: 200 });
  throw new TypeError('Failed to fetch');
});
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  unregister.splice(0).forEach((remove) => remove());
  for (const connection of [station, laptop, ...extras])
    forgetStationProbe(connection.url);
  reachable.clear();
  fetchMock.mockClear();
  vi.unstubAllGlobals();
});

function named(id: string, name: string): SavedConnection {
  const url = `https://${id}.example.test`;
  return {
    ...laptop,
    id,
    name,
    url,
    endpoints: [{ ...laptop.endpoints[0], id: `${id}-endpoint`, url }],
    selectedEndpointId: `${id}-endpoint`,
  };
}
const extras = [
  named('three', 'Build box'),
  named('four', 'Media server'),
  named('five', 'Old dev'),
];

function openMenu(
  connections: SavedConnection[] = [station, laptop],
  forget = vi.fn(async (_connection: SavedConnection) => {}),
) {
  const anchor = document.createElement('button');
  document.body.append(anchor);
  anchor.focus();
  const select = vi.fn(async (_connection: SavedConnection) => {});
  const close = vi.fn();
  const manage = vi.fn();
  render(
    <StationSwitcherMenu
      anchor={anchor}
      connections={connections}
      activeConnectionId="one"
      activeStatus="connected"
      activeStatusLabel="Connected"
      onSelect={select}
      onForget={forget}
      onClose={close}
      onManage={manage}
    />,
  );
  unregister.push(() => anchor.remove());
  return { select, close, manage, forget };
}

function row(name: string | RegExp) {
  return screen.getByRole('menuitemradio', { name });
}

test('marks the current Station, reports peer reachability, and exposes management separately', async () => {
  reachable.add('https://two.example.test');
  const { select, manage } = openMenu();
  expect(row('Workstation — Connected').getAttribute('aria-checked')).toBe(
    'true',
  );
  expect(row('Laptop — Checking…')).toBeTruthy();
  expect(
    (
      await screen.findByRole('menuitemradio', { name: 'Laptop — Online' })
    ).getAttribute('aria-checked'),
  ).toBe('false');
  // Healthy peers carry the status in their name and dot, not visible text.
  expect(screen.queryByText('Online')).toBeNull();
  expect(screen.getByText('Connected')).toBeTruthy();
  // The active Station is not probed: its own status is already live.
  expect(fetchMock).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Manage Stations' }));
  expect(manage).toHaveBeenCalledOnce();
  expect(select).not.toHaveBeenCalled();
});

test('waits for the registered unsaved-work decision before switching', async () => {
  let proceed: (() => void) | undefined;
  unregister.push(
    navigationStore.registerNavigationGuard(Symbol('dirty-editor'), (next) => {
      proceed = next;
    }),
  );
  const { select, close } = openMenu();
  fireEvent.click(row(/^Laptop/));
  expect(proceed).toBeTypeOf('function');
  expect(select).not.toHaveBeenCalled();
  await act(async () => proceed?.());
  expect(select).toHaveBeenCalledExactlyOnceWith(laptop);
  expect(close).toHaveBeenCalledOnce();
});

test('cancelling an unsaved-work decision keeps the Station and permits another attempt', () => {
  let cancel: (() => void) | undefined;
  unregister.push(
    navigationStore.registerNavigationGuard(
      Symbol('dirty-editor'),
      (_next, cancelled) => {
        cancel = cancelled;
      },
    ),
  );
  const { select } = openMenu();
  fireEvent.click(row(/^Laptop/));
  act(() => cancel?.());
  expect(select).not.toHaveBeenCalled();
  expect(row(/^Laptop/).hasAttribute('disabled')).toBe(false);
});

test('lists the active Station first, then by recent use, and focuses the previous one', () => {
  recordStationUse('four');
  recordStationUse('two');
  recordStationUse('one');
  // Saved order is the reverse of use, so only recency can produce the order.
  openMenu([extras[0], laptop, station]);
  const names = screen
    .getAllByRole('menuitemradio')
    .map((item) => item.textContent);
  expect(names.map((name) => name?.replace(/Connected|✓/g, ''))).toEqual([
    'Workstation',
    'Laptop',
    'Build box',
  ]);
  // Below the filter threshold, focus lands on the previous Station, so the
  // switcher shortcut and Enter flip back.
  expect(document.activeElement).toBe(row(/^Laptop/));
});

test('filters by typing, and Enter switches to the best match', async () => {
  const { select } = openMenu([station, laptop, ...extras]);
  const filter = screen.getByRole('searchbox', { name: 'Find a Station' });
  expect(document.activeElement).toBe(filter);
  fireEvent.change(filter, { target: { value: 'media' } });
  expect(screen.getAllByRole('menuitemradio')).toHaveLength(1);
  fireEvent.keyDown(filter, { key: 'Enter' });
  await act(async () => {});
  expect(select).toHaveBeenCalledExactlyOnceWith(extras[1]);
  fireEvent.change(filter, { target: { value: 'nothing here' } });
  expect(screen.getByText('No matching Stations')).toBeTruthy();
});

test('removes a Station after an inline confirmation, never the active one', async () => {
  const { forget } = openMenu();
  expect(
    screen.queryByRole('button', { name: 'Remove Workstation' }),
  ).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Remove Laptop' }));
  expect(forget).not.toHaveBeenCalled();
  expect(screen.getByText('Remove from this device?')).toBeTruthy();
  fireEvent.click(
    screen.getByRole('button', { name: 'Confirm removing Laptop' }),
  );
  await act(async () => {});
  expect(forget).toHaveBeenCalledExactlyOnceWith(laptop);
  expect(screen.queryByRole('menuitemradio', { name: /^Laptop/ })).toBeNull();
});

test('Delete on a row arms its removal, and a refused removal keeps the row', async () => {
  const forget = vi.fn(async () => {
    throw new Error("This app's own Station cannot be forgotten.");
  });
  const show = vi.spyOn(toastStore, 'show');
  openMenu([station, laptop], forget);
  fireEvent.keyDown(row(/^Laptop/), { key: 'Delete' });
  const confirm = screen.getByRole('button', {
    name: 'Confirm removing Laptop',
  });
  expect(document.activeElement).toBe(confirm);
  fireEvent.click(confirm);
  await act(async () => {});
  expect(row(/^Laptop/)).toBeTruthy();
  expect(show.mock.calls[0]?.[0]).toContain(
    "Laptop: This app's own Station cannot be forgotten.",
  );
  show.mockRestore();
});

test('offers to remove every unreachable Station at once', async () => {
  reachable.add('https://three.example.test');
  const { forget } = openMenu([station, laptop, ...extras]);
  const bulk = await screen.findByRole('menuitem', {
    name: 'Remove 3 unreachable',
  });
  fireEvent.click(bulk);
  expect(forget).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole('menuitem', { name: 'Confirm: remove 3 Stations' }),
  );
  await act(async () => {});
  expect(forget.mock.calls.map(([connection]) => connection.name)).toEqual([
    'Laptop',
    'Media server',
    'Old dev',
  ]);
  expect(
    screen.getAllByRole('menuitemradio').map((item) => item.textContent),
  ).toHaveLength(2);
});
