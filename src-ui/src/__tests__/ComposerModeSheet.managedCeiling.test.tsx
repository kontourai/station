// @vitest-environment jsdom
/**
 * #4518: under the machine's managed approval ceiling the picker disables
 * the modes above it and says whose policy limits them.
 */
import type { ManagedPolicySummary } from '@kontourai/station-contracts/managed-policy';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { ComposerModeSheet } from '../components/badges/ComposerModeSheet';
import { DialogHistoryHostBoundary } from '../components/DialogHistoryHost';
import { ManagedPolicyContext } from '../contexts/ManagedPolicyContext';

afterEach(cleanup);

const summary = (maxApprovalMode?: 'ask' | 'auto' | 'never') =>
  ({
    organization: 'Acme',
    supportUrl: 'https://help.acme.example',
    lockedSettings: [],
    limits: maxApprovalMode ? { maxApprovalMode } : {},
  }) satisfies ManagedPolicySummary;

function Host({ onSelect }: { onSelect: (mode: string) => void }) {
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={trigger} type="button">
        Approval
      </button>
      <ComposerModeSheet
        triggerRef={trigger}
        effectiveMode="ask"
        engineConnectionId="codex"
        onClose={() => {}}
        onSelect={onSelect}
        sourceNote="Only this chat"
      />
    </>
  );
}

function renderSheet(policy: ManagedPolicySummary | undefined) {
  const onSelect = vi.fn();
  render(
    <DialogHistoryHostBoundary>
      <ManagedPolicyContext.Provider value={policy}>
        <Host onSelect={onSelect} />
      </ManagedPolicyContext.Provider>
    </DialogHistoryHostBoundary>,
  );
  const radio = (value: string) =>
    screen
      .getAllByRole('radio')
      .find((input) => (input as HTMLInputElement).value === value) as
      | HTMLInputElement
      | undefined;
  return { onSelect, radio };
}

test('a ceiling of Ask disables Auto and Full access and names the organization', () => {
  const { onSelect, radio } = renderSheet(summary('ask'));
  expect(radio('ask')?.disabled).toBe(false);
  expect(radio('connection-default')?.disabled).toBe(false);
  expect(radio('auto')?.disabled).toBe(true);
  expect(radio('never')?.disabled).toBe(true);
  expect(
    screen.getByText(
      "Acme's policy manages approval modes: the broadest allowed is Ask first. For help, visit https://help.acme.example",
    ),
  ).toBeTruthy();
  expect(screen.getAllByText('Managed')).toHaveLength(2);
  fireEvent.click(radio('auto')!);
  expect(onSelect).not.toHaveBeenCalled();
});

test('a ceiling of Auto leaves Auto and disables only Full access', () => {
  const { radio } = renderSheet(summary('auto'));
  expect(radio('auto')?.disabled).toBe(false);
  expect(radio('never')?.disabled).toBe(true);
});

test('without a ceiling (no policy, none set, or never) nothing is disabled or explained', () => {
  for (const policy of [undefined, summary(), summary('never')]) {
    const { radio } = renderSheet(policy);
    for (const mode of ['connection-default', 'ask', 'auto', 'never'])
      expect(radio(mode)?.disabled).toBe(false);
    expect(screen.queryByText(/policy manages approval modes/)).toBeNull();
    cleanup();
  }
});
