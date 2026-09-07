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

/**
 * #1582 D9: "Terminal shell" rendered as an empty box with no placeholder and
 * no current value, so the field said nothing about what a terminal would
 * actually start. Its default is a property of the HOST — `SHELL`, or a
 * platform fallback, or a Windows path — so it cannot be written into the
 * settings registry; the server derives it from the resolver a spawn walks and
 * reports it on `GET /api/config/app`. This asserts the whole wiring through
 * the real section: the reported value becomes the input's hint.
 */
test('#1582 D9: the terminal shell input shows the host default this server reported', () => {
  render(
    <StationConfigSection
      config={{ defaultTerminalShell: '/opt/homebrew/bin/fish' }}
      onChange={vi.fn()}
    />,
  );
  const input = screen.getByRole('textbox', { name: 'Terminal shell' });
  expect(input.getAttribute('placeholder')).toBe('/opt/homebrew/bin/fish');
  // The field itself stays empty: an empty input honestly reads "no override
  // recorded", which is what the DEFAULT chip beside it is about.
  expect((input as HTMLInputElement).value).toBe('');
});

test('#1582 D9: an override is the value, and the host default stays the hint', () => {
  render(
    <StationConfigSection
      config={{
        terminalShell: '/usr/bin/nu',
        defaultTerminalShell: '/opt/homebrew/bin/fish',
      }}
      onChange={vi.fn()}
    />,
  );
  const input = screen.getByRole('textbox', { name: 'Terminal shell' });
  expect((input as HTMLInputElement).value).toBe('/usr/bin/nu');
  expect(input.getAttribute('placeholder')).toBe('/opt/homebrew/bin/fish');
});

test('#1582 D9: a server that reports no default leaves the hint absent rather than guessing', () => {
  render(<StationConfigSection config={{}} onChange={vi.fn()} />);
  const input = screen.getByRole('textbox', { name: 'Terminal shell' });
  expect(input.getAttribute('placeholder')).toBeNull();
});

test('#1582 D9: a field with no host default keeps its registry placeholder', () => {
  // The runtime hint must not become a global override of the static ones.
  render(
    <StationConfigSection
      config={{ defaultTerminalShell: '/opt/homebrew/bin/fish' }}
      onChange={vi.fn()}
    />,
  );
  const registryUrl = screen.getByRole('textbox', { name: 'Registry URL' });
  expect(registryUrl.getAttribute('placeholder')).not.toBe(
    '/opt/homebrew/bin/fish',
  );
});
