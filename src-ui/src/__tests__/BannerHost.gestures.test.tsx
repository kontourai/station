/**
 * @vitest-environment jsdom
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { BannerHost } from '../components/notifications/BannerHost';
import { bannerStore } from '../contexts/banner-store';

afterEach(() => {
  act(() => bannerStore.reset());
});

function present(dismissible: boolean) {
  act(() => {
    bannerStore.present({
      id: `test:${dismissible ? 'dismissible' : 'blocking'}`,
      priority: 10,
      tone: dismissible ? 'warning' : 'blocked',
      message: dismissible ? 'Temporary connection warning' : 'Access required',
      dismissible,
    });
  });
}

describe('BannerHost touch gestures', () => {
  test('a horizontal touch swipe dismisses a dismissible notice', () => {
    present(true);
    render(<BannerHost />);
    const notice = screen.getByRole('alert');
    Object.assign(notice, {
      getBoundingClientRect: () => ({ width: 320 }),
      setPointerCapture: vi.fn(),
    });

    fireEvent.pointerDown(notice, {
      pointerId: 1,
      pointerType: 'touch',
      button: 0,
      clientX: 260,
      clientY: 30,
    });
    fireEvent.pointerMove(notice, {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 170,
      clientY: 32,
    });
    fireEvent.pointerUp(notice, {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 170,
      clientY: 32,
    });

    expect(notice.getAttribute('data-phase')).toBe('exiting');
    act(() => bannerStore.flushExits());
    expect(screen.queryByText('Temporary connection warning')).toBeNull();
  });

  test('blocking notices do not advertise or respond to swipe dismissal', () => {
    present(false);
    render(<BannerHost />);
    const notice = screen.getByRole('alert');

    expect(notice.hasAttribute('data-swipe-dismissible')).toBe(false);
    fireEvent.pointerDown(notice, {
      pointerId: 1,
      pointerType: 'touch',
      button: 0,
      clientX: 260,
      clientY: 30,
    });
    fireEvent.pointerMove(notice, {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 100,
      clientY: 30,
    });
    fireEvent.pointerUp(notice, {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 100,
      clientY: 30,
    });

    expect(notice.getAttribute('data-phase')).toBe('live');
    expect(screen.getByText('Access required')).toBeTruthy();
  });

  test('vertical touch movement leaves a dismissible notice in place', () => {
    present(true);
    render(<BannerHost />);
    const notice = screen.getByRole('alert');

    fireEvent.pointerDown(notice, {
      pointerId: 1,
      pointerType: 'touch',
      button: 0,
      clientX: 200,
      clientY: 30,
    });
    fireEvent.pointerMove(notice, {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 196,
      clientY: 100,
    });
    fireEvent.pointerUp(notice, {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 196,
      clientY: 100,
    });

    expect(notice.getAttribute('data-phase')).toBe('live');
  });
});
