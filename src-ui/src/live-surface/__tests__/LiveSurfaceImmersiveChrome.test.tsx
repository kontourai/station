// @vitest-environment jsdom

/**
 * The shared full-screen chrome: one compact row at phone width (who is in
 * control as a chip, Take or Release control, the surface's primary control,
 * More controls, Exit) with the surface's other controls behind More
 * controls; a hold this viewer has survives going full screen and back; and
 * touch wording on a touch screen.
 */

import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  canvasHarness,
  flush,
  layoutStage,
  lease,
  MY_HOLD,
  renderCanvas,
} from './fixtures/canvasStreamHarness';

function mockMedia(matching: (query: string) => boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: matching(query),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
}

function leaseCalls(h: ReturnType<typeof canvasHarness>) {
  return h.transport.mock.calls
    .filter(([url]) => String(url).endsWith('/lease'))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 1280, height: 800, close() {} })),
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  layoutStage({ width: 640, height: 400 });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('going full screen keeps this viewer’s hold', () => {
  test('a hold is renewed on entering and on leaving full screen', async () => {
    const h = canvasHarness();
    const changes: boolean[] = [];
    await renderCanvas(
      h,
      {
        fit: { aspect: 1.6 },
        fullScreenButton: true,
        onImmersiveChange: (immersive) => changes.push(immersive),
      },
      lease(2, MY_HOLD),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    await flush();
    expect(leaseCalls(h)).toEqual([{ action: 'keep-alive', epoch: 2 }]);
    fireEvent.click(screen.getByRole('button', { name: 'Exit full screen' }));
    await flush();
    expect(leaseCalls(h)).toEqual([
      { action: 'keep-alive', epoch: 2 },
      { action: 'keep-alive', epoch: 2 },
    ]);
    expect(changes).toEqual([true, false]);
  });

  test('without a hold, going full screen claims nothing', async () => {
    const h = canvasHarness();
    await renderCanvas(h, { fit: { aspect: 1.6 }, fullScreenButton: true });
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    await flush();
    expect(leaseCalls(h)).toEqual([]);
  });
});

describe('the compact (phone-width) bar', () => {
  test('one row: a chip, the primary control and More controls; the rest only behind More controls', async () => {
    mockMedia((query) => query.includes('max-width'));
    const h = canvasHarness();
    await renderCanvas(
      h,
      {
        fit: { aspect: 1.6 },
        fullScreenButton: true,
        renderImmersiveActions: () => <span>Primary control</span>,
        renderImmersiveMenu: () => <button type="button">Secondary</button>,
      },
      lease(2, MY_HOLD),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    await flush();
    const bar = screen.getByRole('toolbar', { name: /full screen controls/ });
    expect(bar.classList.contains('live-surface-controls--compact')).toBe(true);
    // The bar's row is kept clear above the picture (see the stylesheet).
    expect(bar.closest('.live-surface')?.hasAttribute('data-compact')).toBe(
      true,
    );
    expect(within(bar).getByText('You').className).toContain(
      'live-surface-controls__chip',
    );
    within(bar).getByText('Primary control');
    within(bar).getByRole('button', { name: 'Release' });
    expect(within(bar).queryByRole('button', { name: 'Secondary' })).toBeNull();
    expect(
      within(bar).queryByRole('button', { name: 'Show keyboard' }),
    ).toBeNull();
    fireEvent.click(within(bar).getByRole('button', { name: 'More controls' }));
    const menu = within(bar).getByRole('group', { name: 'More controls' });
    within(menu).getByRole('button', { name: 'Secondary' });
    within(menu).getByRole('button', { name: 'Show keyboard' });
  });

  test('with room, the same controls stand in one bar with no More controls', async () => {
    mockMedia(() => false);
    const h = canvasHarness();
    await renderCanvas(
      h,
      {
        fit: { aspect: 1.6 },
        fullScreenButton: true,
        renderImmersiveActions: () => <span>Primary control</span>,
        renderImmersiveMenu: () => <button type="button">Secondary</button>,
      },
      lease(2, MY_HOLD),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    await flush();
    const bar = screen.getByRole('toolbar', { name: /full screen controls/ });
    within(bar).getByRole('button', { name: 'Secondary' });
    expect(
      within(bar).queryByRole('button', { name: 'More controls' }),
    ).toBeNull();
  });
});

test('on a touch screen the controller line says Tap, not Click or type', async () => {
  mockMedia((query) => query.includes('pointer: coarse'));
  const h = canvasHarness();
  await renderCanvas(h);
  screen.getByText('No one is in control. Tap to take control.');
});
