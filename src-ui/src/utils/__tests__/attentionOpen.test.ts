/**
 * station#3203. The tray badge counts attention items with no
 * `acknowledgedAt`, and until this change only Dismiss recorded one — so
 * acting on a row left the number where it was and the bell stopped meaning
 * "things you have not seen".
 *
 * The ORDER is the contract, not an implementation detail: "Open session" is a
 * real document navigation, so an acknowledgement fired alongside it races the
 * unload, and the destination reads `/api/attention` on mount. These assert
 * that the write completes before the navigation, on both the success and the
 * failure path.
 */

import { describe, expect, test, vi } from 'vitest';
import { acknowledgeThenOpen, isPlainLeftClick } from '../attentionOpen';

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

describe('acknowledgeThenOpen', () => {
  test('navigates only after the acknowledgement has resolved', async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });

    const done = acknowledgeThenOpen({
      acknowledge: () => {
        order.push('acknowledge');
        return pending;
      },
      navigate: () => order.push('navigate'),
    });

    // The whole point of awaiting: while the ack is in flight the user is
    // still on this document, so the write can actually land.
    expect(order).toEqual(['acknowledge']);
    release();
    await done;
    expect(order).toEqual(['acknowledge', 'navigate']);
  });

  test('still navigates when the acknowledgement fails', async () => {
    // A failed ack must not trap the user on the tray — what they asked for
    // was "open this", and the next attention read is the count's authority.
    const navigate = vi.fn();

    await acknowledgeThenOpen({
      acknowledge: () => Promise.reject(new Error('offline')),
      navigate,
    });

    expect(navigate).toHaveBeenCalledTimes(1);
  });

  test('navigates exactly once', async () => {
    const navigate = vi.fn();

    await acknowledgeThenOpen({
      acknowledge: () => Promise.resolve(),
      navigate,
    });

    expect(navigate).toHaveBeenCalledTimes(1);
  });

  test('does not reject when the acknowledgement rejects', async () => {
    await expect(
      acknowledgeThenOpen({
        acknowledge: () => Promise.reject(new Error('offline')),
        navigate: () => {},
      }),
    ).resolves.toBeUndefined();
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
