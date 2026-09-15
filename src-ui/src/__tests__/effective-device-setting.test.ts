/**
 * Epic #2144 slice 2. Two sources, and the cases that separate them are all
 * falsy: a device setting explicitly turned off is a decision, and reporting
 * it as a default would tell someone their saved "off" never took.
 */

import { DEVICE_SETTINGS_REGISTRY } from '@kontourai/station-contracts/device-settings';
import { describe, expect, test } from 'vitest';
import { resolveEffectiveDeviceSetting } from '../views/settings/effective-device-setting.js';

describe('resolveEffectiveDeviceSetting', () => {
  test('an absent key resolves to the registry default', () => {
    expect(resolveEffectiveDeviceSetting('theme', {})).toEqual({
      value: 'dark',
      source: 'default',
    });
    expect(resolveEffectiveDeviceSetting('theme', undefined)).toEqual({
      value: 'dark',
      source: 'default',
    });
  });

  test('a stored key is this device’s decision', () => {
    expect(resolveEffectiveDeviceSetting('theme', { theme: 'light' })).toEqual({
      value: 'light',
      source: 'device',
    });
  });

  /**
   * The discriminating cases. Each stored value here is falsy and each is
   * also the registry default, so a truthiness test — or a test that
   * compared against the default — would report `'default'` for all three.
   */
  test('a falsy stored value equal to the default is still a decision', () => {
    expect(
      resolveEffectiveDeviceSetting('chatDockAutoHide', {
        chatDockAutoHide: false,
      }),
    ).toEqual({ value: false, source: 'device' });
    expect(
      resolveEffectiveDeviceSetting('projectSidebarCollapsed', {
        projectSidebarCollapsed: false,
      }),
    ).toEqual({ value: false, source: 'device' });
    expect(
      resolveEffectiveDeviceSetting('accentColor', { accentColor: null }),
    ).toEqual({ value: null, source: 'device' });
  });

  test('an explicit undefined is the absence of a value, not a decision', () => {
    expect(
      resolveEffectiveDeviceSetting('theme', {
        theme: undefined,
      } as Partial<{ theme: 'light' | 'dark' }>),
    ).toEqual({ value: 'dark', source: 'default' });
  });

  test('every registered device setting resolves to its own declared default', () => {
    for (const definition of DEVICE_SETTINGS_REGISTRY) {
      expect(
        resolveEffectiveDeviceSetting(definition.key, {}),
        definition.key,
      ).toEqual({ value: definition.defaultValue, source: 'default' });
    }
  });

  test('an unregistered key has no honest answer', () => {
    expect(
      resolveEffectiveDeviceSetting(
        'somethingNobodyDeclared' as never,
        {} as never,
      ),
    ).toBeUndefined();
  });
});
