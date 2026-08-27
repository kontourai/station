import type { Page } from '@playwright/test';

/** Install one deterministic VisualViewport fixture for every mobile E2E lane. */
export async function installVisualViewportFixture(page: Page) {
  await page.addInitScript(() => {
    class TestVisualViewport extends EventTarget {
      width = innerWidth;
      height = innerHeight;
      offsetTop = 0;
      offsetLeft = 0;
      pageTop = 0;
      pageLeft = 0;
      scale = 1;
    }

    const viewport = new TestVisualViewport();
    let hasExplicitOverride = false;
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: viewport,
    });
    const update = (height: number, offsetTop = 0) => {
      hasExplicitOverride = true;
      viewport.height = height;
      viewport.offsetTop = offsetTop;
      viewport.dispatchEvent(new Event('resize'));
      viewport.dispatchEvent(new Event('scroll'));
    };
    // addInitScript runs before the document's viewport meta is applied. On
    // mobile emulation that pre-meta innerHeight can be more than twice the
    // eventual CSS viewport, which makes bottom-sheet geometry look offscreen.
    // Follow the browser's real viewport until the test deliberately installs
    // a keyboard-sized override; explicit simulations must remain stable.
    window.addEventListener('resize', () => {
      if (hasExplicitOverride) return;
      viewport.width = innerWidth;
      viewport.height = innerHeight;
      viewport.offsetTop = 0;
      viewport.dispatchEvent(new Event('resize'));
      viewport.dispatchEvent(new Event('scroll'));
    });
    Object.assign(window, {
      __setTestVisualViewport: update,
      __setChatViewport: update,
      __setTaskFirstViewport: update,
    });
  });
}

export async function setVisualViewport(
  page: Page,
  height: number,
  offsetTop = 0,
) {
  await page.evaluate(
    async ({ nextHeight, nextOffsetTop }) => {
      (
        window as unknown as Window & {
          __setTestVisualViewport: (height: number, offsetTop?: number) => void;
        }
      ).__setTestVisualViewport(nextHeight, nextOffsetTop);

      // The product hook coalesces VisualViewport events in one animation
      // frame. Wait through its state update and the following React commit so
      // callers can measure geometry immediately after this helper resolves.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    },
    { nextHeight: height, nextOffsetTop: offsetTop },
  );
}
