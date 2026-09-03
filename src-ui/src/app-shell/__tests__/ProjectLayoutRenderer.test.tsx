/**
 * @vitest-environment jsdom
 */

import { createDirectAnswerBasisMcpPaneOccurrence } from '@kontourai/station-basis-pane/workspace-basis-mcp-pane';
import { createDirectAnswerBasisPaneInstance } from '@kontourai/station-basis-pane/workspace-basis-pane';
import { WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-browser-preview';
import {
  createWorkspaceCodingDiffPaneInstance,
  createWorkspaceCodingFileBrowserPaneInstance,
  createWorkspaceCodingTerminalPaneInstance,
  WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR,
  WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR,
  WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR,
} from '@kontourai/station-contracts/workspace-coding-panels';
import {
  createWorkspacePlanPaneInstance,
  createWorkspaceReadinessPaneInstance,
  createWorkspaceTrustPaneInstance,
  WORKSPACE_PLAN_PANE_DESCRIPTOR,
  WORKSPACE_READINESS_PANE_DESCRIPTOR,
  WORKSPACE_TRUST_PANE_DESCRIPTOR,
} from '@kontourai/station-contracts/workspace-evidence-panels';
import { WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-file-preview';
import { paneAdaptationFromLayoutTab } from '@kontourai/station-contracts/workspace-pane-layout-adapter';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { type ReactNode, useEffect } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { createBrowserPreviewPaneInstance } from '../../workspace-panes/browserPreviewPaneInstance';
import { writeBrowserPreviewPaneState } from '../../workspace-panes/browserPreviewPaneStateStorage';
import { createFilePreviewPaneInstance } from '../../workspace-panes/filePreviewPaneInstance';
import { writeFilePreviewPaneState } from '../../workspace-panes/filePreviewPaneStateStorage';
import { WorkspacePaneHostRuntime } from '../../workspace-panes/workspacePaneHostRuntime';

const layoutQueryMock = vi.fn();
const catalogMock = vi.fn();
const navigationMock = vi.hoisted(() => ({ setLayout: vi.fn() }));
const { hostMock, hostEffectMock, mobileMock } = vi.hoisted(() => ({
  hostMock: vi.fn(),
  // archive#3794: the real controller runs its availability sweep, its
  // lifecycle-context capture and its authoritative-catalog replacement from
  // dep arrays naming exactly these five inputs
  // (`workspacePaneHostController.ts` — the sweep at its
  // `[operationalAvailability, operationalEventContext, persistenceStatus,
  // state.document]`, the capture at `[operationalEventContext,
  // state.document]`, the replacement at `[..., onInstanceRemoved,...]`).
  // Counting one effect over the same inputs here states the cost in the
  // units the defect is measured in: renders that change nothing must not
  // re-run host work.
  hostEffectMock: vi.fn(),
  mobileMock: vi.fn(() => false),
}));
const codingChatPaneMock = vi.hoisted(() => vi.fn());
const chatWorkspaceLayoutMock = vi.hoisted(() => vi.fn());
const telemetryTrackMock = vi.hoisted(() => vi.fn());
const trustedPluginLayoutMock = vi.hoisted(() => vi.fn());
const pluginBoundaryMock = vi.hoisted(() => vi.fn());

vi.mock('@kontourai/station-sdk', () => ({
  FullScreenError: ({ description }: { description: string }) => (
    <div>{description}</div>
  ),
  LayoutHeader: () => null,
  telemetry: { track: telemetryTrackMock },
  useProjectLayoutQuery: (...args: unknown[]) => {
    const result = layoutQueryMock(...args);
    return result?.data
      ? {
          ...result,
          data: {
            ...result.data,
            id: result.data.id ?? `layout:${String(args[1])}`,
          },
        }
      : result;
  },
  useFlowDefinitionsQuery: () => ({ data: { initialized: false } }),
}));

vi.mock('../../workspace-panes/CodingChatPane', () => ({
  CodingChatPane: (props: unknown) => {
    codingChatPaneMock(props);
    return <div>Coding chat pane</div>;
  },
}));
vi.mock('../../workspace-panes/ChatWorkspaceLayout', () => ({
  ChatWorkspaceLayout: (props: unknown) => {
    chatWorkspaceLayoutMock(props);
    return <div>Chat workspace rendered</div>;
  },
}));
vi.mock('../../hooks/useIsMobile', () => ({
  useIsMobile: () => mobileMock(),
}));
vi.mock('../../components/coding-layout/CodingTerminalPane', () => ({
  CodingTerminalPane: ({ workingDir }: { workingDir: string }) => (
    <div>Terminal pane {workingDir}</div>
  ),
}));
vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: () => navigationMock,
}));
vi.mock('../../hooks/useDerivedSessions', () => ({
  useDerivedSessions: () => [],
}));
vi.mock('../../components/coding-layout/CodingInspectorPanel', () => ({
  WorkflowPlanInspectorContent: () => <div>Plan pane</div>,
  ReadinessInspectorContent: () => <div>Readiness pane</div>,
  TrustInspectorContent: () => <div>Trust pane</div>,
}));
vi.mock('../../workspace-panes/resolvedWorkspacePaneCatalog', () => ({
  useResolvedWorkspacePaneCatalog: (...args: unknown[]) => catalogMock(...args),
}));
vi.mock(
  '../../workspace-panes/workspacePaneRendererSelection',
  async (original) => ({
    ...(await original<
      typeof import('../../workspace-panes/workspacePaneRendererSelection')
    >()),
    resolveClientTrustedPluginLayout: trustedPluginLayoutMock,
  }),
);
vi.mock('../../workspace-panes/PluginWorkspacePaneSDKBoundary', () => ({
  PluginWorkspacePaneSDKBoundary: ({ children, ...identity }: any) => {
    pluginBoundaryMock(identity);
    return children;
  },
}));
vi.mock('../../workspace-panes/useWorkspacePaneBoundIdentity', () => ({
  useWorkspacePaneBoundIdentity: (instance: {
    boundContext?: { projectId?: string; layoutId?: string };
  }) => ({
    state: 'resolved' as const,
    project: {
      id: instance.boundContext?.projectId ?? 'project-uuid',
      slug: 'project-route',
    },
    ...(instance.boundContext?.layoutId
      ? {
          layout: {
            id: instance.boundContext.layoutId,
            slug: 'coding',
            projectSlug: 'project-route',
            type: 'coding',
            name: 'Coding',
          },
        }
      : {}),
  }),
}));
vi.mock('../../platform/native', () => ({
  nativePlatformPromise: new Promise(() => {}),
}));
vi.mock('../../workspace-panes/WorkspacePaneHost', () => ({
  WorkspacePaneHost: ({
    document,
    renderPane,
    compact,
    operationalAvailability,
    operationalEventContext,
    admitRestoredInstance,
    onInstanceRemoved,
    presentationLabel,
    ...props
  }: {
    document: { instances: readonly unknown[]; scope: { projectId: string } };
    renderPane: (instance: unknown) => ReactNode;
    compact?: boolean;
    operationalAvailability?: unknown;
    operationalEventContext?: unknown;
    admitRestoredInstance?: unknown;
    onInstanceRemoved?: unknown;
    presentationLabel?: unknown;
  }) => {
    hostMock({
      document,
      renderPane,
      compact,
      operationalAvailability,
      operationalEventContext,
      admitRestoredInstance,
      onInstanceRemoved,
      presentationLabel,
      ...props,
    });
    useEffect(() => {
      hostEffectMock({
        document,
        operationalAvailability,
        operationalEventContext,
        admitRestoredInstance,
        onInstanceRemoved,
        presentationLabel,
      });
    }, [
      document,
      operationalAvailability,
      operationalEventContext,
      admitRestoredInstance,
      onInstanceRemoved,
      presentationLabel,
    ]);
    return (
      <div>
        Hosted {document.scope.projectId}; instances {document.instances.length}
        ; compact {compact ? 'yes' : 'no'}
        {document.instances.map((instance, index) => (
          <div key={index}>{renderPane(instance)}</div>
        ))}
      </div>
    );
  },
}));
vi.mock('../../components/coding-layout/FileTreePanel', () => ({
  FileTreePanel: ({
    workingDir,
    onFileSelect,
  }: {
    workingDir: string;
    onFileSelect: (intent: { projectSlug: string; path: string }) => void;
  }) => (
    <button
      type="button"
      onClick={() =>
        onFileSelect({ projectSlug: 'project-route', path: 'src/app.ts' })
      }
    >
      Files pane {workingDir}
    </button>
  ),
}));
vi.mock('../../components/coding-layout/DiffPanel', () => ({
  DiffPanel: ({ workingDir }: { workingDir: string }) => (
    <div>Diff pane {workingDir}</div>
  ),
}));
vi.mock('../../components/coding-layout/BranchToolbar', () => ({
  BranchToolbar: () => <div>Branch toolbar</div>,
}));
vi.mock('../../components/coding-layout/PullRequestsPanel', () => ({
  PullRequestsPanel: ({ projectSlug }: { projectSlug: string }) => (
    <div>Pull requests pane {projectSlug}</div>
  ),
}));
vi.mock('../../components/TasksLayout', () => ({
  TasksLayout: () => <div>Tasks rendered</div>,
}));
vi.mock('../../components/session/SessionBoardLayout', () => ({
  SessionBoardLayout: ({ projectSlug }: { projectSlug: string }) => (
    <div>Session board rendered for {projectSlug}</div>
  ),
}));
vi.mock('../../views/LayoutView', () => ({
  LayoutView: () => <div>Current layout view</div>,
}));

import {
  ProjectLayoutRenderer,
  resolveBuiltinCodingPanePopOut,
} from '../ProjectLayoutRenderer';

describe('ProjectLayoutRenderer', () => {
  test('keeps a catalog-missing Coding workspace unavailable instead of mounting another shell', () => {
    catalogMock.mockReturnValue({ entries: [] });
    layoutQueryMock.mockReturnValue({ data: { type: 'coding', config: {} } });
    render(<ProjectLayoutRenderer projectSlug="demo" layoutSlug="coding" />);
    expect(screen.getByRole('alert').textContent).toContain(
      'Coding workspace unavailable',
    );
    expect(screen.queryByText('Coding chat pane')).toBeNull();
  });

  test('explains an existing but unavailable Coding occurrence', () => {
    const coding = paneAdaptationFromLayoutTab(
      {
        id: 'coding',
        label: 'Coding',
        component: { kind: 'builtin-component', name: 'coding' },
      },
      {
        layoutSlug: 'coding',
        instanceScope: 'project:demo:source:builtin:coding',
        modeContextRequirement: { project: true, source: true },
        boundContext: { projectId: 'demo', sourceId: 'builtin:coding' },
      },
    )!;
    const refetch = vi.fn();
    catalogMock.mockReturnValue({
      projectId: 'demo',
      entries: [
        {
          descriptor: coding.descriptor,
          instance: coding.instance,
          availability: {
            state: 'temporarily-unavailable',
            reason: { code: 'renderer-missing', source: 'renderer' },
          },
        },
      ],
      refetch,
    });
    layoutQueryMock.mockReturnValue({ data: { type: 'coding', config: {} } });
    render(<ProjectLayoutRenderer projectSlug="demo" layoutSlug="coding" />);

    expect(screen.getByRole('alert').textContent).toContain(
      'The pane renderer is currently unavailable.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  test('keeps a builtin descriptor under registry failure on renderer-missing Retry', () => {
    const coding = paneAdaptationFromLayoutTab(
      {
        id: 'coding',
        label: 'Coding',
        component: { kind: 'builtin-component', name: 'coding' },
      },
      {
        layoutSlug: 'coding',
        instanceScope: 'project:demo:source:builtin:coding',
        modeContextRequirement: { project: true, source: true },
        boundContext: { projectId: 'demo', sourceId: 'builtin:coding' },
      },
    )!;
    const refetch = vi.fn();
    catalogMock.mockReturnValue({
      projectId: 'demo',
      entries: [
        {
          descriptor: coding.descriptor,
          instance: coding.instance,
          availability: {
            state: 'temporarily-unavailable',
            reason: { code: 'renderer-missing', source: 'renderer' },
          },
        },
      ],
      refetch,
    });
    layoutQueryMock.mockReturnValue({ data: { type: 'coding', config: {} } });

    render(<ProjectLayoutRenderer projectSlug="demo" layoutSlug="coding" />);

    expect(screen.getByRole('alert').textContent).toContain(
      'The pane renderer is currently unavailable.',
    );
    expect(screen.queryByText('Remote extensions are off')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  test('dispatches the session-board layout type to the SessionBoardLayout adapter', () => {
    layoutQueryMock.mockReturnValue({
      data: { type: 'session-board', config: {} },
    });

    render(
      <ProjectLayoutRenderer projectSlug="demo" layoutSlug="session-board" />,
    );

    expect(screen.getByText('Session board rendered for demo')).toBeTruthy();
  });

  test('dispatches existing chat layouts to the shared Chat workspace placement', () => {
    layoutQueryMock.mockReturnValue({ data: { type: 'chat', config: {} } });

    render(<ProjectLayoutRenderer projectSlug="demo" layoutSlug="chat" />);

    expect(screen.getByText('Chat workspace rendered')).toBeTruthy();
    expect(chatWorkspaceLayoutMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectSlug: 'demo', layoutSlug: 'chat' }),
    );
  });

  test('dispatches a Station-owned tabbed chat layout to the shared Chat workspace placement', () => {
    layoutQueryMock.mockReturnValue({
      data: {
        type: 'chat',
        config: {
          tabs: [{ id: 'chat', component: 'chat' }],
        },
      },
    });

    render(<ProjectLayoutRenderer projectSlug="demo" layoutSlug="chat" />);

    expect(screen.getByText('Chat workspace rendered')).toBeTruthy();
    expect(screen.queryByText('Current layout view')).toBeNull();
    expect(chatWorkspaceLayoutMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectSlug: 'demo', layoutSlug: 'chat' }),
    );
  });

  test('keeps a plugin-contributed chat type on its declared component path', () => {
    layoutQueryMock.mockReturnValue({
      data: {
        type: 'chat',
        config: {
          tabs: [
            {
              id: 'workspace',
              component: {
                kind: 'plugin-component',
                name: 'minimal-workspace',
              },
            },
          ],
        },
        catalogContribution: {
          id: 'plugin:minimal-layout:minimal',
          version: '1.0.0',
          sourceIdentity: {
            id: 'minimal-layout',
            kind: 'local',
            source: 'plugins/minimal-layout',
          },
          provenance: { origin: 'plugin', pluginId: 'minimal-layout' },
        },
      },
    });

    render(<ProjectLayoutRenderer projectSlug="demo" layoutSlug="minimal" />);

    expect(screen.getByText('Current layout view')).toBeTruthy();
    expect(screen.queryByText('Chat workspace rendered')).toBeNull();
  });

  test('keeps a persisted plugin chat layout without catalog provenance on its declared component path', () => {
    layoutQueryMock.mockReturnValue({
      data: {
        type: 'chat',
        config: {
          plugin: 'knowledge-docs-starter',
          tabs: [
            {
              id: 'library',
              component: {
                kind: 'plugin-component',
                name: 'library',
              },
            },
          ],
        },
      },
    });

    render(
      <ProjectLayoutRenderer projectSlug="demo" layoutSlug="knowledge-docs" />,
    );

    expect(screen.getByText('Current layout view')).toBeTruthy();
    expect(screen.queryByText('Chat workspace rendered')).toBeNull();
  });

  test('reports catalog loading and failure truthfully', () => {
    catalogMock.mockReturnValue({ isLoading: true, entries: [] });
    layoutQueryMock.mockReturnValue({ data: { type: 'coding', config: {} } });

    render(<ProjectLayoutRenderer projectSlug="demo" layoutSlug="coding" />);

    expect(
      screen.getByRole('status', { name: 'Loading coding workspace panes' }),
    ).toBeTruthy();
  });

  test('reports a catalog failure and preserves an explicit retry action', () => {
    const refetch = vi.fn();
    catalogMock.mockReturnValue({ isError: true, entries: [], refetch });
    layoutQueryMock.mockReturnValue({ data: { type: 'coding', config: {} } });

    render(<ProjectLayoutRenderer projectSlug="demo" layoutSlug="coding" />);

    expect(screen.getByRole('alert').textContent).toContain(
      'Could not load coding workspace',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  test('keeps the live non-Git Project useful and explains the unavailable Diff pane', async () => {
    const { resolveWorkspacePaneCatalogPresentation } = await vi.importActual<
      typeof import('../../workspace-panes/resolvedWorkspacePaneCatalog')
    >('../../workspace-panes/resolvedWorkspacePaneCatalog');
    const projectId = '3008a697-af40-4294-b797-9e8466f66c4b';
    // Sanitized from live-panes.json: these are the exact server-issued IDs
    // and availability inputs for a Project whose workspace is not a Git repo.
    const coding = paneAdaptationFromLayoutTab(
      {
        id: 'coding',
        label: 'Coding',
        component: { kind: 'builtin-component', name: 'coding' },
      },
      {
        layoutSlug: 'coding',
        instanceScope: `project:${projectId}:source:builtin:coding`,
        modeContextRequirement: { project: true, source: true },
        boundContext: { projectId, sourceId: 'builtin:coding' },
      },
    )!;
    const files = createWorkspaceCodingFileBrowserPaneInstance(projectId)!;
    const diff = createWorkspaceCodingDiffPaneInstance(projectId)!;
    const terminal = createWorkspaceCodingTerminalPaneInstance(projectId)!;
    const plan = createWorkspacePlanPaneInstance(projectId)!;
    const readiness = createWorkspaceReadinessPaneInstance(projectId)!;
    const trust = createWorkspaceTrustPaneInstance(projectId)!;
    const input = (requirements?: { gitRepository?: true }) => ({
      rollout: 'available' as const,
      distribution: 'enabled' as const,
      renderer: 'unknown' as const,
      context: {
        project: 'present' as const,
        workspace: 'present' as const,
        gitRepository: 'missing' as const,
      },
      ...(requirements ? { requirements } : {}),
    });
    const availability = (
      descriptorId: typeof coding.descriptor.id,
      instanceId?: typeof coding.instance.instanceId,
      requirements?: { gitRepository?: true },
    ) => ({
      descriptorId,
      ...(instanceId ? { instanceId } : {}),
      input: input(requirements),
      // The server emits its pre-client-renderer result too; the real client
      // resolver above intentionally recomputes this from `input`.
      availability: {
        state: 'unsupported' as const,
        reason: {
          code: 'renderer-unknown' as const,
          source: 'renderer' as const,
        },
        action: {
          type: 'learn-more' as const,
          code: 'view-renderer-requirements' as const,
        },
      },
    });
    const catalog = resolveWorkspacePaneCatalogPresentation(
      {
        projectId,
        descriptors: [
          coding.descriptor,
          WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR,
          WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR,
          WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR,
          WORKSPACE_PLAN_PANE_DESCRIPTOR,
          WORKSPACE_READINESS_PANE_DESCRIPTOR,
          WORKSPACE_TRUST_PANE_DESCRIPTOR,
          WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR,
        ],
        instances: [
          coding.instance,
          files,
          diff,
          terminal,
          plan,
          readiness,
          trust,
        ],
        availability: [
          availability(coding.descriptor.id, coding.instance.instanceId),
          availability(files.descriptorId, files.instanceId),
          availability(diff.descriptorId, diff.instanceId, {
            gitRepository: true,
          }),
          availability(terminal.descriptorId, terminal.instanceId),
          availability(plan.descriptorId, plan.instanceId),
          availability(readiness.descriptorId, readiness.instanceId),
          availability(trust.descriptorId, trust.instanceId),
          availability(WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR.id),
        ],
      },
      { target: 'web', isMobile: false, isDesktop: false } as any,
    );
    catalogMock.mockReturnValue({
      ...catalog,
      isLoading: false,
      isError: false,
    });
    layoutQueryMock.mockReturnValue({ data: { type: 'coding', config: {} } });

    render(
      <ProjectLayoutRenderer projectSlug="kontour-ai" layoutSlug="coding" />,
    );

    expect(screen.getByText(/Hosted 3008a697/)).toBeTruthy();
    expect(screen.getByText(/instances 7/)).toBeTruthy();
    expect(screen.getByText('Diff unavailable')).toBeTruthy();
    expect(
      screen.getByText(/Choose a Git repository before opening this pane/),
    ).toBeTruthy();
    expect(screen.getByText(/Next: Select Git repository/)).toBeTruthy();
  });

  test('hosts exact builtin panels with the selected layout identity', () => {
    const coding = paneAdaptationFromLayoutTab(
      {
        id: 'coding',
        label: 'Coding',
        component: { kind: 'builtin-component', name: 'coding' },
      },
      {
        layoutSlug: 'coding',
        instanceScope: 'project:project-uuid:source:builtin:coding',
        modeContextRequirement: { project: true, source: true },
        boundContext: {
          projectId: 'project-uuid',
          sourceId: 'builtin:coding',
        },
      },
    )!;
    const files = createWorkspaceCodingFileBrowserPaneInstance('project-uuid')!;
    const diff = createWorkspaceCodingDiffPaneInstance('project-uuid')!;
    const terminal = createWorkspaceCodingTerminalPaneInstance('project-uuid')!;
    const plan = createWorkspacePlanPaneInstance('project-uuid')!;
    const readiness = createWorkspaceReadinessPaneInstance('project-uuid')!;
    const trust = createWorkspaceTrustPaneInstance('project-uuid')!;
    const pluginDescriptor = {
      version: '1.0',
      id: 'pane:plugin%3Aplaced-plugin:main',
      name: 'Placed plugin',
      rendererId: 'renderer:plugin%3Aplaced-plugin:main',
      renderer: { kind: 'plugin-component', name: 'placed-main' },
      placement: { supportedRegions: ['primary'] },
      modes: [{ id: 'default', contextRequirement: { project: true } }],
      provenance: { origin: 'plugin', pluginId: 'placed-plugin' },
      lifecycle: { stage: 'stable' },
    } as any;
    const pluginInstance = {
      version: '1.0',
      descriptorId: pluginDescriptor.id,
      instanceId: 'instance:plugin:project-uuid:placed-plugin',
      stateKey: 'state:plugin:project-uuid:placed-plugin',
      boundContext: {
        projectId: 'project-uuid',
        contribution: {
          id: 'plugin:placed-plugin:pane',
          version: '1.0.0',
          sourceIdentity: {
            id: 'placed-plugin',
            kind: 'local',
            source: 'plugins/placed-plugin',
          },
          provenance: { origin: 'plugin', pluginId: 'placed-plugin' },
        },
      },
    } as any;
    const PlacedPlugin = () => <div>Placed plugin renderer</div>;
    trustedPluginLayoutMock.mockReturnValue(PlacedPlugin);
    pluginBoundaryMock.mockClear();
    catalogMock.mockReturnValue({
      projectId: 'project-uuid',
      projectSlug: 'project-route',
      entries: [
        {
          instance: coding.instance,
          availability: {
            state: 'available',
            reason: { code: 'ready', source: 'resolver' },
          },
          descriptor: coding.descriptor,
        },
        {
          availability: {
            state: 'available',
            reason: { code: 'ready', source: 'resolver' },
          },
          descriptor: WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR,
        },
        {
          availability: {
            state: 'unsupported',
            reason: { code: 'unsupported-host', source: 'native-host' },
          },
          descriptor: {
            ...WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR,
            id: 'workspace:host-unsupported',
            name: 'Host-only pane',
          },
        },
        {
          availability: {
            state: 'available',
            reason: { code: 'ready', source: 'resolver' },
          },
          descriptor: WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR,
        },
        {
          instance: files,
          availability: {
            state: 'available',
            reason: { code: 'ready', source: 'resolver' },
          },
          descriptor: WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR,
        },
        {
          instance: diff,
          availability: {
            state: 'available',
            reason: { code: 'ready', source: 'resolver' },
          },
          descriptor: WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR,
        },
        {
          instance: terminal,
          availability: {
            state: 'available',
            reason: { code: 'ready', source: 'resolver' },
          },
          descriptor: WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR,
        },
        {
          instance: plan,
          availability: {
            state: 'available',
            reason: { code: 'ready', source: 'resolver' },
          },
          descriptor: WORKSPACE_PLAN_PANE_DESCRIPTOR,
        },
        {
          instance: readiness,
          availability: {
            state: 'available',
            reason: { code: 'ready', source: 'resolver' },
          },
          descriptor: WORKSPACE_READINESS_PANE_DESCRIPTOR,
        },
        {
          instance: trust,
          availability: {
            state: 'available',
            reason: { code: 'ready', source: 'resolver' },
          },
          descriptor: WORKSPACE_TRUST_PANE_DESCRIPTOR,
        },
        {
          instance: pluginInstance,
          availability: {
            state: 'available',
            reason: { code: 'ready', source: 'resolver' },
          },
          descriptor: pluginDescriptor,
          selectedRenderer: {
            source: 'primary',
            rendererId: pluginDescriptor.rendererId,
            renderer: pluginDescriptor.renderer,
            contributorProvenance: pluginDescriptor.provenance,
            requiredCapabilities: ['trusted-plugin-react'],
          },
        },
      ],
    });
    navigationMock.setLayout.mockReset();
    codingChatPaneMock.mockReset();
    hostMock.mockReset();
    mobileMock.mockReturnValue(false);
    layoutQueryMock.mockReturnValue({
      data: {
        type: 'coding',
        config: {
          workingDirectory: '/repo/workspace',
          workspaceCompositionFilePane: 'compare',
          workspaceCompositionDiffPane: 'compare',
          workspaceCompositionEvidencePanes: 'compare',
        },
      },
    });
    const view = render(
      <ProjectLayoutRenderer projectSlug="project-route" layoutSlug="coding" />,
    );
    expect(screen.getByText(/Hosted project-uuid/)).toBeTruthy();
    expect(screen.getByText(/instances 7/)).toBeTruthy();
    expect(screen.getByText('Coding chat pane')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Files pane/ })).toBeTruthy();
    expect(screen.getByText('Diff pane /repo/workspace')).toBeTruthy();
    expect(screen.getByText('Terminal pane /repo/workspace')).toBeTruthy();
    expect(screen.getByText('Plan pane')).toBeTruthy();
    expect(screen.getByText('Readiness pane')).toBeTruthy();
    expect(screen.getByText('Trust pane')).toBeTruthy();
    expect(codingChatPaneMock).toHaveBeenCalledWith(
      expect.objectContaining({
        browserPreviewAvailability: expect.objectContaining({
          state: 'available',
        }),
      }),
    );
    expect(layoutQueryMock.mock.calls).toEqual(
      expect.arrayContaining([['project-route', 'coding']]),
    );
    expect(hostMock.mock.lastCall?.[0].document.instances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          descriptorId: 'pane:builtin:coding:file-browser',
          boundContext: {
            projectId: 'project-uuid',
            layoutId: 'layout:coding',
            workspaceId: 'project-uuid',
            sourceId: 'builtin:workspace-coding-file-browser',
          },
        }),
      ]),
    );
    expect(hostMock.mock.lastCall?.[0].document.instances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          descriptorId: 'pane:builtin:coding:diff',
          boundContext: {
            projectId: 'project-uuid',
            layoutId: 'layout:coding',
            workspaceId: 'project-uuid',
            sourceId: 'builtin:workspace-coding-diff',
          },
        }),
      ]),
    );
    expect(telemetryTrackMock).toHaveBeenCalledWith(
      'ui.workspace_composition.coding_file_path',
      expect.objectContaining({
        control: 'compare',
        outcome: 'composition-selected',
        fallback_used: 0,
      }),
    );
    expect(telemetryTrackMock).toHaveBeenCalledWith(
      'ui.workspace_composition.coding_diff_path',
      expect.objectContaining({
        category: 'git-diff',
        control: 'compare',
        outcome: 'composition-selected',
        fallback_used: 0,
      }),
    );
    expect(telemetryTrackMock).toHaveBeenCalledWith(
      'ui.workspace_composition.coding_evidence_path',
      expect.objectContaining({
        category: 'evidence',
        control: 'compare',
        outcome: 'composition-selected',
        fallback_used: 0,
      }),
    );
    const receiptCount = telemetryTrackMock.mock.calls.filter(
      ([event]) => event === 'ui.workspace_composition.coding_file_path',
    ).length;
    view.rerender(
      <ProjectLayoutRenderer projectSlug="project-route" layoutSlug="coding" />,
    );
    expect(
      telemetryTrackMock.mock.calls.filter(
        ([event]) => event === 'ui.workspace_composition.coding_file_path',
      ),
    ).toHaveLength(receiptCount);

    fireEvent.click(screen.getByRole('button', { name: /Files pane/ }));
    expect(navigationMock.setLayout).toHaveBeenCalledWith(
      'project-route',
      'coding',
      {
        openFilePreviewIntent: {
          projectSlug: 'project-route',
          path: 'src/app.ts',
        },
      },
    );

    const hostProps = hostMock.mock.lastCall?.[0];
    expect(hostProps.runtime).toBeInstanceOf(WorkspacePaneHostRuntime);
    const basis = createDirectAnswerBasisPaneInstance(
      'project-uuid',
      'session-basis',
      'turn-basis',
    )!;
    expect(hostProps.renderPane(basis)).not.toBeNull();
    expect(hostProps.admitRestoredInstance(basis)).toEqual(basis);
    const basisMcp = createDirectAnswerBasisMcpPaneOccurrence(
      'project-uuid',
      'session-basis',
      'turn-basis',
    )!;
    expect(hostProps.admitRestoredInstance(basisMcp.instance)).toEqual(
      basisMcp.instance,
    );
    expect(
      hostProps.admitRestoredInstance({
        ...basisMcp.instance,
        stateKey: 'forged',
      }),
    ).toBeNull();
    expect(
      hostProps.renderPane(basisMcp.instance, {
        displayMode: 'inline',
        availableDisplayModes: ['inline'],
        requestDisplayMode: () => true,
      }),
    ).not.toBeNull();
    expect(
      hostProps.admitRestoredInstance(
        createDirectAnswerBasisPaneInstance(
          'project-route',
          'session-basis',
          'turn-basis',
        ),
      ),
    ).toBeNull();
    expect(
      hostProps.renderPane({
        ...basis,
        boundContext: { ...basis.boundContext, projectId: 'other-project' },
      }),
    ).not.toBeNull();
    const open = vi.fn(() => true);
    act(() => {
      hostProps.onOpenActionChange({ open });
      hostProps.onOpenCatalog({
        type: 'split',
        targetGroupId: 'catalog-target',
        orientation: 'vertical',
        placement: 'after',
      });
    });
    expect(
      screen.getByRole('dialog', { name: 'Add workspace pane' }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Host-only pane Not supported here',
      }),
    );
    expect(
      screen.getByText('This host does not support this pane.'),
    ).toBeTruthy();
    const codingTrigger = screen.getByRole('button', {
      name: 'Coding Open in this workspace',
    });
    codingTrigger.focus();
    fireEvent.click(codingTrigger);
    expect(codingTrigger.closest('li')?.textContent).toContain(
      'This pane is already open in this workspace.',
    );
    expect(open).not.toHaveBeenCalled();
    expect(
      screen.getByRole('dialog', { name: 'Add workspace pane' }),
    ).toBeTruthy();
    const preview = createFilePreviewPaneInstance(
      {
        version: '1.0',
        projectSlug: 'project-route',
        path: 'src/restored.ts',
        wrap: true,
      },
      'project-uuid',
      'a'.repeat(32),
    )!;
    expect(
      writeFilePreviewPaneState(window.localStorage, preview.stateKey, {
        version: '1.0',
        projectSlug: 'project-route',
        path: 'src/restored.ts',
        wrap: true,
      }),
    ).toBe(true);
    expect(hostProps.admitRestoredInstance(preview)).toEqual(preview);

    const browserPreview = createBrowserPreviewPaneInstance(
      {
        version: '1.0',
        projectId: 'project-uuid',
        requestedUrl: 'http://127.0.0.1:4173/',
        viewportPreference: 'responsive',
        updatedAt: '2026-08-09T00:00:00.000Z',
      },
      'project-uuid',
      'b'.repeat(32),
    )!;
    expect(
      writeBrowserPreviewPaneState(
        window.localStorage,
        browserPreview.stateKey,
        {
          version: '1.0',
          projectId: 'project-uuid',
          requestedUrl: 'http://127.0.0.1:4173/',
          viewportPreference: 'responsive',
          updatedAt: '2026-08-09T00:00:00.000Z',
        },
      ),
    ).toBe(true);
    expect(hostProps.admitRestoredInstance(browserPreview)).toEqual(
      browserPreview,
    );
    expect(hostProps.admitRestoredInstance(pluginInstance)).toEqual(
      pluginInstance,
    );
    render(hostProps.renderPane(pluginInstance));
    expect(screen.getByText('Placed plugin renderer')).toBeTruthy();
    expect(pluginBoundaryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginName: 'placed-plugin',
        projectSlug: 'project-route',
      }),
    );
    expect(pluginBoundaryMock).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Open Placed plugin',
      }),
    );
    expect(open).toHaveBeenCalledWith(
      pluginInstance,
      undefined,
      expect.objectContaining({ type: 'split' }),
    );
    const liveCatalog = catalogMock.mock.results.at(-1)?.value;
    catalogMock.mockReturnValue({
      ...liveCatalog,
      entries: liveCatalog.entries.filter(
        (candidate: { descriptor: { id: string } }) =>
          candidate.descriptor.id !==
          WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR.id,
      ),
    });
    view.rerender(
      <ProjectLayoutRenderer projectSlug="project-route" layoutSlug="coding" />,
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'Coding file workspace unavailable',
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'did not fall back',
    );
  });

  test('passes an unavailable Browser Preview catalog resolution to its sole creator', () => {
    const coding = paneAdaptationFromLayoutTab(
      {
        id: 'coding',
        label: 'Coding',
        component: { kind: 'builtin-component', name: 'coding' },
      },
      {
        layoutSlug: 'workspace',
        instanceScope: 'project:project-uuid:source:builtin:coding',
        modeContextRequirement: { project: true, source: true },
        boundContext: { projectId: 'project-uuid', sourceId: 'builtin:coding' },
      },
    )!;
    catalogMock.mockReturnValue({
      projectId: 'project-uuid',
      entries: [
        {
          instance: coding.instance,
          availability: { state: 'available' },
          descriptor: coding.descriptor,
        },
        {
          availability: { state: 'available' },
          descriptor: WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR,
        },
        {
          availability: {
            state: 'temporarily-unavailable',
            reason: { code: 'health-unavailable', source: 'health' },
          },
          descriptor: WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR,
        },
        {
          instance:
            createWorkspaceCodingFileBrowserPaneInstance('project-uuid')!,
          availability: { state: 'available' },
          descriptor: WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR,
        },
        {
          instance: createWorkspaceCodingDiffPaneInstance('project-uuid')!,
          availability: { state: 'available' },
          descriptor: WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR,
        },
        {
          instance: createWorkspaceCodingTerminalPaneInstance('project-uuid')!,
          availability: { state: 'available' },
          descriptor: WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR,
        },
        {
          instance: createWorkspacePlanPaneInstance('project-uuid')!,
          availability: { state: 'available' },
          descriptor: WORKSPACE_PLAN_PANE_DESCRIPTOR,
        },
        {
          instance: createWorkspaceReadinessPaneInstance('project-uuid')!,
          availability: { state: 'available' },
          descriptor: WORKSPACE_READINESS_PANE_DESCRIPTOR,
        },
        {
          instance: createWorkspaceTrustPaneInstance('project-uuid')!,
          availability: { state: 'available' },
          descriptor: WORKSPACE_TRUST_PANE_DESCRIPTOR,
        },
      ],
    });
    codingChatPaneMock.mockReset();
    layoutQueryMock.mockReturnValue({ data: { type: 'coding', config: {} } });

    render(<ProjectLayoutRenderer projectSlug="demo" layoutSlug="workspace" />);

    expect(codingChatPaneMock).toHaveBeenCalledWith(
      expect.objectContaining({
        browserPreviewAvailability: {
          state: 'temporarily-unavailable',
          reason: { code: 'health-unavailable', source: 'health' },
        },
      }),
    );
  });

  test('awaits bounded typed pop-out results without exposing native details', async () => {
    const coding = paneAdaptationFromLayoutTab(
      {
        id: 'coding',
        label: 'Coding',
        component: { kind: 'builtin-component', name: 'coding' },
      },
      {
        layoutSlug: 'workspace',
        instanceScope: 'project:project-uuid:source:builtin:coding',
        modeContextRequirement: { project: true, source: true },
        boundContext: {
          projectId: 'project-uuid',
          sourceId: 'builtin:coding',
        },
      },
    )!;
    const openWorkspacePanePopOut = vi.fn(async () => ({
      status: 'ok' as const,
      value: undefined,
    }));
    const native = {
      capability: () => ({
        id: 'workspace-pane-pop-out' as const,
        state: 'enabled' as const,
        reason: 'fixture',
      }),
      openWorkspacePanePopOut,
    };
    const input = {
      entries: [
        {
          descriptor: coding.descriptor,
          instance: coding.instance,
          availability: {
            state: 'available' as const,
            reason: { code: 'ready' as const, source: 'resolver' as const },
          },
        },
      ],
      native,
      projectId: 'project-uuid',
      projectSlug: 'project-route',
      layoutSlug: 'workspace',
    };

    const fixed = resolveBuiltinCodingPanePopOut({
      ...input,
      instance: coding.instance,
    });
    expect(fixed.state).toBe('supported');
    if (fixed.state !== 'supported') throw new Error('expected fixed support');
    await expect(fixed.request(coding.instance)).resolves.toEqual({
      status: 'opened',
    });
    expect(openWorkspacePanePopOut).toHaveBeenCalledWith({
      projectId: 'project-uuid',
      projectSlug: 'project-route',
      layoutId: 'workspace',
      descriptorId: coding.instance.descriptorId,
      instanceId: coding.instance.instanceId,
    });

    openWorkspacePanePopOut.mockResolvedValueOnce({
      status: 'unsupported',
      command: 'open-workspace-pane-pop-out',
      reason: 'native platform details must not reach the command surface',
    } as never);
    await expect(fixed.request(coding.instance)).resolves.toEqual({
      status: 'unavailable',
    });

    openWorkspacePanePopOut.mockRejectedValueOnce(
      new Error('native route /private/path rejected'),
    );
    await expect(fixed.request(coding.instance)).resolves.toEqual({
      status: 'failed',
    });

    const filePreview = createFilePreviewPaneInstance(
      {
        version: '1.0',
        projectSlug: 'project-route',
        path: 'src/local.ts',
        wrap: true,
      },
      'project-uuid',
      'c'.repeat(32),
    )!;
    const browserPreview = createBrowserPreviewPaneInstance(
      {
        version: '1.0',
        projectId: 'project-uuid',
        requestedUrl: 'http://127.0.0.1:4173/',
        viewportPreference: 'responsive',
        updatedAt: '2026-08-09T00:00:00.000Z',
      },
      'project-uuid',
      'd'.repeat(32),
    )!;
    for (const instance of [filePreview, browserPreview]) {
      expect(resolveBuiltinCodingPanePopOut({ ...input, instance })).toEqual({
        state: 'unsupported',
        reason:
          'This pane lives in this workspace only, so it can’t be opened in its own window.',
      });
    }
  });

  test('passes compact presentation to the sole host without changing its pane set', () => {
    mobileMock.mockReturnValue(true);
    // The complete catalog fixture is covered above; reusing it would hide the
    // responsive assertion under unrelated renderer expectations.
    const coding = paneAdaptationFromLayoutTab(
      {
        id: 'coding',
        label: 'Coding',
        component: { kind: 'builtin-component', name: 'coding' },
      },
      {
        layoutSlug: 'workspace',
        instanceScope: 'project:project-uuid:source:builtin:coding',
        modeContextRequirement: { project: true, source: true },
        boundContext: { projectId: 'project-uuid', sourceId: 'builtin:coding' },
      },
    )!;
    catalogMock.mockReturnValue({
      projectId: 'project-uuid',
      entries: [
        {
          instance: coding.instance,
          availability: { state: 'available' },
          descriptor: coding.descriptor,
        },
        {
          availability: { state: 'available' },
          descriptor: WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR,
        },
        {
          instance:
            createWorkspaceCodingFileBrowserPaneInstance('project-uuid')!,
          availability: { state: 'available' },
          descriptor: WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR,
        },
        {
          instance: createWorkspaceCodingDiffPaneInstance('project-uuid')!,
          availability: { state: 'available' },
          descriptor: WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR,
        },
        {
          instance: createWorkspaceCodingTerminalPaneInstance('project-uuid')!,
          availability: { state: 'available' },
          descriptor: WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR,
        },
        {
          instance: createWorkspacePlanPaneInstance('project-uuid')!,
          availability: { state: 'available' },
          descriptor: WORKSPACE_PLAN_PANE_DESCRIPTOR,
        },
        {
          instance: createWorkspaceReadinessPaneInstance('project-uuid')!,
          availability: { state: 'available' },
          descriptor: WORKSPACE_READINESS_PANE_DESCRIPTOR,
        },
        {
          instance: createWorkspaceTrustPaneInstance('project-uuid')!,
          availability: { state: 'available' },
          descriptor: WORKSPACE_TRUST_PANE_DESCRIPTOR,
        },
      ],
    });
    layoutQueryMock.mockReturnValue({ data: { type: 'coding', config: {} } });

    render(<ProjectLayoutRenderer projectSlug="demo" layoutSlug="workspace" />);

    expect(
      screen.getByText(/Hosted project-uuid; instances 7; compact yes/),
    ).toBeTruthy();
    expect(hostMock.mock.lastCall?.[0].runtime).toBeInstanceOf(
      WorkspacePaneHostRuntime,
    );
  });

  test.each(['files', 'diff'])(
    'does not host a cross-Project %s pane occurrence',
    (panel) => {
      const coding = paneAdaptationFromLayoutTab(
        {
          id: 'coding',
          label: 'Coding',
          component: { kind: 'builtin-component', name: 'coding' },
        },
        {
          layoutSlug: 'workspace',
          instanceScope: 'project:project-uuid:source:builtin:coding',
          modeContextRequirement: { project: true, source: true },
          boundContext: {
            projectId: 'project-uuid',
            sourceId: 'builtin:coding',
          },
        },
      )!;
      const files = createWorkspaceCodingFileBrowserPaneInstance(
        panel === 'files' ? 'other-project' : 'project-uuid',
      )!;
      const diff = createWorkspaceCodingDiffPaneInstance(
        panel === 'diff' ? 'other-project' : 'project-uuid',
      )!;
      catalogMock.mockReturnValue({
        projectId: 'project-uuid',
        entries: [
          {
            instance: coding.instance,
            availability: { state: 'available' },
            descriptor: coding.descriptor,
          },
          {
            availability: { state: 'available' },
            descriptor: WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR,
          },
          {
            instance: files,
            availability: { state: 'available' },
            descriptor: WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR,
          },
          {
            instance: diff,
            availability: { state: 'available' },
            descriptor: WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR,
          },
        ],
      });
      layoutQueryMock.mockReturnValue({
        data: {
          type: 'coding',
          config: { workingDirectory: '/repo/workspace' },
        },
      });

      render(
        <ProjectLayoutRenderer
          projectSlug="project-route"
          layoutSlug="workspace"
        />,
      );

      expect(screen.getByText(/Hosted project-uuid/)).toBeTruthy();
      expect(
        panel === 'files'
          ? screen.queryByRole('button', { name: /Files pane/ })
          : screen.queryByText(/Diff pane/),
      ).toBeNull();
    },
  );

  test('admits restored dynamic file previews when the Coding host is available even if its catalog entry is coming soon', () => {
    const coding = paneAdaptationFromLayoutTab(
      {
        id: 'coding',
        label: 'Coding',
        component: { kind: 'builtin-component', name: 'coding' },
      },
      {
        layoutSlug: 'coding',
        instanceScope: 'project:demo:source:builtin:coding',
        modeContextRequirement: { project: true, source: true },
        boundContext: { projectId: 'demo', sourceId: 'builtin:coding' },
      },
    )!;
    catalogMock.mockReturnValue({
      projectId: 'demo',
      entries: [
        {
          instance: coding.instance,
          availability: { state: 'available' },
          descriptor: coding.descriptor,
        },
        {
          availability: { state: 'coming-soon' },
          descriptor: WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR,
        },
      ],
    });
    layoutQueryMock.mockReturnValue({ data: { type: 'coding', config: {} } });
    render(<ProjectLayoutRenderer projectSlug="demo" layoutSlug="coding" />);
    expect(screen.getByText(/Hosted demo/)).toBeTruthy();

    const preview = createFilePreviewPaneInstance(
      {
        version: '1.0',
        projectSlug: 'demo',
        path: 'src/restored.ts',
        wrap: true,
      },
      'demo',
      'c'.repeat(32),
    )!;
    expect(
      writeFilePreviewPaneState(window.localStorage, preview.stateKey, {
        version: '1.0',
        projectSlug: 'demo',
        path: 'src/restored.ts',
        wrap: true,
      }),
    ).toBe(true);
    expect(hostMock.mock.lastCall?.[0].admitRestoredInstance(preview)).toEqual(
      preview,
    );
  });

  test('re-renders that change nothing keep every pane-host input identical, so the host does no work (station#3794)', () => {
    const coding = paneAdaptationFromLayoutTab(
      {
        id: 'coding',
        label: 'Coding',
        component: { kind: 'builtin-component', name: 'coding' },
      },
      {
        layoutSlug: 'coding',
        instanceScope: 'project:demo:source:builtin:coding',
        modeContextRequirement: { project: true, source: true },
        boundContext: { projectId: 'demo', sourceId: 'builtin:coding' },
      },
    )!;
    // Production shape after the availability-facts fix: the catalog hook
    // returns a new result object per render while its ENTRIES keep identity
    // until the catalogue itself changes. The callbacks below must depend on
    // the entries (an availability change has to re-run the host's sweep),
    // so entries are stable here and the churn under test is the call site's
    // own — inline arrows churn against a stable catalogue too.
    const entries = [
      {
        descriptor: coding.descriptor,
        instance: coding.instance,
        availability: {
          state: 'available',
          reason: { code: 'ready', source: 'resolver' },
        },
      },
    ];
    catalogMock.mockImplementation(() => ({ projectId: 'demo', entries }));
    layoutQueryMock.mockReturnValue({
      data: { type: 'coding', config: { workingDirectory: '/repo/workspace' } },
    });
    hostMock.mockReset();
    hostEffectMock.mockReset();

    const view = render(
      <ProjectLayoutRenderer projectSlug="demo" layoutSlug="coding" />,
    );
    expect(screen.getByText(/Hosted demo/)).toBeTruthy();
    const first = hostMock.mock.calls[0][0];

    view.rerender(
      <ProjectLayoutRenderer projectSlug="demo" layoutSlug="coding" />,
    );
    view.rerender(
      <ProjectLayoutRenderer projectSlug="demo" layoutSlug="coding" />,
    );
    view.rerender(
      <ProjectLayoutRenderer projectSlug="demo" layoutSlug="coding" />,
    );

    // The host really did render again — this is not "nothing happened".
    expect(hostMock.mock.calls.length).toBeGreaterThanOrEqual(4);
    const last = hostMock.mock.lastCall?.[0];
    for (const input of [
      'document',
      'operationalAvailability',
      'operationalEventContext',
      'admitRestoredInstance',
      'onInstanceRemoved',
      'presentationLabel',
    ] as const) {
      expect(last[input], input).toBe(first[input]);
    }
    // Four renders of the parent, one run of the host work they key.
    expect(hostEffectMock).toHaveBeenCalledTimes(1);
  });

  test('uses the current layout view for an unregistered type', () => {
    catalogMock.mockReturnValue({ entries: [] });
    layoutQueryMock.mockReturnValue({
      data: { type: 'unknown-type', config: {} },
    });

    render(<ProjectLayoutRenderer projectSlug="demo" layoutSlug="whatever" />);

    expect(screen.getByText('Current layout view')).toBeTruthy();
  });
});
