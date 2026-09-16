/**
 * @vitest-environment jsdom
 */

import { act, render, screen } from '@testing-library/react';
import type { JSX } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { LayoutDefinition } from '../types';

const { getLayoutMock } = vi.hoisted(() => ({
  getLayoutMock: vi.fn(),
}));

// Mutable registry status the mocked pluginRegistry serves; tests reassign it
// (and call notifyRegistryListeners) to exercise live registry transitions.
let registryLoadStatus: {
  state: string;
  failedPluginNames: string[];
  failure?: string;
} = { state: 'loaded', failedPluginNames: [] };
const registryListeners = new Set<() => void>();
function notifyRegistryListeners() {
  for (const listener of registryListeners) listener();
}

const { mcpToolUIFrameMock } = vi.hoisted(() => ({
  mcpToolUIFrameMock: vi.fn(),
}));

// The header renders what it is GIVEN, so the double renders the tab quick
// actions it receives: that is the value the renderer has to hand across, and
// the SDK's own LayoutHeader suite owns how the dropdown looks.
vi.mock('@kontourai/station-sdk', () => ({
  FullScreenError: ({ title }: { title: string }) => <div>{title}</div>,
  LayoutHeader: ({
    title,
    tabPrompts,
  }: {
    title: string;
    tabPrompts?: Array<{ id?: string; label: string; data?: string }>;
  }) => (
    <header>
      {title}
      {tabPrompts?.map((entry) => (
        <button type="button" key={entry.id ?? entry.data ?? entry.label}>
          {entry.label}
        </button>
      ))}
    </header>
  ),
}));

vi.mock('../core/PluginRegistry', () => ({
  pluginRegistry: {
    getLayout: getLayoutMock,
    subscribe: (listener: () => void) => {
      registryListeners.add(listener);
      return () => registryListeners.delete(listener);
    },
    getLoadStatus: () => registryLoadStatus,
  },
}));

vi.mock('../components/mcp-ui/MCPToolUIFrame', () => ({
  MCPToolUIFrame: mcpToolUIFrameMock,
}));

const { flowRunConsoleMock } = vi.hoisted(() => ({
  flowRunConsoleMock: vi.fn(),
}));
vi.mock('../components/flow/FlowRunConsole', () => ({
  FlowRunConsole: (props: { projectSlug?: string }) => {
    flowRunConsoleMock(props);
    return <div>Flow run console rendered</div>;
  },
}));

vi.mock('@/utils/logger', () => ({
  log: {
    api: vi.fn(),
    plugin: vi.fn(),
  },
}));

import { LayoutRenderer } from '../layouts';
import { layoutWorkspaceShape } from '../views/layout-workspace-shape';

function PluginLayout() {
  return <div>Plugin layout rendered</div>;
}

function FallbackLayout() {
  return <div>Fallback layout rendered</div>;
}

function renderSingleTab(
  component: LayoutDefinition['tabs'][number]['component'],
) {
  const layout: LayoutDefinition = {
    name: 'Dispatch Test Layout',
    slug: 'dispatch-test',
    tabs: [
      {
        id: 'main',
        label: 'Main',
        component,
      },
    ],
  };

  render(
    <LayoutRenderer
      layout={layout}
      activeTab={layout.tabs[0]}
      activeTabId="main"
    />,
  );
}

describe('LayoutRenderer component dispatch', () => {
  beforeEach(() => {
    registryLoadStatus = { state: 'loaded', failedPluginNames: [] };
    getLayoutMock.mockReset();
    mcpToolUIFrameMock.mockReset();
    mcpToolUIFrameMock.mockImplementation(
      ({
        component,
        fallbackComponent: FallbackComponent,
        fallbackComponentName,
      }: {
        component: { ref: string };
        fallbackComponent?: () => JSX.Element;
        fallbackComponentName?: string;
      }) => (
        <div>
          <div>MCP frame rendered: {component.ref}</div>
          {fallbackComponentName ? (
            <div>Fallback name: {fallbackComponentName}</div>
          ) : null}
          {FallbackComponent ? <FallbackComponent /> : null}
        </div>
      ),
    );
  });

  test('renders legacy string components through the plugin registry', () => {
    getLayoutMock.mockReturnValue(PluginLayout);

    renderSingleTab('legacy-layout');

    expect(getLayoutMock).toHaveBeenCalledWith('legacy-layout');
    expect(screen.getByText('Plugin layout rendered')).toBeTruthy();
  });

  test('does not classify a declared plugin component as unsupported before the lazy registry settles', () => {
    registryLoadStatus = { state: 'loading', failedPluginNames: [] };
    getLayoutMock.mockReturnValue(undefined);

    renderSingleTab('knowledge-library');

    expect(
      screen.getByRole('status', { name: 'Loading extension layout' }),
    ).toBeTruthy();
    expect(screen.queryByText('Unsupported layout tab')).toBeNull();

    getLayoutMock.mockReturnValue(PluginLayout);
    act(() => {
      registryLoadStatus = { state: 'ready', failedPluginNames: [] };
      notifyRegistryListeners();
    });

    expect(screen.getByText('Plugin layout rendered')).toBeTruthy();
    expect(
      screen.queryByRole('status', { name: 'Loading extension layout' }),
    ).toBeNull();
  });

  test('names the remote-isolation refusal for a plugin view instead of claiming it is uninstalled', () => {
    // The plugin IS installed server-side; its bundle was refused by policy.
    // The slot must say so (archive#2539 phone report) — and render without a
    // NavigationProvider (the action is simply absent then).
    registryLoadStatus = {
      state: 'degraded',
      failedPluginNames: [],
      failure: 'remote-isolation',
    };
    getLayoutMock.mockReturnValue(undefined);

    renderSingleTab('knowledge-sources');

    expect(
      screen.getByText('Extensions are disabled for this Station'),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'The "knowledge-sources" view is provided by an extension. Remote extensions are off for this Station on this device — you can turn them on from the Registry, which explains the trade-off first.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/not installed or registered/)).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Review in Registry' }),
    ).toBeNull();
  });

  test('keeps the uninstalled wording when the registry loaded without refusal', () => {
    getLayoutMock.mockReturnValue(undefined);

    renderSingleTab('knowledge-sources');

    expect(
      screen.getByText(
        'Plugin layout component "knowledge-sources" is not installed or registered.',
      ),
    ).toBeTruthy();
  });

  test('a live registry reload swaps a mounted fallback for the registered layout', () => {
    // Consent granted without a page reload: the registry re-initializes,
    // registers the plugin, and notifies — the stranded fallback must
    // re-resolve into the real component.
    registryLoadStatus = {
      state: 'degraded',
      failedPluginNames: [],
      failure: 'remote-isolation',
    };
    getLayoutMock.mockReturnValue(undefined);

    renderSingleTab('knowledge-sources');
    expect(
      screen.getByText('Extensions are disabled for this Station'),
    ).toBeTruthy();

    act(() => {
      registryLoadStatus = { state: 'loaded', failedPluginNames: [] };
      getLayoutMock.mockReturnValue(PluginLayout);
      notifyRegistryListeners();
    });

    expect(screen.getByText('Plugin layout rendered')).toBeTruthy();
    expect(
      screen.queryByText('Extensions are disabled for this Station'),
    ).toBeNull();
  });

  test('renders structured plugin refs through the plugin registry', () => {
    getLayoutMock.mockReturnValue(PluginLayout);

    renderSingleTab({ kind: 'plugin-component', name: 'structured-layout' });

    expect(getLayoutMock).toHaveBeenCalledWith('structured-layout');
    expect(screen.getByText('Plugin layout rendered')).toBeTruthy();
  });

  test('renders explicitly allowlisted builtin components without plugin lookup', () => {
    renderSingleTab({ kind: 'builtin-component', name: 'default' });

    expect(getLayoutMock).not.toHaveBeenCalled();
    expect(screen.getByText('Dispatch Test Layout')).toBeTruthy();
    expect(screen.getByText('Open Chat')).toBeTruthy();
  });

  test('renders unsupported state for unknown builtin components', () => {
    renderSingleTab({ kind: 'builtin-component', name: 'not-registered' });

    expect(getLayoutMock).not.toHaveBeenCalled();
    expect(screen.getByText('Unsupported layout tab')).toBeTruthy();
    expect(
      screen.getByText(
        'Builtin layout component "not-registered" is not supported.',
      ),
    ).toBeTruthy();
  });

  test('renders unsupported state for unknown component kinds', () => {
    renderSingleTab({ kind: 'future-component', name: 'later' } as any);

    expect(getLayoutMock).not.toHaveBeenCalled();
    expect(screen.getByText('Unsupported layout tab')).toBeTruthy();
    expect(
      screen.getByText(
        'This layout tab uses an unsupported layout component reference.',
      ),
    ).toBeTruthy();
  });

  test('renders MCP dispatch through the MCP UI frame without plugin lookup', () => {
    renderSingleTab({ kind: 'mcp-tool-ui', ref: 'server/tool' });

    expect(getLayoutMock).not.toHaveBeenCalled();
    expect(mcpToolUIFrameMock).toHaveBeenCalledWith(
      expect.objectContaining({
        component: { kind: 'mcp-tool-ui', ref: 'server/tool' },
      }),
      undefined,
    );
    expect(screen.getByText('MCP frame rendered: server/tool')).toBeTruthy();
  });

  test('passes resolved plugin fallback component to the MCP UI frame', () => {
    getLayoutMock.mockReturnValue(FallbackLayout);

    renderSingleTab({
      kind: 'mcp-tool-ui',
      ref: 'server/tool',
      fallbackComponent: 'plugin-fallback',
    } as any);

    expect(getLayoutMock).toHaveBeenCalledWith('plugin-fallback');
    expect(mcpToolUIFrameMock).toHaveBeenCalledWith(
      expect.objectContaining({
        component: {
          kind: 'mcp-tool-ui',
          ref: 'server/tool',
          fallbackComponent: 'plugin-fallback',
        },
        fallbackComponent: expect.any(Function),
        fallbackComponentName: 'plugin-fallback',
      }),
      undefined,
    );
    expect(screen.getByText('Fallback layout rendered')).toBeTruthy();
  });

  test('renders a standard Kit view as escaped, read-only metadata', () => {
    const layout: LayoutDefinition & {
      kit: {
        contributionRef: string;
        standardViews: Array<{
          tabId: string;
          projection: string;
          schemaRef: string;
          readOnly: boolean;
        }>;
      };
    } = {
      name: 'Kit layout',
      slug: 'kit-layout',
      tabs: [
        {
          id: 'kit-standard-1',
          label: 'Summary',
          component: { kind: 'builtin-component', name: 'kit-standard-view' },
        },
      ],
      kit: {
        contributionRef: '<untrusted-kit>',
        standardViews: [
          {
            tabId: 'kit-standard-1',
            projection: '<summary>',
            schemaRef: 'https://example.test/schema',
            readOnly: true,
          },
        ],
      },
    };

    render(
      <LayoutRenderer
        layout={layout}
        activeTab={layout.tabs[0]}
        activeTabId="kit-standard-1"
      />,
    );

    const view = screen.getByLabelText('Read-only Kit view');
    expect(view).toBeTruthy();
    expect(screen.getByText('<summary>')).toBeTruthy();
    expect(view.querySelector('pre')?.textContent).toContain('<untrusted-kit>');
    expect(mcpToolUIFrameMock).not.toHaveBeenCalled();
  });
  // The chain a tab quick action travels: LayoutView maps the stored config to
  // `tabs[].skills`, LayoutRenderer hands that to LayoutHeader, and the header
  // opens a dropdown for it. The rename broke the middle of that chain and
  // nothing noticed, because a missing quick action renders as nothing at all
  //
  test('a tab skill is offered as a quick action', () => {
    const layout: LayoutDefinition = {
      name: 'Quick Action Layout',
      slug: 'quick-action',
      tabs: [
        {
          id: 'main',
          label: 'Main',
          component: 'legacy-layout',
          skills: [
            {
              type: 'prompt',
              label: 'Summarise the day',
              data: 'summarise',
            },
          ],
        },
      ],
    };
    getLayoutMock.mockReturnValue(PluginLayout);

    render(
      <LayoutRenderer
        layout={layout}
        activeTab={layout.tabs[0]}
        activeTabId="main"
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Summarise the day' }),
    ).toBeTruthy();
  });

  // The retired key must not keep working by accident.
  test('a tab still carrying the retired prompts key offers no quick actions', () => {
    const layout = {
      name: 'Retired Key Layout',
      slug: 'retired-key',
      tabs: [
        {
          id: 'main',
          label: 'Main',
          component: 'legacy-layout',
          prompts: [
            { type: 'prompt', label: 'Summarise the day', data: 'summarise' },
          ],
        },
      ],
    } as unknown as LayoutDefinition;
    getLayoutMock.mockReturnValue(PluginLayout);

    render(
      <LayoutRenderer
        layout={layout}
        activeTab={layout.tabs[0]}
        activeTabId="main"
      />,
    );

    expect(
      screen.queryByRole('button', { name: 'Summarise the day' }),
    ).toBeNull();
  });
});

/**
 * #2090 — a layout tab whose plugin the viewer cannot see.
 *
 * Driven through the REAL `layoutWorkspaceShape` and the REAL
 * `LayoutRenderer`, deliberately: `LayoutView.test.tsx` and
 * `PersonalBoardView.test.tsx` both STUB the renderer, so a test at those
 * layers proves nothing about the branch that renders.
 */
describe('a layout tab the server would not describe', () => {
  const HIDDEN_PLUGIN = 'secret-notes';

  function renderWithVerdict(
    paneReferences: { unavailableTabIds: readonly string[] } | undefined,
    tabs: Array<Record<string, unknown>>,
  ) {
    const shape = layoutWorkspaceShape(
      {
        slug: 'plugin-layout',
        name: 'Plugin layout',
        config: { tabs },
        ...(paneReferences ? { paneReferences } : {}),
      },
      {
        annotateAgentRef: (item) => item,
        reviewPluginAction: (item) => item,
        hostOwnsGlobalActions: false,
      },
    );
    render(
      <LayoutRenderer
        layout={shape as unknown as LayoutDefinition}
        activeTab={shape?.tabs[0] as never}
        activeTabId={shape?.tabs[0]?.id}
      />,
    );
  }

  test('renders one causeless sentence instead of a false cause', () => {
    // The bundle never loaded, so without the verdict this slot resolves to
    // the unsupported placeholder and asserts a cause the server never
    // derived and that is FALSE — the plugin is installed.
    getLayoutMock.mockReturnValue(undefined);

    renderWithVerdict({ unavailableTabIds: ['notes'] }, [
      { id: 'notes', label: 'Notes', component: 'notes-view' },
    ]);

    expect(screen.getByText('This tab is not available.')).toBeTruthy();
    const rendered = document.body.textContent ?? '';
    for (const forbidden of [
      'not installed',
      'reinstall',
      'operator',
      'Operator',
      'Settings',
      'registered',
      HIDDEN_PLUGIN,
    ]) {
      expect(rendered).not.toContain(forbidden);
    }
  });

  test('the same tab WITHOUT the verdict still reads as uninstalled', () => {
    // The control, and the reason the branch above is load-bearing: this is
    // exactly the sentence #2090 exists to replace, still produced when no
    // verdict says otherwise.
    getLayoutMock.mockReturnValue(undefined);

    renderWithVerdict(undefined, [
      { id: 'notes', label: 'Notes', component: 'notes-view' },
    ]);

    expect(
      screen.getByText(
        'Plugin layout component "notes-view" is not installed or registered.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('This tab is not available.')).toBeNull();
  });

  test('a tab the verdict does not name renders its component', () => {
    getLayoutMock.mockReturnValue(PluginLayout);

    renderWithVerdict({ unavailableTabIds: ['other'] }, [
      { id: 'notes', label: 'Notes', component: 'notes-view' },
    ]);

    expect(screen.getByText('Plugin layout rendered')).toBeTruthy();
    expect(screen.queryByText('This tab is not available.')).toBeNull();
  });

  /**
   * #2157 review M1: `SDKAdapter`'s `boundProjectSlug` rewrites the SDK's
   * navigation, which plugin tabs read — but the built-in `flow-run-console`
   * tab reads the UI's own `NavigationContext`, so a docked Layout of
   * project B carrying it showed project A's runs. The registry entry now
   * passes the renderer's `boundProjectSlug` through; reverting it to the
   * bare `<FlowRunConsole />` reds the first assertion. The second is the
   * route-bound hosts' contract: no prop, no rewrite.
   */
  test('the flow-run-console tab receives the host-bound project, and none when the host binds none', () => {
    const layout: LayoutDefinition = {
      name: 'Runs',
      slug: 'runs',
      tabs: [
        {
          id: 'runs',
          label: 'Runs',
          component: { kind: 'builtin-component', name: 'flow-run-console' },
        },
      ],
    };
    render(
      <LayoutRenderer
        layout={layout}
        activeTab={layout.tabs[0]}
        activeTabId="runs"
        boundProjectSlug="beta"
      />,
    );
    expect(screen.getByText('Flow run console rendered')).toBeTruthy();
    expect(flowRunConsoleMock).toHaveBeenLastCalledWith({
      projectSlug: 'beta',
    });

    flowRunConsoleMock.mockClear();
    render(
      <LayoutRenderer
        layout={layout}
        activeTab={layout.tabs[0]}
        activeTabId="runs"
      />,
    );
    expect(flowRunConsoleMock).toHaveBeenLastCalledWith({
      projectSlug: undefined,
    });
  });

  test('an `unavailable` flag persisted into a stored tab cannot forge one', () => {
    // The flag is a RESPONSE verdict. `layoutWorkspaceShape` builds each tab
    // explicitly and never copies a stored value, which is what stops a
    // caller writing `config.tabs[0].unavailable` into their own record and
    // having it honoured.
    getLayoutMock.mockReturnValue(PluginLayout);

    renderWithVerdict(undefined, [
      {
        id: 'notes',
        label: 'Notes',
        component: 'notes-view',
        unavailable: true,
      },
    ]);

    expect(screen.getByText('Plugin layout rendered')).toBeTruthy();
    expect(screen.queryByText('This tab is not available.')).toBeNull();
  });
});
