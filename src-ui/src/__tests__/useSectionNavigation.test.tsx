/**
 * @vitest-environment jsdom
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { useSectionNavigation } from '../hooks/useSectionNavigation';

const sections = ['models', 'agents', 'knowledge'] as const;

describe('useSectionNavigation', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/connections?keep=1');
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
  });

  test('accepts a supported query on initial load', () => {
    window.history.replaceState({}, '', '/connections?keep=1&section=agents');

    const { result } = renderHook(() =>
      useSectionNavigation(sections, 'models'),
    );

    expect(result.current.activeSection).toBe('agents');
  });

  test('reveals a deep-linked section that renders after the hook mounts', async () => {
    window.history.replaceState({}, '', '/connections?section=knowledge');
    const scrollIntoView = vi.fn();

    renderHook(() => useSectionNavigation(sections, 'models'));
    const target = document.createElement('section');
    target.id = 'section-knowledge';
    target.scrollIntoView = scrollIntoView;
    document.body.append(target);

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledOnce());
    target.remove();
  });

  test('removes an invalid section without dropping unrelated query state', async () => {
    window.history.replaceState({}, '', '/connections?keep=1&section=unknown');

    const { result } = renderHook(() =>
      useSectionNavigation(sections, 'models'),
    );

    await waitFor(() => expect(window.location.search).toBe('?keep=1'));
    expect(result.current.activeSection).toBe('models');
  });

  test('pushes a shareable URL and preserves other query parameters', () => {
    const { result } = renderHook(() =>
      useSectionNavigation(sections, 'models'),
    );

    act(() => result.current.navigateToSection('knowledge'));

    expect(result.current.activeSection).toBe('knowledge');
    expect(window.location.search).toBe('?keep=1&section=knowledge');
    expect(result.current.hrefForSection('agents')).toBe(
      '/connections?keep=1&section=agents',
    );
  });

  test('restores generic in-app section focus and cancels the prior focus work', () => {
    const first = document.createElement('section');
    first.id = 'section-models';
    first.tabIndex = -1;
    const second = document.createElement('section');
    second.id = 'section-agents';
    second.tabIndex = -1;
    document.body.append(first, second);
    const firstFocus = vi.spyOn(first, 'focus');
    const secondFocus = vi.spyOn(second, 'focus');
    const { result } = renderHook(() =>
      useSectionNavigation(sections, 'models'),
    );

    act(() => result.current.navigateToSection('models'));
    act(() => result.current.navigateToSection('agents'));

    expect(firstFocus).toHaveBeenCalled();
    expect(secondFocus).toHaveBeenCalled();
    first.remove();
    second.remove();
  });

  test('tracks browser back and forward popstate changes', () => {
    const { result } = renderHook(() =>
      useSectionNavigation(sections, 'models'),
    );

    act(() => {
      window.history.pushState({}, '', '/connections?keep=1&section=agents');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(result.current.activeSection).toBe('agents');
  });

  test('supports a view query while preserving legacy section deep links', () => {
    window.history.replaceState({}, '', '/settings?keep=1&section=knowledge');
    const settingsViews = ['overview', 'appearance', 'knowledge'] as const;
    const { result } = renderHook(() =>
      useSectionNavigation(settingsViews, 'overview', {
        queryKey: 'view',
        legacyQueryKey: 'section',
      }),
    );

    expect(result.current.activeSection).toBe('knowledge');
    expect(window.location.search).toBe('?keep=1&view=knowledge');
    act(() => result.current.navigateToSection('appearance'));
    expect(window.location.search).toBe('?keep=1&view=appearance');
    expect(result.current.hrefForSection('overview')).toBe(
      '/settings?keep=1&view=overview',
    );
  });

  test('does not let section focus race a catalog leaf highlight', () => {
    window.history.replaceState(
      {},
      '',
      '/settings?view=appearance&highlight=theme',
    );
    const target = document.createElement('section');
    target.id = 'section-appearance';
    target.tabIndex = -1;
    document.body.append(target);
    const focus = vi.spyOn(target, 'focus');

    renderHook(() =>
      useSectionNavigation(['overview', 'appearance'], 'overview', {
        queryKey: 'view',
        legacyQueryKey: 'section',
      }),
    );

    expect(focus).not.toHaveBeenCalled();
    target.remove();
  });
});
