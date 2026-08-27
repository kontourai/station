/** @vitest-environment jsdom */

import {
  createDirectAnswerBasisPaneInstance,
  createSessionInventoryBasisPaneInstance,
  createTaskAnswerBasisPaneInstance,
  createWholeTaskBasisPaneInstance,
  WORKSPACE_BASIS_PANE_DESCRIPTOR,
} from '@kontourai/station-basis-pane/workspace-basis-pane';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { WorkspacePaneHostOpenContext } from '../WorkspacePaneHostOpenContext';

vi.mock('../ConnectedStationBasisPane', () => ({
  ConnectedStationBasisPane: ({ scope }: { scope: unknown }) => (
    <output data-testid="basis-scope">{JSON.stringify(scope)}</output>
  ),
}));
vi.mock('../ConnectedSessionInventory', () => ({
  ConnectedSessionInventory: ({ sessionId }: { sessionId: string }) => (
    <output data-testid="session-inventory">{sessionId}</output>
  ),
}));

const { BasisWorkspacePane } = await import('../BasisWorkspacePane');

describe('BasisWorkspacePane', () => {
  test.each([
    [
      createDirectAnswerBasisPaneInstance('project', 'session', 'turn'),
      'direct-answer',
    ],
    [
      createTaskAnswerBasisPaneInstance('project', 'task', 'answer'),
      'task-answer',
    ],
    [createWholeTaskBasisPaneInstance('project', 'task'), 'whole-task'],
  ])('mounts the exact canonical scope', (instance, kind) => {
    render(
      <BasisWorkspacePane
        descriptor={WORKSPACE_BASIS_PANE_DESCRIPTOR}
        instance={instance!}
      />,
    );
    expect(screen.getByTestId('basis-scope').textContent).toContain(
      `"kind":"${kind}"`,
    );
  });

  test('routes the exact Session occurrence to native inventory without portable MCP', async () => {
    render(
      <BasisWorkspacePane
        descriptor={WORKSPACE_BASIS_PANE_DESCRIPTOR}
        instance={
          createSessionInventoryBasisPaneInstance('project', 'session')!
        }
      />,
    );
    expect((await screen.findByTestId('session-inventory')).textContent).toBe(
      'session',
    );
    expect(screen.queryByRole('button', { name: /portable MCP/i })).toBeNull();
  });

  test('fails closed for a forged occurrence', () => {
    const instance = createWholeTaskBasisPaneInstance('project', 'task')!;
    render(
      <BasisWorkspacePane
        descriptor={WORKSPACE_BASIS_PANE_DESCRIPTOR}
        instance={{
          ...instance,
          stateKey: 'forged' as typeof instance.stateKey,
        }}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'identity is unavailable',
    );
  });

  test('issues the exact portable MCP App occurrence through the current host', () => {
    const open = vi.fn(() => true);
    const instance = createDirectAnswerBasisPaneInstance(
      'project-canonical',
      'session-a',
      'turn-a',
    )!;
    render(
      <WorkspacePaneHostOpenContext.Provider value={{ open }}>
        <BasisWorkspacePane
          descriptor={WORKSPACE_BASIS_PANE_DESCRIPTOR}
          instance={instance}
        />
      </WorkspacePaneHostOpenContext.Provider>,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Open portable MCP App' }),
    );
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        boundContext: expect.objectContaining({
          projectId: 'project-canonical',
          sessionId: 'session-a',
          turnId: 'turn-a',
        }),
      }),
    );
  });
});
