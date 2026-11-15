/**
 * Opening a notification on the Station that sent it: which saved
 * connection a request belongs to, the switch-then-navigate order, the
 * notices, and the cold-load hold.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  captureNotificationLink,
  getNotificationOpenNotice,
  holdColdNotificationLink,
  installNotificationOpener,
  type NotificationOpenRequest,
  type NotificationStationConnection,
  notificationLinkRequest,
  openNotificationTarget,
  requestNotificationOpen,
  resolveNotificationStation,
  setNotificationOpenNotice,
  takeNotificationChat,
} from '../lib/notificationStationOpen';

const A: NotificationStationConnection = {
  id: 'conn-a',
  name: 'Studio Mac',
  url: 'https://a.example:3141',
  environmentId: 'env-a',
};
const B: NotificationStationConnection = {
  id: 'conn-b',
  name: 'Home server',
  url: 'https://b.example',
  endpoints: [{ url: 'https://b.example' }, { url: 'http://100.64.0.2:3141' }],
  environmentId: 'env-b',
};
const CONNECTIONS = [A, B];

afterEach(() => {
  setNotificationOpenNotice(null);
});

describe('resolveNotificationStation', () => {
  test('the active Station opens it in place', () => {
    expect(
      resolveNotificationStation({ stationId: 'env-a' }, CONNECTIONS, A),
    ).toEqual({ kind: 'active' });
  });

  test("another saved Station's link switches to that connection", () => {
    expect(
      resolveNotificationStation({ stationId: 'env-b' }, CONNECTIONS, A),
    ).toEqual({ kind: 'switch', connection: B });
  });

  test('a Station that is not saved here is reported, never guessed', () => {
    expect(
      resolveNotificationStation({ stationId: 'env-gone' }, CONNECTIONS, A),
    ).toEqual({ kind: 'not-saved' });
  });

  test('desktop: the origin the host read the alert from decides, on any endpoint', () => {
    expect(
      resolveNotificationStation(
        { origin: 'http://100.64.0.2:3141' },
        CONNECTIONS,
        A,
      ),
    ).toEqual({ kind: 'switch', connection: B });
    expect(
      resolveNotificationStation(
        { origin: 'https://a.example:3141', stationId: 'env-a' },
        CONNECTIONS,
        B,
      ),
    ).toEqual({ kind: 'switch', connection: A });
  });

  test("desktop: a link naming a different Station than the origin's is refused", () => {
    expect(
      resolveNotificationStation(
        { origin: 'https://a.example:3141', stationId: 'env-b' },
        CONNECTIONS,
        A,
      ),
    ).toEqual({ kind: 'not-saved' });
  });

  test('desktop: an origin no saved connection serves is not opened elsewhere', () => {
    expect(
      resolveNotificationStation(
        { origin: 'https://gone.example' },
        CONNECTIONS,
        A,
      ),
    ).toEqual({ kind: 'not-saved' });
  });

  test("desktop: an unsaved origin cannot borrow a saved Station's id from the link", () => {
    // The host read the alert from an origin no saved connection serves;
    // the link's id names a saved Station. The host's record wins.
    expect(
      resolveNotificationStation(
        { origin: 'https://untrusted.example', stationId: 'env-b' },
        CONNECTIONS,
        A,
      ),
    ).toEqual({ kind: 'not-saved' });
    const unknownActive = { ...A, environmentId: null };
    expect(
      resolveNotificationStation(
        { origin: 'https://untrusted.example', stationId: 'env-b' },
        [unknownActive, B],
        unknownActive,
      ),
    ).toEqual({ kind: 'not-saved' });
  });

  test('a request naming no Station (an older Station) opens on the active one', () => {
    expect(resolveNotificationStation({}, CONNECTIONS, A)).toEqual({
      kind: 'active',
    });
  });

  test('a same-origin connection that never saved its id is placed by the verified observation', () => {
    const sameOrigin = { ...A, environmentId: null };
    const connections = [sameOrigin, B];
    // The tap from this very Station opens here, not as "not saved".
    expect(
      resolveNotificationStation(
        { stationId: 'env-a' },
        connections,
        sameOrigin,
        'env-a',
      ),
    ).toEqual({ kind: 'active' });
    expect(
      resolveNotificationStation(
        { stationId: 'env-b' },
        connections,
        sameOrigin,
        'env-a',
      ),
    ).toEqual({ kind: 'switch', connection: B });
    expect(
      resolveNotificationStation(
        { stationId: 'env-gone' },
        connections,
        sameOrigin,
        'env-a',
      ),
    ).toEqual({ kind: 'not-saved' });
  });

  test('with the active id still unknown, an unplaceable Station is unconfirmed, never guessed active', () => {
    const sameOrigin = { ...A, environmentId: null };
    expect(
      resolveNotificationStation(
        { stationId: 'env-a' },
        [sameOrigin, B],
        sameOrigin,
      ),
    ).toEqual({ kind: 'unconfirmed' });
    // A saved Station it names is still switched to.
    expect(
      resolveNotificationStation(
        { stationId: 'env-b' },
        [sameOrigin, B],
        sameOrigin,
      ),
    ).toEqual({ kind: 'switch', connection: B });
  });

  test('a malformed Station id is ignored rather than matched', () => {
    expect(
      resolveNotificationStation({ stationId: '../env-b' }, CONNECTIONS, A),
    ).toEqual({ kind: 'active' });
  });
});

function harness(active: NotificationStationConnection) {
  const state = { active };
  const order: string[] = [];
  let finishSwitch: (() => void) | undefined;
  const deps = {
    connections: () => CONNECTIONS,
    active: () => state.active,
    committedActiveId: () => state.active.id,
    setActiveConnection: vi.fn(
      (id: string) =>
        new Promise<void>((resolve) => {
          order.push(`switch:${id}`);
          finishSwitch = () => {
            state.active = CONNECTIONS.find((c) => c.id === id)!;
            resolve();
          };
        }),
    ),
    navigate: vi.fn((pathname: string, params: Record<string, string>) => {
      order.push(
        `navigate:${pathname}?${new URLSearchParams(params)}@${state.active.id}`,
      );
    }),
  };
  return { deps, order, finishSwitch: () => finishSwitch?.() };
}

const TAP: NotificationOpenRequest = {
  pathname: '/',
  params: { chat: 'thread-b', dock: 'open', openedNotification: 'n-1' },
  stationId: 'env-b',
};

describe('openNotificationTarget', () => {
  test('switches to the sending Station, says so, and only then navigates', async () => {
    const { deps, order, finishSwitch } = harness(A);
    const done = openNotificationTarget(TAP, deps);
    expect(getNotificationOpenNotice()).toEqual({
      kind: 'switching',
      stationName: 'Home server',
    });
    // The conversation is never looked up on the wrong Station.
    expect(deps.navigate).not.toHaveBeenCalled();
    finishSwitch();
    await expect(done).resolves.toBe('switched');
    expect(order).toEqual([
      'switch:conn-b',
      'navigate:/?chat=thread-b&dock=open&openedNotification=n-1@conn-b',
    ]);
    expect(getNotificationOpenNotice()).toBeNull();
    // The dock reports a failed open of this chat instead of clearing it.
    expect(takeNotificationChat('thread-b')).toBe(true);
  });

  test('the active Station navigates at once', async () => {
    const { deps } = harness(B);
    await expect(openNotificationTarget(TAP, deps)).resolves.toBe('opened');
    expect(deps.setActiveConnection).not.toHaveBeenCalled();
    expect(deps.navigate).toHaveBeenCalledWith('/', TAP.params);
  });

  test('a Station not saved here shows a notice and navigates nowhere', async () => {
    const { deps } = harness(A);
    await expect(
      openNotificationTarget({ ...TAP, stationId: 'env-gone' }, deps),
    ).resolves.toBe('not-saved');
    expect(deps.navigate).not.toHaveBeenCalled();
    expect(getNotificationOpenNotice()).toEqual({ kind: 'not-saved' });
  });

  test('an explicit Station the device cannot confirm never opens here', async () => {
    const unknown = { ...A, environmentId: null };
    const navigate = vi.fn();
    await expect(
      openNotificationTarget(
        {
          pathname: '/',
          params: { chat: 'remote', openedNotification: 'remote-note' },
          stationId: 'unsaved-station',
        },
        {
          connections: () => [unknown],
          active: () => unknown,
          committedActiveId: () => unknown.id,
          setActiveConnection: async () => {},
          navigate,
        },
      ),
    ).resolves.toBe('unconfirmed');
    // Neither looked up nor marked read on the current Station.
    expect(navigate).not.toHaveBeenCalled();
    expect(takeNotificationChat('remote')).toBe(false);
    expect(getNotificationOpenNotice()).toMatchObject({ kind: 'unconfirmed' });
  });

  test('a failed switch says so, and Retry tries again', async () => {
    const { deps } = harness(A);
    deps.setActiveConnection.mockRejectedValueOnce(new Error('unreachable'));
    await expect(openNotificationTarget(TAP, deps)).resolves.toBe(
      'switch-failed',
    );
    const notice = getNotificationOpenNotice();
    expect(notice).toMatchObject({
      kind: 'switch-failed',
      stationName: 'Home server',
    });
    expect(deps.navigate).not.toHaveBeenCalled();
    if (notice?.kind !== 'switch-failed') throw new Error('no retry');
    notice.retry();
    expect(deps.setActiveConnection).toHaveBeenCalledTimes(2);
  });
});

describe('one entry point', () => {
  test('a tap before the opener mounts waits for it; only the newest is kept', () => {
    const opened: NotificationOpenRequest[] = [];
    requestNotificationOpen({ ...TAP, params: { chat: 'older' } });
    requestNotificationOpen(TAP);
    const uninstall = installNotificationOpener((request) =>
      opened.push(request),
    );
    expect(opened).toEqual([TAP]);
    requestNotificationOpen({ ...TAP, params: { chat: 'next' } });
    expect(opened).toHaveLength(2);
    uninstall();
  });
});

describe('notification links', () => {
  test('the Station parameter becomes the request Station, not a navigation param', () => {
    expect(
      notificationLinkRequest(
        '/projects/alpha?chat=s-1&dock=open&openedNotification=n-1&station=env-b',
      ),
    ).toEqual({
      pathname: '/projects/alpha',
      params: { chat: 's-1', dock: 'open', openedNotification: 'n-1' },
      stationId: 'env-b',
    });
  });

  test.each([
    'https://evil.example/',
    '//evil.example',
    '/..//evil.example',
    '/x#station-ui-bootstrap=abc',
    '/a b',
  ])('%j is not an in-app link', (link) => {
    expect(notificationLinkRequest(link)).toBeNull();
  });

  test('a cold load holds the conversation and read marker until its Station is known', () => {
    const cleared: Record<string, null>[] = [];
    const opened: NotificationOpenRequest[] = [];
    const uninstall = installNotificationOpener((request) =>
      opened.push(request),
    );
    holdColdNotificationLink(
      {
        pathname: '/projects/alpha',
        search: '?chat=s-1&dock=open&openedNotification=n-1&station=env-b&x=1',
      },
      (params) => cleared.push(params),
    );
    expect(cleared).toEqual([
      { chat: null, dock: null, openedNotification: null, station: null },
    ]);
    expect(opened).toEqual([
      {
        pathname: '/projects/alpha',
        params: {
          chat: 's-1',
          dock: 'open',
          openedNotification: 'n-1',
          x: '1',
        },
        stationId: 'env-b',
      },
    ]);
    uninstall();
  });

  test('a URL naming no Station is left alone', () => {
    const clear = vi.fn();
    holdColdNotificationLink({ pathname: '/', search: '?chat=s-1' }, clear);
    expect(clear).not.toHaveBeenCalled();
    expect(
      captureNotificationLink({ pathname: '/', search: '?chat=s-1' }),
    ).toBe(null);
  });
});
