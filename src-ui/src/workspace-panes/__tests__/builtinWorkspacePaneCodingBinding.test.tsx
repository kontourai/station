/** @vitest-environment jsdom */

/**
 * #2047 D5: a coding pane is the PROJECT's when it binds no layout, and a
 * layout's when it does — through the real identity resolver
 * (`useWorkspacePaneBoundIdentity` over the SDK's project and layout
 * queries, mocked at the data), so reverting `codingPaneNeedsLayout` to
 * `true` shows as the resolver's "not linked to a layout" state, not as a
 * changed spy argument. The three coding surfaces are stubbed at their
 * component boundary and print the working directory they were handed.
 */

import {
  createWorkspaceCodingDiffPaneInstance,
  createWorkspaceCodingFileBrowserPaneInstance,
  createWorkspaceCodingTerminalPaneInstance,
  WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR,
  WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR,
  WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR,
} from '@kontourai/station-contracts/workspace-coding-panels';
import {
  parseWorkspacePaneInstance,
  type WorkspacePaneDescriptor,
  type WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setLayout: vi.fn(),
  projectWorkingDirectory: '/srv/alpha' as string | undefined,
  layoutWorkingDirectory: '/srv/alpha/layout' as string | undefined,
}));

const PROJECT = {
  id: 'alpha-id',
  slug: 'alpha',
  name: 'Alpha',
  hasWorkingDirectory: true,
  layoutCount: 1,
  hasKnowledge: false,
};
const LAYOUT = { id: 'layout-1', slug: 'coding', projectSlug: 'alpha' };

vi.mock('../../contexts/ApiBaseContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'ui-scope-test-authority',
    isCurrent: () => true,
  }),
}));

vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  useProjectsQuery: () => ({
    data: [{ ...PROJECT, workingDirectory: mocks.projectWorkingDirectory }],
    isLoading: false,
    isError: false,
  }),
  useProjectLayoutsQuery: () => ({
    data: [LAYOUT],
    isLoading: false,
    isError: false,
  }),
  useProjectLayoutQuery: (_slug: string, layoutSlug: string) => ({
    data: layoutSlug
      ? {
          ...LAYOUT,
          config:
            mocks.layoutWorkingDirectory === undefined
              ? {}
              : { workingDirectory: mocks.layoutWorkingDirectory },
        }
      : undefined,
    error: undefined,
    refetch: vi.fn(),
  }),
  useFlowDefinitionsQuery: () => ({ data: undefined }),
}));
vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    activeChat: null,
    openFilePreviewIntent: null,
    setLayout: mocks.setLayout,
  }),
}));
vi.mock('../../hooks/useDerivedSessions', () => ({
  useDerivedSessions: () => [],
}));
vi.mock('../WorkspacePaneHostOpenContext', () => ({
  useWorkspacePaneHostOpenAction: () => null,
}));
vi.mock('../../components/coding-layout/CodingTerminalPane', () => ({
  CodingTerminalPane: ({ workingDir }: { workingDir: string }) => (
    <p data-testid="terminal" data-working-dir={workingDir} />
  ),
}));
vi.mock('../../components/coding-layout/FileTreePanel', () => ({
  FileTreePanel: ({
    workingDir,
    projectSlug,
    onFileSelect,
  }: {
    workingDir: string;
    projectSlug: string;
    onFileSelect: (intent: {
      version: '1.0';
      projectSlug: string;
      path: string;
    }) => void;
  }) => (
    <button
      type="button"
      data-testid="files"
      data-working-dir={workingDir}
      onClick={() =>
        onFileSelect({ version: '1.0', projectSlug, path: 'src/a.ts' })
      }
    >
      src/a.ts
    </button>
  ),
}));
vi.mock('../../components/coding-layout/BranchToolbar', () => ({
  BranchToolbar: ({ workingDir }: { workingDir: string }) => (
    <p data-testid="diff" data-working-dir={workingDir} />
  ),
}));
vi.mock('../../components/coding-layout/DiffPanel', () => ({
  DiffPanel: () => null,
}));
vi.mock('../../components/coding-layout/PullRequestsPanel', () => ({
  PullRequestsPanel: () => null,
}));

import { getBuiltinWorkspacePaneRenderer } from '../builtinWorkspacePaneRegistry';

afterEach(() => {
  mocks.setLayout.mockReset();
  mocks.projectWorkingDirectory = '/srv/alpha';
  mocks.layoutWorkingDirectory = '/srv/alpha/layout';
});

function withLayout(instance: WorkspacePaneInstance): WorkspacePaneInstance {
  const bound = parseWorkspacePaneInstance({
    ...instance,
    boundContext: { ...instance.boundContext, layoutId: LAYOUT.id },
  });
  if (!bound) throw new Error('fixture must parse');
  return bound;
}

function mount(
  descriptor: WorkspacePaneDescriptor,
  instance: WorkspacePaneInstance,
) {
  const Pane = getBuiltinWorkspacePaneRenderer(descriptor, instance);
  if (!Pane) throw new Error(`${descriptor.name} has no renderer`);
  return render(<Pane descriptor={descriptor} instance={instance} />);
}

const PANES: readonly [
  string,
  WorkspacePaneDescriptor,
  (projectId: string) => WorkspacePaneInstance | null,
  string,
][] = [
  [
    'Terminal',
    WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR,
    createWorkspaceCodingTerminalPaneInstance,
    'terminal',
  ],
  [
    'Diff',
    WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR,
    createWorkspaceCodingDiffPaneInstance,
    'diff',
  ],
  [
    'Files',
    WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR,
    createWorkspaceCodingFileBrowserPaneInstance,
    'files',
  ],
];

/**
 * Reverting `codingPaneNeedsLayout` to `true` fails the first assertion of
 * each case: the resolver reports `missing-layout-binding` for the
 * layout-less instance and the pane renders "This pane isn’t linked to a
 * layout" instead of its surface. Reverting `codingWorkingDirectory`'s
 * project fallback fails the `data-working-dir` assertion ("Workspace
 * directory needed" renders instead).
 */
test.each(PANES)(
  '%s without a layout binding resolves as the project’s and works in the project’s directory',
  (_name, descriptor, create, testId) => {
    const instance = create('alpha-id');
    if (!instance) throw new Error('fixture must parse');
    expect(instance.boundContext?.layoutId).toBeUndefined();
    mount(descriptor, instance);
    expect(screen.queryByText('This pane isn’t linked to a layout')).toBeNull();
    expect(screen.getByTestId(testId).dataset.workingDir).toBe('/srv/alpha');
  },
);

/**
 * The layout-bound case is unchanged: the layout still has to resolve, and
 * its own `workingDirectory` wins over the project's. A layout that names
 * none falls back to the project's rather than to "directory needed".
 */
test.each(PANES)(
  '%s with a layout binding works in the layout’s directory, else the project’s',
  (_name, descriptor, create, testId) => {
    const instance = create('alpha-id');
    if (!instance) throw new Error('fixture must parse');
    const bound = withLayout(instance);
    const { unmount } = mount(descriptor, bound);
    expect(screen.getByTestId(testId).dataset.workingDir).toBe(
      '/srv/alpha/layout',
    );
    unmount();

    mocks.layoutWorkingDirectory = undefined;
    mount(descriptor, bound);
    expect(screen.getByTestId(testId).dataset.workingDir).toBe('/srv/alpha');
  },
);

test('a project with no working directory still asks for one', () => {
  mocks.projectWorkingDirectory = undefined;
  const instance = createWorkspaceCodingTerminalPaneInstance('alpha-id');
  if (!instance) throw new Error('fixture must parse');
  mount(WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR, instance);
  expect(screen.getByText('Workspace directory needed')).toBeTruthy();
  expect(screen.queryByTestId('terminal')).toBeNull();
});

/**
 * A layout-less Files pane has no layout route to keep its selection in:
 * a file click must not `setLayout` (it would navigate the dock away to
 * `/projects/alpha/` with an empty layout). The layout-bound pane still
 * does, with the intent. Reverting the `if (layoutSlug)` guard fails the
 * `not.toHaveBeenCalled` assertion.
 */
test('a layout-less Files pane keeps a file click out of navigation; a layout-bound one navigates', () => {
  const instance = createWorkspaceCodingFileBrowserPaneInstance('alpha-id');
  if (!instance) throw new Error('fixture must parse');
  const { unmount } = mount(
    WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR,
    instance,
  );
  fireEvent.click(screen.getByTestId('files'));
  expect(mocks.setLayout).not.toHaveBeenCalled();
  unmount();

  mount(WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR, withLayout(instance));
  fireEvent.click(screen.getByTestId('files'));
  expect(mocks.setLayout).toHaveBeenCalledWith('alpha', 'coding', {
    openFilePreviewIntent: {
      version: '1.0',
      projectSlug: 'alpha',
      path: 'src/a.ts',
    },
  });
});
