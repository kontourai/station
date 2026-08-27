/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

vi.mock('../views/settings/composite-editors', () => ({
  CUSTOM_ROW_RENDERERS: {},
  DEFERRED_COMPOSITE_KEYS: ['approvalGuardian', 'distributionProfile'],
}));

import { StationConfigSection } from '../views/settings/StationConfigSection';

test('USAGE TELEMETRY SETTINGS DEFECT: the registry-backed toggle renders and round-trips', () => {
  const onChange = vi.fn();
  render(<StationConfigSection config={{}} onChange={onChange} />);
  const toggle = screen.getByRole('switch', { name: 'Usage telemetry' });
  expect(
    toggle.getAttribute('aria-checked'),
    'Usage telemetry toggle did not render as its default-on value',
  ).toBe('true');
  fireEvent.click(toggle);
  expect(
    onChange,
    'Usage telemetry toggle did not update app config',
  ).toHaveBeenCalledWith(expect.objectContaining({ telemetryEnabled: false }));
});
