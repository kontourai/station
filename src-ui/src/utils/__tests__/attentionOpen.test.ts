// @vitest-environment jsdom
/**
 * archive#3203. The tray badge counts attention items with no
 * `acknowledgedAt`; opening a row records one. Opening navigates inside the
 * app, so the navigation no longer waits for the write: these pin that the
 * user is taken there at once, the write still happens, and its failure
 * changes nothing they asked for. `navigateToAttentionTarget` is the
 * in-app navigation itself, observed on the real navigation store.
 */

import { describe, expect, test, vi } from 'vitest';
import { navigationStore } from '../../contexts/NavigationContext';
import {
  isPlainLeftClick,
  navigateToAttentionTarget,
  openThenAcknowledge,
} from '../attentionOpen';

function plainClick(overrides: Record<string, unknown> = {}) {
  return {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    ...overrides,
  };
}

describe('openThenAcknowledge', () => {
  test('navigates at once, before the acknowledgement resolves', async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done = openThenAcknowledge({
      acknowledge: () => {
        order.push('acknowledge');
        return pending;
      },
      navigate: () => order.push('navigate'),
    });
    expect(order).toEqual(['navigate', 'acknowledge']);
    release();
    await done;
    expect(order).toEqual(['navigate', 'acknowledge']);
  });

  test('a failing acknowledgement neither rejects nor navigates twice', async () => {
    const navigate = vi.fn();
    await expect(
      openThenAcknowledge({
        acknowledge: () => Promise.reject(new Error('offline')),
        navigate,
      }),
    ).resolves.toBeUndefined();
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  test('nothing to acknowledge: it only navigates', async () => {
    const navigate = vi.fn();
    await openThenAcknowledge({ navigate });
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});

describe('navigateToAttentionTarget', () => {
  test('navigates in the app, without a document load', () => {
    // jsdom does not implement document navigation: a `location.assign`
    // would leave the path where it was, so a changed path is the in-app one.
    navigateToAttentionTarget('/projects/demo?chat=thread-1&dock=open');
    expect(window.location.pathname).toBe('/projects/demo');
    expect(new URLSearchParams(window.location.search).get('chat')).toBe(
      'thread-1',
    );
    expect(navigationStore.getSnapshot().activeChat).toBe('thread-1');
  });

  test('a stored Activity link opens the Chat surface that replaced it', () => {
    navigateToAttentionTarget('/?surface=activity&session=thread-boom');
    const params = new URLSearchParams(window.location.search);
    expect(params.get('surface') ?? 'chat').toBe('chat');
  });
});

describe('isPlainLeftClick', () => {
  test('a plain left click is ours to replace', () => {
    expect(isPlainLeftClick(plainClick())).toBe(true);
  });

  test.each([
    ['meta (open in a new tab)', { metaKey: true }],
    ['ctrl (open in a new tab)', { ctrlKey: true }],
    ['shift (open in a new window)', { shiftKey: true }],
    ['alt (download)', { altKey: true }],
    ['middle click', { button: 1 }],
    ['a click something else already handled', { defaultPrevented: true }],
  ])('%s falls through to the browser', (_label, overrides) => {
    // Intercepting these would both break the browser gesture AND record an
    // acknowledgement for a row the user never actually left.
    expect(isPlainLeftClick(plainClick(overrides))).toBe(false);
  });
});
