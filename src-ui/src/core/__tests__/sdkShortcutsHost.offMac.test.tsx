// @vitest-environment jsdom
/**
 * The plugin shortcut refusals on Windows/Linux. The registry reads the
 * platform once at module load, so the platform is stubbed before the
 * registry modules are imported.
 */
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const realPlatform = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(navigator),
  'platform',
);
let useSDKShortcutsHost: typeof import('../sdkShortcutsHost').useSDKShortcutsHost;
let KeyboardShortcutsProvider: typeof import('../../contexts/KeyboardShortcutsContext').KeyboardShortcutsProvider;

beforeAll(async () => {
  Object.defineProperty(navigator, 'platform', {
    configurable: true,
    get: () => 'Win32',
  });
  vi.resetModules();
  ({ KeyboardShortcutsProvider } = await import(
    '../../contexts/KeyboardShortcutsContext'
  ));
  ({ useSDKShortcutsHost } = await import('../sdkShortcutsHost'));
});
afterAll(() => {
  delete (navigator as { platform?: string }).platform;
  if (realPlatform)
    Object.defineProperty(
      Object.getPrototypeOf(navigator),
      'platform',
      realPlatform,
    );
});

function host() {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <KeyboardShortcutsProvider>{children}</KeyboardShortcutsProvider>
  );
  const { result } = renderHook(() => useSDKShortcutsHost('acme-tools'), {
    wrapper,
  });
  if (!result.current) throw new Error('no shortcut host');
  return result.current;
}

describe('plugin shortcut refusals off a Mac', () => {
  test('the platform stub took effect', () => {
    expect(navigator.platform).toBe('Win32');
  });

  test.each([
    ['Ctrl+Y (redo)', { key: 'y', modifiers: ['ctrl'] }],
    ['cmd+y, which is Ctrl+Y here', { key: 'y', modifiers: ['cmd'] }],
    ['Ctrl+C, which is ⌘C here', { key: 'c', modifiers: ['ctrl'] }],
    ['Ctrl+K, the palette here', { key: 'k', modifiers: ['ctrl'] }],
  ] as const)('refuses %s', (_label, keys) => {
    expect(
      host().validate({
        id: 'probe',
        keys: { key: keys.key, modifiers: [...keys.modifiers] },
        description: 'probe',
      }),
    ).toMatchObject({ ok: false, reason: 'reserved' });
  });

  test('still accepts an unreserved Ctrl chord', () => {
    expect(
      host().validate({
        id: 'probe',
        keys: { key: 'j', modifiers: ['ctrl', 'shift'] },
        description: 'probe',
      }),
    ).toMatchObject({ ok: true, registryId: 'plugin.acme-tools.probe' });
  });
});
