/**
 * A request deadline that fires while an admission or settlement response body
 * is read must reach the caller as `StationRequestTimeoutError` (the same rule
 * `body-read-deadline.scan.test.ts` holds every SDK body-read catch to), while
 * an unreadable body keeps its documented outcome: `network-error` for
 * admission and `null` for settlement.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  admitPluginCommandEffect,
  settlePluginCommandEffects,
} from '../client/plugin-command-effects';
import { StationRequestTimeoutError } from '../client/request-deadline';

const BASE = 'https://station.example.test';

function respondingWith(body: () => Promise<unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const response = new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      vi.spyOn(response, 'json').mockImplementation(body as never);
      return response;
    }),
  );
}

const timeout = () =>
  new StationRequestTimeoutError(`${BASE}/api/plugins`, 20, { method: 'POST' });

const admission = {} as never;
const settlement = {} as never;

describe('plugin command effect fetchers and a mid-body deadline', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('passes a deadline reached while reading an admission body to the caller', async () => {
    const error = timeout();
    respondingWith(async () => {
      throw error;
    });
    await expect(
      admitPluginCommandEffect(BASE, 'plugin-a', admission),
    ).rejects.toBe(error);
    expect(error.mutation).toBe(true);
  });

  it('passes a deadline reached while reading a settlement body to the caller', async () => {
    const error = timeout();
    respondingWith(async () => {
      throw error;
    });
    await expect(settlePluginCommandEffects(BASE, settlement)).rejects.toBe(
      error,
    );
  });

  it('still reports an unreadable admission body as network-error', async () => {
    respondingWith(async () => {
      throw new SyntaxError('Unexpected end of JSON input');
    });
    await expect(
      admitPluginCommandEffect(BASE, 'plugin-a', admission),
    ).resolves.toEqual({ kind: 'network-error' });
  });

  it('still reports an unreadable settlement body as null', async () => {
    respondingWith(async () => {
      throw new SyntaxError('Unexpected end of JSON input');
    });
    await expect(
      settlePluginCommandEffects(BASE, settlement),
    ).resolves.toBeNull();
  });
});
