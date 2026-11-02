/** @vitest-environment jsdom */
import { afterEach, describe, expect, test } from 'vitest';
import {
  applyThemeMode,
  resolveThemeMode,
  SYSTEM_LIGHT_QUERY,
  subscribeSystemThemeMode,
} from '../theme-mode';

function deviceQuery(initiallyLight: boolean) {
  const listeners = new Set<() => void>();
  const state = { light: initiallyLight };
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (media: string) => ({
      matches: media === SYSTEM_LIGHT_QUERY && state.light,
      media,
      addEventListener: (_type: string, listener: () => void) =>
        listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) =>
        listeners.delete(listener),
    }),
  });
  return {
    setLight(light: boolean) {
      state.light = light;
      for (const listener of [...listeners]) listener();
    },
    listeners,
  };
}

afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia');
  document.documentElement.removeAttribute('data-theme');
});

describe('theme mode (#4407)', () => {
  test('an explicit choice wins; System and unknown values follow the device', () => {
    expect(resolveThemeMode('light', false)).toBe('light');
    expect(resolveThemeMode('dark', true)).toBe('dark');
    expect(resolveThemeMode('system', true)).toBe('light');
    expect(resolveThemeMode('system', false)).toBe('dark');
    expect(resolveThemeMode('sepia', true)).toBe('light');
    expect(resolveThemeMode(undefined, false)).toBe('dark');
  });

  test('with no media query support, System renders dark as before', () => {
    expect(resolveThemeMode('system')).toBe('dark');
    expect(subscribeSystemThemeMode(() => {})).toBeTypeOf('function');
  });

  test('the root follows a device change while System is chosen', () => {
    const device = deviceQuery(true);
    const root = document.documentElement;
    expect(applyThemeMode(root, 'system')).toBe('light');
    const stop = subscribeSystemThemeMode(() => applyThemeMode(root, 'system'));
    device.setLight(false);
    expect(root.getAttribute('data-theme')).toBe('dark');
    stop();
    expect(device.listeners.size).toBe(0);
    expect(applyThemeMode(root, 'light')).toBe('light');
  });
});
