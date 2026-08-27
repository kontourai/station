/** @vitest-environment jsdom */

import {
  APP_SETTINGS_REGISTRY,
  type SettingDefinition,
} from '@kontourai/station-contracts/settings-registry';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { DistributionProfileField } from '../views/settings/DistributionProfileField';

const definition = APP_SETTINGS_REGISTRY.find(
  (setting) => setting.key === 'distributionProfile',
) as SettingDefinition;

describe('DistributionProfileField', () => {
  test('absent value defaults the select to standard', () => {
    render(
      <DistributionProfileField
        definition={definition}
        value={undefined}
        onChange={vi.fn()}
      />,
    );
    const select = screen.getByLabelText('Layout sources') as HTMLSelectElement;
    expect(select.value).toBe('standard');
    expect(select.classList.contains('editor-select')).toBe(true);
  });

  test('minimal value selects minimal', () => {
    render(
      <DistributionProfileField
        definition={definition}
        value="minimal"
        onChange={vi.fn()}
      />,
    );
    const select = screen.getByLabelText('Layout sources') as HTMLSelectElement;
    expect(select.value).toBe('minimal');
  });

  test('changing the select calls onChange with the raw string value', () => {
    const onChange = vi.fn();
    render(
      <DistributionProfileField
        definition={definition}
        value="standard"
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText('Layout sources'), {
      target: { value: 'minimal' },
    });
    expect(onChange).toHaveBeenCalledWith('minimal');
  });

  test('a custom layout-source object renders a read-only note instead of the select', () => {
    render(
      <DistributionProfileField
        definition={definition}
        value={{ id: 'custom', registrySources: [] }}
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        'Custom layout sources are configured in app.json. Changes take effect after the next Station restart. Declared remote sources are not fetched or executed.',
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Layout sources')).toBeNull();
  });

  test('names the restart boundary and both built-in choices', () => {
    render(
      <DistributionProfileField
        definition={definition}
        value="standard"
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('option', {
        name: 'Standard — built-in and installed plugin layouts',
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole('option', { name: 'Minimal — no layout sources' }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Changes take effect after the next Station restart. This is project-layout configuration: it does not build or distribute Station, set the Registry URL, or fetch or execute declared remote sources.',
      ),
    ).toBeTruthy();
  });
});
