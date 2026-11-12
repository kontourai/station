/** @vitest-environment jsdom */
import type { SavedConnection } from '@kontourai/station-connect';
import type { ManagedPolicySummary } from '@kontourai/station-contracts/managed-policy-status';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { StationSwitcherMenu } from '../components/header/StationSwitcherMenu';

// #4519: the managed limit, set per test.
const managed = vi.hoisted(() => ({
  limit: undefined as ManagedPolicySummary | undefined,
}));
vi.mock('../hooks/useManagedRemoteClientsRefusal', () => ({
  useManagedRemoteClientsLimit: () => managed.limit,
}));

import { navigationStore } from '../contexts/navigation-store';
import { toastStore } from '../contexts/ToastContext';
import { MOBILE_MEDIA_QUERY } from '../hooks/useIsMobile';
import {
  forgetStationProbe,
  isProbeable,
  probeStation,
  recordStationUse,
} from '../lib/stationSwitcher';

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
  canForget: (connection: SavedConnection) => boolean = () => true,
  select = vi.fn(async (_connection: SavedConnection) => {}),
  {
    activeDisplayName,
    onPairPhone,
    active = {},
  }: {
    activeDisplayName?: string;
    onPairPhone?: () => void;
    active?: Partial<
      Pick<
        ComponentProps<typeof StationSwitcherMenu>,
        | 'activeStatus'
        | 'activeStatusLabel'
        | 'activeReason'
        | 'activeCheckedAt'
      >
    >;
  } = {},
) {
  const anchor = document.createElement('button');
  document.body.append(anchor);
  anchor.focus();
  const close = vi.fn();
  const manage = vi.fn();
  render(
    <StationSwitcherMenu
      anchor={anchor}
      connections={connections}
      activeConnectionId="one"
      activeStatus="connected"
      activeStatusLabel="Connected"
      {...active}
      onSelect={select}
      onForget={forget}
      canForget={canForget}
      onClose={close}
      onManage={manage}
      onPairPhone={onPairPhone}
      activeDisplayName={activeDisplayName}
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
  // Until its probe answers, a peer says it is being checked.
  expect(row('Laptop — Checking…')).toBeTruthy();
  expect(
    (
      await screen.findByRole('menuitemradio', {
        name: 'Laptop — Online · checked just now',
      })
    ).getAttribute('aria-checked'),
  ).toBe('false');
  // Every row says its state in visible text, with when it was learned.
  expect(screen.getByText('Online')).toBeTruthy();
  expect(screen.getByText('· checked just now')).toBeTruthy();
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
    .map((item) => item.querySelector('.station-switcher__name')?.textContent);
  expect(names).toEqual(['Workstation', 'Laptop', 'Build box']);
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
  expect(screen.getByText('Nothing matches “nothing here”')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
  expect(screen.getAllByRole('menuitemradio')).toHaveLength(5);
});

test('removes a Station after an inline confirmation, never the active one', async () => {
  const { forget } = openMenu();
  expect(
    screen.queryByRole('menuitem', { name: 'Forget Workstation' }),
  ).toBeNull();
  const forgetLaptop = screen.getByRole('menuitem', { name: 'Forget Laptop' });
  fireEvent.click(forgetLaptop);
  expect(forget).not.toHaveBeenCalled();
  expect(forgetLaptop.textContent).toBe('Forget');
  expect(
    document.getElementById(forgetLaptop.getAttribute('aria-describedby') ?? '')
      ?.textContent,
  ).toBe('Forget on this device?');
  fireEvent.click(forgetLaptop);
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
  const confirm = screen.getByRole('menuitem', { name: 'Forget Laptop' });
  expect(confirm.textContent).toBe('Forget');
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
    name: 'Forget 3 unreachable',
  });
  fireEvent.click(bulk);
  expect(forget).not.toHaveBeenCalled();
  // The confirmation names what it will forget.
  fireEvent.click(
    screen.getByRole('menuitem', {
      name: 'Forget Laptop, Media server, Old dev?',
    }),
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

test('offers Forget only where it can succeed, and never mid-switch', async () => {
  let finishSwitch: () => void = () => {};
  const select = vi.fn(
    (_connection: SavedConnection) =>
      new Promise<void>((resolve) => {
        finishSwitch = resolve;
      }),
  );
  openMenu(
    [station, laptop, extras[0]],
    undefined,
    (connection) => connection.id !== 'three',
    select,
  );
  expect(
    screen.queryByRole('menuitem', { name: 'Forget Build box' }),
  ).toBeNull();
  expect(screen.getByRole('menuitem', { name: 'Forget Laptop' })).toBeTruthy();
  fireEvent.click(row(/^Laptop/));
  expect(select).toHaveBeenCalledOnce();
  expect(screen.queryByRole('menuitem', { name: 'Forget Laptop' })).toBeNull();
  expect(screen.queryByRole('menuitem', { name: /unreachable/ })).toBeNull();
  fireEvent.keyDown(row(/^Laptop/), { key: 'Delete' });
  expect(screen.queryByText('Forget on this device?')).toBeNull();
  await act(async () => finishSwitch());
});

test('Escape backs out of an armed Forget before it closes the menu', () => {
  const { close } = openMenu();
  fireEvent.keyDown(row(/^Laptop/), { key: 'Delete' });
  expect(screen.getByText('Forget on this device?')).toBeTruthy();
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: 'Escape',
  });
  expect(screen.queryByText('Forget on this device?')).toBeNull();
  expect(close).not.toHaveBeenCalled();
  fireEvent.keyDown(document.body, { key: 'Escape' });
  expect(close).toHaveBeenCalledOnce();
});

test('Space stays on its row to activate it, while a letter goes to the filter', async () => {
  const { select } = openMenu([station, laptop, ...extras]);
  const laptopRow = row(/^Laptop/);
  laptopRow.focus();
  fireEvent.keyDown(laptopRow, { key: ' ' });
  expect(document.activeElement).toBe(laptopRow);
  fireEvent.keyDown(laptopRow, { key: 'b' });
  expect(document.activeElement).toBe(
    screen.getByRole('searchbox', { name: 'Find a Station' }),
  );
  expect(select).not.toHaveBeenCalled();
});

test('a touch screen opens on the previous Station, not the filter keyboard', () => {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query === '(pointer: coarse)',
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
  recordStationUse('two');
  recordStationUse('one');
  openMenu([station, laptop, ...extras]);
  expect(document.activeElement).toBe(row(/^Laptop/));
});

test('reuses an answer, but re-checks a Station that did not answer', async () => {
  reachable.add('https://two.example.test');
  const first = await probeStation(laptop.url);
  expect(first.reachability).toBe('online');
  // A reused answer keeps the time it was learned.
  expect(await probeStation(laptop.url)).toBe(first);
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(await probeStation(extras[0].url)).toMatchObject({
    reachability: 'unreachable',
    failure: 'network',
  });
  reachable.add('https://three.example.test');
  expect((await probeStation(extras[0].url)).reachability).toBe('online');
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

test('the forget prompt is announced for a Station whose name has spaces', () => {
  // Desktop ids embed the Station name, so they can contain spaces, which an
  // id reference list would split.
  const spaced = {
    ...named('three', 'Old dev instance'),
    id: 'station-profile:old dev instance',
  };
  openMenu([station, spaced]);
  fireEvent.keyDown(row(/^Old dev instance/), { key: 'Delete' });
  const confirm = screen.getByRole('menuitem', {
    name: 'Forget Old dev instance',
  });
  const ids = (confirm.getAttribute('aria-describedby') ?? '').split(' ');
  expect(ids).toHaveLength(1);
  expect(document.getElementById(ids[0] ?? '')?.textContent).toBe(
    'Forget on this device?',
  );
});

test('never switches to a Station that is not running', () => {
  const stopped: SavedConnection = {
    ...named('local', 'Local Station'),
    injected: true,
    injectedStatus: 'stopped',
  };
  const { select } = openMenu([station, laptop, extras[0], extras[1], stopped]);
  const filter = screen.getByRole('searchbox', { name: 'Find a Station' });
  fireEvent.change(filter, { target: { value: 'local' } });
  fireEvent.keyDown(filter, { key: 'Enter' });
  expect(select).not.toHaveBeenCalled();
});

test('a touch screen keeps the keyboard down even when the previous Station is not running', () => {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query === '(pointer: coarse)',
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
  const stopped: SavedConnection = {
    ...named('local', 'Local Station'),
    injected: true,
    injectedStatus: 'stopped',
  };
  openMenu([station, stopped, ...extras]);
  expect(document.activeElement).not.toBe(
    screen.getByRole('searchbox', { name: 'Find a Station' }),
  );
  expect(document.activeElement).toBe(row(/^Build box/));
});

test('an HTTPS page does not probe a plain-HTTP address it could not reach', () => {
  const lan = named('lan', 'LAN box');
  expect(
    isProbeable({ ...lan, url: 'http://192.168.1.20:3141' }, 'https:'),
  ).toBe(false);
  expect(isProbeable({ ...lan, url: 'http://127.0.0.1:3141' }, 'https:')).toBe(
    true,
  );
  expect(
    isProbeable({ ...lan, url: 'http://192.168.1.20:3141' }, 'http:'),
  ).toBe(true);
  expect(
    isProbeable({ ...lan, url: 'https://lan.example.test' }, 'https:'),
  ).toBe(true);
});

test('arrow keys step between Stations, beside a filter that sits outside the menu', () => {
  recordStationUse('two');
  recordStationUse('one');
  openMenu([station, laptop, ...extras]);
  const menu = screen.getByRole('menu', { name: 'Choose Station' });
  // A menu may own only its items; the filter is its sibling.
  expect(
    menu.contains(screen.getByRole('searchbox', { name: 'Find a Station' })),
  ).toBe(false);
  const laptopRow = row(/^Laptop/);
  laptopRow.focus();
  fireEvent.keyDown(laptopRow, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(row(/^Build box/));
});

/**
 * Duo audit: the header chip named the seeded Station "Kontour" (its host,
 * #4402) while this menu, opened from that chip, named the same Station
 * "Default". The chip hands the menu the name it shows; every other row,
 * whose host this device has not heard from, keeps its saved name.
 */
test('names the active seeded Station the way the chip does', () => {
  openMenu(
    [
      { ...station, name: 'Default' },
      { ...laptop, name: 'Default' },
    ],
    undefined,
    undefined,
    undefined,
    { activeDisplayName: 'Kontour' },
  );
  expect(row('Kontour — Connected').getAttribute('aria-checked')).toBe('true');
  expect(screen.getByText('Kontour')).toBeTruthy();
  // The peer's host is unknown here, so it keeps its saved name.
  expect(row(/^Default/).getAttribute('aria-checked')).toBe('false');
});

test('a phone offers to connect another device, not to pair a phone', () => {
  const pair = vi.fn();
  openMenu(undefined, undefined, undefined, undefined, { onPairPhone: pair });
  expect(screen.getByRole('menuitem', { name: 'Pair phone' })).toBeTruthy();
  cleanup();
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query === MOBILE_MEDIA_QUERY,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
  openMenu(undefined, undefined, undefined, undefined, { onPairPhone: pair });
  expect(screen.queryByRole('menuitem', { name: 'Pair phone' })).toBeNull();
  fireEvent.click(
    screen.getByRole('menuitem', { name: 'Connect another device' }),
  );
  expect(pair).toHaveBeenCalledOnce();
});

test('#4519: under the managed limit "Pair phone" is disabled and the managed sentence and Get help link show beside it', () => {
  const anchor = document.createElement('button');
  document.body.append(anchor);
  unregister.push(() => anchor.remove());
  const pair = vi.fn();
  const renderWith = () =>
    render(
      <StationSwitcherMenu
        anchor={anchor}
        connections={[station]}
        activeConnectionId="one"
        activeStatus="connected"
        activeStatusLabel="Connected"
        onSelect={vi.fn(async () => {})}
        onForget={vi.fn(async () => {})}
        canForget={() => true}
        onClose={vi.fn()}
        onManage={vi.fn()}
        onPairPhone={pair}
      />,
    );
  managed.limit = {
    organization: 'Acme',
    supportUrl: 'https://help.acme.example/station',
    lockedSettings: [],
    limits: { clients: ['desktop', 'local-browser'] },
  } as ManagedPolicySummary;
  try {
    const { unmount } = renderWith();
    const item = screen.getByRole('menuitem', { name: 'Pair phone' });
    expect((item as HTMLButtonElement).disabled).toBe(true);
    // Round 2, item 7: visible text, not a hover tooltip.
    expect(item.getAttribute('title')).toBeNull();
    const note = screen.getByText(/Acme.s policy manages remote access/);
    expect(item.getAttribute('aria-describedby')).toBe(note.id);
    const help = screen.getByRole('link', { name: 'Get help' });
    expect(help.getAttribute('href')).toBe('https://help.acme.example/station');
    expect(note.contains(help)).toBe(true);
    fireEvent.click(item);
    expect(pair).not.toHaveBeenCalled();
    unmount();
  } finally {
    managed.limit = undefined;
  }
  renderWith();
  const enabled = screen.getByRole('menuitem', { name: 'Pair phone' });
  expect((enabled as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByText(/policy manages remote access/)).toBeNull();
  fireEvent.click(enabled);
  expect(pair).toHaveBeenCalledOnce();
});

test('the active row says why its last health check failed and how long ago', () => {
  openMenu([station, laptop], undefined, undefined, undefined, {
    active: {
      activeStatus: 'error',
      activeStatusLabel: "Can't connect",
      activeReason: 'timeout',
      activeCheckedAt: Date.now() - 2 * 60_000,
    },
  });
  expect(
    row("Workstation — Can't connect · no answer in time · checked 2m ago"),
  ).toBeTruthy();
});

test('a healthy active row shows when it was checked, not a stale reason', () => {
  openMenu([station, laptop], undefined, undefined, undefined, {
    active: { activeReason: 'timeout', activeCheckedAt: Date.now() },
  });
  expect(row('Workstation — Connected · checked just now')).toBeTruthy();
});

test('an unreachable peer says what failed, when it was checked, and when it last worked', async () => {
  const lastWorked = { ...laptop, lastSuccessAt: Date.now() - 3 * 86_400_000 };
  openMenu([station, lastWorked]);
  expect(
    await screen.findByRole('menuitemradio', {
      name: 'Laptop — Unreachable · nothing answered · checked just now · last connected 3d ago',
    }),
  ).toBeTruthy();
});

test('a probe that runs out its deadline reads as no answer in time', async () => {
  fetchMock.mockImplementationOnce(async () => {
    throw new DOMException('The operation timed out.', 'TimeoutError');
  });
  expect(await probeStation(laptop.url)).toMatchObject({
    reachability: 'unreachable',
    failure: 'timeout',
  });
  // The failed probe was not cached, so this opening probes again.
  fetchMock.mockImplementationOnce(async () => {
    throw new DOMException('The operation timed out.', 'TimeoutError');
  });
  openMenu([station, laptop]);
  expect(
    await screen.findByRole('menuitemradio', {
      name: 'Laptop — Unreachable · no answer in time · checked just now',
    }),
  ).toBeTruthy();
});

test('a Station this page cannot probe shows its saved failure with its age', () => {
  // A broker route is never probed directly, so its saved result is all there is.
  const brokered = {
    ...laptop,
    brokerRoute: {
      routeId: 'route-1',
    } as unknown as SavedConnection['brokerRoute'],
    lastError: {
      reason: 'server-restarted' as const,
      at: Date.now() - 3 * 3_600_000,
    },
  };
  expect(isProbeable(brokered)).toBe(false);
  openMenu([station, brokered]);
  expect(
    row("Laptop — Can't connect · Station restarted · 3h ago"),
  ).toBeTruthy();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('a refused Station says since when it has needed access', async () => {
  const refused = {
    ...laptop,
    lastError: {
      reason: 'authentication-failed' as const,
      at: Date.now() - 5 * 60_000,
    },
  };
  reachable.add('https://two.example.test');
  openMenu([station, refused]);
  expect(row('Laptop — Needs access · refused 5m ago')).toBeTruthy();
  // Its handshake answering does not make it healthy: the dot keeps saying
  // it needs access.
  await act(async () => {
    await probeStation(refused.url);
  });
  expect(
    row(/^Laptop/).querySelector('[aria-label="needs pairing"]'),
  ).not.toBeNull();
});

test('the ages in an open menu keep up with the clock', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  try {
    openMenu([station, laptop], undefined, undefined, undefined, {
      active: { activeCheckedAt: Date.now() },
    });
    expect(row('Workstation — Connected · checked just now')).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(3 * 60_000);
    });
    expect(row('Workstation — Connected · checked 3m ago')).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});
