// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { FileAttachmentInput } from '../components/chat/FileAttachmentInput';

vi.mock('../contexts/PreviewContext', () => ({
  usePreview: () => ({ openPreview: vi.fn() }),
}));

describe('FileAttachmentInput accessibility', () => {
  test('exposes one named non-submit control while keeping its paperclip decorative', () => {
    const { container } = render(
      <FileAttachmentInput
        attachments={[]}
        onFilesSelected={vi.fn()}
        onRemove={vi.fn()}
        onClearAll={vi.fn()}
        supportsImages
      />,
    );
    const input = container.querySelector('input[type="file"]');
    expect(input).toBeTruthy();
    expect(input?.getAttribute('accept')).toContain('.heic,.heif');
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
        onRemove={vi.fn()}
        onClearAll={vi.fn()}
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
});
