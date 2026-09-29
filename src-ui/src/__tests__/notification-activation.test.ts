/**
 * @vitest-environment jsdom
 */

import type { Notification } from '@kontourai/station-contracts/notification';
import { describe, expect, test, vi } from 'vitest';
import { activateNotification } from '../lib/notification-activation';

function enveloped(target?: unknown): Pick<Notification, 'id' | 'metadata'> {
  return {
    id: 'n-1',
    metadata: {
      envelope: {
        v: 1,
        source: {
          kind: 'agent',
          sessionId: 'session-1',
          agent: 'builder',
          assurance: 'bound',
        },
        audience: { kind: 'session-readers', sessionId: 'session-1' },
        urgency: 'attention',
        interrupt: 'default',
        ...(target ? { target } : {}),
      },
    },
  };
}

function deps(markRead = vi.fn(async () => 'read')) {
  return { navigate: vi.fn(), markRead };
}

describe('activateNotification (#2587)', () => {
  test('a session target opens that chat in the dock and marks the record read', async () => {
    const d = deps();
    expect(
      await activateNotification(
        enveloped({ kind: 'session', sessionId: 'session-9' }),
        d,
      ),
    ).toBe(true);
    expect(d.navigate).toHaveBeenCalledWith('/', {
      chat: 'session-9',
      dock: 'open',
    });
    expect(d.markRead).toHaveBeenCalledWith('n-1');
  });

  test('a path target navigates to that relative path', async () => {
    const d = deps();
    await activateNotification(
      enveloped({ kind: 'path', path: '/schedule?job=nightly' }),
      d,
    );
    expect(d.navigate).toHaveBeenCalledWith('/schedule?job=nightly', undefined);
  });

  test('an agent notification with no target opens the calling session', async () => {
    const d = deps();
    await activateNotification(enveloped(), d);
    expect(d.navigate).toHaveBeenCalledWith('/', {
      chat: 'session-1',
      dock: 'open',
    });
  });

  test('a failed read marker does not undo the navigation', async () => {
    const d = deps(
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    await expect(activateNotification(enveloped(), d)).resolves.toBe(true);
    expect(d.navigate).toHaveBeenCalledTimes(1);
  });

  test('a legacy record is neither navigated nor marked', async () => {
    const d = deps();
    expect(
      await activateNotification(
        { id: 'n-2', metadata: { sessionId: 's' } },
        d,
      ),
    ).toBe(false);
    expect(d.navigate).not.toHaveBeenCalled();
    expect(d.markRead).not.toHaveBeenCalled();
  });
});
