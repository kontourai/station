// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import {
  installVisualViewportInset,
  useMobileVisualViewport,
} from '../hooks/useMobileVisualViewport';
import { ANDROID_INSETS_EVENT } from '../platform/androidSafeArea';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete window.StationAndroidInsets;
  document.documentElement.style.removeProperty(
    '--visual-viewport-bottom-inset',
  );
});

function Consumer() {
  const viewport = useMobileVisualViewport();
  return (
    <output aria-label="Viewport consumer" style={viewport.style}>
      {viewport.height}
    </output>
  );
}

test('native inset events update mounted consumers and shared geometry through show, rotation, hide, and disposal', () => {
  vi.stubGlobal('innerHeight', 915);
  vi.stubGlobal('innerWidth', 412);
  const visualViewport = Object.assign(new EventTarget(), {
    height: 915,
    offsetTop: 0,
  });
  vi.stubGlobal('visualViewport', visualViewport);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  let native = { viewportWidth: 412, viewportHeight: 915, visibleHeight: 915 };
  window.StationAndroidInsets = { safeArea: () => JSON.stringify(native) };
  const dispose = installVisualViewportInset();
  const view = render(<Consumer />);
  const consumer = view.getByLabelText('Viewport consumer');
  const sharedInset = () =>
    document.documentElement.style.getPropertyValue(
      '--visual-viewport-bottom-inset',
    );
  expect(consumer.textContent).toBe('915');

  act(() => {
    native.visibleHeight = 578;
    window.dispatchEvent(new Event(ANDROID_INSETS_EVENT));
  });
  expect(consumer.style.getPropertyValue('--chat-visual-viewport-height')).toBe(
    '578px',
  );
  expect(consumer.style.getPropertyValue('--chat-visual-viewport-bottom')).toBe(
    '337px',
  );
  expect(sharedInset()).toBe('337px');

  act(() => {
    vi.stubGlobal('innerWidth', 915);
    vi.stubGlobal('innerHeight', 412);
    visualViewport.height = 412;
    native = { viewportWidth: 915, viewportHeight: 412, visibleHeight: 210 };
    window.dispatchEvent(new Event(ANDROID_INSETS_EVENT));
  });
  expect(consumer.textContent).toBe('210');
  expect(sharedInset()).toBe('202px');

  act(() => {
    native.visibleHeight = 412;
    window.dispatchEvent(new Event(ANDROID_INSETS_EVENT));
  });
  expect(consumer.textContent).toBe('412');
  expect(sharedInset()).toBe('0px');
  view.unmount();
  dispose();
  native.visibleHeight = 100;
  window.dispatchEvent(new Event(ANDROID_INSETS_EVENT));
  expect(sharedInset()).toBe('0px');
});
