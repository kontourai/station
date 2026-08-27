/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { PromptModal } from '../components/modals/PromptModal';

describe('PromptModal', () => {
  test('IME Enter does not confirm, then plain Enter confirms', () => {
    const onConfirm = vi.fn();
    render(
      <PromptModal
        isOpen={true}
        title="Rename file"
        initialValue="report.txt"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    const input = screen.getByRole('textbox');
    fireEvent.keyDown(input, {
      key: 'Enter',
      isComposing: true,
      keyCode: 229,
    });
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onConfirm).toHaveBeenCalledWith('report.txt');
  });
});
