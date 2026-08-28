/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
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
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
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
