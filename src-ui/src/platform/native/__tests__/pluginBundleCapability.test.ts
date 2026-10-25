import { runInNewContext } from 'node:vm';
import { describe, expect, test } from 'vitest';
import source from '../pluginBundleCapability.js?raw';

const capability = 'C'.repeat(43);
const shellOrigins = [
  'tauri://localhost',
  'http://tauri.localhost',
  'http://127.0.0.1:5173',
];

function install(label: string, origin: string, child = false) {
  const url = new URL(origin);
  const window = {
    location: { protocol: url.protocol, host: url.host },
    __TAURI_INTERNALS__: { metadata: { currentWebview: { label } } },
    top: null as unknown,
  };
  window.top = child ? {} : window;
  const realm = { window };
  // The host invokes the included function as an IIFE with literal arguments.
  runInNewContext(
    `Array.prototype.includes = () => { throw new Error('page prototype invoked'); };\n(${source})(${JSON.stringify(capability)}, ${JSON.stringify([origin.startsWith('tauri:') ? shellOrigins[0] : shellOrigins[1], shellOrigins[2]])})`,
    realm,
  );
  expect(Object.hasOwn(realm, 'installPluginBundleCapability')).toBe(false);
  expect(Object.hasOwn(window, 'installPluginBundleCapability')).toBe(false);
  return window;
}

describe('native plugin capability initialization', () => {
  test('does not expose the installer globally, including on Browser Preview internet pages', () => {
    install('main', 'http://tauri.localhost');
    install(
      'browser-preview-41a4f105-33ca-4fa0-b054-23f02b6e74bd',
      'https://untrusted.example',
    );
  });

  test.each([
    'main',
    'workspace-pane-pop-out-41a4f105-33ca-4fa0-b054-23f02b6e74bd',
  ])('installs only into the shell top realm for %s', (label) => {
    for (const origin of shellOrigins) {
      const window = install(label, origin);
      expect(
        Object.getOwnPropertyDescriptor(
          window,
          '__STATION_PLUGIN_CAPABILITY__',
        ),
      ).toEqual({
        value: capability,
        writable: false,
        enumerable: false,
        configurable: false,
      });
    }
  });

  test('withholds the capability from child frames even at the shell origin and label', () => {
    const frame = install('main', 'http://tauri.localhost', true);
    expect(Object.hasOwn(frame, '__STATION_PLUGIN_CAPABILITY__')).toBe(false);
  });

  test.each([
    'https://untrusted.example',
    'http://tauri.localhost.evil',
    'http://127.0.0.1:5174',
  ])('withholds the capability on top-level navigation to %s', (origin) => {
    expect(
      Object.hasOwn(install('main', origin), '__STATION_PLUGIN_CAPABILITY__'),
    ).toBe(false);
  });

  test.each([
    'browser-preview-41a4f105-33ca-4fa0-b054-23f02b6e74bd',
    'unknown',
    'workspace-pane-pop-out-unknown',
  ])('withholds the capability from webview %s', (label) => {
    expect(
      Object.hasOwn(
        install(label, 'http://tauri.localhost'),
        '__STATION_PLUGIN_CAPABILITY__',
      ),
    ).toBe(false);
  });
});
