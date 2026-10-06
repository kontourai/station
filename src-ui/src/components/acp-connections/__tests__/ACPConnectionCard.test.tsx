/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import {
  openOverflow,
  overflowItems,
} from '../../../__tests__/helpers/overflow-menu';
import type { ACPConnectionInfo } from '../../../hooks/useACPConnections';
import { ACPConnectionCard } from '../ACPConnectionCard';

const connection: ACPConnectionInfo = {
  id: 'kiro',
  name: 'Kiro CLI',
  command: 'kiro-cli',
  args: ['--acp'],
  enabled: true,
  status: 'available',
  modes: [],
  sessionId: null,
  mcpServers: [],
  currentModel: null,
  source: 'user',
};

function renderCard() {
  const onClick = vi.fn();
  const onRemove = vi.fn();
  render(
    <ACPConnectionCard
      conn={connection}
      agents={[]}
      onClick={onClick}
      onToggle={vi.fn()}
      onRemove={onRemove}
      onReconnect={vi.fn()}
    />,
  );
  // #3045: Remove is a menu row, not a button on the card.
  expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Manage Kiro CLI' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }));
  const dialog = screen.getByRole('dialog');
  expect(
    within(dialog).getByRole('heading', { name: 'Remove Connection' }),
  ).toBeTruthy();
  onClick.mockClear();
  return { onClick, onRemove, dialog };
}

/**
 * archive#1111: the card puts `onClick` on its root `<div>` and renders the
 * confirm dialog inside it. The dialog portals to `document.body`, but React
 * synthetic events follow the React tree, so backing out of "remove this
 * connection" used to select the connection the user had just decided to keep.
 */
test('dismissing the remove confirm does not select the connection', () => {
  const { onClick, onRemove } = renderCard();

  const overlay = document.querySelector('.station-dialog__overlay');
  expect(overlay).not.toBeNull();
  fireEvent.pointerDown(overlay!);
  fireEvent.click(overlay!);

  expect(screen.queryByRole('dialog')).toBeNull();
  expect(onRemove).not.toHaveBeenCalled();
  expect(onClick).not.toHaveBeenCalled();
});

// Review M3: the card's two standing commands are folded (#3045). Both are
// present and destructive, and Disable still confirms before it toggles.
//
// What is NOT tested here: that dismissing the menu does not select the
// connection. The card's `onClick` is on a sibling button, not an ancestor of
// the menu, so there is no click-through for this card to have; the general
// case — a menu inside a clickable host — is covered by ActionRow.test.tsx.
test('the card menu holds a destructive Disable and Remove, and Disable confirms', () => {
  const onToggle = vi.fn();
  render(
    <ACPConnectionCard
      conn={connection}
      agents={[]}
      onClick={vi.fn()}
      onToggle={onToggle}
      onRemove={vi.fn()}
      onReconnect={vi.fn()}
    />,
  );

  // Ready recommends nothing, so the menu is the card's one labelled action:
  // a word beside the glyph, and a name that contains that word.
  const trigger = screen.getByRole('button', { name: 'Manage Kiro CLI' });
  expect(trigger.textContent).toContain('Manage');

  expect(overflowItems(openOverflow('Manage Kiro CLI'))).toEqual([
    { name: 'Disable', danger: true },
    { name: 'Remove', danger: true },
  ]);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Disable' }));
  expect(onToggle).not.toHaveBeenCalled();
  const dialog = screen.getByRole('dialog');
  expect(
    within(dialog).getByRole('heading', { name: 'Disable Connection' }),
  ).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Disable' }));
  expect(onToggle).toHaveBeenCalledWith(false);
});

test('a card with a recommended action keeps the bare ⋯ beside it', () => {
  render(
    <ACPConnectionCard
      conn={{ ...connection, enabled: false }}
      agents={[]}
      onClick={vi.fn()}
      onToggle={vi.fn()}
      onRemove={vi.fn()}
      onReconnect={vi.fn()}
    />,
  );
  expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Manage Kiro CLI' }).textContent,
  ).toBe('⋯');
  // A disabled connection has nothing to disable.
  expect(overflowItems(openOverflow('Manage Kiro CLI'))).toEqual([
    { name: 'Remove', danger: true },
  ]);
});

test('confirming the remove does not also select the connection', () => {
  const { onClick, onRemove, dialog } = renderCard();

  fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));

  expect(onRemove).toHaveBeenCalledTimes(1);
  expect(onClick).not.toHaveBeenCalled();
});

test('hides raw command details until Advanced is opened', () => {
  render(
    <ACPConnectionCard
      conn={connection}
      agents={[]}
      onClick={vi.fn()}
      onToggle={vi.fn()}
      onRemove={vi.fn()}
      onReconnect={vi.fn()}
    />,
  );

  expect(screen.getByText('Ready')).toBeTruthy();
  const advanced = screen.getByText('Advanced').closest('details');
  expect(advanced).not.toBeNull();
  expect((advanced as HTMLDetailsElement).open).toBe(false);
  expect(within(advanced!).getByText('kiro-cli --acp')).toBeTruthy();

  fireEvent.click(screen.getByText('Advanced'));

  expect((advanced as HTMLDetailsElement).open).toBe(true);
});

test.each([
  ['available', true, 'Ready', null],
  ['probing', true, 'Checking', null],
  ['unavailable', true, 'Setup needed', null],
  ['error', true, 'Unavailable', 'Reconnect'],
  ['available', false, 'Off', 'Enable'],
] as const)(
  'renders one readiness label and action for %s / enabled=%s',
  (status, enabled, label, action) => {
    render(
      <ACPConnectionCard
        conn={{ ...connection, status, enabled }}
        agents={[]}
        onClick={vi.fn()}
        onToggle={vi.fn()}
        onRemove={vi.fn()}
        onReconnect={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('status', { name: `Readiness: ${label}` }),
    ).toBeTruthy();
    expect(screen.queryByText('Disabled')).toBeNull();
    expect(screen.queryByText('App missing')).toBeNull();
    expect(screen.queryByText('Connection failed')).toBeNull();
    expect(screen.queryByText('Disconnected')).toBeNull();
    if (action === 'Enable') {
      expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy();
    } else {
      expect(screen.queryByRole('button', { name: 'Enable' })).toBeNull();
    }
    if (action === 'Reconnect') {
      expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
    } else {
      expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
    }
  },
);

test('keeps plugin-provided engines inspectable without unsupported mutations', () => {
  render(
    <ACPConnectionCard
      conn={{ ...connection, source: 'plugin', status: 'error' }}
      agents={[]}
      onClick={vi.fn()}
      onToggle={vi.fn()}
      onRemove={vi.fn()}
      onReconnect={vi.fn()}
    />,
  );

  expect(screen.getByText('Provided by plugin')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Enable' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Disable' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Open Kiro CLI connection details' }),
  ).toBeTruthy();
});
