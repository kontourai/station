/** @vitest-environment jsdom */

import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { invalidateQueriesForServerEvent } from '../hooks/useServerEvents';

test.each([SERVER_EVENTS.AGENTS_CHANGED, SERVER_EVENTS.ACP_STATUS])(
  '%s refreshes visible readiness and cached connection views before reentry',
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
    const queryKeys = [
      ['agents'],
      ['connections', 'engines'],
      ['connections', 'oc'],
      ['acp-connections'],
      ['acp-unregistered-connections'],
      ['acp-connection-registry'],
      ['model-picker-catalog'],
    ];
    const observers = queryKeys.map(
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
      ).toEqual(Array(queryKeys.length).fill('OpenCode could not start'));

      for (const next of ['Ready', 'OpenCode initialization timed out']) {
        readiness = next;
        invalidateQueriesForServerEvent(event, client);
        await waitFor(() => {
          expect(
            observers.map((observer) => observer.getCurrentResult().data),
          ).toEqual(Array(queryKeys.length).fill(next));
        });
      }

      unsubscribe.slice(1).forEach((stop) => stop());
      readiness = 'Ready after leaving Connections';
      invalidateQueriesForServerEvent(event, client);
      await waitFor(() => {
        expect(queryKeys.map((key) => client.getQueryData(key))).toEqual(
          Array(queryKeys.length).fill(readiness),
        );
      });
    } finally {
      unsubscribe.forEach((stop) => stop());
      client.clear();
    }
  },
);
