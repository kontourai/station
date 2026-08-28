/**
 * @vitest-environment jsdom
 *
 * archive#3341 — the seam's whole contract is that `true` cannot be reached
 * without a `writeText` that itself resolved. All three arms are pinned here
 * because each one was a live defect at a real call site: the missing-clipboard
 * arm is the insecure-origin case the old `?.` shape reported as success, and
 * the rejection arm is the permission refusal the old `void` shape dropped.
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { copyToClipboard } from '../clipboard';

afterEach(() => {
  Object.assign(navigator, { clipboard: undefined });
});

describe('copyToClipboard', () => {
  test('resolves true only after the write itself resolved', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    await expect(copyToClipboard('station-thread-1')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('station-thread-1');
  });

  test('resolves false when the origin has no clipboard API at all', async () => {
    Object.assign(navigator, { clipboard: undefined });

    await expect(copyToClipboard('station-thread-1')).resolves.toBe(false);
  });

  test('resolves false when the write is refused', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.assign(navigator, { clipboard: { writeText } });

    await expect(copyToClipboard('station-thread-1')).resolves.toBe(false);
    expect(writeText).toHaveBeenCalledWith('station-thread-1');
  });

  test('a clipboard object without writeText is not a clipboard', async () => {
    Object.assign(navigator, { clipboard: {} });

    await expect(copyToClipboard('station-thread-1')).resolves.toBe(false);
  });

  test('never throws back to the caller', async () => {
    Object.assign(navigator, {
      clipboard: {
        writeText: () => {
          throw new TypeError('synchronous refusal');
        },
      },
    });

    await expect(copyToClipboard('station-thread-1')).resolves.toBe(false);
  });
});
