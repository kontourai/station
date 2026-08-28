/** @vitest-environment jsdom */

import {
  createWorkspaceCodingDiffPaneInstance,
  createWorkspaceCodingFileBrowserPaneInstance,
  createWorkspaceCodingTerminalPaneInstance,
  WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR,
  WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR,
  WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR,
} from '@kontourai/station-contracts/workspace-coding-panels';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

/**
 * Review, sharpest instance in the app: a FAILED `useProjectLayoutQuery`
 * read leaves `layout` undefined, so `codingWorkingDirectory` returns `''`
 * exactly as it would for a genuinely unconfigured project — all three
 * coding panes rendered "Workspace directory needed", which is WRONG
 * GUIDANCE on a failed read: it sends a user whose read hit a transient 500
 * off to reconfigure a project that is already configured. These tests pin
 * the fix (`CodingLayoutReadFailure`, shared by all three panes) against a
 * regression back to that empty-labelled guidance.
 */

const mocks = vi.hoisted(() => ({
  boundIdentity: {
    state: 'resolved' as const,
    project: { id: 'project-uuid-1', slug: 'project-alpha' },
  },
  layout: undefined as unknown,
  layoutError: undefined as unknown,
  refetchLayout: vi.fn(),
}));

vi.mock('../useWorkspacePaneBoundIdentity', () => ({
  useWorkspacePaneBoundIdentity: () => mocks.boundIdentity,
}));

vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  useFlowDefinitionsQuery: () => ({ data: undefined }),
  useProjectLayoutQuery: () => ({
    data: mocks.layout,
    error: mocks.layoutError,
    refetch: mocks.refetchLayout,
  }),
}));

vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    activeChat: null,
    openFilePreviewIntent: null,
    setLayout: vi.fn(),
  }),
}));

vi.mock('../../hooks/useDerivedSessions', () => ({
  useDerivedSessions: () => [],
}));

vi.mock('../WorkspacePaneHostOpenContext', () => ({
  useWorkspacePaneHostOpenAction: () => null,
}));

import { getBuiltinWorkspacePaneRenderer } from '../builtinWorkspacePaneRegistry';

afterEach(() => {
  mocks.boundIdentity = {
    state: 'resolved',
    project: { id: 'project-uuid-1', slug: 'project-alpha' },
  };
  mocks.layout = undefined;
  mocks.layoutError = undefined;
  mocks.refetchLayout.mockReset();
});

describe('CodingFileBrowserPane read failure (Review H1)', () => {
  const descriptor = WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR;
  const instance =
    createWorkspaceCodingFileBrowserPaneInstance('project-uuid-1')!;

  test('an errored layout read renders the shared failure state, not "Workspace directory needed"', () => {
    mocks.layoutError = new Error('layout read failed');
    const Pane = getBuiltinWorkspacePaneRenderer(descriptor)!;
    render(<Pane descriptor={descriptor} instance={instance} />);

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(
      screen.getByText("Unable to load this Project's layout"),
    ).toBeTruthy();
    expect(screen.getByText('layout read failed')).toBeTruthy();
    expect(screen.queryByText('Workspace directory needed')).toBeNull();
  });

  test('a settled-empty layout read (no error) still renders "Workspace directory needed", with no error state', () => {
    mocks.layout = undefined;
    mocks.layoutError = undefined;
    const Pane = getBuiltinWorkspacePaneRenderer(descriptor)!;
    render(<Pane descriptor={descriptor} instance={instance} />);

    expect(screen.getByText('Workspace directory needed')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('clicking Retry calls the layout query refetch', () => {
    mocks.layoutError = new Error('layout read failed');
    const Pane = getBuiltinWorkspacePaneRenderer(descriptor)!;
    render(<Pane descriptor={descriptor} instance={instance} />);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mocks.refetchLayout).toHaveBeenCalledTimes(1);
  });
});

describe('CodingDiffPane read failure (Review H1)', () => {
  const descriptor = WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR;
  const instance = createWorkspaceCodingDiffPaneInstance('project-uuid-1')!;

  test('an errored layout read renders the shared failure state, not "Workspace directory needed"', () => {
    mocks.layoutError = new Error('layout read failed');
    const Pane = getBuiltinWorkspacePaneRenderer(descriptor)!;
    render(<Pane descriptor={descriptor} instance={instance} />);

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(
      screen.getByText("Unable to load this Project's layout"),
    ).toBeTruthy();
    expect(screen.queryByText('Workspace directory needed')).toBeNull();
  });
});

describe('CodingTerminalWorkspacePane read failure (Review H1)', () => {
  const descriptor = WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR;
  const instance = createWorkspaceCodingTerminalPaneInstance('project-uuid-1')!;

  test('an errored layout read renders the shared failure state, not "Workspace directory needed"', () => {
    mocks.layoutError = new Error('layout read failed');
    const Pane = getBuiltinWorkspacePaneRenderer(descriptor)!;
    render(<Pane descriptor={descriptor} instance={instance} />);

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(
      screen.getByText("Unable to load this Project's layout"),
    ).toBeTruthy();
    expect(screen.queryByText('Workspace directory needed')).toBeNull();
  });
});
