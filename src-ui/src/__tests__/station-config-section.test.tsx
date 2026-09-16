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

/**
 * #2144 slice 6 item A: `defaultApprovalMode` is the Station-scope layer
 * `resolveEffectiveApprovalMode` reads between the engine connection's own
 * default and the adapter default. Its precedence is pinned on the resolver
 * (`approvalMode.test.ts`); this pins the row that writes it.
 */
test('#2144 slice 6: the default approval mode row renders its effective value and round-trips', () => {
  const onChange = vi.fn();
  render(<StationConfigSection config={{}} onChange={onChange} />);
  const select = screen.getByRole('combobox', {
    name: 'Default approval mode',
  }) as HTMLSelectElement;
  // Nothing stored: the row shows the value that IS in force, which is
  // "defer to the connection", not a blank box.
  expect(select.value).toBe('connection-default');
  expect([...select.options].map((option) => option.value)).toEqual([
    'connection-default',
    'ask',
    'auto',
    'never',
  ]);
  fireEvent.change(select, { target: { value: 'ask' } });
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({ defaultApprovalMode: 'ask' }),
  );
});

test('#2144 slice 6: the row states who ignores it and when it applies', () => {
  render(<StationConfigSection config={{}} onChange={vi.fn()} />);
  // The conditions themselves, not a paraphrase: the two engines whose
  // adapters read `approvalMode` are named, so the row cannot imply a floor
  // Station does not impose on the others; Station-mode chats are named
  // because they keep a knob-capable connection id and still get nothing
  // (round 2 M2).
  expect(
    screen.getByText(/engines with no approval knob of their own/),
  ).toBeTruthy();
  expect(
    screen.getByText(/Chats that run on Station’s own engine/),
  ).toBeTruthy();
  // The WHEN, which is what makes the row's own promise checkable: it is
  // sent by whichever message starts a session — including a reopened or
  // exited conversation's next send — and never while one is running
  // (round 2 M3, corrected in round 3 F1).
  expect(
    screen.getByText(/sent whenever a message starts a session/),
  ).toBeTruthy();
  expect(screen.getByText(/never while one is running/)).toBeTruthy();
  // The queued-drain carve-out is part of the promise, not a footnote.
  expect(screen.getByText(/A queued follow-up never carries it/)).toBeTruthy();
});

test('#2144 slice 6: a stored value is what the row shows', () => {
  render(
    <StationConfigSection
      config={{ defaultApprovalMode: 'never' }}
      onChange={vi.fn()}
    />,
  );
  expect(
    (
      screen.getByRole('combobox', {
        name: 'Default approval mode',
      }) as HTMLSelectElement
    ).value,
  ).toBe('never');
});
