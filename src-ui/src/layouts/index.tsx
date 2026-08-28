import {
  type LayoutComponentRef,
  normalizeLayoutComponentRef,
} from '@kontourai/station-contracts';
import type { AgentQuickPrompt } from '@kontourai/station-contracts/agent';
import type {
  MCPAppDisplayModeDecision,
  MCPAppPanePresentationIdentity,
} from '@kontourai/station-contracts/mcp-app-display-mode';
import { FullScreenError, LayoutHeader } from '@kontourai/station-sdk';
import type { JSX } from 'react';
import { useSyncExternalStore } from 'react';
import { FlowRunConsole } from '../components/flow/FlowRunConsole';
import { MCPToolUIFrame } from '../components/mcp-ui/MCPToolUIFrame';
import { Empty } from '../components/state';
import { useNavigationOptional } from '../contexts/NavigationContext';
import { pluginRegistry } from '../core/PluginRegistry';
import type { AgentSummary, LayoutDefinition, LayoutTab } from '../types';
import { log } from '../utils/logger';

export interface AgentLayoutProps {
  agent?: AgentSummary;
  layout?: LayoutDefinition;
  activeTab?: LayoutTab;
  onLaunchPrompt?: (prompt: AgentQuickPrompt) => void;
  onLaunchWorkflow?: (workflowId: string) => void;
  onShowChat?: () => void;
  onRequestAuth?: () => Promise<boolean>;
  onSendToChat?: (text: string, agent?: string) => void;
/**
* A terminal MCP UI resolver result. This is observational only: the frame
* continues to own resource loading, CSP, sandboxing, and approval policy.
*/
  onMcpUiResolution?: (resolution: {
    ref: string;
    status: 'missing_resource' | 'render_revoked';
  }) => void;
/** Immutable declaration identity that scopes an MCP resolver attempt. */
  mcpUiResolutionIdentity?: string;
  mcpUiPaneIdentity?: MCPAppPanePresentationIdentity;
  mcpUiDisplayMode?: 'inline' | 'fullscreen';
  mcpUiHostAvailableDisplayModes?: readonly ('inline' | 'fullscreen')[];
  onMcpUiRequestDisplayMode?: (mode: 'inline' | 'fullscreen') => boolean;
  onMcpUiDisplayModeDecision?: (decision: MCPAppDisplayModeDecision) => void;
}

export type AgentLayoutComponent = (props: AgentLayoutProps) => JSX.Element;

// Builtin layout components are explicit so plugin names cannot accidentally
// shadow internal surfaces or fall through silently.
const builtinRegistry: Record<string, AgentLayoutComponent> = {};
const loggedComponents = new Set<string>();

const DefaultLayout: AgentLayoutComponent = ({ layout, onShowChat }) => (
  <div className="workspace-default">
    <Empty
      variant="prominent"
      icon={
        <svg
          className="workspace-default__icon"
          aria-hidden="true"
          width="48"
          height="48"
          viewBox="0 0 48 48"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="6" y="10" width="36" height="28" rx="4" />
          <path d="M6 18h36" />
          <circle cx="14" cy="14" r="1.5" fill="currentColor" stroke="none" />
          <circle cx="20" cy="14" r="1.5" fill="currentColor" stroke="none" />
          <circle cx="26" cy="14" r="1.5" fill="currentColor" stroke="none" />
          <path d="M16 28l4-4 3 3 5-5 4 4" opacity="0.5" />
        </svg>
      }
      label={layout?.name || 'Layout'}
      description="Start a conversation or schedule an automated job to get things moving."
      action={
        <button
          type="button"
          className="workspace-default__btn"
          onClick={() => onShowChat?.()}
        >
          Open Chat
        </button>
      }
    />
  </div>
);

const UnsupportedLayoutComponent: AgentLayoutComponent = ({ activeTab }) => {
  const loadStatus = useSyncExternalStore(
    pluginRegistry.subscribe,
    pluginRegistry.getLoadStatus,
  );
  const navigation = useNavigationOptional();
  const component = activeTab?.component;

// A plugin-provided view withheld by the remote-isolation policy is not
// "missing" — naming installation as the cause would send the user to
// reinstall a plugin the server already has. Name the real refusal and
 // offer the same path the chrome banner does (archive#2539).
  if (
    typeof component === 'string' &&
    loadStatus.failure === 'remote-isolation'
  ) {
    return (
      <div className="workspace-default" role="status">
        <Empty
          variant="prominent"
          label="Extensions are disabled for this Station"
          description={`The "${component}" view is provided by an extension. Remote extensions are off for this Station on this device — you can turn them on from the Registry, which explains the trade-off first.`}
          action={
            navigation ? (
              <button
                type="button"
                className="workspace-default__btn"
                onClick={() => navigation.navigate('/registry')}
              >
                Review in Registry
              </button>
            ) : undefined
          }
        />
      </div>
    );
  }

  let detail = 'This layout tab references a component Station cannot render.';

  if (typeof component === 'string') {
    detail = `Plugin layout component "${component}" is not installed or registered.`;
  } else if (component?.kind === 'builtin-component') {
    detail = `Builtin layout component "${component.name}" is not supported.`;
  } else if (component?.kind === 'mcp-tool-ui') {
    detail = `MCP UI layout component "${component.ref}" is not available in this build.`;
  } else if (component && typeof component === 'object') {
    detail = 'This layout tab uses an unsupported layout component reference.';
  }

  return (
    <div className="workspace-default" role="status">
      <Empty
        variant="prominent"
        label="Unsupported layout tab"
        description={detail}
      />
    </div>
  );
};

const MCPToolUILayout: AgentLayoutComponent = ({
  activeTab,
  layout,
  onLaunchPrompt,
  onMcpUiResolution,
  mcpUiResolutionIdentity,
  mcpUiPaneIdentity,
  mcpUiDisplayMode,
  mcpUiHostAvailableDisplayModes,
  onMcpUiRequestDisplayMode,
  onMcpUiDisplayModeDecision,
  ...props
}) => {
  const component = activeTab?.component;
  let normalized: LayoutComponentRef;

  try {
    normalized = normalizeLayoutComponentRef(
      component as string | LayoutComponentRef,
    );
  } catch {
    return <UnsupportedLayoutComponent activeTab={activeTab} />;
  }

  if (normalized.kind !== 'mcp-tool-ui') {
    return <UnsupportedLayoutComponent activeTab={activeTab} />;
  }

  const fallbackComponentName =
    typeof (normalized as { fallbackComponent?: unknown }).fallbackComponent ===
    'string'
      ? (normalized as { fallbackComponent: string }).fallbackComponent
      : undefined;
  const fallbackComponent = fallbackComponentName
    ? pluginRegistry.getLayout(fallbackComponentName)
    : undefined;
  const renderFallback = fallbackComponent
    ? () => {
        const FallbackComponent = fallbackComponent as AgentLayoutComponent;
        return (
          <FallbackComponent
            layout={layout}
            activeTab={activeTab}
            onLaunchPrompt={onLaunchPrompt}
            {...props}
          />
        );
      }
    : undefined;

  return (
    <MCPToolUIFrame
      component={normalized}
      fallbackComponent={renderFallback}
      fallbackComponentName={
        fallbackComponent ? fallbackComponentName : undefined
      }
      onResolutionStatus={onMcpUiResolution}
      resolutionIdentity={mcpUiResolutionIdentity}
      paneIdentity={mcpUiPaneIdentity}
      currentDisplayMode={mcpUiDisplayMode}
      hostAvailableDisplayModes={mcpUiHostAvailableDisplayModes}
      onRequestDisplayMode={onMcpUiRequestDisplayMode}
      onDisplayModeDecision={onMcpUiDisplayModeDecision}
    />
  );
};

type KitLayoutDefinition = LayoutDefinition & {
  kit?: {
    contributionRef?: string;
    standardViews?: Array<{
      tabId?: string;
      projection?: string;
      schemaRef?: string;
      readOnly?: boolean;
    }>;
  };
};

/**
 * The standard-view fallback renders declaration metadata only. React text
 * rendering escapes every value, and this component has no action, tool, or
 * iframe capability. MCP app views continue through MCPToolUIFrame.
 */
const KitStandardViewLayout: AgentLayoutComponent = ({ layout, activeTab }) => {
  const kit = (layout as KitLayoutDefinition | undefined)?.kit;
  const view = kit?.standardViews?.find(
    (candidate) => candidate.tabId === activeTab?.id,
  );

  if (view?.readOnly !== true) {
    return <UnsupportedLayoutComponent activeTab={activeTab} />;
  }

  return (
    <section className="workspace-default" aria-label="Read-only Kit view">
      <Empty
        variant="prominent"
        label={view.projection || 'Read-only Kit view'}
        description="Station shows this Kit view as read-only information. Nothing here can be changed."
      />
      <pre className="workspace-default__description">
        {JSON.stringify(
          {
            contribution: kit?.contributionRef,
            projection: view.projection,
            schemaRef: view.schemaRef,
            readOnly: true,
          },
          null,
          2,
        )}
      </pre>
    </section>
  );
};

builtinRegistry.default = DefaultLayout;
// Project-wide Flow run console : include in a layout via
// { kind: 'builtin-component', name: 'flow-run-console' }.
builtinRegistry['flow-run-console'] = () => <FlowRunConsole />;
builtinRegistry['kit-standard-view'] = KitStandardViewLayout;

/**
 * Reports only whether this UI build has a renderer dispatch branch for a
 * declared component. MCP host support is distinct from a tool's permission
 * or health, which remain resolver-owned facts.
 */
export function clientLayoutRendererPresence(
  component: string | LayoutComponentRef,
): 'present' | 'missing' {
  let normalized: LayoutComponentRef;
  try {
    normalized = normalizeLayoutComponentRef(component);
  } catch {
    return 'missing';
  }
  switch (normalized.kind) {
    case 'builtin-component':
      return builtinRegistry[normalized.name] ? 'present' : 'missing';
    case 'plugin-component':
      return pluginRegistry.getLayout(normalized.name) ? 'present' : 'missing';
    case 'mcp-tool-ui':
// MCPToolUILayout is an explicit host branch; this says nothing about
// the MCP tool's own permission or availability.
      return 'present';
  }
}

function resolvePluginLayoutComponent(
  componentId: string,
): AgentLayoutComponent {
  const pluginComponent = pluginRegistry.getLayout(componentId);
  if (pluginComponent) {
    if (!loggedComponents.has(componentId)) {
      log.plugin(`Loaded layout component: ${componentId}`);
      loggedComponents.add(componentId);
    }
    return pluginComponent as AgentLayoutComponent;
  }

  return UnsupportedLayoutComponent;
}

function resolveLayoutComponent(
  component?: string | LayoutComponentRef,
): AgentLayoutComponent {
  if (!component) return DefaultLayout;

  let normalized: LayoutComponentRef;
  try {
    normalized = normalizeLayoutComponentRef(component);
  } catch {
    return UnsupportedLayoutComponent;
  }

  switch (normalized.kind) {
    case 'plugin-component':
      return resolvePluginLayoutComponent(normalized.name);
    case 'builtin-component':
      return builtinRegistry[normalized.name] ?? UnsupportedLayoutComponent;
    case 'mcp-tool-ui':
      return MCPToolUILayout;
    default:
      return UnsupportedLayoutComponent;
  }
}

interface LayoutRendererProps extends AgentLayoutProps {
  componentId?: string | LayoutComponentRef;
  onRefresh?: () => void;
  loading?: boolean;
  activeTabId?: string;
  onTabChange?: (tabId: string) => void;
  refreshKey?: number;
/** Exact direct-pane plugin component already authorized by its occurrence. */
  trustedPluginLayout?: AgentLayoutComponent;
}

export function LayoutRenderer({
  componentId,
  layout,
  activeTab,
  onRefresh,
  loading,
  activeTabId,
  onTabChange,
  onLaunchPrompt,
  refreshKey = 0,
  trustedPluginLayout,
  ...props
}: LayoutRendererProps) {
// Re-resolve the component when the plugin registry's status changes: a
// live registry reload (e.g. consent granted without a page reload) must
// swap a mounted fallback for the newly registered layout instead of
// stranding the stale selection.
  useSyncExternalStore(pluginRegistry.subscribe, pluginRegistry.getLoadStatus);
  try {
    return (
      <>
        {layout && (
          <LayoutHeader
            layoutName={layout.name}
            tabs={layout.tabs?.map((tab) => ({
              id: tab.id,
              label: tab.label,
              icon: tab.icon,
            }))}
            activeTabId={activeTabId}
            onTabChange={onTabChange}
            actions={layout.actions}
            layoutPrompts={layout.globalSkills}
            onLayoutPromptSelect={onLaunchPrompt}
            onLaunchAction={
              onLaunchPrompt
                ? (action) =>
                    onLaunchPrompt({
                      id: action.data,
                      label: action.label,
                      prompt:
                        action.type === 'inline-prompt'
                          ? action.data
                          : action.label,
                    })
                : undefined
            }
            title={activeTab?.label || layout.name}
            description={activeTab?.description || layout.description || ''}
            tabActions={activeTab?.actions as any}
            tabPrompts={activeTab?.skills as any}
            onTabPromptSelect={
              onLaunchPrompt
                ? (action: any) =>
                    onLaunchPrompt({
                      id: action.data || action.id,
                      label: action.label,
                      prompt:
                        action.type === 'inline-prompt'
                          ? action.data
                          : action.prompt || action.label,
                    })
                : undefined
            }
            onRefresh={onRefresh}
            loading={loading}
          />
        )}
        {layout?.tabs
          ? // Only mount the active tab to avoid duplicate data fetching
            layout.tabs.map((tab) => {
              const isActive = tab.id === activeTabId;
              if (!isActive) return null;
              const Component =
                trustedPluginLayout ?? resolveLayoutComponent(tab.component);
              return (
                <div key={tab.id} className="workspace-tab-content">
                  <Component
                    key={`${tab.id}-${refreshKey}`}
                    layout={layout}
                    activeTab={tab}
                    onLaunchPrompt={onLaunchPrompt}
                    {...props}
                  />
                </div>
              );
            })
          : // Fallback for layouts without tabs
            (() => {
              const Component = resolveLayoutComponent(componentId);
              return (
                <Component
                  key={refreshKey}
                  layout={layout}
                  activeTab={activeTab}
                  onLaunchPrompt={onLaunchPrompt}
                  {...props}
                />
              );
            })()}
      </>
    );
  } catch (error) {
    log.api('Error rendering layout:', error);
    return (
      <FullScreenError
        title="Error loading layout"
        description="Something unexpected happened while rendering this layout."
        onRetry={() => window.location.reload()}
      />
    );
  }
}
