/** @vitest-environment jsdom */

import { createDirectAnswerBasisPaneInstance } from '@kontourai/station-basis-pane/workspace-basis-pane';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { useBasisPaneLauncher } from '../BasisPaneLauncher';
import { readSessionInventorySelection } from '../sessionInventorySelection';
import { WorkspacePaneHostOpenContext } from '../WorkspacePaneHostOpenContext';

const authority = {
  apiBase: 'http://station.test',
  authorityKey: 'basis-launcher-test',
  isCurrent: () => true,
};

vi.mock('../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => authority,
}));

vi.mock('../BasisPaneFallbackContent', () => ({
  ConnectedBasisFallbackPane: ({
    scope,
  }: {
    scope: { kind: string; sessionId?: string };
  }) =>
    scope.kind === 'session-inventory' ? (
      <div>Session renderer {scope.sessionId}</div>
    ) : (
      <div>Shared Basis renderer</div>
    ),
}));

function Harness() {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const { openBasis, fallback } = useBasisPaneLauncher();
  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={(event) =>
          openBasis(
            createDirectAnswerBasisPaneInstance('project', 'session', 'turn'),
            { kind: 'direct-answer', sessionId: 'session', turnId: 'turn' },
            event.currentTarget,
          )
        }
      >
        Open
      </button>
      {fallback}
    </>
  );
}

function SessionHarness() {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const { openBasis, fallback } = useBasisPaneLauncher();
  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={(event) =>
          openBasis(
            null,
            { kind: 'session-inventory', sessionId: 'session' },
            event.currentTarget,
          )
        }
      >
        Open Session
      </button>
      {fallback}
    </>
  );
}

describe('Basis Pane launcher', () => {
  test('uses the Workspace Pane host when available', () => {
    const open = vi.fn(() => true);
    render(
      <WorkspacePaneHostOpenContext.Provider value={{ open }}>
        <Harness />
      </WorkspacePaneHostOpenContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(open).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('uses the same renderer in a dismissible responsive fallback', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Basis' })).toBeTruthy();
    expect(await screen.findByText('Shared Basis renderer')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test('uses the native Session renderer when no Workspace Pane host opens it', async () => {
    render(<SessionHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Session' }));
    expect(await screen.findByText('Session renderer session')).toBeTruthy();
    expect(screen.queryByText('Shared Basis renderer')).toBeNull();
  });

  test('prepares an exact Session scope before synchronous host admission', () => {
    const open = vi.fn(() => true);
    function ExactScopeHarness() {
      const { openBasis } = useBasisPaneLauncher();
      return (
        <button
          type="button"
          onClick={(event) =>
            openBasis(
              createDirectAnswerBasisPaneInstance('project', 'session', 'turn'),
              {
                kind: 'session-inventory',
                sessionId: 'session',
                initialScope: {
                  kind: 'current-answer',
                  sessionId: 'session',
                  turnId: 'turn',
                },
              },
              event.currentTarget,
            )
          }
        >
          Open exact
        </button>
      );
    }
    render(
      <WorkspacePaneHostOpenContext.Provider value={{ open }}>
        <ExactScopeHarness />
      </WorkspacePaneHostOpenContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open exact' }));
    expect(open).toHaveBeenCalledOnce();
    expect(
      readSessionInventorySelection({ ...authority, sessionId: 'session' }),
    ).toMatchObject({ scope: { kind: 'current-answer', turnId: 'turn' } });
  });
});
