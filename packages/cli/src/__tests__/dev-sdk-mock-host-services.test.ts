// @vitest-environment jsdom
/**
 * `station dev` serves plugins this mock in place of `@kontourai/station-sdk`.
 * Executes the serialized mock exactly as the dev page does and drives the
 * host-service hooks the real adapter supplies, including their refusals.
 */
import { act, fireEvent, renderHook } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { serializeSDKMock } from '../dev/sdk-mock.js';

type Mock = Record<string, any>;
// The CLI compiles without the DOM lib; jsdom supplies these at run time.
const win = globalThis as any;
let mock: Mock;

beforeAll(() => {
  win.React = React;
  // The mock's own script is a classic script body, as in the dev page.
  new Function(serializeSDKMock({ layoutSlug: 'demo' }))();
  mock = win.__station_ai_sdk_mock;
});
afterEach(() => vi.restoreAllMocks());

const isMac = /mac/i.test(win.navigator.platform);

describe('station dev SDK mock host services', () => {
  test('exports every public host-service hook', () => {
    for (const name of [
      'useHost',
      'useHostFacts',
      'useShortcut',
      'useShortcutScope',
    ])
      expect(typeof mock[name], name).toBe('function');
  });

  test('openExternal opens http(s) and refuses other schemes without opening', async () => {
    const open = vi.spyOn(win, 'open').mockImplementation(() => null);
    const host = mock.useHost();
    await expect(host.openExternal('javascript:alert(1)')).resolves.toBe(false);
    expect(open).not.toHaveBeenCalled();
    await expect(host.openExternal('https://example.com')).resolves.toBe(true);
    expect(open).toHaveBeenCalledWith(
      'https://example.com',
      '_blank',
      'noopener,noreferrer',
    );
  });

  test('prompt resolves trimmed text, and null for cancel or empty', async () => {
    const host = mock.useHost();
    vi.spyOn(win, 'prompt').mockReturnValueOnce('  name.md ');
    await expect(host.prompt({ title: 'Rename' })).resolves.toBe('name.md');
    vi.spyOn(win, 'prompt').mockReturnValueOnce(null);
    await expect(host.prompt({ title: 'Rename' })).resolves.toBeNull();
    vi.spyOn(win, 'prompt').mockReturnValueOnce('   ');
    await expect(host.prompt({ title: 'Rename' })).resolves.toBeNull();
  });

  test('useShortcut fires its chord and refuses a reserved kernel chord', () => {
    const run = vi.fn();
    const { result } = renderHook(() =>
      mock.useShortcut({
        id: 'pick',
        keys: { key: 'j', modifiers: ['cmd', 'shift'] },
        description: 'Pick',
        run,
      }),
    );
    expect(result.current).toEqual({ ok: true, registryId: 'plugin.dev.pick' });
    act(() => {
      fireEvent.keyDown(win, {
        key: 'J',
        shiftKey: true,
        metaKey: isMac,
        ctrlKey: !isMac,
      });
    });
    expect(run).toHaveBeenCalledTimes(1);

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const refusedRun = vi.fn();
    const refused = renderHook(() =>
      mock.useShortcut({
        id: 'palette',
        keys: { key: 'k', modifiers: ['cmd'] },
        description: 'Steal',
        run: refusedRun,
      }),
    );
    expect(refused.result.current).toMatchObject({
      ok: false,
      reason: 'reserved',
    });
    act(() => {
      fireEvent.keyDown(win, { key: 'k', metaKey: isMac, ctrlKey: !isMac });
    });
    expect(refusedRun).not.toHaveBeenCalled();
  });

  test('useHostFacts reports the device facts shape', () => {
    const { result } = renderHook(() => mock.useHostFacts());
    expect(result.current).toEqual({ device: { isMobile: false } });
  });
});
