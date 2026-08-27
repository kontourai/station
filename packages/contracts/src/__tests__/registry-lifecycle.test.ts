import { describe, expect, test } from 'vitest';
import {
  canInstallRegistryItem,
  canRemoveRegistryItem,
} from '../registry-lifecycle';

describe('registry lifecycle contract', () => {
  test('characterizes install and removal states without UI behavior', () => {
    expect(canInstallRegistryItem({ state: 'installable' })).toBe(true);
    expect(canInstallRegistryItem({ state: 'update_available' })).toBe(true);
    expect(canInstallRegistryItem({ state: 'installed' })).toBe(false);
    expect(canRemoveRegistryItem({ state: 'installed' })).toBe(true);
    expect(canRemoveRegistryItem({ state: 'disabled' })).toBe(true);
    expect(canRemoveRegistryItem({ state: 'draft' })).toBe(false);
  });
});
