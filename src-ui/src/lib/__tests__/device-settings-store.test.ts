/**
 * @vitest-environment jsdom
 */

import { DEFAULT_NOTIFICATION_SOUND_PREFERENCES } from '@kontourai/station-contracts/device-settings';
import { afterEach, describe, expect, test, vi } from 'vitest';

const ENVELOPE_KEY = 'station-device-settings-v1';

/**
 * The store is a module-level singleton (mirrors `onboarding-setup-store.ts`)
 * whose one-time prior-setting migration runs in its constructor — so getting a
 * "fresh" instance per scenario means seeding real jsdom `localStorage`
 * before re-importing the module after `vi.resetModules()`, the same
 * pattern `active-chats-store.test.ts` uses for its own module-singleton
 * store (there via an injectable storage; here the store has none, so the
 * real global is seeded directly instead).
 */
async function freshStore() {
  vi.resetModules();
  return import('../device-settings-store');
}

describe('device-settings-store', () => {
  afterEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  describe('one-time prior-setting migration, one test per prior key', () => {
    test('theme', async () => {
      localStorage.setItem('theme', 'light');
      const { deviceSettingsStore } = await freshStore();

      expect(deviceSettingsStore.get('theme')).toBe('light');
      expect(localStorage.getItem('theme')).toBeNull();
      expect(localStorage.getItem(ENVELOPE_KEY)).not.toBeNull();
    });

    test('accentColor', async () => {
      localStorage.setItem('station-accent-color', '#8b5cf6');
      const { deviceSettingsStore } = await freshStore();

      expect(deviceSettingsStore.get('accentColor')).toBe('#8b5cf6');
      expect(localStorage.getItem('station-accent-color')).toBeNull();
    });

    test('featureSettings', async () => {
      localStorage.setItem(
        'station-feature-settings',
        JSON.stringify({ ttsReadbackEnabled: true, voiceS2SEnabled: true }),
      );
      const { deviceSettingsStore } = await freshStore();

      expect(deviceSettingsStore.get('featureSettings')).toEqual({
        ttsReadbackEnabled: true,
        pushNotificationsEnabled: false,
        voiceS2SEnabled: true,
        mobilePairingEnabled: false,
        notificationSounds: DEFAULT_NOTIFICATION_SOUND_PREFERENCES,
      });
      expect(localStorage.getItem('station-feature-settings')).toBeNull();
    });

    test('sttProvider', async () => {
      localStorage.setItem('station-stt-provider', 'nova');
      const { deviceSettingsStore } = await freshStore();

      expect(deviceSettingsStore.get('sttProvider')).toBe('nova');
      expect(localStorage.getItem('station-stt-provider')).toBeNull();
    });

    test('ttsProvider', async () => {
      localStorage.setItem('station-tts-provider', 'polly');
      const { deviceSettingsStore } = await freshStore();

      expect(deviceSettingsStore.get('ttsProvider')).toBe('polly');
      expect(localStorage.getItem('station-tts-provider')).toBeNull();
    });

    test('chatDockAutoHide', async () => {
      localStorage.setItem('chatDockAutoHide', 'true');
      const { deviceSettingsStore } = await freshStore();

      expect(deviceSettingsStore.get('chatDockAutoHide')).toBe(true);
      expect(localStorage.getItem('chatDockAutoHide')).toBeNull();
    });

    test('diffStyle', async () => {
      localStorage.setItem('station.diff.style', 'split');
      const { deviceSettingsStore } = await freshStore();

      expect(deviceSettingsStore.get('diffStyle')).toBe('split');
      expect(localStorage.getItem('station.diff.style')).toBeNull();
    });

    test('diffWrap (prior "1"/"0" encoding, not "true"/"false")', async () => {
      localStorage.setItem('station.diff.wrap', '1');
      const { deviceSettingsStore } = await freshStore();

      expect(deviceSettingsStore.get('diffWrap')).toBe(true);
      expect(localStorage.getItem('station.diff.wrap')).toBeNull();
    });

    test('inboxOpen', async () => {
      localStorage.setItem('station.inbox.open', 'false');
      const { deviceSettingsStore } = await freshStore();

      expect(deviceSettingsStore.get('inboxOpen')).toBe(false);
      expect(localStorage.getItem('station.inbox.open')).toBeNull();
    });

    test('inboxSections', async () => {
      localStorage.setItem(
        'station.inbox.sections',
        JSON.stringify({ snoozed: true, earlier: true }),
      );
      const { deviceSettingsStore } = await freshStore();

      expect(deviceSettingsStore.get('inboxSections')).toEqual({
        snoozed: true,
        earlier: true,
      });
      expect(localStorage.getItem('station.inbox.sections')).toBeNull();
    });

    test('projectSidebarCollapsed', async () => {
      localStorage.setItem('station-sidebar-collapsed', 'true');
      const { deviceSettingsStore } = await freshStore();

      expect(deviceSettingsStore.get('projectSidebarCollapsed')).toBe(true);
      expect(localStorage.getItem('station-sidebar-collapsed')).toBeNull();
    });

    test('onboardingSetupDismissed (prior "1" encoding)', async () => {
      localStorage.setItem('station:onboarding-setup-dismissed', '1');
      const { deviceSettingsStore } = await freshStore();

      expect(deviceSettingsStore.get('onboardingSetupDismissed')).toBe(true);
      expect(
        localStorage.getItem('station:onboarding-setup-dismissed'),
      ).toBeNull();
    });

    test('shortcutOverrides + modelPickerPreferences (shared 1359 root)', async () => {
      localStorage.setItem(
        'station.device-settings',
        JSON.stringify({
          version: 1,
          shortcuts: {
            bindings: { 'app.settings': { key: 's', modifiers: ['cmd'] } },
          },
          modelPicker: { favorites: ['providermodel'] },
        }),
      );
      const { deviceSettingsStore } = await freshStore();

      expect(deviceSettingsStore.get('shortcutOverrides')).toEqual({
        'app.settings': { key: 's', modifiers: ['cmd'] },
      });
      expect(deviceSettingsStore.get('modelPickerPreferences')).toEqual({
        favorites: ['providermodel'],
        recents: [],
        hidden: [],
        order: [],
      });
      expect(localStorage.getItem('station.device-settings')).toBeNull();
    });

    test('shortcutOverrides falls back to default when the shared root has no shortcuts field', async () => {
      localStorage.setItem(
        'station.device-settings',
        JSON.stringify({ version: 1, modelPicker: { favorites: ['x'] } }),
      );
      const { deviceSettingsStore } = await freshStore();

      expect(deviceSettingsStore.get('shortcutOverrides')).toEqual({});
      expect(
        Object.hasOwn(
          deviceSettingsStore.getEnvelope().values,
          'shortcutOverrides',
        ),
      ).toBe(false);
      expect(
        deviceSettingsStore.get('modelPickerPreferences').favorites,
      ).toEqual(['x']);
    });

    test('a malformed shared 1359 root falls back to defaults for both sharers without throwing', async () => {
      localStorage.setItem('station.device-settings', '{not valid json');
      const { deviceSettingsStore } = await freshStore();

      expect(deviceSettingsStore.get('shortcutOverrides')).toEqual({});
      expect(deviceSettingsStore.get('modelPickerPreferences')).toEqual({
        favorites: [],
        recents: [],
        hidden: [],
        order: [],
      });
    });
  });

  describe('v1 -> v2 backfill migration for already-upgraded devices (slice 3 review finding 1)', () => {
    // The real bug: slice 2 (already live on main before slice 3) writes an
    // empty v1 envelope on EVERY device's first boot, so a device that
    // upgrades straight to this slice already has a v1 envelope present —
    // `migrateFromPriorStorage` (which only runs when the envelope key is
    // entirely ABSENT) never fires for it, and without the v1->v2 ladder
    // step its `station.device-settings` root would orphan forever.
    test('a pre-existing v1 envelope alongside a populated prior settings root backfills on construction, preserves unrelated values, and removes the prior settings root', async () => {
      localStorage.setItem(
        ENVELOPE_KEY,
        JSON.stringify({
          version: 1,
          values: { theme: 'light', diffWrap: true },
        }),
      );
      localStorage.setItem(
        'station.device-settings',
        JSON.stringify({
          shortcuts: {
            bindings: { 'app.settings': { key: 's', modifiers: ['cmd'] } },
          },
          modelPicker: { favorites: ['provider-model'] },
        }),
      );

      const { deviceSettingsStore } = await freshStore();

      const envelope = deviceSettingsStore.getEnvelope();
      expect(envelope.version).toBe(2);
      expect(deviceSettingsStore.get('shortcutOverrides')).toEqual({
        'app.settings': { key: 's', modifiers: ['cmd'] },
      });
      expect(
        deviceSettingsStore.get('modelPickerPreferences').favorites,
      ).toEqual(['provider-model']);
      // Unrelated pre-existing values survive the backfill untouched.
      expect(deviceSettingsStore.get('theme')).toBe('light');
      expect(deviceSettingsStore.get('diffWrap')).toBe(true);
      // The prior settings root is fully consumed and removed.
      expect(localStorage.getItem('station.device-settings')).toBeNull();
      // The backfill was actually persisted, not just held in memory.
      const persisted = JSON.parse(
        localStorage.getItem(ENVELOPE_KEY) as string,
      );
      expect(persisted.version).toBe(2);
      expect(persisted.values.shortcutOverrides).toEqual({
        'app.settings': { key: 's', modifiers: ['cmd'] },
      });
    });

    test('a pre-existing v1 envelope with no prior settings root cleanly upgrades to v2 with a no-op backfill', async () => {
      localStorage.setItem(
        ENVELOPE_KEY,
        JSON.stringify({ version: 1, values: { theme: 'light' } }),
      );

      const { deviceSettingsStore } = await freshStore();

      expect(deviceSettingsStore.getEnvelope().version).toBe(2);
      expect(deviceSettingsStore.get('theme')).toBe('light');
      expect(deviceSettingsStore.get('shortcutOverrides')).toEqual({});
      expect(deviceSettingsStore.get('modelPickerPreferences')).toEqual({
        favorites: [],
        recents: [],
        hidden: [],
        order: [],
      });
      expect(localStorage.getItem('station.device-settings')).toBeNull();
    });

    test('a write failure during backfill retains the prior settings root (degraded but lossless, matching migrateFromPriorStorage)', async () => {
      localStorage.setItem(
        ENVELOPE_KEY,
        JSON.stringify({ version: 1, values: { theme: 'light' } }),
      );
      localStorage.setItem(
        'station.device-settings',
        JSON.stringify({
          shortcuts: {
            bindings: { 'app.settings': { key: 's', modifiers: ['cmd'] } },
          },
        }),
      );

      const setItemSpy = vi
        .spyOn(Storage.prototype, 'setItem')
        .mockImplementation((key: string) => {
          if (key === ENVELOPE_KEY) {
            throw new Error('QuotaExceededError (simulated)');
          }
          throw new Error(`unexpected setItem(${key}) during migration`);
        });

      const { deviceSettingsStore } = await freshStore();

      // Degraded but lossless: the backfilled value is served from memory
      // this session even though the write never landed.
      expect(deviceSettingsStore.get('shortcutOverrides')).toEqual({
        'app.settings': { key: 's', modifiers: ['cmd'] },
      });

      setItemSpy.mockRestore();

      // The prior settings root was NOT removed, since the write was never confirmed.
      expect(localStorage.getItem('station.device-settings')).not.toBeNull();
    });
  });

  // station#settings-revamp slice 4 review NOTE: `Number('')` and
  // `Number('   ')` both coerce to `0`, not `NaN` — an unguarded number-kind
  // `parsePriorValue` would silently resolve an empty/whitespace prior raw
  // value to `0` instead of the setting's real default. Currently dead code
  // in production (no number-kind device setting has a `priorStorageKey`
  // yet) — this test exercises the exported function directly so the guard
  // has a pinned regression test before the first one lands.
  describe("parsePriorValue('number') empty/whitespace guard (dead code today, guarded for the first number-kind prior key)", () => {
    test('an empty string falls back to defaultValue, not 0', async () => {
      const { parsePriorValue } = await freshStore();

      expect(parsePriorValue({ kind: 'number' }, '', 14)).toBe(14);
    });

    test('a whitespace-only string falls back to defaultValue, not 0', async () => {
      const { parsePriorValue } = await freshStore();

      expect(parsePriorValue({ kind: 'number' }, '   ', 14)).toBe(14);
    });

    test('a genuine numeric string still parses correctly', async () => {
      const { parsePriorValue } = await freshStore();

      expect(parsePriorValue({ kind: 'number' }, '18', 14)).toBe(18);
    });

    test('a non-numeric, non-empty string falls back to defaultValue', async () => {
      const { parsePriorValue } = await freshStore();

      expect(parsePriorValue({ kind: 'number' }, 'not-a-number', 14)).toBe(14);
    });
  });

  test('malformed JSON in a prior composite value falls back to default without throwing', async () => {
    localStorage.setItem('station-feature-settings', '{not valid json');
    const { deviceSettingsStore } = await freshStore();

    expect(deviceSettingsStore.get('featureSettings')).toEqual({
      ttsReadbackEnabled: false,
      pushNotificationsEnabled: false,
      voiceS2SEnabled: false,
      mobilePairingEnabled: false,
      notificationSounds: DEFAULT_NOTIFICATION_SOUND_PREFERENCES,
    });
  });

  test('drops an imported featureSettings value with an invalid notification sound', async () => {
    const { deviceSettingsStore } = await freshStore();

    const result = deviceSettingsStore.importEnvelope({
      version: 2,
      values: {
        featureSettings: {
          notificationSounds: { 'job-failure': 'airhorn' },
        },
      },
    });

    expect(result.droppedKeys).toEqual(['featureSettings']);
    expect(
      deviceSettingsStore.get('featureSettings').notificationSounds,
    ).toEqual(DEFAULT_NOTIFICATION_SOUND_PREFERENCES);
  });

  test('persists a category sound within the existing featureSettings envelope', async () => {
    const { deviceSettingsStore } = await freshStore();
    const featureSettings = deviceSettingsStore.get('featureSettings');

    deviceSettingsStore.set('featureSettings', {
      ...featureSettings,
      notificationSounds: {
        ...featureSettings.notificationSounds,
        'turn-completed': 'none',
      },
    });

    expect(
      JSON.parse(localStorage.getItem(ENVELOPE_KEY) ?? '{}').values
        .featureSettings.notificationSounds['turn-completed'],
    ).toBe('none');
  });

  test('a missing prior key resolves to its default with no forced write into the envelope', async () => {
    const { deviceSettingsStore } = await freshStore();

    expect(deviceSettingsStore.get('chatDockAutoHide')).toBe(false);
    const envelope = deviceSettingsStore.getEnvelope();
    expect(Object.hasOwn(envelope.values, 'chatDockAutoHide')).toBe(false);
  });

  test('an empty-string prior value is still migrated (present, not absent)', async () => {
    localStorage.setItem('chatDockAutoHide', '');
    const { deviceSettingsStore } = await freshStore();

    expect(deviceSettingsStore.get('chatDockAutoHide')).toBe(false);
    expect(localStorage.getItem('chatDockAutoHide')).toBeNull();
    expect(
      Object.hasOwn(
        deviceSettingsStore.getEnvelope().values,
        'chatDockAutoHide',
      ),
    ).toBe(true);
  });

  test('envelope version ladder scaffold: an already-current envelope passes through unchanged', async () => {
    // CURRENT_ENVELOPE_VERSION is 2 (station#settings-revamp slice 3 review
    // finding 1) — seed a v2 envelope directly to test the "already current,
    // no ladder step runs" case; v1-envelope upgrade behavior is covered by
    // the dedicated "v1 -> v2 backfill migration" describe block above.
    localStorage.setItem(
      ENVELOPE_KEY,
      JSON.stringify({ version: 2, values: { theme: 'light' } }),
    );
    const { deviceSettingsStore } = await freshStore();

    expect(deviceSettingsStore.getEnvelope()).toEqual({
      version: 2,
      values: { theme: 'light' },
    });
    expect(deviceSettingsStore.get('theme')).toBe('light');
  });

  test('a malformed envelope value resets to an empty current-version envelope rather than throwing', async () => {
    localStorage.setItem(ENVELOPE_KEY, '{not valid json');
    const { deviceSettingsStore } = await freshStore();

    expect(deviceSettingsStore.getEnvelope()).toEqual({
      version: 2,
      values: {},
    });
  });

  test('hydration is synchronously true immediately after construction', async () => {
    const { deviceSettingsStore } = await freshStore();

    expect(deviceSettingsStore.isHydrated()).toBe(true);
  });

  test('set() persists, updates the resolved snapshot, and notifies subscribers', async () => {
    const { deviceSettingsStore } = await freshStore();

    const before = deviceSettingsStore.getSnapshot();
    const listener = vi.fn();
    deviceSettingsStore.subscribe(listener);

    deviceSettingsStore.set('theme', 'light');

    expect(deviceSettingsStore.get('theme')).toBe('light');
    expect(deviceSettingsStore.getSnapshot()).not.toBe(before);
    expect(listener).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(localStorage.getItem(ENVELOPE_KEY) as string);
    expect(persisted.values.theme).toBe('light');
  });

  test('reset() clears an explicit override back to the registry default', async () => {
    const { deviceSettingsStore } = await freshStore();

    deviceSettingsStore.set('diffWrap', true);
    expect(deviceSettingsStore.get('diffWrap')).toBe(true);

    deviceSettingsStore.reset('diffWrap');
    expect(deviceSettingsStore.get('diffWrap')).toBe(false);
    expect(
      Object.hasOwn(deviceSettingsStore.getEnvelope().values, 'diffWrap'),
    ).toBe(false);
  });

  test('merge() applies several values at once', async () => {
    const { deviceSettingsStore } = await freshStore();

    deviceSettingsStore.merge({ diffStyle: 'split', diffWrap: true });

    expect(deviceSettingsStore.get('diffStyle')).toBe('split');
    expect(deviceSettingsStore.get('diffWrap')).toBe(true);
  });

  test('importEnvelope() adopts a whole envelope wholesale', async () => {
    const { deviceSettingsStore } = await freshStore();

    deviceSettingsStore.importEnvelope({
      version: 1,
      values: { theme: 'light', chatDockAutoHide: true },
    });

    expect(deviceSettingsStore.get('theme')).toBe('light');
    expect(deviceSettingsStore.get('chatDockAutoHide')).toBe(true);
  });

  describe('resolveBootTheme', () => {
    test('reads theme from a present envelope', async () => {
      const { resolveBootTheme } = await freshStore();
      const envelopeRaw = JSON.stringify({
        version: 1,
        values: { theme: 'light' },
      });
      expect(resolveBootTheme(envelopeRaw, null)).toBe('light');
    });

    test('falls back to the prior raw key when the envelope is absent', async () => {
      const { resolveBootTheme } = await freshStore();
      expect(resolveBootTheme(null, 'light')).toBe('light');
    });

    test('defaults to dark when both are absent', async () => {
      const { resolveBootTheme } = await freshStore();
      expect(resolveBootTheme(null, null)).toBe('dark');
    });

    test('never throws on a malformed envelope, falling back to prior/default', async () => {
      const { resolveBootTheme } = await freshStore();
      expect(() => resolveBootTheme('{not valid json', 'light')).not.toThrow();
      expect(resolveBootTheme('{not valid json', 'light')).toBe('light');
      expect(resolveBootTheme('{not valid json', null)).toBe('dark');
    });

    // Review omission item: prove the real module-import-order sequence
    // (`main.tsx` imports this module for `resolveBootTheme`, which runs the
    // singleton's migrating constructor as an ES-module side effect BEFORE
    // any of the module's exports are called) actually gives the fast path
    // a correct value from the envelope alone on the very first post-
    // upgrade load — not just via the prior-setting branch.
    test('on the first post-upgrade load, the envelope the migration just wrote already carries the value main.tsx reads', async () => {
      localStorage.setItem('theme', 'light');

      const { resolveBootTheme } = await freshStore();

      const envelopeRaw = localStorage.getItem(ENVELOPE_KEY);
      const priorRaw = localStorage.getItem('theme');
      expect(priorRaw).toBeNull();
      expect(envelopeRaw).not.toBeNull();
      expect(resolveBootTheme(envelopeRaw, priorRaw)).toBe('light');
    });
  });

  describe('finding 1: migration only removes prior keys after a confirmed envelope write', () => {
    test('a failed envelope write keeps the prior keys and still serves parsed values from memory this session', async () => {
      localStorage.setItem('theme', 'light');
      localStorage.setItem('station-accent-color', '#112233');

      const setItemSpy = vi
        .spyOn(Storage.prototype, 'setItem')
        .mockImplementation((key: string) => {
          if (key === ENVELOPE_KEY) {
            throw new Error('QuotaExceededError (simulated)');
          }
          throw new Error(`unexpected setItem(${key}) during migration`);
        });

      const { deviceSettingsStore } = await freshStore();

      // Degraded but lossless: served from memory even though the write
      // never landed.
      expect(deviceSettingsStore.get('theme')).toBe('light');
      expect(deviceSettingsStore.get('accentColor')).toBe('#112233');

      setItemSpy.mockRestore();

      // The prior keys were NOT removed, since the write was never
      // confirmed to have landed.
      expect(localStorage.getItem('theme')).toBe('light');
      expect(localStorage.getItem('station-accent-color')).toBe('#112233');
      expect(localStorage.getItem(ENVELOPE_KEY)).toBeNull();
    });

    test('a subsequent construction with working storage completes the migration from the still-present prior keys', async () => {
      localStorage.setItem('theme', 'light');
      localStorage.setItem('station-accent-color', '#112233');

      const setItemSpy = vi
        .spyOn(Storage.prototype, 'setItem')
        .mockImplementation((key: string) => {
          if (key === ENVELOPE_KEY) throw new Error('simulated quota error');
        });
      await freshStore(); // first ("failed") boot
      setItemSpy.mockRestore();

      const { deviceSettingsStore: reconstructed } = await freshStore();

      expect(reconstructed.get('theme')).toBe('light');
      expect(reconstructed.get('accentColor')).toBe('#112233');
      expect(localStorage.getItem('theme')).toBeNull();
      expect(localStorage.getItem('station-accent-color')).toBeNull();
      expect(localStorage.getItem(ENVELOPE_KEY)).not.toBeNull();
    });
  });

  describe('finding 2: importEnvelope validates version and per-value shape', () => {
    test('rejects a version newer than this app understands, adopting nothing', async () => {
      const { deviceSettingsStore, DeviceSettingsImportVersionError } =
        await freshStore();

      // CURRENT_ENVELOPE_VERSION is 2 (station#settings-revamp slice 3
      // review finding 1) — version 3 is the one genuinely newer than this
      // app understands.
      expect(() =>
        deviceSettingsStore.importEnvelope({
          version: 3,
          values: { theme: 'light' },
        }),
      ).toThrow(DeviceSettingsImportVersionError);
      expect(deviceSettingsStore.get('theme')).toBe('dark');
    });

    test('drops an invalid composite value (inboxSections: null) and reports it, rather than crashing a consumer that dereferences it', async () => {
      const { deviceSettingsStore } = await freshStore();

      const result = deviceSettingsStore.importEnvelope({
        version: 1,
        values: { theme: 'light', inboxSections: null },
      });

      expect(result.droppedKeys).toEqual(['inboxSections']);
      expect(deviceSettingsStore.get('theme')).toBe('light');
      expect(deviceSettingsStore.get('inboxSections')).toEqual({
        snoozed: false,
        earlier: false,
      });
    });

    test('imports the valid subset of a partially-valid file', async () => {
      const { deviceSettingsStore } = await freshStore();

      const result = deviceSettingsStore.importEnvelope({
        version: 1,
        values: {
          theme: 'light',
          diffStyle: 'not-a-real-style',
          chatDockAutoHide: 'yes',
        },
      });

      expect(result.droppedKeys.sort()).toEqual(
        ['diffStyle', 'chatDockAutoHide'].sort(),
      );
      expect(deviceSettingsStore.get('theme')).toBe('light');
      expect(deviceSettingsStore.get('diffStyle')).toBe('unified');
      expect(deviceSettingsStore.get('chatDockAutoHide')).toBe(false);
    });

    describe('shortcutOverrides / modelPickerPreferences shape validation (slice 3 review finding 2)', () => {
      test('a modelPickerPreferences.order sent as a string is dropped, not silently coerced', async () => {
        const { deviceSettingsStore } = await freshStore();

        const result = deviceSettingsStore.importEnvelope({
          version: 2,
          values: {
            modelPickerPreferences: {
              favorites: ['ab'],
              order: 'not-an-array',
            },
          },
        });

        expect(result.droppedKeys).toEqual(['modelPickerPreferences']);
        expect(deviceSettingsStore.get('modelPickerPreferences')).toEqual({
          favorites: [],
          recents: [],
          hidden: [],
          order: [],
        });
      });

      test('a shortcutOverrides binding with a non-string key is dropped', async () => {
        const { deviceSettingsStore } = await freshStore();

        const result = deviceSettingsStore.importEnvelope({
          version: 2,
          values: {
            shortcutOverrides: {
              'app.settings': { key: 123, modifiers: ['cmd'] },
            },
          },
        });

        expect(result.droppedKeys).toEqual(['shortcutOverrides']);
        expect(deviceSettingsStore.get('shortcutOverrides')).toEqual({});
      });

      test('a shortcutOverrides binding with an unrecognized modifier is dropped', async () => {
        const { deviceSettingsStore } = await freshStore();

        const result = deviceSettingsStore.importEnvelope({
          version: 2,
          values: {
            shortcutOverrides: {
              'app.settings': { key: 'k', modifiers: ['hyper'] },
            },
          },
        });

        expect(result.droppedKeys).toEqual(['shortcutOverrides']);
      });

      test('valid shortcutOverrides and modelPickerPreferences values still import', async () => {
        const { deviceSettingsStore } = await freshStore();

        const result = deviceSettingsStore.importEnvelope({
          version: 2,
          values: {
            shortcutOverrides: {
              'app.settings': { key: 's', modifiers: ['cmd'] },
              'command-palette': null,
            },
            modelPickerPreferences: {
              favorites: ['x'],
              hidden: [],
              order: ['x'],
            },
          },
        });

        expect(result.droppedKeys).toEqual([]);
        expect(deviceSettingsStore.get('shortcutOverrides')).toEqual({
          'app.settings': { key: 's', modifiers: ['cmd'] },
          'command-palette': null,
        });
        expect(deviceSettingsStore.get('modelPickerPreferences')).toEqual({
          favorites: ['x'],
          recents: [],
          hidden: [],
          order: ['x'],
        });
      });
    });
  });

  describe('finding 3: two-tab lost-update and cross-tab sync', () => {
    test('set() read-merge-writes, preserving an out-of-band localStorage change to an unrelated key', async () => {
      const { deviceSettingsStore } = await freshStore();

      deviceSettingsStore.set('theme', 'light');

      // Simulate another tab writing a DIFFERENT key directly, without
      // going through this tab's in-memory store at all.
      const outOfBand = JSON.parse(
        localStorage.getItem(ENVELOPE_KEY) as string,
      );
      outOfBand.values.diffWrap = true;
      localStorage.setItem(ENVELOPE_KEY, JSON.stringify(outOfBand));

      // This tab, unaware of the direct write, sets an unrelated key. A
      // blind overwrite from this tab's stale in-memory envelope would
      // have reverted diffWrap back to false.
      deviceSettingsStore.set('chatDockAutoHide', true);

      const persisted = JSON.parse(
        localStorage.getItem(ENVELOPE_KEY) as string,
      );
      expect(persisted.values.diffWrap).toBe(true);
      expect(persisted.values.chatDockAutoHide).toBe(true);
      expect(deviceSettingsStore.get('diffWrap')).toBe(true);
      expect(deviceSettingsStore.get('chatDockAutoHide')).toBe(true);
    });

    test('an external storage event for the envelope key updates the snapshot and notifies subscribers', async () => {
      const { deviceSettingsStore } = await freshStore();
      const listener = vi.fn();
      deviceSettingsStore.subscribe(listener);

      expect(deviceSettingsStore.get('theme')).toBe('dark');

      const externalEnvelope = { version: 1, values: { theme: 'light' } };
      localStorage.setItem(ENVELOPE_KEY, JSON.stringify(externalEnvelope));
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: ENVELOPE_KEY,
          newValue: JSON.stringify(externalEnvelope),
          storageArea: localStorage,
        }),
      );

      expect(deviceSettingsStore.get('theme')).toBe('light');
      expect(listener).toHaveBeenCalledTimes(1);
    });

    test('a storage event for an unrelated key is ignored', async () => {
      const { deviceSettingsStore } = await freshStore();
      const listener = vi.fn();
      deviceSettingsStore.subscribe(listener);

      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'some-other-key',
          newValue: 'whatever',
        }),
      );

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('station#settings-revamp slice 4: chatShowReasoning/chatShowToolDetails/chatFontSize/dockSlotPlacement', () => {
    test('resolve to their registry defaults with no prior key to migrate from', async () => {
      const { deviceSettingsStore } = await freshStore();

      expect(deviceSettingsStore.get('chatShowReasoning')).toBe(true);
      expect(deviceSettingsStore.get('chatShowToolDetails')).toBe(true);
      expect(deviceSettingsStore.get('chatFontSize')).toBeNull();
      expect(deviceSettingsStore.get('dockSlotPlacement')).toBe('bottom');
      // No prior key exists for any of these — the migration must not
      // conjure a raw-string read for a key that was never registered.
      const envelope = deviceSettingsStore.getEnvelope();
      expect(Object.hasOwn(envelope.values, 'chatShowReasoning')).toBe(false);
      expect(Object.hasOwn(envelope.values, 'chatFontSize')).toBe(false);
    });

    test('set()/get() round-trip a number value for chatFontSize', async () => {
      const { deviceSettingsStore } = await freshStore();

      deviceSettingsStore.set('chatFontSize', 18);

      expect(deviceSettingsStore.get('chatFontSize')).toBe(18);
      const persisted = JSON.parse(
        localStorage.getItem(ENVELOPE_KEY) as string,
      );
      expect(persisted.values.chatFontSize).toBe(18);
    });

    test('reset() clears an explicit chatFontSize back to null (follow the Station default)', async () => {
      const { deviceSettingsStore } = await freshStore();

      deviceSettingsStore.set('chatFontSize', 18);
      deviceSettingsStore.reset('chatFontSize');

      expect(deviceSettingsStore.get('chatFontSize')).toBeNull();
    });

    test('set()/get() round-trip dockSlotPlacement', async () => {
      const { deviceSettingsStore } = await freshStore();

      deviceSettingsStore.set('dockSlotPlacement', 'right');

      expect(deviceSettingsStore.get('dockSlotPlacement')).toBe('right');
    });

    test('importEnvelope() accepts a valid chatFontSize number and rejects a non-numeric one', async () => {
      const { deviceSettingsStore } = await freshStore();

      const ok = deviceSettingsStore.importEnvelope({
        version: 2,
        values: { chatFontSize: 16 },
      });
      expect(ok.droppedKeys).toEqual([]);
      expect(deviceSettingsStore.get('chatFontSize')).toBe(16);

      const bad = deviceSettingsStore.importEnvelope({
        version: 2,
        values: { chatFontSize: '16' },
      });
      expect(bad.droppedKeys).toEqual(['chatFontSize']);
      expect(deviceSettingsStore.get('chatFontSize')).toBeNull();
    });

    // station#settings-revamp slice 4 review finding 2: the number case
    // ignored `descriptor.min`/`max`/`integer` entirely — an imported
    // `chatFontSize: 5000` (or `-12`, or `3.7` against `integer: true`)
    // landed unclamped into a real inline `fontSize` style (ChatSettingsPanel's
    // A−/A+ clamp is client-side only, never re-applied to an imported
    // value). Out-of-bounds/non-integer must be dropped, not silently
    // clamped, matching the established import contract for every other
    // kind.
    test('importEnvelope() drops an out-of-range chatFontSize (over max) rather than clamping it', async () => {
      const { deviceSettingsStore } = await freshStore();

      const result = deviceSettingsStore.importEnvelope({
        version: 2,
        values: { chatFontSize: 5000 },
      });

      expect(result.droppedKeys).toEqual(['chatFontSize']);
      expect(deviceSettingsStore.get('chatFontSize')).toBeNull();
    });

    test('importEnvelope() drops an out-of-range chatFontSize (under min, negative) rather than clamping it', async () => {
      const { deviceSettingsStore } = await freshStore();

      const result = deviceSettingsStore.importEnvelope({
        version: 2,
        values: { chatFontSize: -12 },
      });

      expect(result.droppedKeys).toEqual(['chatFontSize']);
      expect(deviceSettingsStore.get('chatFontSize')).toBeNull();
    });

    test('importEnvelope() drops a non-integer chatFontSize rather than rounding it', async () => {
      const { deviceSettingsStore } = await freshStore();

      const result = deviceSettingsStore.importEnvelope({
        version: 2,
        values: { chatFontSize: 3.7 },
      });

      expect(result.droppedKeys).toEqual(['chatFontSize']);
      expect(deviceSettingsStore.get('chatFontSize')).toBeNull();
    });

    test('importEnvelope() accepts an in-range integer chatFontSize', async () => {
      const { deviceSettingsStore } = await freshStore();

      const result = deviceSettingsStore.importEnvelope({
        version: 2,
        values: { chatFontSize: 18 },
      });

      expect(result.droppedKeys).toEqual([]);
      expect(deviceSettingsStore.get('chatFontSize')).toBe(18);
    });

    test('importEnvelope() accepts the exact min/max boundary values (10 and 24)', async () => {
      const { deviceSettingsStore } = await freshStore();

      const min = deviceSettingsStore.importEnvelope({
        version: 2,
        values: { chatFontSize: 10 },
      });
      expect(min.droppedKeys).toEqual([]);
      expect(deviceSettingsStore.get('chatFontSize')).toBe(10);

      const max = deviceSettingsStore.importEnvelope({
        version: 2,
        values: { chatFontSize: 24 },
      });
      expect(max.droppedKeys).toEqual([]);
      expect(deviceSettingsStore.get('chatFontSize')).toBe(24);
    });

    test('importEnvelope() accepts an explicit null chatFontSize (the "follow the Station default" value)', async () => {
      const { deviceSettingsStore } = await freshStore();

      deviceSettingsStore.set('chatFontSize', 16);
      const result = deviceSettingsStore.importEnvelope({
        version: 2,
        values: { chatFontSize: null },
      });

      expect(result.droppedKeys).toEqual([]);
      expect(deviceSettingsStore.get('chatFontSize')).toBeNull();
    });

    test('importEnvelope() rejects null for a non-nullable number-kind field the same way it rejects null strings', async () => {
      const { deviceSettingsStore } = await freshStore();

      // No non-nullable number-kind device setting exists yet other than the
      // nullable chatFontSize itself, so this proves the general rule using
      // a value shape check instead: a bogus key is simply dropped by
      // `sanitizeImportedValues` (untouched behavior), confirmed here so a
      // future non-nullable number field inherits the right default.
      const result = deviceSettingsStore.importEnvelope({
        version: 2,
        values: { dockSlotPlacement: null },
      });
      expect(result.droppedKeys).toEqual(['dockSlotPlacement']);
      expect(deviceSettingsStore.get('dockSlotPlacement')).toBe('bottom');
    });

    test('importEnvelope() rejects an out-of-enum dockSlotPlacement', async () => {
      const { deviceSettingsStore } = await freshStore();

      const result = deviceSettingsStore.importEnvelope({
        version: 2,
        values: { dockSlotPlacement: 'floating' },
      });

      expect(result.droppedKeys).toEqual(['dockSlotPlacement']);
      expect(deviceSettingsStore.get('dockSlotPlacement')).toBe('bottom');
    });

    test('same-value set() on chatFontSize/dockSlotPlacement/chatShowReasoning is a true no-op', async () => {
      const { deviceSettingsStore } = await freshStore();
      const listener = vi.fn();
      deviceSettingsStore.subscribe(listener);

      deviceSettingsStore.set('chatShowReasoning', true); // already the default
      deviceSettingsStore.set('dockSlotPlacement', 'bottom'); // already the default
      deviceSettingsStore.set('chatFontSize', null); // already the default

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('omission item: same-value set() is a true no-op', () => {
    test('setting a key to its already-current (default) value replaces nothing and does not notify', async () => {
      const { deviceSettingsStore } = await freshStore();
      const beforeSnapshot = deviceSettingsStore.getSnapshot();
      const beforeEnvelope = deviceSettingsStore.getEnvelope();
      const listener = vi.fn();
      deviceSettingsStore.subscribe(listener);

      deviceSettingsStore.set('theme', 'dark');

      expect(deviceSettingsStore.getSnapshot()).toBe(beforeSnapshot);
      expect(deviceSettingsStore.getEnvelope()).toBe(beforeEnvelope);
      expect(listener).not.toHaveBeenCalled();
    });

    test('setting an already-explicit value to the same value again is also a no-op', async () => {
      const { deviceSettingsStore } = await freshStore();
      deviceSettingsStore.set('diffWrap', true);
      const snapshotAfterFirstSet = deviceSettingsStore.getSnapshot();
      const listener = vi.fn();
      deviceSettingsStore.subscribe(listener);

      deviceSettingsStore.set('diffWrap', true);

      expect(deviceSettingsStore.getSnapshot()).toBe(snapshotAfterFirstSet);
      expect(listener).not.toHaveBeenCalled();
    });
  });

  /**
   * A document whose storage access is denied — an opaque origin (a sandboxed
   * iframe without `allow-same-origin`, an `about:blank` document) or a
   * browser configured to block site data — throws `SecurityError` when the
   * `window.localStorage` PROPERTY is read, before any `getItem` runs. The
   * store is a module-scope singleton, so a probe that propagates that throw
   * takes down every bundle importing this module at import time. jsdom always
   * grants storage, so the denial is modelled by replacing the accessor.
   */
  describe('a document that denies storage access', () => {
    async function withDeniedStorage<T>(run: () => Promise<T>): Promise<T> {
      const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new DOMException(
            "Failed to read the 'localStorage' property from 'Window': Access is denied for this document.",
            'SecurityError',
          );
        },
      });
      try {
        return await run();
      } finally {
        if (original) Object.defineProperty(window, 'localStorage', original);
      }
    }

    test('importing the module constructs the singleton instead of throwing', async () => {
      const settings = await withDeniedStorage(() => freshStore());

      expect(settings.deviceSettingsStore.get('theme')).toBe('dark');
    });

    test('writes are best-effort no-ops rather than throws', async () => {
      await withDeniedStorage(async () => {
        const { deviceSettingsStore } = await freshStore();

        expect(() => deviceSettingsStore.set('theme', 'light')).not.toThrow();
        expect(deviceSettingsStore.get('theme')).toBe('light');
        expect(() => deviceSettingsStore.reset('theme')).not.toThrow();
      });
    });
  });
});
