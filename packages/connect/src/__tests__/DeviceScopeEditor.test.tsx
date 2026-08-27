/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import {
  closestBasePreset,
  DeviceScopeEditor,
  scopeSelectionTokens,
} from '../react/connection-manager-modal/DeviceScopeEditor';

/**
 * station#3816. A device's access was fixed at pairing time — the only
 * mutation was revoking the whole device, so narrowing meant unpairing and
 * starting over.
 *
 * The model these pin: the base ladder is ORCHESTRATION access (with a real
 * "none" rung), and everything that composes freely with it — fleet
 * inference, and the two operator-promotion grants — is a capability. An
 * earlier version modelled inference as a base rung, which made valid MIXED
 * scopes unrepresentable and silently dropped tokens on Apply.
 */

function openEditor(currentScope: string, onApply = vi.fn()) {
  render(
    <DeviceScopeEditor
      deviceName="Phone"
      currentScope={currentScope}
      busy={false}
      onApply={onApply}
      onCancel={vi.fn()}
    />,
  );
  return onApply;
}

const apply = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

test('initialises from the device’s CURRENT scope, base and capabilities alike', () => {
  openEditor(
    'orchestration:read orchestration:operate terminal:operate consent:decide',
  );
  expect(
    (screen.getByRole('radio', { name: /Standard/ }) as HTMLInputElement)
      .checked,
  ).toBe(true);
  expect(
    (
      screen.getByRole('checkbox', {
        name: /Decide consent requests/,
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
  expect(
    (
      screen.getByRole('checkbox', {
        name: /Approve pairing requests/,
      }) as HTMLInputElement
    ).checked,
  ).toBe(false);
});

test('narrowing to read-only applies exactly the read-only tokens, with the scope it was opened against', () => {
  const onApply = openEditor(
    'orchestration:read orchestration:operate terminal:operate',
  );
  fireEvent.click(screen.getByRole('radio', { name: /Read-only/ }));
  apply();
  expect(onApply).toHaveBeenCalledWith(
    ['orchestration:read'],
    'orchestration:read orchestration:operate terminal:operate',
  );
});

test('a MIXED inference scope survives an unrelated edit (review MEDIUM)', () => {
  // `orchestration:read inference:invoke` is a scope the server accepts.
  // Modelling inference as a base rung made this initialise as Read-only and
  // drop inference on Apply — a capability lost to an edit that never
  // mentioned it.
  const onApply = openEditor('orchestration:read inference:invoke');
  expect(
    (
      screen.getByRole('checkbox', {
        name: /Fleet inference/,
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
  fireEvent.click(screen.getByRole('radio', { name: /Delegation/ }));
  apply();
  expect(onApply).toHaveBeenCalledWith(
    ['orchestration:read', 'orchestration:operate', 'inference:invoke'],
    'orchestration:read inference:invoke',
  );
});

test('a pure fleet-inference device holds no orchestration access, and keeps it that way', () => {
  const onApply = openEditor('inference:invoke');
  expect(
    (screen.getByRole('radio', { name: /No work access/ }) as HTMLInputElement)
      .checked,
  ).toBe(true);
  apply();
  expect(onApply).toHaveBeenCalledWith(
    ['inference:invoke'],
    'inference:invoke',
  );
});

test('promotion is a deliberate switch on top of the base', () => {
  const onApply = openEditor('orchestration:read');
  fireEvent.click(
    screen.getByRole('checkbox', { name: /Decide consent requests/ }),
  );
  apply();
  expect(onApply).toHaveBeenCalledWith(
    ['orchestration:read', 'consent:decide'],
    'orchestration:read',
  );
});

test('an empty selection cannot be applied — revoking is the control for no access', () => {
  openEditor('orchestration:read');
  fireEvent.click(screen.getByRole('radio', { name: /No work access/ }));
  expect(
    (screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test('the irreversible-loss notice names what is actually lost (review MEDIUM)', () => {
  openEditor(
    'orchestration:read orchestration:operate terminal:operate access:manage',
  );
  // "device management access" was wrong — a paired device is refused the
  // pairing family regardless. The notice must name the surfaces the token
  // really gates, or it asks for a decision the reader cannot make.
  expect(screen.getByText(/telemetry disclosure/)).toBeTruthy();
  expect(screen.getByText(/credential recovery/)).toBeTruthy();
  expect(screen.getByText(/there is no way to grant it back/)).toBeTruthy();
});

test('a device without access:manage sees no such notice', () => {
  openEditor('orchestration:read');
  expect(screen.queryByText(/no way to grant it back/)).toBeNull();
});

test('the derivations agree with the contracts vocabulary', () => {
  expect(closestBasePreset('orchestration:read')).toBe('read-only');
  expect(closestBasePreset('orchestration:read orchestration:operate')).toBe(
    'delegation',
  );
  expect(
    closestBasePreset(
      'orchestration:read orchestration:operate terminal:operate',
    ),
  ).toBe('standard');
  // No orchestration access, and an unparseable legacy scope, both resolve
  // to the none rung — never the widest, which would make the first Apply a
  // silent widening.
  expect(closestBasePreset('inference:invoke')).toBeNull();
  expect(closestBasePreset('legacy-unparseable')).toBeNull();

  expect(
    scopeSelectionTokens('delegation', new Set(['access:approve'])),
  ).toEqual(['orchestration:read', 'orchestration:operate', 'access:approve']);
  expect(scopeSelectionTokens(null, new Set())).toEqual([]);
});
