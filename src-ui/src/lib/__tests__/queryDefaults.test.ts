/**
 * station#2327 — the app's shared query default must not retry into a
 * saturated native transport, and must otherwise keep `retry: 1`. Driven
 * through a REAL QueryClient built from `stationQueryDefaults()`, so what is
 * proven is the retryer's behaviour, not the predicate in isolation.
 */

import { QueryClient } from '@tanstack/react-query';
import { describe, expect, test } from 'vitest';
import { stationQueryDefaults } from '../queryDefaults';

function codedError(code: string): Error {
  return Object.assign(new Error(`Native Station request failed: ${code}`), {
    code,
  });
}

async function attemptsUntilSettled(error: Error): Promise<number> {
  const client = new QueryClient({
    defaultOptions: {
      queries: { ...stationQueryDefaults(), retryDelay: 0 },
    },
  });
  let attempts = 0;
  await client
    .fetchQuery({
      queryKey: ['station-2327', error.message],
      queryFn: async () => {
        attempts += 1;
        throw error;
      },
    })
    .catch(() => undefined);
  client.clear();
  return attempts;
}

describe('stationQueryDefaults retry (station#2327)', () => {
  test('does not retry a transport_capacity refusal', async () => {
    expect(await attemptsUntilSettled(codedError('transport_capacity'))).toBe(
      1,
    );
  });

  test('keeps one retry for any other failure', async () => {
    expect(await attemptsUntilSettled(codedError('transport_timeout'))).toBe(2);
    expect(await attemptsUntilSettled(new Error('Failed to fetch'))).toBe(2);
  });

  test('keys on the code, not on the message text', async () => {
    // The capacity refusal's own wording, with no code attached, is an
    // ordinary failure: prose is display-only across the FFI boundary.
    expect(
      await attemptsUntilSettled(
        new Error('native Station request queue capacity reached'),
      ),
    ).toBe(2);
  });
});
