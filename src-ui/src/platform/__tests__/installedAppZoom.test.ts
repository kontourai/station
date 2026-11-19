/** @vitest-environment jsdom */

import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  isStandaloneDisplay,
  setInstalledAppZoomLock,
} from '../installedAppZoom';

const BASE = 'width=device-width, initial-scale=1.0, viewport-fit=cover';

function viewport(): HTMLMetaElement {
  let meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'viewport';
    document.head.append(meta);
  }
  meta.content = BASE;
  return meta;
}

describe('installed app zoom lock', () => {
  afterEach(() => {
    setInstalledAppZoomLock(false);
    vi.unstubAllGlobals();
  });

  test('locks the viewport, root touch-action class and iOS gestures, then releases them', () => {
    const meta = viewport();
    const release = setInstalledAppZoomLock(true);
    expect(meta.content).toBe(`${BASE}, maximum-scale=1, user-scalable=no`);
    expect(document.documentElement.classList.contains('is-zoom-locked')).toBe(
      true,
    );
    const gesture = new Event('gesturestart', { cancelable: true });
    document.dispatchEvent(gesture);
    expect(gesture.defaultPrevented).toBe(true);

    setInstalledAppZoomLock(true);
    expect(meta.content).toBe(`${BASE}, maximum-scale=1, user-scalable=no`);

    release();
    expect(meta.content).toBe(BASE);
    expect(document.documentElement.classList.contains('is-zoom-locked')).toBe(
      false,
    );
    const after = new Event('gesturestart', { cancelable: true });
    document.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  test('a browser tab is not standalone; a home-screen app is', () => {
    const media = (standalone: boolean) => (query: string) => ({
      matches: standalone && query === '(display-mode: standalone)',
    });
    vi.stubGlobal('matchMedia', media(false));
    expect(isStandaloneDisplay()).toBe(false);
    vi.stubGlobal('matchMedia', media(true));
    expect(isStandaloneDisplay()).toBe(true);
  });
});
