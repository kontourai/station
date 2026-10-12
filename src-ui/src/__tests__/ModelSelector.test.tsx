// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../contexts/ModelsContext', () => ({
  useModels: () => [],
}));
vi.mock('../contexts/ModelCapabilitiesContext', () => ({
  useModelCapabilities: () => ({}),
}));

import {
  ModelSelector,
  ModelSelectorAutocomplete,
} from '../components/ModelSelector';
import { deviceSettingsStore } from '../lib/device-settings-store';
import {
  modelPreferenceKey,
  readModelPickerPreferences,
} from '../settings/modelPickerPreferences';

beforeEach(() => {
  window.localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
});
afterEach(cleanup);

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

    // A "Use..." option is offered for the typed id, and selecting it commits it.
    fireEvent.mouseDown(screen.getByText(/Use .claude-opus-4-9./));
    expect(onChange).toHaveBeenCalledWith('claude-opus-4-9');
  });
});

describe('/model selection', () => {
  test('shows model icons, skips unavailable routes with the keyboard and records the accepted route', () => {
    const onSelect = vi.fn();
    render(
      <ModelSelectorAutocomplete
        query=""
        onClose={vi.fn()}
        onSelect={onSelect}
        models={[
          {
            id: 'blocked',
            name: 'Blocked route',
            providerType: 'codex',
            available: false,
            unavailableReason: 'Skills unavailable',
          },
          {
            id: 'ready',
            name: 'Ready route',
            providerId: 'claude-local',
            providerType: 'claude',
          },
        ]}
      />,
    );
    expect(screen.getByText('Skills unavailable')).toBeTruthy();
    expect(
      document.querySelectorAll('.brand-icon--codex, .brand-icon--claude'),
    ).toHaveLength(2);
    fireEvent.mouseDown(screen.getByText('Blocked route'));
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ready', providerId: 'claude-local' }),
    );
    expect(readModelPickerPreferences().recents).toEqual([
      modelPreferenceKey('claude-local', 'ready'),
    ]);
  });
});
