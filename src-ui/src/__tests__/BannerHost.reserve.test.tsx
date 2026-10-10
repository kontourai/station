/**
 * @vitest-environment jsdom
 *
 * The banner stack stops covering content, and every banner collapses.
 *
 * Two claims, deliberately kept in one file because they are the same fix:
 * a collapsed banner is shorter, and the reserved space follows it, which is
 * the only reason collapsing does anything about overlap at all.
 *
 * What the published height and the collapse do under the real cascade (the
 * content inset, the height tween, reduced motion) is measured in Chromium by
 * `components/notifications/__tests__/BannerHost.reserve-cascade.test.tsx`.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  BANNER_RESERVED_HEIGHT_PROPERTY,
  BannerHost,
} from '../components/notifications/BannerHost';
import { bannerReservedHeight, bannerStore } from '../contexts/banner-store';

afterEach(() => {
  vi.restoreAllMocks();
  act(() => bannerStore.reset());
});

/**
 * jsdom lays nothing out, so every box reads 0. Geometry is supplied per
 * element instead — the host's own top, and each card's bottom edge — which
 * is exactly the pair the reservation is derived from.
 */
function stubGeometry(
  edges: (element: Element) => [top: number, bottom: number],
) {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: Element) {
      const [top, bottom] = edges(this);
      return {
        top,
        bottom,
        left: 0,
        right: 320,
        width: 320,
        height: bottom - top,
        x: 0,
        y: top,
        toJSON: () => ({}),
      } as DOMRect;
    },
  );
}

const HOST_TOP = 40;

/** Host at y=40; each card 60px tall, stacked from y=46. */
function stackedCards(element: Element): [number, number] {
  if (element.classList.contains('banner-host')) return [HOST_TOP, 0];
  const index = element.hasAttribute('data-banner-id')
    ? Number(element.getAttribute('data-index') ?? '0')
    : 0;
  const top = 46 + index * 66;
  return [top, top + 60];
}

function presentBlocking(overrides: Record<string, unknown> = {}) {
  act(() => {
    bannerStore.present({
      id: 'test:blocking',
      priority: 100,
      tone: 'blocked',
      badge: 'Credential required',
      message: 'Station cannot reach this host until you pair again.',
      detail: 'Automatic reconnect is paused until this is resolved.',
      actions: [{ label: 'Pair again', onClick: () => {} }],
      ...overrides,
    });
  });
}

describe('bannerReservedHeight', () => {
  test('reserves nothing when there is nothing to reserve for', () => {
    expect(bannerReservedHeight(40, [])).toBe(0);
  });

  test('reserves down to the bottom-most reserving edge, not the sum', () => {
    expect(
      bannerReservedHeight(40, [
        { reserves: true, bottom: 106 },
        { reserves: true, bottom: 172 },
      ]),
    ).toBe(132);
  });

  test('an overlay-only stack reserves nothing at all', () => {
    expect(
      bannerReservedHeight(40, [
        { reserves: false, bottom: 106 },
        { reserves: false, bottom: 172 },
      ]),
    ).toBe(0);
  });

  test('an overlay banner below the last reserving one adds nothing', () => {
    expect(
      bannerReservedHeight(40, [
        { reserves: true, bottom: 106 },
        { reserves: false, bottom: 172 },
      ]),
    ).toBe(66);
  });

  test('a reserving banner below an overlay one reserves through it', () => {
    expect(
      bannerReservedHeight(40, [
        { reserves: false, bottom: 106 },
        { reserves: true, bottom: 172 },
      ]),
    ).toBe(132);
  });

  test('an un-laid-out (or stale) box reserves nothing rather than a negative', () => {
    expect(bannerReservedHeight(40, [{ reserves: true, bottom: 0 }])).toBe(0);
  });
});

describe('BannerHost space reservation', () => {
  test('publishes the occupied height onto its own container', () => {
    stubGeometry(stackedCards);
    presentBlocking();
    const { container } = render(<BannerHost />);

    // Card bottom 106, host top 40.
    expect(
      container.style.getPropertyValue(BANNER_RESERVED_HEIGHT_PROPERTY),
    ).toBe('66px');
  });

  test('an overlay banner is measured and still reserves nothing', () => {
    stubGeometry(stackedCards);
    presentBlocking({ overlay: true });
    const { container } = render(<BannerHost />);

    expect(screen.getByRole('alert').getAttribute('data-overlay')).toBe('true');
    expect(
      container.style.getPropertyValue(BANNER_RESERVED_HEIGHT_PROPERTY),
    ).toBe('');
  });

  test('a reserving card clipped by its stack does not reserve its hidden portion', () => {
    stubGeometry((element) => {
      if (element.classList.contains('banner-host__stack')) return [46, 142];
      if (element.hasAttribute('data-banner-id')) {
        const top = element.getAttribute('data-banner-id') === 'upper' ? 46 : 112;
        return [top, top + 60];
      }
      return stackedCards(element);
    });
    presentBlocking({ id: 'upper', priority: 101 });
    presentBlocking({ id: 'lower' });
    const { container } = render(<BannerHost />);
    const stack = container.querySelector<HTMLElement>('.banner-host__stack')!;
    stack.style.overflowY = 'auto';
    fireEvent.scroll(stack);

    expect(
      container.style.getPropertyValue(BANNER_RESERVED_HEIGHT_PROPERTY),
    ).toBe('102px');
  });

  test('a scroll-clipped stack reserves its visible cards and follows scrolling', () => {
    let scrollOffset = 0;
    stubGeometry((element) => {
      if (element.classList.contains('banner-host__stack')) return [46, 106];
      if (element.hasAttribute('data-banner-id')) {
        const top =
          (element.getAttribute('data-banner-id') === 'reserving' ? 46 : 112) -
          scrollOffset;
        return [top, top + 60];
      }
      return stackedCards(element);
    });
    presentBlocking({ id: 'reserving', priority: 101 });
    presentBlocking({ id: 'overlay', overlay: true });
    const { container } = render(<BannerHost />);
    const stack = container.querySelector<HTMLElement>('.banner-host__stack')!;
    stack.style.overflowY = 'auto';
    fireEvent.scroll(stack);

    expect(
      container.style.getPropertyValue(BANNER_RESERVED_HEIGHT_PROPERTY),
    ).toBe('66px');

    scrollOffset = 30;
    fireEvent.scroll(stack);
    expect(
      container.style.getPropertyValue(BANNER_RESERVED_HEIGHT_PROPERTY),
    ).toBe('36px');

    scrollOffset = 66;
    fireEvent.scroll(stack);
    expect(
      container.style.getPropertyValue(BANNER_RESERVED_HEIGHT_PROPERTY),
    ).toBe('');
  });

  test('a clipped overlay-only stack still reserves nothing', () => {
    stubGeometry((element) => {
      if (element.classList.contains('banner-host__stack')) return [46, 142];
      if (element.hasAttribute('data-banner-id')) {
        const top =
          element.getAttribute('data-banner-id') === 'overlay-2' ? 46 : 112;
        return [top, top + 60];
      }
      return stackedCards(element);
    });
    presentBlocking({ id: 'overlay-1', overlay: true });
    presentBlocking({ id: 'overlay-2', overlay: true, priority: 101 });
    const { container } = render(<BannerHost />);
    const stack = container.querySelector<HTMLElement>('.banner-host__stack')!;
    stack.style.overflowY = 'auto';
    fireEvent.scroll(stack);

    expect(
      container.style.getPropertyValue(BANNER_RESERVED_HEIGHT_PROPERTY),
    ).toBe('');
  });

  test('hands the space back when the last banner leaves', () => {
    stubGeometry(stackedCards);
    presentBlocking();
    const { container } = render(<BannerHost />);
    expect(
      container.style.getPropertyValue(BANNER_RESERVED_HEIGHT_PROPERTY),
    ).toBe('66px');

    act(() => bannerStore.dismiss('test:blocking'));

    expect(
      container.style.getPropertyValue(BANNER_RESERVED_HEIGHT_PROPERTY),
    ).toBe('');
  });

  test('hands the space back on unmount, not leaving the app permanently inset', () => {
    stubGeometry(stackedCards);
    presentBlocking();
    const { container, unmount } = render(<BannerHost />);
    expect(
      container.style.getPropertyValue(BANNER_RESERVED_HEIGHT_PROPERTY),
    ).toBe('66px');

    unmount();

    expect(
      container.style.getPropertyValue(BANNER_RESERVED_HEIGHT_PROPERTY),
    ).toBe('');
  });
});

describe('BannerHost per-banner collapse', () => {
  test('a non-dismissible blocking banner is collapsible', () => {
    presentBlocking({ dismissible: false });
    render(<BannerHost />);

    // archive#3432 kept this band out of the stack cap; that is about leaving
    // the DOM, and says nothing about collapsing in place.
    expect(screen.queryByRole('button', { name: 'Dismiss notice' })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Collapse notice' }),
    ).toBeTruthy();
  });

  test('collapsing keeps the fault named and its actions reachable', () => {
    presentBlocking({ dismissible: false });
    render(<BannerHost />);
    act(() => {
      screen.getByRole('button', { name: 'Collapse notice' }).click();
    });

    const card = screen.getByRole('alert');
    expect(card.dataset.collapsed).toBe('true');
    expect(card.className).toMatch(/banner-host__item--collapsed/);
    // Not a blank strip: the badge, the message and the remedy all survive.
    expect(screen.getByText('Credential required')).toBeTruthy();
    expect(screen.getByText(/Station cannot reach this host/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pair again' })).toBeTruthy();
    // Only the recoverable part goes: the detail disclosure is not rendered
    // (a focusable control inside a clipped box is reachable and invisible).
    // archive#4470b: the toggle's label is the constant "Details" now (was
    // "More"/"Less").
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Expand notice' })).toBeTruthy();
  });

  test('a source re-presenting the same occurrence does not re-open it', () => {
    presentBlocking({ occurrence: 'pairing-required' });
    render(<BannerHost />);
    act(() => {
      screen.getByRole('button', { name: 'Collapse notice' }).click();
    });
    expect(screen.getByRole('alert').dataset.collapsed).toBe('true');

    // The poll that would otherwise undo the user's decision every 10s.
    presentBlocking({
      occurrence: 'pairing-required',
      message: 'Changed copy.',
    });

    expect(screen.getByRole('alert').dataset.collapsed).toBe('true');
  });

  test('a new occurrence of the same condition arrives expanded', () => {
    presentBlocking({ occurrence: 'pairing-required' });
    render(<BannerHost />);
    act(() => {
      screen.getByRole('button', { name: 'Collapse notice' }).click();
    });
    expect(screen.getByRole('alert').dataset.collapsed).toBe('true');

    presentBlocking({ occurrence: 'host-moved' });

    expect(screen.getByRole('alert').dataset.collapsed).toBeUndefined();
  });

  test('an old occurrence coming back does not resurrect the old collapse', () => {
    presentBlocking({ occurrence: 'pairing-required' });
    render(<BannerHost />);
    act(() => {
      screen.getByRole('button', { name: 'Collapse notice' }).click();
    });

    // Superseded by a different occurrence, which arrives expanded...
    presentBlocking({ occurrence: 'host-moved' });
    expect(screen.getByRole('alert').dataset.collapsed).toBeUndefined();
    //.and the first condition recurring is a new thing to read, not a
    // resumption of the showing the user collapsed. Same posture as
    // dismissal, whose suppression key is released the same way.
    presentBlocking({ occurrence: 'pairing-required' });

    expect(screen.getByRole('alert').dataset.collapsed).toBeUndefined();
  });

  test('clear(prefix) releases the collapsed state with the banner', () => {
    presentBlocking();
    render(<BannerHost />);
    act(() => {
      screen.getByRole('button', { name: 'Collapse notice' }).click();
    });

    act(() => bannerStore.clear('test:'));
    presentBlocking();

    expect(screen.getByRole('alert').dataset.collapsed).toBeUndefined();
  });

  test('an exiting banner is never forced through the collapsed layout', () => {
    presentBlocking({ dismissible: true });
    const { container } = render(<BannerHost />);
    act(() => {
      screen.getByRole('button', { name: 'Collapse notice' }).click();
    });

    act(() => bannerStore.dismiss('test:blocking', { reason: 'user' }));

    // Queried by attribute, not by role: an exiting card is `aria-hidden`.
    // Both states would drive `height`, and the exit's row collapse must win.
    const card = container.querySelector('[data-banner-id]');
    expect(card).not.toBeNull();
    if (card === null) return;
    expect(card.className).toMatch(/banner-host__item--exiting/);
    expect(card.className).not.toMatch(/banner-host__item--collapsed/);
  });
});
