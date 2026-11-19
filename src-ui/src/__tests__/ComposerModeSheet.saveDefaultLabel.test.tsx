// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { type ComponentProps, useRef } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { ComposerModeSheet } from '../components/badges/ComposerModeSheet';
import { DialogHistoryHostBoundary } from '../components/DialogHistoryHost';
import { AccountPreferencesContext } from '../contexts/AccountPreferencesContext';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const account: ComponentProps<
  typeof AccountPreferencesContext.Provider
>['value'] = {
  status: 'account',
  saving: false,
  retrying: false,
  waitingForConnection: false,
  error: false,
  conflict: false,
  save: vi.fn(),
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

test('uses the product name and saves a supported approval default', () => {
  renderSheet('codex');
  fireEvent.click(
    screen.getByRole('checkbox', { name: 'Save as my Codex default' }),
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Save current mode as my default' }),
  );
  expect(account.save).toHaveBeenCalledWith({
    interactiveApprovalModes: { codex: 'ask' },
  });
});

test.each(['opencode', '', null])(
  'does not offer an approval default for %j',
  (id) => {
    renderSheet(id);
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /^Auto/ }));
    expect(account.save).not.toHaveBeenCalled();
  },
);
