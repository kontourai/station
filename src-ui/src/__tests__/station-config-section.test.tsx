/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

vi.mock('../views/settings/composite-editors', () => ({
  CUSTOM_ROW_RENDERERS: {},
  DEFERRED_COMPOSITE_KEYS: ['approvalGuardian', 'distributionProfile'],
}));

import {
  STATION_SETTING_KEYS_BY_SECTION,
  StationConfigSection,
} from '../views/settings/StationConfigSection';
import { SETTINGS_CATALOG } from '../views/settings/settings-catalog';

/**
 * Every key the single "Station configuration" card rendered before #2182
 * dissolved it, in the order it rendered them.
 *
 * Pinned as a literal because the split is only safe if it is exhaustive: a
 * key left out of every section's list disappears from Settings entirely, and
 * nothing else would have said so — the catalog would still carry its row,
 * the 54-row count would be unchanged, and the deep link would open a card
 * the control is not on.
 */
const KEYS_THE_DISSOLVED_CARD_RENDERED = [
  'approvalGuardian',
  'telemetryEnabled',
  'defaultMaxTurns',
  'defaultMaxOutputTokens',
  'defaultChatFontSize',
  'terminalShell',
  'mcpUiHost',
  'surfaceTrustFromVeritasEvidence',
  'disableDefaultSkillRegistries',
  'workspaceCheckpoints',
  'defaultWorkspaceIsolation',
  'defaultApprovalMode',
  'registryUrl',
  'distributionProfile',
  'builtinAgentEngineConnectionId',
] as const;

test('#2182: the split renders every key the one card used to, and no other', () => {
  const rendered = Object.values(STATION_SETTING_KEYS_BY_SECTION).flatMap(
    (keys) => [...keys],
  );
  expect(new Set(rendered).size).toBe(rendered.length);
  expect([...rendered].sort()).toEqual(
    [...KEYS_THE_DISSOLVED_CARD_RENDERED].sort(),
  );
});

test('#2182: a key renders under the section its deep link names', () => {
  const sectionForKey = new Map(
    SETTINGS_CATALOG.filter((entry) => entry.configKeys?.length).map(
      (entry) => [entry.configKeys?.[0] as string, entry.section],
    ),
  );
  const disagreements = Object.entries(STATION_SETTING_KEYS_BY_SECTION)
    .flatMap(([section, keys]) =>
      [...keys].map((key) => ({
        section,
        key,
        catalog: sectionForKey.get(key),
      })),
    )
    .filter((row) => row.catalog !== row.section)
    .map(
      (row) =>
        `${row.key}: rendered in ${row.section}, catalog says ${row.catalog}`,
    );
  // A row rendered in one card while `?view=` names another sends a reader
  // who follows the link to a card the control is not on, with no error.
  expect(disagreements).toEqual([]);
});

test('USAGE TELEMETRY SETTINGS DEFECT: the registry-backed toggle renders and round-trips', () => {
  const onChange = vi.fn();
  render(
    <StationConfigSection
      containerScope="station"
      section="telemetry"
      config={{}}
      onChange={onChange}
    />,
  );
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
      containerScope="station"
      section="host-runtime"
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
      containerScope="station"
      section="host-runtime"
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
  render(
    <StationConfigSection
      containerScope="station"
      section="host-runtime"
      config={{}}
      onChange={vi.fn()}
    />,
  );
  const input = screen.getByRole('textbox', { name: 'Terminal shell' });
  expect(input.getAttribute('placeholder')).toBeNull();
});

test('#1582 D9: a field with no host default keeps its registry placeholder', () => {
  // The runtime hint must not become a global override of the static ones.
  // Registry URL is in a DIFFERENT section from the shell since #2182, and
  // the host default is still supplied here: a hint that leaked would leak
  // across the split too.
  render(
    <StationConfigSection
      containerScope="station"
      section="sources"
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
  render(
    <StationConfigSection
      containerScope="station"
      section="permissions"
      config={{}}
      onChange={onChange}
    />,
  );
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
  render(
    <StationConfigSection
      containerScope="station"
      section="permissions"
      config={{}}
      onChange={vi.fn()}
    />,
  );
  // The conditions themselves, not a paraphrase. WHEN it applies is the
  // row's checkable promise: since #2436 the server applies it at EVERY
  // session start, unattended ones included (owner decision), and never to a
  // running session. Full access here reaching webhooks, Discord, schedules
  // and delegations must be said where the operator chooses it.
  expect(
    screen.getByText(/Applied when any session starts, including unattended/),
  ).toBeTruthy();
  expect(
    screen.getByText(/webhooks, Discord, scheduled jobs, delegations/),
  ).toBeTruthy();
  expect(
    screen.getByText(/Never applied to a session already running/),
  ).toBeTruthy();
  // Who it does nothing for: Station's own engine (it keeps a knob-capable
  // connection id and renders no approval control) and every engine whose
  // adapter has no knob.
  expect(screen.getByText(/Chats on Station\u2019s own engine/)).toBeTruthy();
  expect(
    screen.getByText(/engines without an approval knob, ignore it/),
  ).toBeTruthy();
});

test('#2144 slice 6: a stored value is what the row shows', () => {
  render(
    <StationConfigSection
      containerScope="station"
      section="permissions"
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
