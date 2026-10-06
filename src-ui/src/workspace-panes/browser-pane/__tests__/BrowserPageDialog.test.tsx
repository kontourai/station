/** @vitest-environment jsdom */

/**
 * The held-dialog card (#90): it keeps the person's hold alive only while a
 * person could be reading it (the tab visible and the card in view), and
 * Escape answers THIS dialog without reaching anything around it.
 */
import type { BrowserPendingDialogView } from '@kontourai/station-contracts/workspace-browser-pane';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { BrowserPageDialog } from '../BrowserPageDialog';

const CONFIRM: BrowserPendingDialogView = {
  dialogId: 'd1',
  type: 'confirm',
  message: 'Remove the blue mug?',
  openedAt: '2026-09-22T12:00:05.000Z',
};

/** An IntersectionObserver the test drives: `report(visible)` for each. */
let observers: Array<(visible: boolean) => void> = [];
class FakeIntersectionObserver {
  constructor(callback: IntersectionObserverCallback) {
    observers.push((visible) =>
      callback(
        [{ isIntersecting: visible } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      ),
    );
  }
  observe() {}
  disconnect() {}
  unobserve() {}
  takeRecords() {
    return [];
  }
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  observers = [];
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  setVisibility('visible');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setVisibility('visible');
});

function renderCard(
  extra: Partial<Parameters<typeof BrowserPageDialog>[0]> = {},
) {
  const onAnswer = vi.fn();
  const onKeepAlive = vi.fn();
  render(
    <BrowserPageDialog
      dialog={CONFIRM}
      pageHost="shop.example.com"
      pending={false}
      error={null}
      onAnswer={onAnswer}
      onKeepAlive={onKeepAlive}
      {...extra}
    />,
  );
  return { onAnswer, onKeepAlive };
}

describe("keeping the person's hold alive", () => {
  test('renews every 10 s while the card is in view on a visible tab', () => {
    const { onKeepAlive } = renderCard();
    act(() => observers.forEach((report) => report(true)));
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(onKeepAlive).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(onKeepAlive).toHaveBeenCalledTimes(3);
  });

  test('does not renew while the card is scrolled or folded out of view', () => {
    const { onKeepAlive } = renderCard();
    act(() => observers.forEach((report) => report(false)));
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(onKeepAlive).not.toHaveBeenCalled();
    // Back in view: renewals resume.
    act(() => observers.forEach((report) => report(true)));
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(onKeepAlive).toHaveBeenCalledTimes(1);
  });

  test('does not renew while the tab is hidden', () => {
    const { onKeepAlive } = renderCard();
    act(() => observers.forEach((report) => report(true)));
    setVisibility('hidden');
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(onKeepAlive).not.toHaveBeenCalled();
  });
});

describe('Escape', () => {
  test('dismisses the confirm and does not reach the page around the card', () => {
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    try {
      const { onAnswer } = renderCard();
      fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
      expect(onAnswer).toHaveBeenCalledWith({ accept: false });
      expect(outer).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', outer);
    }
  });
});

describe('the pointer the card sizes itself for', () => {
  function stubPointer(coarse: boolean) {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(pointer: coarse)' ? coarse : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  }

  test('a coarse pointer marks the card coarse, so the compact density never applies', () => {
    stubPointer(true);
    renderCard({ compact: true });
    expect(screen.getByRole('alertdialog').getAttribute('data-pointer')).toBe(
      'coarse',
    );
  });

  test('a fine pointer marks the card fine, which is what the compact density keys on', () => {
    stubPointer(false);
    renderCard({ compact: true });
    expect(screen.getByRole('alertdialog').getAttribute('data-pointer')).toBe(
      'fine',
    );
  });
});
