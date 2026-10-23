/** @vitest-environment jsdom */

import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { invalidateQueriesForServerEvent } from '../hooks/useServerEvents';

test.each([SERVER_EVENTS.AGENTS_CHANGED, SERVER_EVENTS.ACP_STATUS])(
  '%s refreshes visible agent and engine readiness without remounting',
  async (event) => {
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: Infinity,
          refetchOnMount: false,
          refetchOnWindowFocus: false,
        },
      },
    });
    let readiness = 'OpenCode could not start';
    const observers = [
      ['agents'],
      ['connections', 'engines'],
      ['acp-connections'],
    ].map(
      (queryKey) =>
        new QueryObserver(client, {
          queryKey,
          queryFn: async () => readiness,
        }),
    );
    const unsubscribe = observers.map((observer) =>
      observer.subscribe(() => {}),
    );
    try {
      await Promise.all(observers.map((observer) => observer.refetch()));
      expect(
        observers.map((observer) => observer.getCurrentResult().data),
      ).toEqual(Array(3).fill('OpenCode could not start'));

      for (const next of ['Ready', 'OpenCode initialization timed out']) {
        readiness = next;
        invalidateQueriesForServerEvent(event, client);
        await waitFor(() => {
          expect(
            observers.map((observer) => observer.getCurrentResult().data),
          ).toEqual(Array(3).fill(next));
        });
      }
    } finally {
      unsubscribe.forEach((stop) => stop());
      client.clear();
    }
  },
);
