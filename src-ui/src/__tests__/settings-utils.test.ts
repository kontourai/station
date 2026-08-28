/**
 * @vitest-environment jsdom
 */

import { DEFAULT_NOTIFICATION_SOUND_PREFERENCES } from '@kontourai/station-contracts/device-settings';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  DeviceSettingsImportVersionError,
  deviceSettingsStore,
} from '../lib/device-settings-store';
import { DEVICE_SETTINGS_EVENT } from '../settings/shortcutPreferences';
import type { AppConfig } from '../types';
import {
  buildSettingsExportPayload,
  getSettingsValidation,
  isSettingsSectionVisible,
  parseImportedSettingsFile,
} from '../views/settings/utils';

function jsonFile(payload: unknown): File {
  return new File([JSON.stringify(payload)], 'station-settings.json', {
    type: 'application/json',
  });
}

describe('settings utils', () => {
  test('getSettingsValidation returns errors and warnings for invalid config', () => {
    const result = getSettingsValidation({
      region: 'bad region',
      systemPrompt: 'x'.repeat(10001),
      templateVariables: [{ key: 'bad key', type: 'static', value: '' }],
    } as any);

    expect(result.errors).toEqual(
      expect.objectContaining({
        region: 'Invalid region format (e.g. us-east-1)',
        systemPrompt: 'Exceeds 10,000 character limit',
        templateVars: 'Variable names cannot contain spaces',
      }),
    );
    expect(result.warnings.templateVarValues).toBe(
      'Static variables with empty values will resolve to blank',
    );
    expect(result.isValid).toBe(false);
  });

  test('isSettingsSectionVisible uses section term matches', () => {
    expect(isSettingsSectionVisible('section-agent-defaults', 'region')).toBe(
      true,
    );
    expect(isSettingsSectionVisible('section-agent-defaults', 'voice')).toBe(
      false,
    );
    expect(isSettingsSectionVisible('section-agent-defaults', '')).toBe(true);
  });

  describe('export/import (station#settings-revamp slice 2)', () => {
    beforeEach(() => {
      // The device-settings store is a module singleton — clear it back to
      // an empty envelope between tests rather than letting one test's
      // import leak into the next's assertions.
      deviceSettingsStore.importEnvelope({ version: 1, values: {} });
      localStorage.clear();
    });

    test('buildSettingsExportPayload emits registry-driven station config, no raw spread, no internal fields', () => {
      const config = {
        region: 'us-east-1',
        logLevel: 'debug',
        // Internal, runtime-derived — never in APP_SETTINGS_REGISTRY, must
        // never appear in an exported file.
        mcpUiFrameOrigin: 'http://127.0.0.1:1234',
        managedChatOrchestration: true,
        // Not a registered AppConfig field at all.
        someUnknownField: 'x',
      } as unknown as AppConfig;

      const payload = buildSettingsExportPayload(config);

      expect(payload.version).toBe(2);
      expect(payload.station).toEqual({
        region: 'us-east-1',
        logLevel: 'debug',
      });
      expect(payload.station).not.toHaveProperty('mcpUiFrameOrigin');
      expect(payload.station).not.toHaveProperty('managedChatOrchestration');
      expect(payload.station).not.toHaveProperty('someUnknownField');
      expect(payload.device).toEqual(deviceSettingsStore.getEnvelope());
    });

    test('v2 round-trip restores both the station config and the device envelope', async () => {
      deviceSettingsStore.set('theme', 'light');
      deviceSettingsStore.set('diffWrap', true);
      const config = {
        region: 'us-east-1',
        defaultModel: 'anthropic.claude',
      } as unknown as AppConfig;

      const payload = buildSettingsExportPayload(config);

      // Simulate a fresh browser: clear the device store before importing.
      deviceSettingsStore.importEnvelope({ version: 1, values: {} });
      expect(deviceSettingsStore.get('theme')).toBe('dark');

      const { serverConfig } = await parseImportedSettingsFile(
        jsonFile(payload),
      );

      expect(serverConfig).toEqual({
        region: 'us-east-1',
        defaultModel: 'anthropic.claude',
      });
      expect(deviceSettingsStore.get('theme')).toBe('light');
      expect(deviceSettingsStore.get('diffWrap')).toBe(true);
    });

    test('legacy 4-key _localStorage import lands on the matching device settings', async () => {
      const legacyFile = {
        region: 'us-west-2',
        _localStorage: {
          theme: 'light',
          'station-feature-settings': JSON.stringify({
            ttsReadbackEnabled: true,
          }),
          'station-stt-provider': 'nova',
          'station-tts-provider': 'polly',
        },
      };

      const { serverConfig } = await parseImportedSettingsFile(
        jsonFile(legacyFile),
      );

      expect(serverConfig).toEqual({ region: 'us-west-2' });
      expect(deviceSettingsStore.get('theme')).toBe('light');
      expect(deviceSettingsStore.get('featureSettings')).toEqual({
        ttsReadbackEnabled: true,
        pushNotificationsEnabled: false,
        voiceS2SEnabled: false,
        mobilePairingEnabled: false,
        notificationSounds: DEFAULT_NOTIFICATION_SOUND_PREFERENCES,
      });
      expect(deviceSettingsStore.get('sttProvider')).toBe('nova');
      expect(deviceSettingsStore.get('ttsProvider')).toBe('polly');
    });

    test('an unknown _localStorage key is ignored rather than crashing the import', async () => {
      const legacyFile = {
        region: 'us-west-2',
        _localStorage: {
          theme: 'light',
          'some-retired-plugin-key': 'whatever',
        },
      };

      const { serverConfig } = await parseImportedSettingsFile(
        jsonFile(legacyFile),
      );

      expect(serverConfig).toEqual({ region: 'us-west-2' });
      expect(deviceSettingsStore.get('theme')).toBe('light');
    });

    test('a config-only file (neither v2 nor _localStorage) still parses without crashing', async () => {
      const configOnlyFile = {
        region: 'eu-central-1',
        logLevel: 'warn',
        someUnknownField: 'x',
      };

      const { serverConfig } = await parseImportedSettingsFile(
        jsonFile(configOnlyFile),
      );

      expect(serverConfig).toEqual({
        region: 'eu-central-1',
        logLevel: 'warn',
      });
    });

    // archive#settings-revamp.
    test('a device envelope from a newer Station (future version) is rejected, not imported unchanged', async () => {
      const futureFile = {
        version: 2,
        station: { region: 'us-west-2' },
        device: { version: 3, values: { theme: 'light' } },
      };

      await expect(
        parseImportedSettingsFile(jsonFile(futureFile)),
      ).rejects.toThrow(DeviceSettingsImportVersionError);
      // Nothing was adopted from the rejected file.
      expect(deviceSettingsStore.get('theme')).toBe('dark');
    });

    test('an invalid composite value (inboxSections: null) is dropped instead of crashing a consumer', async () => {
      const file = {
        version: 2,
        station: {},
        device: { version: 1, values: { theme: 'light', inboxSections: null } },
      };

      const { droppedDeviceKeys } = await parseImportedSettingsFile(
        jsonFile(file),
      );

      expect(droppedDeviceKeys).toEqual(['inboxSections']);
      expect(deviceSettingsStore.get('theme')).toBe('light');
      expect(deviceSettingsStore.get('inboxSections')).toEqual({
        snoozed: false,
        earlier: false,
      });
    });

    test('a partially-valid file imports the valid subset and reports the rest as dropped', async () => {
      const file = {
        version: 2,
        station: {},
        device: {
          version: 1,
          values: {
            theme: 'light',
            diffStyle: 'not-a-real-style',
            chatDockAutoHide: 'yes',
            featureSettings: { ttsReadbackEnabled: 'not-a-boolean' },
          },
        },
      };

      const { droppedDeviceKeys } = await parseImportedSettingsFile(
        jsonFile(file),
      );

      expect(droppedDeviceKeys.sort()).toEqual(
        ['diffStyle', 'chatDockAutoHide', 'featureSettings'].sort(),
      );
      expect(deviceSettingsStore.get('theme')).toBe('light');
      expect(deviceSettingsStore.get('diffStyle')).toBe('unified');
      expect(deviceSettingsStore.get('chatDockAutoHide')).toBe(false);
      expect(deviceSettingsStore.get('featureSettings')).toEqual({
        ttsReadbackEnabled: false,
        pushNotificationsEnabled: false,
        voiceS2SEnabled: false,
        mobilePairingEnabled: false,
        notificationSounds: DEFAULT_NOTIFICATION_SOUND_PREFERENCES,
      });
    });
  });

  test('notifies same-window consumers after importing device settings', async () => {
    const listener = vi.fn();
    window.addEventListener(DEVICE_SETTINGS_EVENT, listener);
    const file = new File(
      [
        JSON.stringify({
          _localStorage: {
            'station.device-settings': JSON.stringify({
              shortcutBindings: {
                'chat.new': { key: 'n', modifiers: ['cmd'] },
              },
            }),
          },
        }),
      ],
      'station-settings.json',
      { type: 'application/json' },
    );

    await parseImportedSettingsFile(file);

    expect(listener).toHaveBeenCalledTimes(1);
    // archive#settings-revamp (archive#1359 convergence): the shared
    // `station.device-settings` root is migrated into the envelope's own
    // `shortcutOverrides` entry rather than written back verbatim.
    expect(localStorage.getItem('station.device-settings')).toBeNull();
    expect(deviceSettingsStore.get('shortcutOverrides')).toEqual({
      'chat.new': { key: 'n', modifiers: ['cmd'] },
    });
    window.removeEventListener(DEVICE_SETTINGS_EVENT, listener);
  });

  test('an old v2 export carrying the #1359 sharedDeviceRoot field still lands its fields on import', async () => {
    const file = jsonFile({
      version: 2,
      station: {},
      device: { version: 1, values: { theme: 'light' } },
      sharedDeviceRoot: JSON.stringify({
        shortcuts: {
          bindings: { 'app.settings': { key: 's', modifiers: ['cmd'] } },
        },
        modelPicker: { favorites: ['provider-model'] },
      }),
    });

    await parseImportedSettingsFile(file);

    expect(deviceSettingsStore.get('theme')).toBe('light');
    expect(deviceSettingsStore.get('shortcutOverrides')).toEqual({
      'app.settings': { key: 's', modifiers: ['cmd'] },
    });
    expect(deviceSettingsStore.get('modelPickerPreferences').favorites).toEqual(
      ['provider-model'],
    );
  });
});
