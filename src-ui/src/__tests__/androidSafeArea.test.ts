/**
 * @vitest-environment jsdom
 *
 * station#2617. Android's WebView reports env(safe-area-inset-*) as 0 for
 * system bars, so MainActivity bridges WindowInsets through a
 * `StationAndroidInsets` JavascriptInterface. This proves the web side
 * projects that bridge onto the `--safe-*` custom properties, re-applies on
 * the native change event, and stays inert (no override, no crash) when the
 * bridge is absent or returns garbage.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { installAndroidSafeArea } from '../platform/androidSafeArea';

function readVar(name: string): string {
  return document.documentElement.style.getPropertyValue(name);
}

afterEach(() => {
  delete (window as { StationAndroidInsets?: unknown }).StationAndroidInsets;
  for (const side of ['top', 'right', 'bottom', 'left']) {
    document.documentElement.style.removeProperty(`--safe-${side}`);
  }
});

describe('installAndroidSafeArea (station#2617)', () => {
  it('projects the bridge insets onto the --safe-* custom properties', () => {
    window.StationAndroidInsets = {
      safeArea: () => '{"top":32.5,"right":0,"bottom":18,"left":0}',
    };

    installAndroidSafeArea();

    expect(readVar('--safe-top')).toBe('32.5px');
    expect(readVar('--safe-bottom')).toBe('18px');
    expect(readVar('--safe-right')).toBe('0px');
    expect(readVar('--safe-left')).toBe('0px');
  });

  it('re-applies when the native side dispatches station-android-insets', () => {
    let json = '{"top":32,"right":0,"bottom":18,"left":0}';
    window.StationAndroidInsets = { safeArea: () => json };

    installAndroidSafeArea();
    expect(readVar('--safe-top')).toBe('32px');

    // Rotation: top inset collapses, left gains the cutout.
    json = '{"top":0,"right":0,"bottom":18,"left":32}';
    window.dispatchEvent(new Event('station-android-insets'));

    expect(readVar('--safe-top')).toBe('0px');
    expect(readVar('--safe-left')).toBe('32px');
  });

  it('leaves the env()-derived defaults untouched without the bridge', () => {
    installAndroidSafeArea();
    expect(readVar('--safe-top')).toBe('');
  });

  it('ignores malformed bridge payloads instead of throwing or half-applying', () => {
    window.StationAndroidInsets = { safeArea: () => 'not json' };
    expect(() => installAndroidSafeArea()).not.toThrow();
    expect(readVar('--safe-top')).toBe('');

    window.StationAndroidInsets = {
      safeArea: () => '{"top":"tall","bottom":-4,"left":null,"right":12}',
    };
    installAndroidSafeArea();
    expect(readVar('--safe-top')).toBe('');
    expect(readVar('--safe-bottom')).toBe('');
    expect(readVar('--safe-left')).toBe('');
    expect(readVar('--safe-right')).toBe('12px');
  });
});
