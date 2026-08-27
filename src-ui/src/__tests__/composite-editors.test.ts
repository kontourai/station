import { APP_SETTINGS_REGISTRY } from '@kontourai/station-contracts/settings-registry';
import { describe, expect, test } from 'vitest';
import {
  COMPOSITE_EDITORS,
  DEFERRED_COMPOSITE_KEYS,
} from '../views/settings/composite-editors';

describe('composite editor completeness (station#settings-revamp slice 3)', () => {
  test('every composite-kind APP_SETTINGS_REGISTRY key is either in COMPOSITE_EDITORS or DEFERRED_COMPOSITE_KEYS', () => {
    const deferred = new Set(DEFERRED_COMPOSITE_KEYS);
    const unclassified = APP_SETTINGS_REGISTRY.filter(
      (definition) => definition.descriptor.kind === 'composite',
    )
      .map((definition) => definition.key as string)
      .filter((key) => !(key in COMPOSITE_EDITORS) && !deferred.has(key));

    expect(unclassified).toEqual([]);
  });

  test('COMPOSITE_EDITORS and DEFERRED_COMPOSITE_KEYS name only composite-kind registry keys', () => {
    const compositeKeys = new Set(
      APP_SETTINGS_REGISTRY.filter(
        (definition) => definition.descriptor.kind === 'composite',
      ).map((definition) => definition.key as string),
    );
    for (const key of Object.keys(COMPOSITE_EDITORS)) {
      expect(compositeKeys.has(key), `${key} is not a composite-kind key`).toBe(
        true,
      );
    }
    for (const key of DEFERRED_COMPOSITE_KEYS) {
      expect(compositeKeys.has(key), `${key} is not a composite-kind key`).toBe(
        true,
      );
    }
  });

  test('no key is both registered and deferred', () => {
    const deferred = new Set(DEFERRED_COMPOSITE_KEYS);
    const overlap = Object.keys(COMPOSITE_EDITORS).filter((key) =>
      deferred.has(key),
    );
    expect(overlap).toEqual([]);
  });
});
