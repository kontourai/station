import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type NotificationSource } from '@kontourai/station-contracts/notification';
import {
  defaultNotificationPreferences,
  type NotificationPreferencesV1,
} from '@kontourai/station-contracts/notification-preferences';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  NOTIFICATION_PREFERENCES_FILE,
  NotificationPreferencesInvalidError,
  NotificationPreferencesStore,
  parseNotificationPreferences,
} from '../notification-preferences.js';

const AGENT: NotificationSource = {
  kind: 'agent',
  sessionId: 'session-1',
  projectId: 'project-a',
  agent: 'builder',
  assurance: 'bound',
};

function valid(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    agentNotifications: 'attention-only',
    perProject: { 'project-a': 'off' },
    perAgent: { builder: 'all' },
    quietHours: { start: '22:00', end: '07:00', allowAttention: true },
    perSurface: {
      'device:phone': { minUrgency: 'failed', hideContent: true },
      'local:9f1c': { minUrgency: 'info', hideContent: false },
    },
    escalateAfterMs: 60_000,
    ...overrides,
  };
}

describe('parseNotificationPreferences', () => {
  test('accepts a complete document and returns a fresh copy', () => {
    const input = valid();
    const parsed = parseNotificationPreferences(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
  });

  test('defaults parse as themselves (no quiet hours, 3 min, all)', () => {
    const defaults = defaultNotificationPreferences();
    expect(defaults).toEqual({
      schemaVersion: 1,
      agentNotifications: 'all',
      perProject: {},
      perAgent: {},
      perSurface: {},
      escalateAfterMs: 180_000,
    });
    expect(parseNotificationPreferences(defaults)).toEqual(defaults);
  });

  test.each<[string, unknown]>([
    ['not an object', 'all'],
    ['an array', []],
    ['an unknown top-level key', valid({ extra: true })],
    ['another schema version', valid({ schemaVersion: 2 })],
    [
      'a missing required key',
      (() => {
        const v = valid();
        delete v.perSurface;
        return v;
      })(),
    ],
    ['an unknown level', valid({ agentNotifications: 'some' })],
    ['an unknown per-project level', valid({ perProject: { a: 'quiet' } })],
    ['a blank per-agent key', valid({ perAgent: { ' ': 'off' } })],
    ['a fractional escalation', valid({ escalateAfterMs: 1.5 })],
    ['a negative escalation', valid({ escalateAfterMs: -1 })],
    ['an escalation over a day', valid({ escalateAfterMs: 86_400_001 })],
    ['an escalation as a string', valid({ escalateAfterMs: '180000' })],
    [
      'quiet hours with a bad clock',
      valid({
        quietHours: { start: '24:00', end: '07:00', allowAttention: false },
      }),
    ],
    [
      'an empty quiet window',
      valid({
        quietHours: { start: '07:00', end: '07:00', allowAttention: false },
      }),
    ],
    [
      'quiet hours with an extra key',
      valid({
        quietHours: {
          start: '22:00',
          end: '07:00',
          allowAttention: false,
          tz: 'UTC',
        },
      }),
    ],
    [
      'quiet hours missing allowAttention',
      valid({ quietHours: { start: '22:00', end: '07:00' } }),
    ],
    [
      'a surface id of another shape',
      valid({
        perSurface: { phone: { minUrgency: 'info', hideContent: false } },
      }),
    ],
    [
      'a surface with an unknown urgency',
      valid({
        perSurface: {
          'device:x': { minUrgency: 'urgent', hideContent: false },
        },
      }),
    ],
    [
      'a surface with an extra key',
      valid({
        perSurface: {
          'device:x': { minUrgency: 'info', hideContent: false, sound: true },
        },
      }),
    ],
    [
      'a surface hideContent that is not boolean',
      valid({
        perSurface: { 'device:x': { minUrgency: 'info', hideContent: 'yes' } },
      }),
    ],
    [
      'too many surfaces',
      valid({
        perSurface: Object.fromEntries(
          Array.from({ length: 257 }, (_, i) => [
            `device:${i}`,
            { minUrgency: 'info', hideContent: false },
          ]),
        ),
      }),
    ],
  ])('refuses %s', (_label, value) => {
    expect(parseNotificationPreferences(value)).toBeUndefined();
  });

  test('a __proto__ key stays data and cannot change the prototype', () => {
    const parsed = parseNotificationPreferences(
      JSON.parse(
        JSON.stringify(valid()).replace(
          '"perAgent":{"builder":"all"}',
          '"perAgent":{"__proto__":"off"}',
        ),
      ),
    );
    expect(parsed).toBeDefined();
    expect(Object.getPrototypeOf(parsed!.perAgent)).toBe(Object.prototype);
    expect(Object.hasOwn(parsed!.perAgent, '__proto__')).toBe(true);
  });
});

describe('NotificationPreferencesStore', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'notification-preferences-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test('a missing file reads as the defaults, not stored', () => {
    const store = new NotificationPreferencesStore(home);
    expect(store.read()).toEqual({
      ok: true,
      preferences: defaultNotificationPreferences(),
      stored: false,
    });
  });

  test('write persists 0600 JSON and serves it back', () => {
    const store = new NotificationPreferencesStore(home);
    const written = store.write(valid());
    const path = join(home, NOTIFICATION_PREFERENCES_FILE);
    if (process.platform !== 'win32')
      expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(written);
    // A second store (a restart) reads the same value from disk.
    expect(new NotificationPreferencesStore(home).read()).toEqual({
      ok: true,
      preferences: written,
      stored: true,
    });
  });

  test('an invalid write is refused and leaves the stored value alone', () => {
    const store = new NotificationPreferencesStore(home);
    store.write(valid());
    expect(() => store.write(valid({ agentNotifications: 'loud' }))).toThrow(
      NotificationPreferencesInvalidError,
    );
    expect(
      new NotificationPreferencesStore(home).current().agentNotifications,
    ).toBe('attention-only');
  });

  test.each([
    ['invalid JSON', '{not json', 0o600],
    [
      'a document that fails the strict parse',
      JSON.stringify(valid({ extra: 1 })),
      0o600,
    ],
    ['a file readable by others', JSON.stringify(valid()), 0o644],
  ])(
    '%s is reported unreadable, and delivery falls back to the defaults with one warning',
    (_label, contents, mode) => {
      if (process.platform === 'win32' && mode !== 0o600) return;
      const path = join(home, NOTIFICATION_PREFERENCES_FILE);
      writeFileSync(path, contents, { mode });
      chmodSync(path, mode);
      const logger = { warn: vi.fn() };
      const store = new NotificationPreferencesStore(home, logger);
      expect(store.read()).toEqual({ ok: false, error: 'unreadable' });
      expect(store.current()).toEqual(defaultNotificationPreferences());
      store.current();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      // Saving repairs it.
      store.write(valid());
      expect(store.read().ok).toBe(true);
    },
  );

  test('isMuted: agent sources only, most specific override wins', () => {
    const store = new NotificationPreferencesStore(home);
    const set = (value: Partial<NotificationPreferencesV1>) =>
      store.write({ ...defaultNotificationPreferences(), ...value });

    set({ agentNotifications: 'off' });
    expect(store.isMuted(AGENT)).toBe(true);
    expect(store.isMuted({ kind: 'system', subsystem: 'approvals' })).toBe(
      false,
    );
    expect(store.isMuted({ kind: 'provider', providerId: 'p' })).toBe(false);

    set({ agentNotifications: 'attention-only' });
    expect(store.isMuted(AGENT)).toBe(false);
    expect(store.isMuted(AGENT, 'attention')).toBe(false);
    expect(store.isMuted(AGENT, 'failed')).toBe(true);
    expect(store.isMuted(AGENT, 'info')).toBe(true);

    set({ perProject: { 'project-a': 'off' } });
    expect(store.isMuted(AGENT)).toBe(true);
    set({ perProject: { 'project-a': 'off' }, perAgent: { builder: 'all' } });
    expect(store.isMuted(AGENT)).toBe(false);
  });
});
