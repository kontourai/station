import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  InboundWebhookConfigurationError,
  InboundWebhookReplayStore,
} from '../inbound-webhook-store.js';

const temporary = trackTempDirs();
const NOW = 1_780_000_000_000;

function ledgerPath(homeDir: string): string {
  return join(homeDir, 'security', 'inbound-webhook-replays.json');
}

function writeLedger(homeDir: string, entries: unknown): void {
  mkdirSync(join(homeDir, 'security'), { recursive: true });
  writeFileSync(ledgerPath(homeDir), JSON.stringify(entries));
}

function reserved(
  outcome: ReturnType<InboundWebhookReplayStore['reserve']>,
): string {
  if (outcome.outcome !== 'reserved') throw new Error('expected a reservation');
  return outcome.token;
}

// The durable ledger behind Telltale's webhook source. These drive the file
// store directly: the route tests cover what Telltale does with the answers.
describe('InboundWebhookReplayStore as a Telltale replay ledger', () => {
  test('a reserved or delivered key refuses another reservation until expiresAt', () => {
    const store = new InboundWebhookReplayStore(temporary('station-replay-'));
    const token = reserved(store.reserve('k', NOW + 1000, NOW));
    expect(store.reserve('k', NOW + 1000, NOW)).toEqual({
      outcome: 'replayed',
    });
    expect(store.commit('k', token)).toBe(true);
    expect(store.reserve('k', NOW + 1000, NOW + 999)).toEqual({
      outcome: 'replayed',
    });
    // `expiresAt` is the first instant the key is free again.
    expect(store.reserve('k', NOW + 5000, NOW + 1000).outcome).toBe('reserved');
  });

  test('extend, commit and release act only for the owning token', () => {
    const store = new InboundWebhookReplayStore(temporary('station-replay-'));
    const token = reserved(store.reserve('k', NOW + 1000, NOW));
    expect(store.extend('k', 'not-the-owner', NOW + 9000, NOW)).toBe(false);
    expect(store.commit('k', 'not-the-owner')).toBe(false);
    expect(store.release('k', 'not-the-owner')).toBe(false);
    expect(store.reserve('k', NOW + 1000, NOW)).toEqual({
      outcome: 'replayed',
    });

    expect(store.extend('k', token, NOW + 9000, NOW + 500)).toBe(true);
    // Extended: still held past the original expiry.
    expect(store.reserve('k', NOW + 9000, NOW + 2000)).toEqual({
      outcome: 'replayed',
    });
    expect(store.release('k', token)).toBe(true);
    // Released: the same request may be delivered again.
    expect(store.reserve('k', NOW + 9000, NOW + 2000).outcome).toBe('reserved');
  });

  test('a lapsed holder cannot touch the newer reservation of its key', () => {
    const store = new InboundWebhookReplayStore(temporary('station-replay-'));
    const first = reserved(store.reserve('k', NOW + 1000, NOW));
    expect(store.extend('k', first, NOW + 5000, NOW + 1000)).toBe(false);
    const second = reserved(store.reserve('k', NOW + 5000, NOW + 1000));
    expect(store.commit('k', first)).toBe(false);
    expect(store.release('k', first)).toBe(false);
    expect(store.commit('k', second)).toBe(true);
    // A delivered key is not released.
    expect(store.release('k', second)).toBe(false);
  });

  test('entries written before the Telltale ledger still refuse their replay', () => {
    const homeDir = temporary('station-replay-');
    writeLedger(homeDir, [{ key: 'legacy', expiresAt: NOW + 1000 }]);
    const store = new InboundWebhookReplayStore(homeDir);
    expect(store.reserve('legacy', NOW + 1000, NOW)).toEqual({
      outcome: 'replayed',
    });
    // Without a token, no holder can release it.
    expect(store.release('legacy', 'anything')).toBe(false);
  });

  test('a ledger full of live keys refuses rather than evicting one', () => {
    const homeDir = temporary('station-replay-');
    writeLedger(
      homeDir,
      Array.from({ length: 10_000 }, (_, i) => ({
        key: `live-${i}`,
        expiresAt: NOW + 1000,
        state: 'delivered',
      })),
    );
    const store = new InboundWebhookReplayStore(homeDir);
    expect(() => store.reserve('new', NOW + 1000, NOW)).toThrow(
      InboundWebhookConfigurationError,
    );
    // Nothing was evicted.
    expect(store.reserve('live-0', NOW + 1000, NOW)).toEqual({
      outcome: 'replayed',
    });
    // Once keys expire there is room again, and expired keys are dropped.
    expect(store.reserve('new', NOW + 9000, NOW + 1000).outcome).toBe(
      'reserved',
    );
    expect(JSON.parse(readFileSync(ledgerPath(homeDir), 'utf8'))).toEqual([
      expect.objectContaining({ key: 'new', state: 'reserved' }),
    ]);
  });

  test('a corrupt ledger fails closed', () => {
    const homeDir = temporary('station-replay-');
    writeLedger(homeDir, [{ key: 'k', expiresAt: NOW, state: 'unknown' }]);
    expect(() =>
      new InboundWebhookReplayStore(homeDir).reserve('k', NOW + 1000, NOW),
    ).toThrow(InboundWebhookConfigurationError);
  });
});
