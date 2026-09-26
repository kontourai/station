/**
 * @vitest-environment jsdom
 */

import { describe, expect, test, vi } from 'vitest';

const { show, navigate, markRead } = vi.hoisted(() => ({
  show: vi.fn(),
  navigate: vi.fn(),
  markRead: vi.fn(async () => undefined),
}));
vi.mock('../contexts/ToastContext', () => ({ toastStore: { show } }));
vi.mock('../contexts/NavigationContext', () => ({
  navigationStore: { navigate },
}));
vi.mock('@kontourai/station-sdk/notification-read', () => ({
  markNotificationRead: markRead,
}));

import { showEnvelopeNotificationToast } from '../lib/notification-envelope-toast';

const envelope = {
  v: 1,
  source: {
    kind: 'agent',
    sessionId: 'session-1',
    agent: 'planner',
    assurance: 'bearer-exposed',
  },
  audience: { kind: 'owner' },
  urgency: 'info',
  interrupt: 'silent',
};

describe('enveloped delivery toast (#2587)', () => {
  test('Open goes to the envelope target and records the read for that id', async () => {
    showEnvelopeNotificationToast(
      {
        id: 'n-1',
        category: 'agent-info',
        title: 'Tests pass',
        body: 'All green.',
        metadata: { envelope },
      },
      5000,
    );

    expect(show).toHaveBeenCalledTimes(1);
    const [message, , duration, actions, metadata] = show.mock.calls[0];
    expect(message).toBe('Tests pass — All green.');
    expect(duration).toBe(5000);
    expect(metadata).toEqual({
      envelope,
      detail: 'from planner · session session-1',
    });
    expect(actions).toHaveLength(1);
    expect(actions[0].label).toBe('Open');

    actions[0].onClick();
    await vi.waitFor(() => expect(markRead).toHaveBeenCalledTimes(1));
    expect(navigate).toHaveBeenCalledWith('/', {
      chat: 'session-1',
      dock: 'open',
    });
    expect(markRead).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'n-1' }),
    );
  });

  test('a record without an id offers no Open', () => {
    show.mockClear();
    showEnvelopeNotificationToast(
      { title: 'Tests pass', metadata: { envelope } },
      5000,
    );
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0][3]).toBeUndefined();
  });
});
