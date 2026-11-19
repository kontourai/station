/** @vitest-environment jsdom */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { copyToClipboard } from '../clipboard';

afterEach(() => {
  Object.assign(navigator, { clipboard: undefined });
  Reflect.deleteProperty(document, 'execCommand');
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

  test.each(['absent', 'refused'])(
    'copies the selected text when the async clipboard API is %s',
    async (availability) => {
      if (availability === 'refused') {
        Object.assign(navigator, {
          clipboard: {
            writeText: vi.fn().mockRejectedValue(new Error('denied')),
          },
        });
      }
      const dialog = document.createElement('dialog');
      dialog.open = true;
      const trigger = document.createElement('button');
      dialog.append(trigger);
      document.body.append(dialog);
      trigger.focus();
      Object.assign(document, {
        execCommand: vi.fn((command: string) => {
          const field = document.activeElement as HTMLTextAreaElement;
          return (
            command === 'copy' &&
            dialog.contains(field) &&
            field.value.slice(field.selectionStart, field.selectionEnd) ===
              'Line 1\nLine 2'
          );
        }),
      });
      try {
        await expect(copyToClipboard('Line 1\nLine 2')).resolves.toBe(true);
        expect(document.activeElement).toBe(trigger);
        expect(dialog.querySelector('textarea')).toBeNull();
      } finally {
        dialog.remove();
      }
    },
  );

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
