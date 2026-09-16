/** @vitest-environment jsdom */

/**
 * #2157: the Layout pane renderer, with the SDK's reads stubbed. What it
 * proves is the renderer's own decisions — which record an id resolves to,
 * which project it binds, which kinds render and which are sent to Main,
 * and what an id the lists no longer carry shows — with `LayoutRenderer`
 * and `SDKAdapter` replaced by probes that report what they were handed.
 */

import { createWorkspaceLayoutPaneInstance } from '@kontourai/station-contracts/workspace-layout-pane';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const LAYOUT = '1d61ce22-7f4b-4282-86f0-019ef1bc223c';
const OTHER_LAYOUT = '2e72df33-8a5c-4393-97a1-12af02cd334d';
const PROJECT = 'f2e27d8e-dd81-4fe3-9d6e-9de369389b01';

const sdk = vi.hoisted(() => ({
  boards: [] as { id: string; slug: string; name: string }[],
  boardRecords: {} as Record<string, unknown>,
  projects: [] as { id: string; slug: string; name: string }[],
  layoutsByProject: {} as Record<
    string,
    { id: string; slug: string; name: string; projectSlug: string }[]
  >,
  layoutRecords: {} as Record<string, unknown>,
  loading: false,
  calls: [] as string[],
}));

vi.mock('@kontourai/station-sdk', () => ({
  usePersonalLayoutsQuery: (config?: { enabled?: boolean }) => {
    sdk.calls.push(`boards:${config?.enabled ?? true}`);
    return {
      data: config?.enabled === false ? undefined : sdk.boards,
      isLoading: sdk.loading && config?.enabled !== false,
      isError: false,
      refetch: vi.fn(),
    };
  },
  usePersonalLayoutQuery: (slug: string | undefined) => {
    sdk.calls.push(`board:${slug ?? ''}`);
    return {
      data: slug ? sdk.boardRecords[slug] : undefined,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
  },
  useProjectsQuery: (config?: { enabled?: boolean }) => {
    sdk.calls.push(`projects:${config?.enabled ?? true}`);
    return {
      data: config?.enabled === false ? undefined : sdk.projects,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
  },
  useProjectLayoutsQuery: (slug: string, config?: { enabled?: boolean }) => {
    sdk.calls.push(`layouts:${slug}:${config?.enabled ?? true}`);
    return {
      data: config?.enabled === false ? undefined : sdk.layoutsByProject[slug],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
  },
  useProjectLayoutQuery: (
    projectSlug: string | undefined,
    layoutSlug: string | undefined,
    config?: { enabled?: boolean },
  ) => {
    sdk.calls.push(`layout:${projectSlug ?? ''}/${layoutSlug ?? ''}`);
    return {
      data:
        config?.enabled === false || !projectSlug || !layoutSlug
          ? undefined
          : sdk.layoutRecords[`${projectSlug}/${layoutSlug}`],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
  },
}));

const adapter = vi.hoisted(() => ({ boundProjectSlug: [] as unknown[] }));
vi.mock('../../core/SDKAdapter', () => ({
  SDKAdapter: ({
    children,
    boundProjectSlug,
  }: {
    children: ReactNode;
    boundProjectSlug?: string;
  }) => {
    adapter.boundProjectSlug.push(boundProjectSlug);
    return <div data-testid="sdk-adapter">{children}</div>;
  },
}));

const renderer = vi.hoisted(() => ({
  layouts: [] as { slug: string }[],
  boundProjectSlug: [] as unknown[],
  canLaunchPrompts: [] as unknown[],
  onLaunchPrompt: [] as unknown[],
}));
vi.mock('../../layouts', () => ({
  LayoutRenderer: ({
    layout,
    activeTabId,
    onTabChange,
    boundProjectSlug,
    canLaunchPrompts,
    onLaunchPrompt,
  }: {
    layout: { slug: string; name: string; tabs: { id: string }[] };
    activeTabId?: string;
    onTabChange?: (id: string) => void;
    boundProjectSlug?: string;
    canLaunchPrompts?: boolean;
    onLaunchPrompt?: unknown;
  }) => {
    renderer.layouts.push(layout);
    renderer.boundProjectSlug.push(boundProjectSlug);
    renderer.canLaunchPrompts.push(canLaunchPrompts);
    renderer.onLaunchPrompt.push(onLaunchPrompt);
    return (
      <div data-testid="layout-renderer" data-active-tab={activeTabId}>
        {layout.name}
        {layout.tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => onTabChange?.(tab.id)}
          >
            {tab.id}
          </button>
        ))}
      </div>
    );
  },
}));

const navigation = vi.hoisted(() => ({
  navigate: vi.fn(),
  setLayout: vi.fn(),
  // The ROUTE's project, which is not the docked Layout's (#2171 A1): the
  // pane never reads it, and these tests hold it at a different project so
  // that a binding to the route would show up as 'beta' in the probes.
  activeProject: 'beta',
}));
vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: () => navigation,
}));

import { LayoutWorkspacePane } from '../LayoutWorkspacePane';

function instanceFor(
  key:
    | { kind: 'board'; layoutId: string }
    | { kind: 'project'; projectId: string; layoutId: string },
) {
  const instance = createWorkspaceLayoutPaneInstance(key);
  if (!instance) throw new Error('fixture must mint');
  return instance;
}

beforeEach(() => {
  sdk.boards = [{ id: LAYOUT, slug: 'my-board', name: 'My Board' }];
  sdk.boardRecords = {
    'my-board': {
      id: LAYOUT,
      slug: 'my-board',
      name: 'My Board',
      type: 'custom',
      config: {
        tabs: [
          { id: 'one', label: 'One' },
          { id: 'two', label: 'Two' },
        ],
      },
    },
  };
  sdk.projects = [{ id: PROJECT, slug: 'alpha', name: 'Alpha' }];
  sdk.layoutsByProject = {
    alpha: [
      { id: LAYOUT, slug: 'notes', name: 'Notes', projectSlug: 'alpha' },
      {
        id: OTHER_LAYOUT,
        slug: 'coding',
        name: 'Coding',
        projectSlug: 'alpha',
      },
    ],
  };
  sdk.layoutRecords = {
    'alpha/notes': {
      id: LAYOUT,
      slug: 'notes',
      name: 'Notes',
      projectSlug: 'alpha',
      type: 'custom',
      config: { tabs: [{ id: 'n', label: 'N' }] },
    },
    'alpha/coding': {
      id: OTHER_LAYOUT,
      slug: 'coding',
      name: 'Coding',
      projectSlug: 'alpha',
      type: 'coding',
      config: {},
    },
  };
  sdk.loading = false;
  sdk.calls = [];
  adapter.boundProjectSlug = [];
  renderer.layouts = [];
  renderer.boundProjectSlug = [];
  renderer.canLaunchPrompts = [];
  renderer.onLaunchPrompt = [];
  navigation.navigate.mockReset();
  navigation.setLayout.mockReset();
  window.localStorage.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('a Board as a pane', () => {
  /**
   * Reverting the renderer to read the record by ID (or by the dock's
   * project) reds the first assertion: the SDK's read is slug-keyed, and the
   * slug comes from the list. Passing a `boundProjectSlug` for a Board reds
   * the adapter assertion — a Board has no project.
   */
  test('resolves the id to the Board through the personal list and renders it with no project bound', () => {
    render(
      <LayoutWorkspacePane
        instance={instanceFor({ kind: 'board', layoutId: LAYOUT })}
      />,
    );
    expect(screen.getByTestId('layout-renderer').textContent).toContain(
      'My Board',
    );
    expect(sdk.calls).toContain('board:my-board');
    expect(adapter.boundProjectSlug).toEqual([undefined]);
    expect(renderer.boundProjectSlug).toEqual([undefined]);
    // The project queries are not enabled for a Board.
    expect(sdk.calls).toContain('projects:false');
    expect(renderer.layouts[0]).toMatchObject({
      slug: 'my-board',
      tabs: [{ id: 'one' }, { id: 'two' }],
    });
  });

  test('keeps its own tab selection, local to the pane', () => {
    render(
      <LayoutWorkspacePane
        instance={instanceFor({ kind: 'board', layoutId: LAYOUT })}
      />,
    );
    expect(screen.getByTestId('layout-renderer').dataset.activeTab).toBe('one');
    fireEvent.click(screen.getByRole('button', { name: 'two' }));
    expect(screen.getByTestId('layout-renderer').dataset.activeTab).toBe('two');
    // No hash, no session storage: there is no LayoutNavigationProvider.
    expect(window.location.hash).toBe('');
    expect(window.sessionStorage.length).toBe(0);
  });

  test('an id the personal list no longer carries reads as not found, and the record is never asked for', () => {
    sdk.boards = [];
    render(
      <LayoutWorkspacePane
        instance={instanceFor({ kind: 'board', layoutId: LAYOUT })}
      />,
    );
    expect(screen.getByText('Board not found')).toBeTruthy();
    expect(screen.queryByTestId('layout-renderer')).toBeNull();
    expect(sdk.calls).toContain('board:');
    expect(sdk.calls).not.toContain('board:my-board');
  });

  test('a loading list shows a skeleton rather than not-found', () => {
    sdk.loading = true;
    render(
      <LayoutWorkspacePane
        instance={instanceFor({ kind: 'board', layoutId: LAYOUT })}
      />,
    );
    expect(screen.getByRole('status', { name: 'Loading Board' })).toBeTruthy();
    expect(screen.queryByText('Board not found')).toBeNull();
  });
});

describe('a project Layout as a pane', () => {
  /**
   * A3: the project is bound THROUGH THE ID. Nothing here supplies a dock
   * project — the renderer is mounted with no dock context at all — and the
   * adapter still receives the project the id names. Reverting the adapter
   * call to omit `boundProjectSlug` reds the second assertion.
   */
  test('resolves project id → slug → layout slug and binds that project to the adapter', () => {
    render(
      <LayoutWorkspacePane
        instance={instanceFor({
          kind: 'project',
          projectId: PROJECT,
          layoutId: LAYOUT,
        })}
      />,
    );
    expect(screen.getByTestId('layout-renderer').textContent).toContain(
      'Notes',
    );
    expect(adapter.boundProjectSlug).toEqual(['alpha']);
    // Review M1: the renderer gets the binding too, for the built-in tab
    // that reads the UI's navigation rather than the SDK's.
    expect(renderer.boundProjectSlug).toEqual(['alpha']);
    expect(sdk.calls).toContain('layouts:alpha:true');
    expect(sdk.calls).toContain('layout:alpha/notes');
    // The personal list is not enabled for a project Layout.
    expect(sdk.calls).toContain('boards:false');
  });

  /**
   * A4: a `coding` layout renders the "Open in Main" placeholder and NEVER
   * a nested `WorkspacePaneHost` — asserted by the absence of any host
   * document write (a `BuiltinCodingLayoutHost` persists one under
   * `station:workspace-pane-host:v2:…` on mount) and of the renderer probe.
   * Reverting the kind check to render every kind reds the renderer
   * assertion.
   */
  test('a coding-kind Layout renders the Open-in-Main placeholder and writes no host document', () => {
    render(
      <LayoutWorkspacePane
        instance={instanceFor({
          kind: 'project',
          projectId: PROJECT,
          layoutId: OTHER_LAYOUT,
        })}
      />,
    );
    expect(screen.getByText('Open this Layout in Main')).toBeTruthy();
    expect(screen.queryByTestId('layout-renderer')).toBeNull();
    expect(screen.queryByTestId('sdk-adapter')).toBeNull();
    expect(
      Object.keys(window.localStorage).filter((key) =>
        key.startsWith('station:workspace-pane-host:v2'),
      ),
    ).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Open in Main' }));
    expect(navigation.setLayout).toHaveBeenCalledWith('alpha', 'coding');
  });

  test('a chat-kind Layout is sent to Main for its own reason', () => {
    sdk.layoutRecords['alpha/notes'] = {
      ...(sdk.layoutRecords['alpha/notes'] as object),
      type: 'chat',
    };
    render(
      <LayoutWorkspacePane
        instance={instanceFor({
          kind: 'project',
          projectId: PROJECT,
          layoutId: LAYOUT,
        })}
      />,
    );
    expect(screen.getByText('Open this Layout in Main')).toBeTruthy();
    expect(screen.getByText(/whole viewport/)).toBeTruthy();
    expect(screen.queryByTestId('layout-renderer')).toBeNull();
  });

  test('a plugin-contributed layout typed coding still renders: the kind is derived, not the type word', () => {
    sdk.layoutRecords['alpha/coding'] = {
      ...(sdk.layoutRecords['alpha/coding'] as object),
      config: { plugin: 'acme', tabs: [{ id: 'p', label: 'P' }] },
    };
    render(
      <LayoutWorkspacePane
        instance={instanceFor({
          kind: 'project',
          projectId: PROJECT,
          layoutId: OTHER_LAYOUT,
        })}
      />,
    );
    expect(screen.getByTestId('layout-renderer').textContent).toContain(
      'Coding',
    );
  });

  test('an unknown project id reads as not found', () => {
    render(
      <LayoutWorkspacePane
        instance={instanceFor({
          kind: 'project',
          projectId: '00000000-0000-0000-0000-000000000000',
          layoutId: LAYOUT,
        })}
      />,
    );
    expect(screen.getByText('Layout not found')).toBeTruthy();
    expect(sdk.calls).not.toContain('layouts:alpha:true');
  });

  /**
   * Review M2(b): `only()` refuses an AMBIGUOUS list, not just an empty
   * one. Two entries sharing one id is a record the resolver will not guess
   * between; loosening `matches.length === 1` to `>= 1` reds this.
   */
  test('two listed Layouts sharing one id read as not found rather than the first', () => {
    sdk.layoutsByProject.alpha = [
      { id: LAYOUT, slug: 'notes', name: 'Notes', projectSlug: 'alpha' },
      { id: LAYOUT, slug: 'notes-2', name: 'Notes 2', projectSlug: 'alpha' },
    ];
    render(
      <LayoutWorkspacePane
        instance={instanceFor({
          kind: 'project',
          projectId: PROJECT,
          layoutId: LAYOUT,
        })}
      />,
    );
    expect(screen.getByText('Layout not found')).toBeTruthy();
    expect(screen.queryByTestId('layout-renderer')).toBeNull();
    expect(sdk.calls).not.toContain('layout:alpha/notes');
  });

  test('an id that lists under the project but no longer resolves reads as not found', () => {
    sdk.layoutsByProject.alpha = [];
    render(
      <LayoutWorkspacePane
        instance={instanceFor({
          kind: 'project',
          projectId: PROJECT,
          layoutId: LAYOUT,
        })}
      />,
    );
    expect(screen.getByText('Layout not found')).toBeTruthy();
  });
});

test('an impostor occurrence under the Layout descriptor renders the invalid-pane copy', () => {
  const instance = instanceFor({ kind: 'board', layoutId: LAYOUT });
  const impostor = {
    ...instance,
    boundContext: { projectId: PROJECT, sourceId: 'builtin:workspace-layout' },
  };
  render(<LayoutWorkspacePane instance={impostor} />);
  expect(screen.getByText('This pane can’t open here')).toBeTruthy();
  expect(screen.queryByTestId('layout-renderer')).toBeNull();
});

/**
 * #2171: a docked Layout carrying prompts declares to the renderer that it
 * cannot launch them, and hands it no launcher. The choice was to withhold
 * the control rather than wire a launch to the bound project (the design
 * record says why); what these pin is that the declaration is made, for
 * both families, and that nothing here ever binds the route's project.
 */
describe('a docked Layout carrying prompts (#2171)', () => {
  const prompts = {
    actions: [{ type: 'prompt', label: 'Summarise', data: 'summarise' }],
    globalSkills: [{ id: 'g', label: 'Global', prompt: 'g' }],
  };

  /**
   * A1. The route is at project `beta` (the navigation mock) and the layout
   * belongs to `alpha` (through its id). The renderer gets `alpha` as the
   * binding and `false` as the launch declaration, with no handler. Passing
   * a launcher, or omitting `canLaunchPrompts`, reds this.
   */
  test('a project Layout with prompts: bound to its OWN project, declares no launch, hands no launcher', () => {
    sdk.layoutRecords['alpha/notes'] = {
      ...(sdk.layoutRecords['alpha/notes'] as object),
      config: { tabs: [{ id: 'n', label: 'N', ...prompts }], ...prompts },
    };
    render(
      <LayoutWorkspacePane
        instance={instanceFor({
          kind: 'project',
          projectId: PROJECT,
          layoutId: LAYOUT,
        })}
      />,
    );
    // The shape still CARRIES the prompts — the host withholds the control,
    // it does not strip the declaration.
    expect(renderer.layouts[0]).toMatchObject({
      actions: prompts.actions,
      globalSkills: prompts.globalSkills,
    });
    expect(renderer.boundProjectSlug).toEqual(['alpha']);
    expect(adapter.boundProjectSlug).toEqual(['alpha']);
    expect(renderer.canLaunchPrompts).toEqual([false]);
    expect(renderer.onLaunchPrompt).toEqual([undefined]);
  });

  /** A2. A Board has no project; the same declaration, with no binding. */
  test('a Board with prompts: no project bound, declares no launch, hands no launcher', () => {
    sdk.boardRecords['my-board'] = {
      ...(sdk.boardRecords['my-board'] as object),
      config: { tabs: [{ id: 'one', label: 'One', ...prompts }], ...prompts },
    };
    render(
      <LayoutWorkspacePane
        instance={instanceFor({ kind: 'board', layoutId: LAYOUT })}
      />,
    );
    expect(renderer.layouts[0]).toMatchObject({ actions: prompts.actions });
    expect(renderer.boundProjectSlug).toEqual([undefined]);
    expect(renderer.canLaunchPrompts).toEqual([false]);
    expect(renderer.onLaunchPrompt).toEqual([undefined]);
  });
});
