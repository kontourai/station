// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../contexts/ModelsContext', () => ({
  useModels: () => [],
}));
vi.mock('../contexts/ModelCapabilitiesContext', () => ({
  useModelCapabilities: () => ({}),
}));

import { ModelSelector } from '../components/ModelSelector';

describe('ModelSelector', () => {
  test('lets you pick a model from the provided catalog', () => {
    const onChange = vi.fn();
    render(
      <ModelSelector
        value=""
        onChange={onChange}
        models={[{ id: 'sonnet', name: 'Claude Sonnet', originalId: 'sonnet' }]}
      />,
    );

    fireEvent.focus(screen.getByRole('textbox'));
    fireEvent.mouseDown(screen.getByText('Claude Sonnet'));
    expect(onChange).toHaveBeenCalledWith('sonnet');
  });

  test('accepts an off-catalog model id typed in (custom entry)', () => {
    const onChange = vi.fn();
    render(
      <ModelSelector
        value=""
        onChange={onChange}
        models={[{ id: 'sonnet', name: 'Claude Sonnet', originalId: 'sonnet' }]}
      />,
    );

    const input = screen.getByRole('textbox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'claude-opus-4-9' } });

    // A "Use ..." option is offered for the typed id, and selecting it commits it.
    fireEvent.mouseDown(screen.getByText(/Use .claude-opus-4-9./));
    expect(onChange).toHaveBeenCalledWith('claude-opus-4-9');
  });
});
