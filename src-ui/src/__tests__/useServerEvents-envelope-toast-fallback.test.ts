/**
 * @vitest-environment jsdom
 */

import { describe, expect, test, vi } from 'vitest';

const { show } = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock('../contexts/ToastContext', () => ({ toastStore: { show } }));
vi.mock('../lib/notification-sounds', () => ({
  playDeliveredNotificationSound: vi.fn(),
}));
// The lazily loaded envelope toast chunk fails to load (offline, or a deploy
// replaced it).
vi.mock('../lib/notification-envelope-toast', () => {
  throw new Error('chunk failed to load');
});

import {
  handleNotificationDeliveredToast,
  NOTIFICATION_TOAST_DISPLAY_MS,
} from '../hooks/useServerEvents';

describe('enveloped delivery toast fallback (#2587 review L6)', () => {
  test('a failed envelope chunk still shows the plain toast', async () => {
    handleNotificationDeliveredToast({
      id: 'n-1',
      category: 'agent-done',
      title: 'Tests pass',
      body: 'All green.',
      metadata: { envelope: { v: 1 } },
    });
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    expect(show).toHaveBeenCalledWith(
      'Tests pass — All green.',
      undefined,
      NOTIFICATION_TOAST_DISPLAY_MS,
      undefined,
      { envelope: { v: 1 } },
    );
  });
});
