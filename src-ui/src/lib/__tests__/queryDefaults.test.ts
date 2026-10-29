/**
 * station#2327 — the app's shared query default must not retry into a
 * saturated native transport, and must otherwise keep `retry: 1`. Driven
 * through a REAL QueryClient built from `stationQueryDefaults()`, so what is
 * proven is the retryer's behaviour, not the predicate in isolation.
 */

import { onlineManager, QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, test } from 'vitest';
import {
  stationMutationDefaults,
  stationQueryDefaults,
} from '../queryDefaults';

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

describe('stationMutationDefaults', () => {
  afterEach(() => {
    onlineManager.setOnline(true);
  });

  async function offlineWrite(networkMode?: 'online') {
    const client = new QueryClient({
      defaultOptions: { mutations: stationMutationDefaults() },
    });
    onlineManager.setOnline(false);
    let attempts = 0;
    const settled = client
      .getMutationCache()
      .build(client, {
        ...(networkMode ? { networkMode } : {}),
        mutationFn: async () => {
          attempts += 1;
          throw new TypeError('Failed to fetch');
        },
      })
      .execute(undefined)
      .then(
        () => 'resolved',
        () => 'rejected',
      );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const paused = client
      .getMutationCache()
      .getAll()
      .some((mutation) => mutation.state.isPaused);
    return { attempts, paused, settled, client };
  }

  test('an offline write fails now instead of waiting to replay on reconnect', async () => {
    const write = await offlineWrite();
    expect(write.attempts).toBe(1);
    expect(write.paused).toBe(false);
    await expect(write.settled).resolves.toBe('rejected');
    write.client.clear();
  });

  test('a write that opts into waiting still pauses (the control)', async () => {
    const write = await offlineWrite('online');
    expect(write.attempts).toBe(0);
    expect(write.paused).toBe(true);
    write.client.clear();
  });
});
