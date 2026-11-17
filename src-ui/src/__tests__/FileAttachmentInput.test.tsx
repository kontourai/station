// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { FileAttachmentInput } from '../components/chat/FileAttachmentInput';

describe('FileAttachmentInput accessibility', () => {
  test('exposes one named non-submit control while keeping its paperclip decorative', () => {
    const { container } = render(
      <FileAttachmentInput
        attachments={[]}
        onFilesSelected={vi.fn()}
        supportsImages
      />,
    );
    const input = container.querySelector('input[type="file"]');
    expect(input).toBeTruthy();
    expect(input?.getAttribute('accept')).toContain('.heic,.heif');
    // #4403: the native input is what Attach clicks, not a second control —
    // exposed, browsers name it a 1x1 "Choose File" button in every composer.
    expect(input?.getAttribute('aria-hidden')).toBe('true');
    expect((input as HTMLInputElement | null)?.tabIndex).toBe(-1);
    const openPicker = vi.fn();
    Object.defineProperty(input, 'click', { value: openPicker });

    const button = screen.getByRole('button', { name: 'Attach files' });
    expect(button.getAttribute('type')).toBe('button');
    const icon = button.querySelector('svg');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(icon?.getAttribute('focusable')).toBe('false');

    fireEvent.click(button);
    expect(openPicker).toHaveBeenCalledOnce();
  });

  test('an engine that refused images explains itself on tap instead of sitting disabled', () => {
    const onUnavailable = vi.fn();
    const { container } = render(
      <FileAttachmentInput
        attachments={[]}
        onFilesSelected={vi.fn()}
        disabled
        supportsImages={false}
        supportsFiles={false}
        unavailableReason="Grok Build reported that it cannot accept images."
        onUnavailable={onUnavailable}
      />,
    );
    const input = container.querySelector('input[type="file"]');
    const openPicker = vi.fn();
    Object.defineProperty(input, 'click', { value: openPicker });
    const button = screen.getByRole('button', { name: 'Attach files' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button);
    expect(onUnavailable).toHaveBeenCalledWith(
      'Grok Build reported that it cannot accept images.',
    );
    expect(openPicker).not.toHaveBeenCalled();
  });

  test('with files attached, the paperclip still opens the picker to add more', () => {
    const onFilesSelected = vi.fn();
    const { container } = render(
      <FileAttachmentInput
        attachments={[
          {
            id: 'a1',
            name: 'screenshot.png',
            type: 'image/png',
            size: 10,
            data: 'data:image/png;base64,AAAA',
            preview: 'data:image/png;base64,AAAA',
          },
        ]}
        onFilesSelected={onFilesSelected}
        supportsImages
        supportsFiles
      />,
    );
    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const openPicker = vi.fn();
    Object.defineProperty(input, 'click', { value: openPicker });

    // The composer's chip strip lists and removes what is attached; the
    // paperclip has no review panel of its own to open instead.
    fireEvent.click(screen.getByRole('button', { name: 'Attach files' }));
    expect(openPicker).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull();

    // The picked files go to the composer's intake alongside the first.
    const added = new File(['more'], 'more.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [added] } });
    expect(onFilesSelected).toHaveBeenCalledWith([added]);
  });
});
