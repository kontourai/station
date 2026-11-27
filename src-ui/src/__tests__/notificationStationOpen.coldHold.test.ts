// @vitest-environment jsdom
/**
 * A cold-loaded notification link is held until the opener mounts (the
 * active Station's id is not known yet). A navigation the person makes in
 * the meantime supersedes it: the held link must not pull them back. Driven
 * through the REAL navigation store, wired as `main.tsx` wires it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { navigationStore } from '../contexts/navigation-store';
import {
  holdColdNotificationLink,
  installNavigationPosition,
  installNotificationOpener,
  type NotificationOpenRequest,
} from '../lib/notificationStationOpen';

let uninstallPosition: () => void = () => {};
const opened: NotificationOpenRequest[] = [];

beforeEach(() => {
  opened.length = 0;
  navigationStore.navigate('/projects/old', {
    chat: 'old',
    dock: 'open',
    station: 'env-a',
  });
  uninstallPosition = installNavigationPosition(() =>
    navigationStore.getHistoryIndex(),
  );
  holdColdNotificationLink(window.location, (params) =>
    navigationStore.updateParams(params),
  );
});

afterEach(() => uninstallPosition());

describe('held cold-load notification link', () => {
  test('opens once the opener mounts when the person stayed put', () => {
    const uninstall = installNotificationOpener((request) =>
      opened.push(request),
    );
    expect(opened).toEqual([
      {
        pathname: '/projects/old',
        params: { chat: 'old', dock: 'open' },
        stationId: 'env-a',
      },
    ]);
    uninstall();
  });

  test('is dropped when the person navigated before the opener mounted', () => {
    navigationStore.navigate('/settings', { chat: null, dock: null });
    const uninstall = installNotificationOpener((request) =>
      opened.push(request),
    );
    expect(opened).toEqual([]);
    expect(window.location.pathname).toBe('/settings');
    uninstall();
  });
});
