/** @vitest-environment jsdom */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { observeRootTheme, useRootThemeVersion } from '../root-theme';

const root = document.documentElement;

/** MutationObserver records are delivered on a microtask. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  for (const name of [
    'data-color-theme',
    'data-color-theme-flavor',
    'data-color-theme-accent',
    'data-page-hidden',
    'class',
    'style',
  ])
    root.removeAttribute(name);
  root.setAttribute('data-theme', 'dark');
});

describe('observeRootTheme', () => {
  test('fires for every theme input on <html>', async () => {
    root.setAttribute('data-theme', 'dark');
    const onChange = vi.fn();
    const stop = observeRootTheme(onChange);
    const changes: Array<[string, () => void]> = [
      ['light/dark', () => root.setAttribute('data-theme', 'light')],
      ['palette', () => root.setAttribute('data-color-theme', 'catppuccin')],
      ['flavor', () => root.setAttribute('data-color-theme-flavor', 'latte')],
      ['accent', () => root.setAttribute('data-color-theme-accent', 'mauve')],
      [
        'device accent (inline style)',
        () => root.style.setProperty('--accent-primary', '#ff00aa'),
      ],
      [
        'white-label brand (inline style)',
        () => root.style.setProperty('--k-brand', '#123456'),
      ],
      ['class', () => root.classList.add('is-dev-build')],
    ];
    for (const [label, change] of changes) {
      onChange.mockClear();
      change();
      await flush();
      expect(onChange, label).toHaveBeenCalledTimes(1);
    }
    stop();
  });

  test('ignores geometry writes and unrelated attributes', async () => {
    const onChange = vi.fn();
    const stop = observeRootTheme(onChange);
    root.style.setProperty('--visual-viewport-bottom-inset', '312px');
    root.style.setProperty('--safe-top', '47px');
    root.style.setProperty('--titlebar-inset-left', '78px');
    root.setAttribute('data-page-hidden', 'true');
    await flush();
    expect(onChange).not.toHaveBeenCalled();
    // A re-write of the same theme value is not a change either.
    root.setAttribute('data-theme', root.getAttribute('data-theme') ?? 'dark');
    await flush();
    expect(onChange).not.toHaveBeenCalled();
    stop();
  });

  test('shares one observer; an unsubscribe leaves the others live', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = observeRootTheme(first);
    const stopSecond = observeRootTheme(second);
    stopFirst();
    root.setAttribute('data-color-theme', 'nord');
    await flush();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    stopSecond();
    root.setAttribute('data-color-theme', 'gruvbox');
    await flush();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('useRootThemeVersion', () => {
  test('re-renders with a new version when a palette attribute changes', async () => {
    const { result, unmount } = renderHook(() => useRootThemeVersion());
    const before = result.current;
    await act(async () => {
      root.setAttribute('data-color-theme-accent', 'peach');
      await flush();
    });
    expect(result.current).toBeGreaterThan(before);
    const after = result.current;
    await act(async () => {
      root.style.setProperty('--visual-viewport-bottom-inset', '20px');
      await flush();
    });
    expect(result.current).toBe(after);
    unmount();
  });
});
