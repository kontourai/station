/** @vitest-environment jsdom */

import {
  PAIRING_SCOPE_GRANT_PATHS,
  PAIRING_SCOPES,
} from '@kontourai/station-contracts/environment-security';
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
 * inference, home transfer, and the operator-promotion grants (pairing
 * approval, consent, engine sign-in) — is a capability. An
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

test('a home-transfer scope survives an unrelated orchestration edit', () => {
  const onApply = openEditor('orchestration:read home:transfer');
  expect(
    (
      screen.getByRole('checkbox', {
        name: /Home transfer/,
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);

  fireEvent.click(screen.getByRole('radio', { name: /Delegation/ }));
  apply();
  expect(onApply).toHaveBeenCalledWith(
    ['orchestration:read', 'orchestration:operate', 'home:transfer'],
    'orchestration:read home:transfer',
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
  expect(closestBasePreset('home:transfer')).toBeNull();
  expect(closestBasePreset('legacy-unparseable')).toBeNull();

  expect(
    scopeSelectionTokens('delegation', new Set(['access:approve'])),
  ).toEqual(['orchestration:read', 'orchestration:operate', 'access:approve']);
  expect(scopeSelectionTokens(null, new Set())).toEqual([]);
  expect(scopeSelectionTokens(null, new Set(['home:transfer']))).toEqual([
    'home:transfer',
  ]);
});

test('an operator can grant engine sign-in, and it is marked elevated', () => {
  const standard = 'orchestration:read orchestration:operate terminal:operate';
  const onApply = openEditor(standard);
  const toggle = screen.getByRole('checkbox', {
    name: /Start engine sign-in/,
  }) as HTMLInputElement;

  expect(toggle.checked).toBe(false);
  expect(toggle.closest('label')?.textContent).toContain('Elevated');

  fireEvent.click(toggle);
  apply();

  expect(onApply).toHaveBeenCalledWith(
    [
      'orchestration:read',
      'orchestration:operate',
      'terminal:operate',
      'engine:login',
    ],
    standard,
  );
});

test('an engine sign-in grant survives an unrelated base edit', () => {
  const onApply = openEditor(
    'orchestration:read orchestration:operate terminal:operate engine:login',
  );
  expect(
    (
      screen.getByRole('checkbox', {
        name: /Start engine sign-in/,
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);

  fireEvent.click(screen.getByRole('radio', { name: /Delegation/ }));
  apply();

  expect(onApply.mock.calls[0][0]).toEqual([
    'orchestration:read',
    'orchestration:operate',
    'engine:login',
  ]);
});

/*
 * The editor offers operator-promotion grants from a hand-written list, and the
 * contracts vocabulary grows independently of it. When `engine:login` joined
 * the contracts with `operator-promotion` as its only grant path, this editor
 * silently could not grant it and no test noticed, so the capability was
 * unreachable from the product. Compared as sets through the editor's own
 * selection derivation, so a token missing from the list is a failure here.
 */
test('every operator-promotion token in the contracts is offered by the editor', () => {
  const promotionTokens = PAIRING_SCOPES.filter((token) =>
    PAIRING_SCOPE_GRANT_PATHS[token].includes('operator-promotion'),
  );
  expect(promotionTokens.length).toBeGreaterThan(0);

  const offered = scopeSelectionTokens(null, new Set(promotionTokens));

  expect([...offered].sort()).toEqual([...promotionTokens].sort());
});
