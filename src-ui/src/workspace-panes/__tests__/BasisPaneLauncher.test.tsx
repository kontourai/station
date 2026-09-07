/** @vitest-environment jsdom */

import { createDirectAnswerBasisPaneInstance } from '@kontourai/station-basis-pane/workspace-basis-pane';
import {
  parseWorkspacePaneInstance,
  type WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import type { WorkspacePaneHostDocumentV1 } from '@kontourai/station-contracts/workspace-pane-host';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { useBasisPaneLauncher } from '../BasisPaneLauncher';
import { readSessionInventorySelection } from '../sessionInventorySelection';
import { WorkspacePaneHost } from '../WorkspacePaneHost';
import { WorkspacePaneHostOpenContext } from '../WorkspacePaneHostOpenContext';
import {
  WORKSPACE_PANE_OPENED,
  workspacePaneOpenRefused,
} from '../workspacePaneHostOpenOutcome';

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

function ExistingPaneHarness() {
  const { openBasis, focusBasis, fallback } = useBasisPaneLauncher();
  const [focused, setFocused] = useState<boolean | null>(null);
  const instance = createDirectAnswerBasisPaneInstance(
    'project',
    'session',
    'turn',
  )!;
  return (
    <>
      <button
        type="button"
        onClick={(event) =>
          openBasis(
            instance,
            { kind: 'direct-answer', sessionId: 'session', turnId: 'turn' },
            event.currentTarget,
          )
        }
      >
        Open existing
      </button>
      <button type="button" onClick={() => setFocused(focusBasis(instance))}>
        Focus existing
      </button>
      {focused !== null ? <output>{String(focused)}</output> : null}
      {fallback}
    </>
  );
}

const nestedBasisInstance = createDirectAnswerBasisPaneInstance(
  'project',
  'session',
  'turn',
)!;
const nestedSourceInstance = parseWorkspacePaneInstance({
  version: '1.0',
  descriptorId: 'Launcher source',
  instanceId: 'launcher-source',
  stateKey: 'launcher-source',
})!;
const nestedHostDocument: WorkspacePaneHostDocumentV1 = {
  version: '1.1',
  id: 'basis-launcher-nested',
  scope: { kind: 'project', projectId: 'project', layoutId: 'layout' },
  instances: [nestedSourceInstance, nestedBasisInstance],
  activeInstanceId: nestedSourceInstance.instanceId,
  root: {
    type: 'tabs',
    id: 'root',
    instanceIds: [
      nestedSourceInstance.instanceId,
      nestedBasisInstance.instanceId,
    ],
    selectedInstanceId: nestedSourceInstance.instanceId,
  },
};

function NestedHostLauncher() {
  const { openBasis, fallback } = useBasisPaneLauncher();
  return (
    <>
      <button
        type="button"
        onClick={(event) =>
          openBasis(
            nestedBasisInstance,
            { kind: 'direct-answer', sessionId: 'session', turnId: 'turn' },
            event.currentTarget,
          )
        }
      >
        Open duplicate Basis
      </button>
      {fallback}
    </>
  );
}

describe('Basis Pane launcher', () => {
  test('uses the Workspace Pane host when available', () => {
    const open = vi.fn(() => WORKSPACE_PANE_OPENED);
    render(
      <WorkspacePaneHostOpenContext.Provider value={{ open }}>
        <Harness />
      </WorkspacePaneHostOpenContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(open).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('focuses an existing host pane before attempting a new open', () => {
    const open = vi.fn(() => workspacePaneOpenRefused('refused'));
    const focusExisting = vi.fn(() => true);
    render(
      <WorkspacePaneHostOpenContext.Provider value={{ open, focusExisting }}>
        <ExistingPaneHarness />
      </WorkspacePaneHostOpenContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open existing' }));
    fireEvent.click(screen.getByRole('button', { name: 'Focus existing' }));

    expect(open).not.toHaveBeenCalled();
    expect(focusExisting).toHaveBeenCalledTimes(2);
    expect(screen.getByText('true')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('a nested real host selects an existing deterministic Basis pane without fallback', async () => {
    const onDocumentChange = vi.fn();
    render(
      <WorkspacePaneHost
        document={nestedHostDocument}
        lockManager={{
          request: async (_name, _options, callback) => callback({}),
        }}
        onDocumentChange={onDocumentChange}
        renderPane={(instance: WorkspacePaneInstance) =>
          instance.instanceId === nestedSourceInstance.instanceId ? (
            <NestedHostLauncher />
          ) : (
            <p>Existing Basis pane</p>
          )
        }
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Open duplicate Basis' }),
      ).toBeTruthy(),
    );
    onDocumentChange.mockClear();

    fireEvent.click(
      screen.getByRole('button', { name: 'Open duplicate Basis' }),
    );

    await waitFor(() =>
      expect(onDocumentChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          activeInstanceId: nestedBasisInstance.instanceId,
        }),
      ),
    );
    expect(screen.getByText('Existing Basis pane')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Basis' })).toBeNull();
  });

  test('uses the same renderer in a dismissible responsive fallback', async () => {
    const { container } = render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Basis' });
    expect(dialog).toBeTruthy();
    expect(dialog.classList.contains('station-dialog')).toBe(true);
    expect(dialog.classList.contains('station-dialog--lg')).toBe(true);
    expect(
      dialog.parentElement?.classList.contains('station-dialog__overlay'),
    ).toBe(true);
    expect(container.contains(dialog)).toBe(false);
    expect(dialog.parentElement?.parentElement).toBe(document.body);
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
    const open = vi.fn(() => WORKSPACE_PANE_OPENED);
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
