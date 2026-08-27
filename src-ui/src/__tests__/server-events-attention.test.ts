/**
 * @vitest-environment jsdom
 */

import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test, vi } from 'vitest';
import { invalidateQueriesForServerEvent } from '../hooks/useServerEvents';

describe('attention server-event invalidation', () => {
  test.each([
    SERVER_EVENTS.NOTIFICATION_DELIVERED,
    SERVER_EVENTS.NOTIFICATION_UPDATED,
    SERVER_EVENTS.NOTIFICATION_DISMISSED,
    SERVER_EVENTS.NOTIFICATION_CLEARED,
  ])('invalidates attention for %s', (event) => {
    const invalidateQueries = vi.fn();

    invalidateQueriesForServerEvent(event, { invalidateQueries });

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['attention'],
    });
  });
});
