/**
 * Registry-completeness tests for `device-settings.ts`
 * (docs/design/settings-architecture.md §3 "S3. Device", §6 slice 2). The
 * module itself carries a compile-time completeness assertion
 * (`_assertRegistryCoversDeviceSettings`) — these are the runtime
 * companions, mirroring `settings-registry.test.ts`'s shape for
 * `APP_SETTINGS_REGISTRY`.
 */

import { describe, expect, test } from 'vitest';
import {
  DEFAULT_NOTIFICATION_SOUND_PREFERENCES,
  DEVICE_SETTINGS_PRIOR_KEYS,
  DEVICE_SETTINGS_REGISTRY,
  extractPriorDeviceSettingsRoot,
} from '../device-settings.js';

describe('DEVICE_SETTINGS_REGISTRY completeness', () => {
  test('registry keys are unique', () => {
    const keys = DEVICE_SETTINGS_REGISTRY.map((definition) => definition.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('every entry declares scope: device', () => {
    for (const definition of DEVICE_SETTINGS_REGISTRY) {
      expect(definition.scope).toBe('device');
    }
  });

  test('priorStorageKey values are non-empty, and unique unless every sharer declares priorRead', () => {
    for (const key of DEVICE_SETTINGS_PRIOR_KEYS) {
      expect(typeof key).toBe('string');
      expect(key.length).toBeGreaterThan(0);
    }
    const byKey = new Map<
      string,
      (typeof DEVICE_SETTINGS_REGISTRY)[number][]
    >();
    for (const definition of DEVICE_SETTINGS_REGISTRY) {
      // station#settings-revamp slice 4: entries with no prior key at all
      // (never persisted pre-unification) have nothing to check here — see
      // the dedicated 'entries with no priorStorageKey' describe block
      // below.
      const priorKey = definition.priorStorageKey;
      if (priorKey === undefined) continue;
      const group = byKey.get(priorKey) ?? [];
      group.push(definition);
      byKey.set(priorKey, group);
    }
    for (const [key, group] of byKey) {
      if (group.length === 1) continue;
      // station#settings-revamp slice 3 (#1359 convergence): a shared
      // prior key is only legitimate when every sharer declares an
      // explicit `priorRead` extractor.
      for (const definition of group) {
        expect(
          definition.priorRead,
          `${String(definition.key)} shares prior key "${key}" without a priorRead hook`,
        ).toBeTypeOf('function');
      }
    }
  });

  describe('entries with no priorStorageKey (station#settings-revamp slice 4: priorStorageKey is optional for a setting that was never persisted pre-unification)', () => {
    test('settings without pre-unification keys declare neither priorStorageKey nor priorRead', () => {
      const byKey = new Map(
        DEVICE_SETTINGS_REGISTRY.map((definition) => [
          definition.key,
          definition,
        ]),
      );
      for (const key of [
        'chatShowReasoning',
        'chatShowToolDetails',
        'chatFontSize',
        'dockSlotPlacement',
        'hapticsEnabled',
        // station#3314 — new sections state; never persisted pre-unification.
        'sidebarSections',
        // station#4525 — the chat dock's remembered project binding; never
        // persisted pre-unification (it did not previously exist).
        'chatDockProjectSlug',
      ] as const) {
        const definition = byKey.get(key);
        expect(definition, `${key} must be registered`).toBeDefined();
        expect(definition!.priorStorageKey).toBeUndefined();
        expect(definition!.priorRead).toBeUndefined();
      }
    });

    test('DEVICE_SETTINGS_PRIOR_KEYS omits no-prior-key entries rather than contributing undefined', () => {
      expect(DEVICE_SETTINGS_PRIOR_KEYS).not.toContain(undefined);
      expect(DEVICE_SETTINGS_PRIOR_KEYS.length).toBe(
        DEVICE_SETTINGS_REGISTRY.filter(
          (definition) => definition.priorStorageKey !== undefined,
        ).length,
      );
    });
  });

  // Pins the exact pre-unification localStorage keys this registry
  // replaces (docs/design/settings-architecture.md §6 slice 2) — a drift
  // here would silently break the store's one-time migration for real
  // users' existing browsers.
  test('priorStorageKey values match the documented pre-unification keys exactly', () => {
    const byKey = new Map(
      DEVICE_SETTINGS_REGISTRY.map((definition) => [
        definition.key,
        definition.priorStorageKey,
      ]),
    );
    expect(byKey.get('theme')).toBe('theme');
    expect(byKey.get('accentColor')).toBe('station-accent-color');
    expect(byKey.get('featureSettings')).toBe('station-feature-settings');
    expect(byKey.get('sttProvider')).toBe('station-stt-provider');
    expect(byKey.get('ttsProvider')).toBe('station-tts-provider');
    expect(byKey.get('chatDockAutoHide')).toBe('chatDockAutoHide');
    expect(byKey.get('diffStyle')).toBe('station.diff.style');
    expect(byKey.get('diffWrap')).toBe('station.diff.wrap');
    expect(byKey.get('inboxOpen')).toBe('station.inbox.open');
    expect(byKey.get('inboxSections')).toBe('station.inbox.sections');
    expect(byKey.get('projectSidebarCollapsed')).toBe(
      'station-sidebar-collapsed',
    );
    expect(byKey.get('onboardingSetupDismissed')).toBe(
      'station:onboarding-setup-dismissed',
    );
    // #1359 convergence (station#settings-revamp slice 3): both share the
    // single root #1359 shipped for keyboard-shortcut/model-picker prefs.
    expect(byKey.get('shortcutOverrides')).toBe('station.device-settings');
    expect(byKey.get('modelPickerPreferences')).toBe('station.device-settings');
  });

  test('registers exactly the twenty-six documented DeviceSettings fields', () => {
    const keys = DEVICE_SETTINGS_REGISTRY.map(
      (definition) => definition.key as string,
    ).sort();
    expect(keys).toEqual(
      [
        'theme',
        'accentColor',
        'featureSettings',
        'sttProvider',
        'ttsProvider',
        'chatDockAutoHide',
        'chatDockHeight',
        'chatDockWidth',
        'diffStyle',
        'diffWrap',
        'inboxOpen',
        'inboxSections',
        'projectSidebarCollapsed',
        'onboardingSetupDismissed',
        'skillShortcuts',
        'shortcutOverrides',
        'modelPickerPreferences',
        // station#settings-revamp slice 4:
        'chatShowReasoning',
        'chatShowToolDetails',
        'chatFontSize',
        'dockSlotPlacement',
        // station#1954:
        'hapticsEnabled',
        // station#2652 — guided first-run progress on this device.
        'firstRunProgress',
        // station#3314 — sidebar Open chats/Drafts collapse + removal.
        'sidebarSections',
        // station#3313 — Developer tools are enabled per device; the
        // surface-visibility flags read this to decide whether the
        // Developer and Monitoring surfaces are advertised at all.
        'developerToolsEnabled',
        // station#4525 — the chat dock's remembered project binding.
        'chatDockProjectSlug',
      ].sort(),
    );
  });

  test('defaultValue matches the confirmed code-level absent-value behavior', () => {
    const byKey = new Map(
      DEVICE_SETTINGS_REGISTRY.map((definition) => [
        definition.key,
        definition.defaultValue,
      ]),
    );
    expect(byKey.get('theme')).toBe('dark');
    expect(byKey.get('accentColor')).toBeNull();
    expect(byKey.get('hapticsEnabled')).toBe(true);
    expect(byKey.get('featureSettings')).toEqual({
      ttsReadbackEnabled: false,
      pushNotificationsEnabled: false,
      voiceS2SEnabled: false,
      mobilePairingEnabled: false,
      notificationSounds: DEFAULT_NOTIFICATION_SOUND_PREFERENCES,
    });
    expect(byKey.get('sttProvider')).toBe('webspeech');
    expect(byKey.get('ttsProvider')).toBe('webspeech');
    expect(byKey.get('chatDockAutoHide')).toBe(false);
    expect(byKey.get('chatDockHeight')).toBe(320);
    expect(byKey.get('chatDockWidth')).toBe(400);
    expect(byKey.get('diffStyle')).toBe('unified');
    expect(byKey.get('diffWrap')).toBe(false);
    expect(byKey.get('inboxOpen')).toBe(true);
    expect(byKey.get('inboxSections')).toEqual({
      snoozed: false,
      earlier: false,
    });
    expect(byKey.get('sidebarSections')).toEqual({
      openChatsCollapsed: false,
      openChatsHidden: false,
      draftsCollapsed: false,
      draftsHidden: false,
    });
    expect(byKey.get('projectSidebarCollapsed')).toBe(false);
    expect(byKey.get('onboardingSetupDismissed')).toBe(false);
    expect(byKey.get('shortcutOverrides')).toEqual({});
    expect(byKey.get('modelPickerPreferences')).toEqual({
      favorites: [],
      recents: [],
      hidden: [],
      order: [],
    });
    // station#settings-revamp slice 4 — confirmed against the pre-slice-4
    // useChatDockState.ts (`useState(true)` for both toggles) and
    // navigation-store.ts (`fontSize: null` absent, `dockMode: 'bottom'`
    // fallback).
    expect(byKey.get('chatShowReasoning')).toBe(true);
    expect(byKey.get('chatShowToolDetails')).toBe(true);
    expect(byKey.get('chatFontSize')).toBeNull();
    expect(byKey.get('dockSlotPlacement')).toBe('bottom');
    expect(byKey.get('chatDockProjectSlug')).toBeNull();
  });

  test('priorRead extracts shortcutOverrides and modelPickerPreferences from the shared #1359 root', () => {
    const root = {
      shortcuts: {
        bindings: { 'app.settings': { key: 's', modifiers: ['cmd'] } },
      },
      modelPicker: { favorites: ['provider\u001fmodel'] },
    };
    const values = extractPriorDeviceSettingsRoot(root);
    expect(values.shortcutOverrides).toEqual({
      'app.settings': { key: 's', modifiers: ['cmd'] },
    });
    expect(values.modelPickerPreferences).toEqual({
      favorites: ['provider\u001fmodel'],
      recents: [],
      hidden: [],
      order: [],
    });
  });

  test('priorRead is undefined for a field absent from the shared root, and extraction is total for a missing/malformed root', () => {
    expect(extractPriorDeviceSettingsRoot({})).toEqual({});
    expect(extractPriorDeviceSettingsRoot(null)).toEqual({});
    expect(extractPriorDeviceSettingsRoot('not an object')).toEqual({});
  });
});
