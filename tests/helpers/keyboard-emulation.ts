import type { Page } from '@playwright/test';

/**
 * A software keyboard, emulated: Chromium cannot raise one, so this replaces
 * `window.visualViewport` with one whose height the test shrinks, exactly as
 * iOS Safari and Android Chrome report an open keyboard. Painting the
 * keyboard's area is for the screenshot only; it takes no pointer events.
 * Real iOS behaviour is a separate, device-only check.
 */
export async function installKeyboardEmulation(page: Page) {
  await page.addInitScript(() => {
    const target = new EventTarget();
    let keyboard = 0;
    const viewport = new Proxy(target, {
      get(object, property) {
        switch (property) {
          case 'height':
            return window.innerHeight - keyboard;
          case 'width':
            return window.innerWidth;
          case 'offsetTop':
          case 'offsetLeft':
          case 'pageTop':
          case 'pageLeft':
            return 0;
          case 'scale':
            return 1;
          default: {
            const value = Reflect.get(object, property, object);
            return typeof value === 'function' ? value.bind(object) : value;
          }
        }
      },
    });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      get: () => viewport,
    });
    (window as any).__emulateKeyboard = (height: number) => {
      keyboard = height;
      document.getElementById('e2e-emulated-keyboard')?.remove();
      if (height > 0) {
        const pane = document.createElement('div');
        pane.id = 'e2e-emulated-keyboard';
        pane.textContent = 'Emulated keyboard';
        pane.setAttribute('aria-hidden', 'true');
        Object.assign(pane.style, {
          position: 'fixed',
          left: '0',
          right: '0',
          bottom: '0',
          height: `${height}px`,
          zIndex: '2147483647',
          pointerEvents: 'none',
          display: 'grid',
          placeItems: 'center',
          font: '14px system-ui',
          color: '#555',
          background: '#d1d3d9',
        });
        document.body.append(pane);
      }
      target.dispatchEvent(new Event('resize'));
    };
  });
}

/** Raise the emulated keyboard to `height` CSS pixels (0 closes it). */
export async function emulateKeyboard(page: Page, height: number) {
  await page.evaluate(
    (value) =>
      (
        window as unknown as { __emulateKeyboard(height: number): void }
      ).__emulateKeyboard(value),
    height,
  );
}
