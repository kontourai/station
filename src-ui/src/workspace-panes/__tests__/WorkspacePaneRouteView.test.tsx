/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

const catalogMock = vi.hoisted(() => ({
  projectId: 'project-uuid',
  entries: [
    {
      descriptor: {
        id: 'builtin:flow-run-console',
        name: 'Flow run console',
        description: 'Observe Flow run state',
      },
      // A real catalog instance always carries its bound context; the baseline
      // entry is owned by this mock's own Project so ownership admission passes.
      instance: {
        instanceId: 'flow-console-1',
        boundContext: { projectId: 'project-uuid' },
      },
      availability: {
        state: 'available',
        reason: { code: 'ready', source: 'resolver' },
      },
      clientRendererPresence: 'present',
    },
  ],
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}));

const { resolveClientTrustedPluginLayoutMock } = vi.hoisted(() => ({
  resolveClientTrustedPluginLayoutMock: vi.fn(),
}));

vi.mock('@kontourai/station-sdk', () => ({
  useProjectLayoutQuery: (
    projectSlug: string,
    layoutSlug: string,
    options?: { enabled?: boolean },
  ) => ({
    data: options?.enabled
      ? {
          id: 'layout-uuid',
          slug: layoutSlug,
          projectSlug,
          type: 'coding',
          name: 'Coding',
        }
      : undefined,
    isLoading: false,
  }),
}));

vi.mock('../resolvedWorkspacePaneCatalog', () => ({
  useResolvedWorkspacePaneCatalog: () => ({
    ...catalogMock,
    entries: catalogMock.entries.map((entry: any) =>
      entry.instance
        ? {
            ...entry,
            instance: {
              version: entry.instance.version ?? '1.0',
              descriptorId: entry.instance.descriptorId ?? entry.descriptor.id,
              stateKey:
                entry.instance.stateKey ?? `state:${entry.instance.instanceId}`,
              ...entry.instance,
              boundContext: {
                projectId:
                  entry.instance.boundContext?.projectId ??
                  catalogMock.projectId,
                ...entry.instance.boundContext,
              },
            },
          }
        : entry,
    ),
  }),
}));

vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

vi.mock('../../contexts/ConfigContext', () => ({
  useConfig: () => ({ mcpUiHost: true }),
}));

vi.mock('../builtinWorkspacePaneRegistry', () => ({
  builtinWorkspacePaneRendererPresence: () => 'present',
  isCanonicalBuiltinCodingOccurrence: () => false,
  getBuiltinWorkspacePaneRenderer: (descriptor: {
    id: string;
    renderer?: { kind?: string };
  }) =>
    descriptor.renderer?.kind === 'builtin-component' ||
    descriptor.id.startsWith('builtin:')
      ? ({ projectSlug }: { projectSlug?: string }) => (
          <div data-testid="mounted-pane">
            Mounted for {projectSlug ?? 'demo'}
          </div>
        )
      : null,
}));

vi.mock('../../layouts', () => ({
  LayoutRenderer: ({
    componentId,
    onMcpUiResolution,
  }: {
    componentId: { kind: string; ref?: string };
    onMcpUiResolution?: (resolution: {
      ref: string;
      status: 'missing_resource' | 'render_revoked';
    }) => void;
  }) => (
    <button
      type="button"
      data-testid="contributed-pane"
      onClick={() =>
        componentId.kind === 'mcp-tool-ui' && componentId.ref
          ? onMcpUiResolution?.({
              ref: componentId.ref,
              status: 'missing_resource',
            })
          : undefined
      }
    >
      {componentId.kind}
    </button>
  ),
}));

vi.mock('../workspacePaneRendererSelection', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../workspacePaneRendererSelection')
  >()),
  resolveClientTrustedPluginLayout: resolveClientTrustedPluginLayoutMock,
}));

import { WorkspacePaneRouteView } from '../WorkspacePaneRouteView';

describe('WorkspacePaneRouteView', () => {
  test('rejects an available occurrence scoped to another Project before mounting', () => {
    catalogMock.entries = [
      {
        descriptor: {
          id: 'builtin:flow-run-console',
          name: 'Flow run console',
          description: 'Observe Flow run state',
        },
        instance: {
          instanceId: 'cross-project-console',
          boundContext: { projectId: 'project-b' },
        },
        availability: {
          state: 'available',
          reason: { code: 'ready', source: 'resolver' },
        },
        clientRendererPresence: 'present',
      },
    ];

    render(
      <WorkspacePaneRouteView
        projectSlug="demo"
        descriptorId="builtin:flow-run-console"
        instanceId="cross-project-console"
      />,
    );

    expect(screen.getByText('Workspace pane unavailable')).toBeTruthy();
    expect(
      screen.getByText('This pane belongs to a different Project.'),
    ).toBeTruthy();
    expect(screen.queryByTestId('mounted-pane')).toBeNull();
    catalogMock.entries = [
      {
        descriptor: {
          id: 'builtin:flow-run-console',
          name: 'Flow run console',
          description: 'Observe Flow run state',
        },
        instance: {
          instanceId: 'flow-console-1',
          boundContext: { projectId: 'project-uuid' },
        },
        availability: {
          state: 'available',
          reason: { code: 'ready', source: 'resolver' },
        },
        clientRendererPresence: 'present',
      },
    ];
  });

  test('mounts the exact available direct-route occurrence', () => {
    render(
      <WorkspacePaneRouteView
        projectSlug="demo"
        descriptorId="builtin:flow-run-console"
        instanceId="flow-console-1"
      />,
    );

    expect(screen.getByTestId('mounted-pane').textContent).toContain('demo');
  });

  test('mounts the catalog-selected contributed renderer without branching on contributor identity', () => {
    resolveClientTrustedPluginLayoutMock.mockReturnValue(() => null);
    catalogMock.entries = [
      {
        descriptor: {
          id: 'pane:plugin%3Athird-party:review:issues',
          name: 'Third-party issues',
          description: 'Read-only review projection.',
          renderer: { kind: 'mcp-tool-ui', ref: 'third-party-mcp/issues' },
          provenance: {
            origin: 'plugin',
            pluginId: 'third-party-review',
            mcpServerId: 'third-party-mcp',
          },
        },
        instance: {
          instanceId: 'third-party-issues-1',
          boundContext: {
            contribution: {
              id: 'plugin:third-party-review:review',
              version: '2.4.0',
              sourceIdentity: {
                id: 'third-party-review',
                kind: 'local',
                source: 'plugins/third-party-review',
              },
              provenance: {
                origin: 'plugin',
                pluginId: 'third-party-review',
              },
            },
          },
        },
        selectedRenderer: {
          source: 'alternative',
          renderer: { kind: 'plugin-component', name: 'issues-read-only' },
          contributorProvenance: {
            origin: 'plugin',
            pluginId: 'third-party-review',
            mcpServerId: 'third-party-mcp',
          },
          requiredCapabilities: ['trusted-plugin-react'],
        },
        availability: {
          state: 'available',
          reason: { code: 'ready', source: 'resolver' },
        },
        clientRendererPresence: 'present',
      },
    ] as any;

    render(
      <WorkspacePaneRouteView
        projectSlug="demo"
        descriptorId="pane:plugin%3Athird-party:review:issues"
        instanceId="third-party-issues-1"
      />,
    );

    expect(screen.getByTestId('contributed-pane').textContent).toBe(
      'plugin-component',
    );
    expect(screen.queryByTestId('mounted-pane')).toBeNull();
    expect(resolveClientTrustedPluginLayoutMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'pane:plugin%3Athird-party:review:issues',
      }),
      expect.objectContaining({
        renderer: { kind: 'plugin-component', name: 'issues-read-only' },
      }),
      expect.objectContaining({ instanceId: 'third-party-issues-1' }),
    );
  });

  test('asynchronously reselects only the declared standard-data alternative after a missing MCP resource', () => {
    const contribution = {
      id: 'plugin:third-party-review:review',
      version: '2.4.0',
      sourceIdentity: {
        id: 'third-party-review',
        kind: 'local',
        source: 'plugins/third-party-review',
      },
      provenance: { origin: 'plugin', pluginId: 'third-party-review' },
    };
    catalogMock.entries = [
      {
        descriptor: {
          version: '1.0',
          id: 'pane:plugin%3Athird-party:review:issues',
          name: 'Third-party issues',
          rendererId: 'renderer:third-party:mcp',
          renderer: { kind: 'mcp-tool-ui', ref: 'third-party-mcp/issues' },
          requiredRendererCapabilities: ['sandboxed-mcp-app'],
          alternativeRenderer: {
            rendererId: 'renderer:third-party:read-only',
            renderer: {
              kind: 'standard-data',
              view: {
                id: 'issues-read-only',
                projection: 'Issues',
                schemaRef: 'example://issues',
                readOnly: true,
                contribution,
                incarnation: 1,
              },
            },
            reason:
              'Use the inert declared projection when MCP UI is unavailable.',
          },
          placement: { supportedRegions: ['standalone'] },
          provenance: {
            origin: 'plugin',
            pluginId: 'third-party-review',
            mcpServerId: 'third-party-mcp',
          },
          lifecycle: { stage: 'stable' },
        },
        instance: {
          instanceId: 'third-party-issues-1',
          boundContext: { contribution },
        },
        selectedRenderer: {
          source: 'primary',
          rendererId: 'renderer:third-party:mcp',
          renderer: { kind: 'mcp-tool-ui', ref: 'third-party-mcp/issues' },
          contributorProvenance: {
            origin: 'plugin',
            pluginId: 'third-party-review',
            mcpServerId: 'third-party-mcp',
          },
          requiredCapabilities: ['sandboxed-mcp-app'],
        },
        availability: {
          state: 'available',
          reason: { code: 'ready', source: 'resolver' },
        },
        clientRendererPresence: 'present',
      },
    ] as any;

    render(
      <WorkspacePaneRouteView
        projectSlug="demo"
        descriptorId="pane:plugin%3Athird-party:review:issues"
        instanceId="third-party-issues-1"
      />,
    );

    fireEvent.click(screen.getByTestId('contributed-pane'));

    expect(screen.getByLabelText('Read-only standard data view')).toBeTruthy();
    expect(screen.queryByTestId('contributed-pane')).toBeNull();
  });

  test('rejects a terminal MCP fact after the descriptor, renderer, and contribution lifecycle changes', () => {
    const firstContribution = {
      id: 'plugin:third-party-review:review',
      version: '2.4.0',
      sourceIdentity: {
        id: 'third-party-review',
        kind: 'local',
        source: 'plugins/third-party-review',
      },
      provenance: { origin: 'plugin', pluginId: 'third-party-review' },
    };
    const entry = {
      descriptor: {
        version: '1.0',
        id: 'pane:plugin%3Athird-party:review:issues',
        name: 'Third-party issues',
        rendererId: 'renderer:third-party:mcp-v1',
        renderer: { kind: 'mcp-tool-ui', ref: 'third-party-mcp/issues' },
        requiredRendererCapabilities: ['sandboxed-mcp-app'],
        alternativeRenderer: {
          rendererId: 'renderer:third-party:read-only-v1',
          renderer: {
            kind: 'standard-data',
            view: {
              id: 'issues-read-only',
              projection: 'Issues',
              schemaRef: 'example://issues',
              readOnly: true,
              contribution: firstContribution,
              incarnation: 1,
            },
          },
          reason:
            'Use the inert declared projection when MCP UI is unavailable.',
        },
        placement: { supportedRegions: ['standalone'] },
        provenance: {
          origin: 'plugin',
          pluginId: 'third-party-review',
          mcpServerId: 'third-party-mcp',
        },
        lifecycle: { stage: 'stable', since: '2026-08-09' },
      },
      instance: {
        instanceId: 'third-party-issues-1',
        boundContext: { contribution: firstContribution },
      },
      selectedRenderer: {
        source: 'primary',
        rendererId: 'renderer:third-party:mcp-v1',
        renderer: { kind: 'mcp-tool-ui', ref: 'third-party-mcp/issues' },
        contributorProvenance: {
          origin: 'plugin',
          pluginId: 'third-party-review',
          mcpServerId: 'third-party-mcp',
        },
        requiredCapabilities: ['sandboxed-mcp-app'],
      },
      availability: {
        state: 'available',
        reason: { code: 'ready', source: 'resolver' },
      },
      clientRendererPresence: 'present',
    };
    catalogMock.entries = [entry] as any;

    const view = render(
      <WorkspacePaneRouteView
        projectSlug="demo"
        descriptorId="pane:plugin%3Athird-party:review:issues"
        instanceId="third-party-issues-1"
      />,
    );
    fireEvent.click(screen.getByTestId('contributed-pane'));
    expect(screen.getByLabelText('Read-only standard data view')).toBeTruthy();

    const replacementContribution = {
      ...firstContribution,
      version: '2.5.0',
      sourceIdentity: {
        ...firstContribution.sourceIdentity,
        source: 'plugins/third-party-review-v2',
      },
    };
    catalogMock.entries = [
      {
        ...entry,
        descriptor: {
          ...entry.descriptor,
          rendererId: 'renderer:third-party:mcp-v2',
          alternativeRenderer: {
            ...entry.descriptor.alternativeRenderer,
            rendererId: 'renderer:third-party:read-only-v2',
            renderer: {
              kind: 'standard-data',
              view: {
                ...entry.descriptor.alternativeRenderer.renderer.view,
                contribution: replacementContribution,
                incarnation: 2,
              },
            },
          },
          lifecycle: { stage: 'stable', since: '2026-08-10' },
        },
        instance: {
          ...entry.instance,
          boundContext: { contribution: replacementContribution },
        },
        selectedRenderer: {
          ...entry.selectedRenderer,
          rendererId: 'renderer:third-party:mcp-v2',
        },
      },
    ] as any;
    view.rerender(
      <WorkspacePaneRouteView
        projectSlug="demo"
        descriptorId="pane:plugin%3Athird-party:review:issues"
        instanceId="third-party-issues-1"
      />,
    );

    expect(screen.getByTestId('contributed-pane')).toBeTruthy();
    expect(screen.queryByLabelText('Read-only standard data view')).toBeNull();

    fireEvent.click(screen.getByTestId('contributed-pane'));
    expect(screen.getByLabelText('Read-only standard data view')).toBeTruthy();
  });

  test.each([
    ['Plan', 'pane:builtin:evidence:plan', 'workspace-plan', 'workspace-plan'],
    [
      'Readiness',
      'pane:builtin:evidence:readiness',
      'workspace-readiness',
      'workspace-readiness',
    ],
    [
      'Trust',
      'pane:builtin:evidence:trust',
      'workspace-trust',
      'workspace-trust',
    ],
  ])(
    'mounts the Project-scoped %s occurrence from its direct link',
    (_name, descriptorId, rendererName, instanceId) => {
      catalogMock.entries = [
        {
          descriptor: {
            id: descriptorId,
            name: _name,
            description: `Inspect ${_name} for this Project.`,
            renderer: { kind: 'builtin-component', name: rendererName },
          },
          instance: { instanceId },
          availability: {
            state: 'available',
            reason: { code: 'ready', source: 'resolver' },
          },
          clientRendererPresence: 'present',
        },
      ] as any;

      render(
        <WorkspacePaneRouteView
          projectSlug="demo"
          descriptorId={descriptorId}
          instanceId={instanceId}
        />,
      );

      expect(screen.getByTestId('mounted-pane').textContent).toContain('demo');
      expect(
        screen.queryByText('Workspace pane needs a selected layout'),
      ).toBeNull();
    },
  );

  test('uses the same unavailable reason and action for a real placed route', () => {
    catalogMock.entries = [
      {
        descriptor: {
          id: 'pane:builtin:workspace-preview:browser-preview',
          name: 'Browser Preview',
          description: 'Inspect a validated local browser preview',
        },
        instance: { instanceId: 'browser-preview-1' },
        availability: {
          state: 'unsupported',
          reason: { code: 'unsupported-host', source: 'native-host' },
          action: { type: 'learn-more', code: 'view-host-requirements' },
        },
        clientRendererPresence: 'present',
      },
    ] as any;
    render(
      <WorkspacePaneRouteView
        projectSlug="demo"
        descriptorId="pane:builtin:workspace-preview:browser-preview"
        instanceId="browser-preview-1"
      />,
    );

    expect(
      screen.getByText('This host does not support this pane.'),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'View host requirements is not available from this screen.',
      ),
    ).toBeTruthy();
  });

  test.each([
    {
      descriptorId: 'pane:builtin:coding',
      rendererName: 'coding',
      instanceId: 'coding-1',
    },
    {
      descriptorId: 'pane:builtin:coding:file-browser',
      rendererName: 'workspace-coding-file-browser',
      instanceId: 'files-1',
    },
    {
      descriptorId: 'pane:builtin:coding:terminal',
      rendererName: 'workspace-coding-terminal',
      instanceId: 'terminal-1',
    },
  ])(
    'does not mount the direct %s pane route without a layout identity',
    ({ descriptorId, rendererName, instanceId }) => {
      catalogMock.entries = [
        {
          descriptor: {
            id: descriptorId,
            name: 'Coding pane',
            description: 'Use the selected Project layout.',
            renderer: {
              kind: 'builtin-component',
              name: rendererName,
            },
          },
          instance: { instanceId },
          availability: {
            state: 'available',
            reason: { code: 'ready', source: 'resolver' },
          },
          clientRendererPresence: 'present',
        },
      ] as any;

      render(
        <WorkspacePaneRouteView
          projectSlug="demo"
          descriptorId={descriptorId}
          instanceId={instanceId}
        />,
      );

      expect(
        screen.getByText('Workspace pane needs a selected layout'),
      ).toBeTruthy();
      expect(screen.queryByTestId('mounted-pane')).toBeNull();
    },
  );

  test.each([
    {
      descriptorId: 'pane:builtin:coding',
      rendererName: 'coding',
      instanceId: 'coding-1',
    },
    {
      descriptorId: 'pane:builtin:coding:file-browser',
      rendererName: 'workspace-coding-file-browser',
      instanceId: 'files-1',
    },
    {
      descriptorId: 'pane:builtin:coding:diff',
      rendererName: 'workspace-coding-diff',
      instanceId: 'diff-1',
    },
    {
      descriptorId: 'pane:builtin:coding:terminal',
      rendererName: 'workspace-coding-terminal',
      instanceId: 'terminal-1',
    },
  ])(
    'mounts the direct %s pane route with its exact layout identity',
    ({ descriptorId, rendererName, instanceId }) => {
      catalogMock.entries = [
        {
          descriptor: {
            id: descriptorId,
            name: 'Coding pane',
            description: 'Use the selected Project layout.',
            renderer: {
              kind: 'builtin-component',
              name: rendererName,
            },
          },
          instance: { instanceId },
          availability: {
            state: 'available',
            reason: { code: 'ready', source: 'resolver' },
          },
          clientRendererPresence: 'present',
        },
      ] as any;

      render(
        <WorkspacePaneRouteView
          projectSlug="demo"
          layoutSlug="coding"
          descriptorId={descriptorId}
          instanceId={instanceId}
        />,
      );

      expect(screen.getByTestId('mounted-pane').textContent).toContain('demo');
      expect(
        screen.queryByText('Workspace pane needs a selected layout'),
      ).toBeNull();
    },
  );
});
