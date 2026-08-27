import { describe, expect, test, vi } from 'vitest';
import {
  COMMAND_FRECENCY_MAX_BOOST,
  COMMAND_FRECENCY_MAX_COUNT,
  commandFrecencyBoost,
  normalizeCommandFrecency,
  recordCommandFrecency,
} from '../command-frecency';
import {
  COMMAND_FRECENCY_STORAGE_KEY,
  createCommandFrecencyStorage,
} from '../command-frecency-storage';
import { type PaletteCommand, rankCommands } from '../command-palette-utils';

const DAY = 24 * 60 * 60 * 1000;
const run = vi.fn();

function command(id: string, label: string): PaletteCommand {
  return { id, label, group: 'Actions', run };
}

describe('command frecency', () => {
  test('decays a capped boost to zero and caps repeated use', () => {
    const recent = { commandId: 'recent', count: 999, lastUsedAt: 100 * DAY };
    expect(COMMAND_FRECENCY_MAX_COUNT).toBe(20);
    expect(commandFrecencyBoost(recent, 100 * DAY)).toBe(
      COMMAND_FRECENCY_MAX_BOOST,
    );
    expect(commandFrecencyBoost(recent, 129 * DAY)).toBe(0);

    let entries = [{ commandId: 'recent', count: 1, lastUsedAt: 0 }];
    for (let count = 0; count < 100; count += 1) {
      entries = recordCommandFrecency(
        entries,
        'recent',
        count,
      ) as typeof entries;
    }
    expect(entries[0].count).toBe(20);
  });

  test('prunes deterministically by recency, count, then command id', () => {
    const entries = normalizeCommandFrecency(
      [
        { commandId: 'zulu', count: 1, lastUsedAt: 10 },
        { commandId: 'alpha', count: 1, lastUsedAt: 10 },
        { commandId: 'bravo', count: 2, lastUsedAt: 10 },
      ],
      2,
    );
    expect(entries.map((entry) => entry.commandId)).toEqual(['bravo', 'alpha']);
  });

  test('keeps exact labels ahead of history, and registry order breaks a true tie', () => {
    const commands = [
      command('exact', 'Agents'),
      command('prefix', 'Agent tools'),
    ];
    expect(
      rankCommands(
        'agents',
        commands,
        [{ commandId: 'prefix', count: 20, lastUsedAt: 10 * DAY }],
        10 * DAY,
      ).map((entry) => entry.id),
    ).toEqual(['exact', 'prefix']);

    const tied = [command('first', 'Run'), command('second', 'Run')];
    expect(rankCommands('run', tied).map((entry) => entry.id)).toEqual([
      'first',
      'second',
    ]);
  });

  test('uses history only within literal tiers and never boosts unavailable rows', () => {
    const commands = [
      command('literal', 'Agent tools'),
      { ...command('unavailable', 'Agent notes'), closeOnRun: false },
      command('fuzzy', 'A green note'),
    ];
    const ranked = rankCommands(
      'agent',
      commands,
      [
        { commandId: 'unavailable', count: 20, lastUsedAt: 10 * DAY },
        { commandId: 'fuzzy', count: 20, lastUsedAt: 10 * DAY },
      ],
      10 * DAY,
    );
    expect(ranked.map((entry) => entry.id)).toEqual([
      'literal',
      'unavailable',
      'fuzzy',
    ]);
  });
});

describe('command frecency storage', () => {
  test('treats malformed local data as empty and publishes only confirmed writes', () => {
    const storage = new Map<string, string>([
      [COMMAND_FRECENCY_STORAGE_KEY, '{not json'],
    ]);
    const adapter = createCommandFrecencyStorage({
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
      },
      now: () => 42,
    });
    expect(adapter.read()).toEqual([]);
    const listener = vi.fn();
    adapter.subscribe(listener);
    expect(adapter.record('nav:agents')).toBe(true);
    expect(adapter.read()).toEqual([
      { commandId: 'nav:agents', count: 1, lastUsedAt: 42 },
    ]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('keeps the prior snapshot when storage writes fail', () => {
    const adapter = createCommandFrecencyStorage({
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota');
        },
      },
      now: () => 42,
    });
    const listener = vi.fn();
    adapter.subscribe(listener);
    expect(adapter.record('nav:agents')).toBe(false);
    expect(adapter.read()).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });

  test('reset writes an empty bounded history and notifies subscribers', () => {
    const storage = new Map<string, string>();
    const adapter = createCommandFrecencyStorage({
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
      },
      now: () => 42,
    });
    const listener = vi.fn();
    adapter.subscribe(listener);
    adapter.record('nav:agents');
    expect(adapter.reset()).toBe(true);
    expect(adapter.read()).toEqual([]);
    expect(
      JSON.parse(storage.get(COMMAND_FRECENCY_STORAGE_KEY) ?? 'null'),
    ).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  test('retires stale Settings history without touching other commands', () => {
    const values = new Map<string, string>();
    const adapter = createCommandFrecencyStorage({
      storage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
      },
      now: () => 42,
    });
    adapter.record('settings:theme');
    adapter.record('settings:retired');
    adapter.record('nav:agents');

    expect(adapter.reconcileSettings(new Set(['settings:theme']))).toBe(true);
    expect(adapter.read().map((entry) => entry.commandId)).toEqual([
      'nav:agents',
      'settings:theme',
    ]);
  });
});
