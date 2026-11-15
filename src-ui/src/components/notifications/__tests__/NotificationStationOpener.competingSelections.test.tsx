// @vitest-environment jsdom
/**
 * Competing Station selections through the REAL connection provider and the
 * REAL opener. The provider resolves a selection that a newer one overtook
 * without committing it, so a tap's switch resolving proves nothing: the
 * opener must navigate only for the newest tap, and only when the store
 * actually committed the Station that tap asked for.
 */
import {
  ConnectionStore,
  ConnectionsProvider,
  useConnections,
} from '@kontourai/station-connect';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  getNotificationOpenNotice,
  openingConversationLabel,
  requestNotificationOpen,
  setNotificationOpenNotice,
} from '../../../lib/notificationStationOpen';

const opened: { chat: string | undefined; station: string | undefined }[] = [];
let store: ConnectionStore;

vi.mock('../../../contexts/NavigationContext', () => ({
  useNavigationActions: () => ({
    navigate: (_pathname: string, params: Record<string, string>) =>
      opened.push({ chat: params.chat, station: store.getActive()?.name }),
  }),
}));

const { NotificationStationOpener } = await import(
  '../NotificationStationOpener'
);

let context: ReturnType<typeof useConnections>;
function ReadConnections() {
  context = useConnections();
  return null;
}

const prepared = new Map<string, () => void>();
const ids: Record<string, string> = {};

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    get: (key: string) => data.get(key) ?? null,
    set: (key: string, value: string) => void data.set(key, value),
    remove: (key: string) => void data.delete(key),
  };
}

beforeEach(async () => {
  opened.length = 0;
  prepared.clear();
  store = new ConnectionStore({ storage: memoryStorage() });
  for (const name of ['A', 'B', 'C', 'D']) {
    const connection = store.add(name, `https://${name.toLowerCase()}.example`);
    // The real writer of a saved Station's id: its verified handshake.
    store.reconcileHandshake(connection.id, {
      environmentId: `env-${name.toLowerCase()}`,
      authentication: { scheme: 'bearer', protocolVersion: 1 },
    });
    ids[name] = store
      .getAll()
      .find((saved) => saved.environmentId === `env-${name.toLowerCase()}`)!.id;
  }
  store.setActive(ids.A);
  await act(async () => {
    render(
      <ConnectionsProvider
        store={store}
        defaultUrl="https://a.example"
        // Each selection waits until the test prepares it, so selections
        // can finish in any order.
        prepareActiveConnection={(id) =>
          new Promise<void>((resolve) => prepared.set(id, resolve))
        }
      >
        <ReadConnections />
        <NotificationStationOpener />
      </ConnectionsProvider>,
    );
  });
});

afterEach(() => {
  cleanup();
  act(() => setNotificationOpenNotice(null));
});

const tap = (station: string, chat: string) =>
  requestNotificationOpen({
    pathname: '/',
    params: { chat, dock: 'open' },
    stationId: `env-${station}`,
  });

const flush = () => act(async () => {});

describe('competing Station selections', () => {
  test('tap B then C, C finishing first: only C opens, on C', async () => {
    await act(async () => {
      tap('b', 'B-thread');
      tap('c', 'C-thread');
    });
    await act(async () => prepared.get(ids.C)?.());
    await flush();
    await act(async () => prepared.get(ids.B)?.());
    await flush();
    expect(store.getActive()?.name).toBe('C');
    expect(opened).toEqual([{ chat: 'C-thread', station: 'C' }]);
    // The overtaken tap is not reported as a failed switch over C's thread.
    expect(getNotificationOpenNotice()).toBeNull();
    // The dock names the Station it switched to while the thread opens.
    expect(openingConversationLabel('C-thread')).toBe(
      'Opening conversation on C',
    );
    expect(openingConversationLabel('B-thread')).toBe('Opening conversation');
  });

  test('tap B then C, B finishing first: B never opens, C opens on C', async () => {
    await act(async () => {
      tap('b', 'B-thread');
      tap('c', 'C-thread');
    });
    await act(async () => prepared.get(ids.B)?.());
    await flush();
    expect(opened).toEqual([]);
    // Overtaken, not failed: C is still opening.
    expect(getNotificationOpenNotice()).toMatchObject({
      kind: 'switching',
      stationName: 'C',
    });
    await act(async () => prepared.get(ids.C)?.());
    await flush();
    expect(opened).toEqual([{ chat: 'C-thread', station: 'C' }]);
    expect(getNotificationOpenNotice()).toBeNull();
  });

  test('a manual switch to D overtakes the tap: nothing opens, and it says so', async () => {
    await act(async () => tap('b', 'B-thread'));
    await act(async () => {
      void context.setActiveConnection(ids.D);
    });
    await act(async () => prepared.get(ids.B)?.());
    await flush();
    await act(async () => prepared.get(ids.D)?.());
    await flush();
    expect(store.getActive()?.name).toBe('D');
    expect(opened).toEqual([]);
    expect(getNotificationOpenNotice()).toMatchObject({
      kind: 'switch-failed',
      stationName: 'B',
    });
    expect(screen.getByText("Couldn't switch to B")).toBeTruthy();
  });

  test('a tap for the active Station overtakes an earlier switch away from it', async () => {
    await act(async () => {
      tap('b', 'B-thread');
      tap('a', 'A-thread');
    });
    await act(async () => prepared.get(ids.A)?.());
    await flush();
    await act(async () => prepared.get(ids.B)?.());
    await flush();
    expect(store.getActive()?.name).toBe('A');
    expect(opened).toEqual([{ chat: 'A-thread', station: 'A' }]);
  });
});
