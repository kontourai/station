// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { type ComponentProps, useRef } from 'react';
import { afterEach, expect, test } from 'vitest';
import { ComposerModeSheet } from '../components/badges/ComposerModeSheet';
import { DialogHistoryHostBoundary } from '../components/DialogHistoryHost';
import { AccountPreferencesContext } from '../contexts/AccountPreferencesContext';

afterEach(cleanup);

const account: ComponentProps<
  typeof AccountPreferencesContext.Provider
>['value'] = {
  status: 'account',
  saving: false,
  waitingForConnection: false,
  error: false,
  conflict: false,
  save() {},
  retry() {},
};

function Host({ engineConnectionId }: { engineConnectionId: string | null }) {
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={trigger} type="button">
        Approval
      </button>
      <ComposerModeSheet
        triggerRef={trigger}
        effectiveMode="ask"
        engineConnectionId={engineConnectionId}
        onClose={() => {}}
        onSelect={() => {}}
        sourceNote="Only this chat"
        isNewSession
      />
    </>
  );
}

function renderSheet(engineConnectionId: string | null) {
  render(
    <DialogHistoryHostBoundary>
      <AccountPreferencesContext.Provider value={account}>
        <Host engineConnectionId={engineConnectionId} />
      </AccountPreferencesContext.Provider>
    </DialogHistoryHostBoundary>,
  );
}

test.each([
  ['codex', 'Save as my Codex default'],
  ['', 'Save as my engine default'],
  [null, 'Save as my engine default'],
])('names the engine %j in the save-as-default label (#4390)', (id, label) => {
  renderSheet(id);
  expect(
    screen
      .getByRole('checkbox')
      .closest('label')
      ?.textContent?.replace(/\s+/g, ' ')
      .trim(),
  ).toBe(label);
});
