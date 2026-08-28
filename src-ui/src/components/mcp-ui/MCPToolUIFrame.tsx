import type {
  MCPToolRefParts,
  MCPToolUILayoutComponentRef,
} from '@kontourai/station-contracts/layout';
import { parseMcpToolRef } from '@kontourai/station-contracts/layout';
import {
  type MCPAppDisplayModeDecision,
  type MCPAppPanePresentationIdentity,
  mcpAppHostAvailableDisplayModes,
  mediateMcpAppDisplayMode,
} from '@kontourai/station-contracts/mcp-app-display-mode';
import {
  deriveSessionWorkItemGithubUrl,
  SESSION_INVENTORY_CURRENT_GROUP_IDS,
} from '@kontourai/station-contracts/session-inventory';
import {
  parseStationSessionInventoryMcpV2Envelope,
  parseStationSessionInventoryMcpV2Input,
} from '@kontourai/station-contracts/session-inventory-mcp';
import type {
  MCPToolUIPermissions,
  MCPToolUIResolutionStatus,
} from '@kontourai/station-shared/mcp';
import type { MCPToolUICsp } from '@kontourai/station-shared/mcp-ui-csp';
import { buildMcpUiCsp } from '@kontourai/station-shared/mcp-ui-csp';
import type {
  McpUiHostContext,
  McpUiStyles,
} from '@modelcontextprotocol/ext-apps';
import {
  AppBridge,
  buildAllowAttribute,
  PostMessageTransport,
} from '@modelcontextprotocol/ext-apps/app-bridge';
import type {
  CallToolResult,
  ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js';
import { useQuery } from '@tanstack/react-query';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  useApiBase,
  useHostRequestAuthorityScope,
} from '../../contexts/ApiBaseContext';
import { useConfig } from '../../contexts/ConfigContext';
import { useDeviceSettings } from '../../contexts/DeviceSettingsContext';
import {
  type ApiEnvelope,
  apiRequest,
  unwrapApiData,
} from '../../lib/apiClient';
import { nativePlatformPromise } from '../../platform/native';
import { usePlatformProfile } from '../../platform/PlatformProfileContext';
import { ConfirmModal } from '../modals/ConfirmModal';
import './MCPToolUIFrame.css';

interface MCPToolUIResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  truncated?: boolean;
  _meta?: Record<string, unknown>;
  ui?: {
    csp?: MCPToolUICsp;
    permissions?: MCPToolUIPermissions;
  };
}

interface MCPToolUIResolution {
  status: MCPToolUIResolutionStatus | 'error';
  ref: string;
  serverId?: string;
  toolName?: string;
  resourceUri?: string;
  url?: string;
  reason?: string;
}

type MCPToolUIFrameStatus = MCPToolUIResolution['status'] | 'loading';
type FallbackComponent = ReactNode | (() => ReactNode);

/**
 * The open-link boundary is intentionally reconstructed from the current
 * structured result, never from an App request or a provider-shaped field.
 */
export type SessionInventoryV2OpenLinkCapability = {
  occurrenceId: string;
  scopeKey: string;
  urls: ReadonlySet<string>;
};

export function sessionInventoryV2OpenLinkCapability(
  result: unknown,
  input: unknown,
): SessionInventoryV2OpenLinkCapability | null {
  const negotiated = parseStationSessionInventoryMcpV2Input(input);
  const envelope = parseStationSessionInventoryMcpV2Envelope(
    (result as { structuredContent?: unknown } | null)?.structuredContent,
  );
  if (
    !negotiated ||
    !envelope ||
    JSON.stringify(negotiated.scope) !==
      JSON.stringify(
        envelope.kind === 'projection'
          ? envelope.projection.scope
          : envelope.page.scope,
      )
  )
    return null;
  if (
    (negotiated.operation === 'open' && envelope.kind !== 'projection') ||
    (negotiated.operation === 'page' &&
      (envelope.kind !== 'group-page' ||
        envelope.page.group.id !== negotiated.groupId))
  )
    return null;
  const capability = (result as { _meta?: Record<string, unknown> } | null)
    ?._meta?.['station.session-inventory-app/v2'];
  const capabilityRecord =
    capability && typeof capability === 'object' && !Array.isArray(capability)
      ? (capability as Record<string, unknown>)
      : null;
  const continuations = capabilityRecord?.continuations;
  if (
    !capabilityRecord ||
    !/^[A-Za-z0-9_-]{24,128}$/.test(capabilityRecord.occurrenceId as string) ||
    !Array.isArray(continuations) ||
    continuations.length > SESSION_INVENTORY_CURRENT_GROUP_IDS.length ||
    !continuations.every(
      (entry) =>
        !!entry &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        SESSION_INVENTORY_CURRENT_GROUP_IDS.includes(
          (entry as Record<string, unknown>).groupId as never,
        ) &&
        /^[A-Za-z0-9_-]{24,128}$/.test(
          (entry as Record<string, unknown>).continuationToken as string,
        ),
    )
  )
    return null;
  if (
    negotiated.operation === 'page' &&
    capabilityRecord.occurrenceId !== negotiated.occurrenceId
  )
    return null;
  const groups =
    envelope.kind === 'projection'
      ? envelope.projection.groups
      : [envelope.page.group];
  const urls = new Set<string>();
  for (const group of groups)
    for (const row of group.items)
      if (row.kind === 'station-session-work-item') {
        const url = deriveSessionWorkItemGithubUrl(row);
        if (url) urls.add(url);
      }
  return {
    occurrenceId: capabilityRecord.occurrenceId as string,
    scopeKey: JSON.stringify(negotiated.scope),
    urls,
  };
}

export interface MCPToolUIFrameProps {
  component: MCPToolUILayoutComponentRef;
  fallbackComponent?: FallbackComponent;
  fallbackComponentName?: string;
  /**
   * Observes a terminal resolver result without changing the hardened MCP
   * rendering path. Hosts may use this fact to select a separately declared,
   * inert alternative; they never receive resource contents or an approval
   * bypass through this callback.
   */
  onResolutionStatus?: (resolution: {
    ref: string;
    status: 'missing_resource' | 'render_revoked';
  }) => void;
  /**
   * Immutable host-supplied identity for this resolution attempt. It scopes
   * React Query's resolver result to the exact pane declaration that asked for
   * it, so a lifecycle replacement cannot reuse an earlier terminal result.
   */
  resolutionIdentity?: string;
  /** Exact host occurrence; display requests may change presentation only. */
  paneIdentity?: MCPAppPanePresentationIdentity;
  currentDisplayMode?: 'inline' | 'fullscreen';
  hostAvailableDisplayModes?: readonly ('inline' | 'fullscreen')[];
  onRequestDisplayMode?: (mode: 'inline' | 'fullscreen') => boolean;
  /** Receipt seam for host policy/operational evidence. */
  onDisplayModeDecision?: (decision: MCPAppDisplayModeDecision) => void;
  apiBase?: string;
  /**
   * Code-issued only: permits the exact continuation call for Station's whole
   * Task Basis App. This is intentionally not expressible in a layout manifest.
   */
  basisReadSession?: {
    serverId: 'station-control';
    toolName: 'get_task_basis';
    taskId: string;
  };
  /**
   * Semantic host-owned external navigation. Absence means denied; Apps never
   * receive browser opener authority directly.
   */
  openExternalLink?: (url: string) => Promise<boolean>;
}

async function semanticHostExternalLink(url: string): Promise<boolean> {
  const native = await nativePlatformPromise;
  if (native.platform === 'tauri') return native.openExternalLink(url);
  // Top-level navigation is the web platform's semantic external navigation;
  // it retains mobile browser gesture and history semantics without popups.
  window.location.assign(url);
  return true;
}

const STATUS_COPY: Record<
  MCPToolUIFrameStatus,
  { title: string; description: string }
> = {
  loading: {
    title: 'Loading MCP UI',
    description: 'Resolving the MCP tool UI resource.',
  },
  invalid_ref: {
    title: 'Invalid MCP UI reference',
    description: 'References look like serverId/toolName.',
  },
  missing_server: {
    title: 'MCP server unavailable',
    description: 'The referenced MCP server is not installed or connected.',
  },
  missing_tool: {
    title: 'MCP tool unavailable',
    description: 'The referenced tool was not discovered for this MCP server.',
  },
  missing_resource: {
    title: 'MCP UI resource missing',
    description: 'This MCP tool doesn’t provide a screen to show.',
  },
  render_revoked: {
    title: 'Rendering disabled for this server',
    description:
      'An operator disabled MCP-UI rendering for this server. Re-enable it in the integration settings.',
  },
  unsupported: {
    title: 'MCP UI unsupported',
    description: 'The resolved MCP UI resource cannot be rendered safely here.',
  },
  success: {
    title: 'MCP UI resource resolved',
    description:
      'Remote MCP UI resources are unsupported until Station has a trusted host security model.',
  },
  error: {
    title: 'MCP UI failed to load',
    description: 'The resolver returned an unexpected error.',
  },
};

export function MCPToolUIFrame({
  component,
  fallbackComponent,
  fallbackComponentName,
  onResolutionStatus,
  resolutionIdentity,
  paneIdentity,
  currentDisplayMode,
  hostAvailableDisplayModes,
  onRequestDisplayMode,
  onDisplayModeDecision,
  apiBase,
  basisReadSession,
  openExternalLink = semanticHostExternalLink,
}: MCPToolUIFrameProps) {
  const apiContext = useApiBase();
  const config = useConfig();
  const platform = usePlatformProfile();
  const requestAuthority = useHostRequestAuthorityScope();
  const nativeIframeBlocked = platform.isTauri;
  // MCP-UI host renders by default; operators opt out with `mcpUiHost: false`.
  const hostEnabled = config?.mcpUiHost !== false;
  const baseUrl = apiBase ?? apiContext.apiBase;
  const refParts = parseMcpToolRef(component.ref);

  const resolution = useQuery<MCPToolUIResolution>({
    queryKey: ['mcp-tool-ui', component.ref, resolutionIdentity, baseUrl],
    queryFn: () =>
      fetchMCPToolUIResolution(baseUrl, refParts as MCPToolRefParts),
    enabled: !!refParts && !nativeIframeBlocked,
    retry: false,
  });

  const shouldTryEmbeddedPresentation =
    hostEnabled &&
    !!refParts &&
    resolution.data?.status === 'missing_resource' &&
    component.approvalPolicy === 'read-only';

  useEffect(() => {
    const status = resolution.data?.status;
    if (
      nativeIframeBlocked ||
      (status !== 'missing_resource' && status !== 'render_revoked')
    )
      return;
    // A read-only pin has another eligible, hardened presentation path. Its
    // resolver result becomes terminal only if that embedded path also fails.
    if (shouldTryEmbeddedPresentation) return;
    onResolutionStatus?.({ ref: component.ref, status });
  }, [
    component.ref,
    nativeIframeBlocked,
    onResolutionStatus,
    resolution.data?.status,
    shouldTryEmbeddedPresentation,
  ]);

  if (nativeIframeBlocked) {
    return (
      <MCPToolUIStatus
        status="unsupported"
        ref={component.ref}
        reason="Scripted MCP UI frames are unavailable in Station native shells because the embedded WebView exposes host IPC to subframes. Open this content in the web client instead."
        approvalPolicy={component.approvalPolicy}
        fallbackComponent={fallbackComponent}
        fallbackComponentName={fallbackComponentName}
      />
    );
  }

  if (!refParts) {
    return (
      <MCPToolUIStatus
        status="invalid_ref"
        ref={component.ref}
        reason="Expected canonical <serverId>/<toolName> reference"
        fallbackComponent={fallbackComponent}
        fallbackComponentName={fallbackComponentName}
      />
    );
  }

  if (resolution.isLoading) {
    return <MCPToolUIStatus status="loading" ref={component.ref} />;
  }

  if (resolution.isError) {
    return (
      <MCPToolUIStatus
        status="error"
        ref={component.ref}
        serverId={refParts.serverId}
        toolName={refParts.toolName}
        reason={errorMessage(resolution.error)}
        fallbackComponent={fallbackComponent}
        fallbackComponentName={fallbackComponentName}
      />
    );
  }

  const data = resolution.data;

  // mcp-ui.dev embedded-dialect fallback. A SEP-1865 resolve needs a declared
  // `_meta.ui.resourceUri`; servers shipping the older mcp-ui.dev convention
  // (UI returned inside a tool result) resolve to `missing_resource`. When the
  // host flag is on AND the operator pinned the tool read-only — asserting it is
  // safe to call for display — render by calling the tool and extracting its
  // embedded UI. Embedded mode is srcdoc-only (the dedicated origin is SEP-1865).
  if (shouldTryEmbeddedPresentation && refParts) {
    return (
      <MCPToolUISandbox
        component={component}
        refParts={refParts as MCPToolRefParts}
        baseUrl={baseUrl}
        mode="embedded"
        onTerminalResolution={onResolutionStatus}
        resolutionIdentity={resolutionIdentity}
        paneIdentity={paneIdentity}
        currentDisplayMode={currentDisplayMode}
        hostAvailableDisplayModes={hostAvailableDisplayModes}
        onRequestDisplayMode={onRequestDisplayMode}
        onDisplayModeDecision={onDisplayModeDecision}
        fallbackComponent={fallbackComponent}
        fallbackComponentName={fallbackComponentName}
        basisReadSession={basisReadSession}
        requestAuthority={requestAuthority}
        openExternalLink={openExternalLink}
      />
    );
  }

  if (data?.status !== 'success') {
    return (
      <MCPToolUIStatus
        status={data?.status ?? 'error'}
        ref={component.ref}
        serverId={data?.serverId ?? refParts.serverId}
        toolName={data?.toolName ?? refParts.toolName}
        reason={data?.reason}
        fallbackComponent={fallbackComponent}
        fallbackComponentName={fallbackComponentName}
      />
    );
  }

  if (hostEnabled && refParts) {
    return (
      <MCPToolUISandbox
        component={component}
        refParts={refParts as MCPToolRefParts}
        baseUrl={baseUrl}
        resourceUri={data.resourceUri ?? data.url}
        frameOrigin={config?.mcpUiFrameOrigin}
        resolutionIdentity={resolutionIdentity}
        paneIdentity={paneIdentity}
        currentDisplayMode={currentDisplayMode}
        hostAvailableDisplayModes={hostAvailableDisplayModes}
        onRequestDisplayMode={onRequestDisplayMode}
        onDisplayModeDecision={onDisplayModeDecision}
        fallbackComponent={fallbackComponent}
        fallbackComponentName={fallbackComponentName}
        basisReadSession={basisReadSession}
        requestAuthority={requestAuthority}
        openExternalLink={openExternalLink}
      />
    );
  }

  return (
    <MCPToolUIStatus
      status="unsupported"
      ref={component.ref}
      serverId={data.serverId}
      toolName={data.toolName}
      reason="Remote MCP UI resources are unsupported until Station has a trusted host security model. No iframe, bridge, or tool proxy is enabled."
      resourceUri={data.resourceUri ?? data.url}
      approvalPolicy={component.approvalPolicy}
      fallbackComponent={fallbackComponent}
      fallbackComponentName={fallbackComponentName}
    />
  );
}

// ── Sandboxed render + host bridge (behind the mcpUiHost flag) ──
// Interactive Apps use the required different-origin sandbox proxy. Station
// first reads the resource, then sends raw HTML and sanitized policy after the
// proxy's ready notification. The proxy contains that HTML in an opaque inner
// frame, while AppBridge owns the JSON-RPC handshake and method routing.
// If a distinct proxy origin is unavailable, Station degrades to the stricter
// opaque-origin srcdoc path.
const MCP_UI_MIN_HEIGHT = 160;
const MCP_UI_MAX_HEIGHT = 2000;
const MCP_UI_DEFAULT_HEIGHT = 360;

function canonicalToolArguments(value: Record<string, unknown> | undefined) {
  return JSON.stringify(value ?? null, (_key, nested) =>
    nested && typeof nested === 'object' && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(nested).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        )
      : nested,
  );
}

export function mcpUiHostGeometry(
  container: Pick<Element, 'getBoundingClientRect'>,
  target: Window = window,
) {
  const rect = container.getBoundingClientRect();
  const viewport = target.visualViewport;
  const styles = target.getComputedStyle(target.document.documentElement);
  const inset = (name: string) => {
    const value = Number.parseFloat(styles.getPropertyValue(name));
    return Number.isFinite(value) && value >= 0 ? value : 0;
  };
  const width = rect.width || viewport?.width || target.innerWidth;
  const height = rect.height || viewport?.height || target.innerHeight;
  return {
    containerDimensions: {
      width: Math.max(0, Math.round(width)),
      height: Math.max(0, Math.round(height)),
    },
    safeAreaInsets: {
      top: inset('--safe-top'),
      right: inset('--safe-right'),
      bottom: inset('--safe-bottom'),
      left: inset('--safe-left'),
    },
    platform: 'web' as const,
    deviceCapabilities: {
      touch: (target.navigator.maxTouchPoints ?? 0) > 0,
      hover: target.matchMedia?.('(hover: hover)').matches ?? false,
    },
  };
}

const MCP_UI_HOST_STYLE_TOKENS = {
  '--color-background-primary': '--bg-primary',
  '--color-background-secondary': '--bg-secondary',
  '--color-background-tertiary': '--bg-tertiary',
  '--color-text-primary': '--text-primary',
  '--color-text-secondary': '--text-secondary',
  '--color-text-tertiary': '--text-tertiary',
  '--color-border-primary': '--border-primary',
  '--color-border-secondary': '--border-secondary',
  '--color-ring-primary': '--accent-primary',
  '--font-sans': '--k-font-ui',
  '--font-mono': '--k-font-mono',
} as const;

/** Maps Station's resolved design tokens onto the public MCP Apps whitelist. */
export function mcpUiHostAppearance(
  theme: 'light' | 'dark',
  target: Window = window,
): Pick<McpUiHostContext, 'theme' | 'styles'> {
  const computed = target.getComputedStyle(target.document.documentElement);
  const variables = Object.fromEntries(
    Object.entries(MCP_UI_HOST_STYLE_TOKENS).flatMap(
      ([hostToken, stationToken]) => {
        const value = computed.getPropertyValue(stationToken).trim();
        return value ? [[hostToken, value]] : [];
      },
    ),
  );
  return {
    theme,
    styles: { variables: variables as McpUiStyles },
  };
}

/**
 * Decide how a View-initiated tool call is gated by the layout's approvalPolicy:
 * - `read-only`  → `deny`: blocks every call (client-side, before any request).
 * - `require`    → `server-gate`: the server blocks on a real inbox approval
 *   ("never direct execution"); no client prompt, so we don't double-prompt.
 * - `inherit`/unspecified → `prompt`: client-side confirm (today's behavior;
 *   `inherit` will defer to the agent's autoApprove policy once an agent
 *   context is wired — until then the local confirm is the safe default).
 */
export function mcpUiToolCallDecision(
  approvalPolicy?: 'inherit' | 'require' | 'read-only',
): 'deny' | 'server-gate' | 'prompt' {
  if (approvalPolicy === 'read-only') return 'deny';
  if (approvalPolicy === 'require') return 'server-gate';
  return 'prompt';
}

function MCPToolUISandbox({
  component,
  refParts,
  baseUrl,
  resourceUri,
  frameOrigin,
  mode = 'declared',
  onTerminalResolution,
  resolutionIdentity,
  paneIdentity,
  currentDisplayMode = 'inline',
  hostAvailableDisplayModes = ['inline'],
  onRequestDisplayMode,
  onDisplayModeDecision,
  fallbackComponent,
  fallbackComponentName,
  basisReadSession,
  requestAuthority,
  openExternalLink,
}: {
  component: MCPToolUILayoutComponentRef;
  refParts: MCPToolRefParts;
  baseUrl: string;
  resourceUri?: string;
  frameOrigin?: string;
  // 'declared' = SEP-1865 (resolved resourceUri, may use the dedicated origin);
  // 'embedded' = mcp-ui.dev (call the tool, extract its embedded UI; srcdoc-only).
  mode?: 'declared' | 'embedded';
  onTerminalResolution?: MCPToolUIFrameProps['onResolutionStatus'];
  resolutionIdentity?: string;
  paneIdentity?: MCPAppPanePresentationIdentity;
  currentDisplayMode?: 'inline' | 'fullscreen';
  hostAvailableDisplayModes?: readonly ('inline' | 'fullscreen')[];
  onRequestDisplayMode?: (mode: 'inline' | 'fullscreen') => boolean;
  onDisplayModeDecision?: (decision: MCPAppDisplayModeDecision) => void;
  fallbackComponent?: FallbackComponent;
  fallbackComponentName?: string;
  basisReadSession?: MCPToolUIFrameProps['basisReadSession'];
  requestAuthority?: ReturnType<typeof useHostRequestAuthorityScope>;
  openExternalLink: NonNullable<MCPToolUIFrameProps['openExternalLink']>;
}) {
  const { theme } = useDeviceSettings();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<AppBridge | null>(null);
  const [height, setHeight] = useState(MCP_UI_DEFAULT_HEIGHT);
  const paneIdentityKey = paneIdentity
    ? `${paneIdentity.descriptorId}:${paneIdentity.instanceId}:${paneIdentity.stateKey}`
    : '';
  const paneIdentityRef = useRef(paneIdentity);
  const currentDisplayModeRef = useRef<'inline' | 'fullscreen'>(
    currentDisplayMode ?? 'inline',
  );
  const hostAvailableDisplayModesRef = useRef(hostAvailableDisplayModes);
  const requestDisplayModeRef = useRef(onRequestDisplayMode);
  const displayModeDecisionRef = useRef(onDisplayModeDecision);
  const themeRef = useRef(theme);
  paneIdentityRef.current = paneIdentity;
  currentDisplayModeRef.current = currentDisplayMode ?? 'inline';
  hostAvailableDisplayModesRef.current = hostAvailableDisplayModes;
  requestDisplayModeRef.current = onRequestDisplayMode;
  displayModeDecisionRef.current = onDisplayModeDecision;
  themeRef.current = theme;
  const currentAllowedHostModes = useCallback(() => {
    const identityModes = mcpAppHostAvailableDisplayModes(
      paneIdentityRef.current,
    );
    return hostAvailableDisplayModesRef.current.filter(
      (hostMode) =>
        identityModes.includes(hostMode) &&
        (hostMode !== 'fullscreen' || !!requestDisplayModeRef.current),
    );
  }, []);
  const hostDisplayModeCapabilityKey = `${paneIdentityKey}:${hostAvailableDisplayModes.join(':')}:${onRequestDisplayMode ? 'mediated' : 'unmediated'}`;
  const embedded = mode === 'embedded';
  // Declared Apps use the proxy only when its origin is verifiably different
  // from Station. The embedded compatibility path remains srcdoc-only.
  const useDistinctOrigin = !embedded && isDistinctFrameOrigin(frameOrigin);
  const frameSrc =
    useDistinctOrigin && frameOrigin ? `${frameOrigin}/mcp-ui/proxy` : null;
  // Every mode reads the resource before mounting. The stable web-host flow
  // sends raw HTML and authoritative resource policy to the different-origin
  // sandbox proxy only after it reports ready.
  const resource = useQuery<MCPToolUIResourceContent>({
    queryKey: [
      'mcp-tool-ui-resource',
      mode,
      component.ref,
      resolutionIdentity,
      baseUrl,
    ],
    queryFn: () => fetchMCPToolUIResource(baseUrl, refParts, mode),
    enabled: true,
    retry: false,
  });
  useEffect(() => {
    if (mode !== 'embedded' || resource.isLoading) return;
    if (!resource.isError && typeof resource.data?.text === 'string') return;
    onTerminalResolution?.({
      ref: component.ref,
      status: 'missing_resource',
    });
  }, [
    component.ref,
    mode,
    onTerminalResolution,
    resource.data?.text,
    resource.isError,
    resource.isLoading,
  ]);
  // The Apps spec puts policy on resource content and requires hosts to ignore
  // tool-level csp/permissions. Missing policy therefore stays deny-by-default.
  const effectiveCsp = resource.data?.ui?.csp;
  const effectivePermissions = resource.data?.ui?.permissions;
  const appsPermissions = effectivePermissions as Parameters<
    typeof buildAllowAttribute
  >[0];
  // Permission-policy `allow` from the app's declared permissions (camera, etc.)
  // via the official helper; empty string when none declared.
  const allow = buildAllowAttribute(appsPermissions);
  const [pendingCall, setPendingCall] = useState<{
    toolName: string;
    resolve: () => void;
    reject: () => void;
  } | null>(null);
  const readOnly = component.approvalPolicy === 'read-only';
  // Stable primitives so the bridge effect doesn't re-run on every render (the
  // refParts object identity changes each render in the parent).
  const { serverId, toolName } = refParts;
  const initialArgumentsKey = canonicalToolArguments(
    component.initialArguments,
  );
  const capturedInitialArguments = useMemo(
    () =>
      initialArgumentsKey === 'null'
        ? undefined
        : (JSON.parse(initialArgumentsKey) as Record<string, unknown>),
    [initialArgumentsKey],
  );
  // Only the independently versioned Station inventory App has an exact,
  // result-derived external-link handler. Every other MCP App sees no
  // openLinks capability at all.
  const sessionInventoryV2OpenLinks =
    serverId === 'station-control' &&
    toolName === 'get_session_inventory' &&
    resourceUri === 'ui://station/basis/session-inventory/v2' &&
    !!parseStationSessionInventoryMcpV2Input(capturedInitialArguments);

  const srcDoc = useMemo(() => {
    const text = resource.data?.text;
    if (!text) return null;
    return wrapResourceHtml(text, buildMcpUiCsp(effectiveCsp));
  }, [resource.data?.text, effectiveCsp]);

  // Wire the host bridge as soon as the iframe is mounted — NOT on its `load`
  // event. The View (ext-apps `App`) sends `ui/initialize` the instant its
  // document runs, which for a srcdoc frame is before `load` fires; gating on
  // `load` would register the host's postMessage listener too late and the
  // handshake would be silently lost. The iframe's WindowProxy is stable across
  // the srcdoc document swap, so capturing `contentWindow` early is valid. A
  // static HTML resource that doesn't speak the protocol simply never
  // handshakes — the iframe still renders. AppBridge is created without an MCP
  // client (no tool/resource forwarding) until Phase C.
  const frameContentReady = useDistinctOrigin
    ? !!frameSrc && typeof resource.data?.text === 'string'
    : !!srcDoc;
  useEffect(() => {
    const bridge = bridgeRef.current;
    const iframe = iframeRef.current;
    if (!bridge || !iframe) return;
    bridge.setHostContext({
      ...mcpUiHostAppearance(theme),
      displayMode: currentDisplayModeRef.current,
      availableDisplayModes: [...currentAllowedHostModes()],
      ...mcpUiHostGeometry(iframe),
    });
  }, [currentAllowedHostModes, theme]);
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !frameContentReady) return;
    const expectedIdentityKey = paneIdentityRef.current
      ? `${paneIdentityRef.current.descriptorId}:${paneIdentityRef.current.instanceId}:${paneIdentityRef.current.stateKey}`
      : '';
    if (expectedIdentityKey !== paneIdentityKey) return;
    let bridge: AppBridge | undefined;
    let disposed = false;
    let lifecycle: 'initializing' | 'active' | 'tearing-down' = 'initializing';
    let initialResultSent = false;
    // These remain per effect/mount. A replacement frame must never inherit a
    // capability completed by a previous frame after it was torn down.
    let basisOccurrenceId: string | null = null;
    let basisContinuationToken: string | null = null;
    // This capture is bound to the exact rendered occurrence. A later
    // connection/principal rotation cannot spend it.
    const resultAuthority = requestAuthority;
    let openLinkCapability: SessionInventoryV2OpenLinkCapability | null = null;
    let initialOpenLinkWitness: Pick<
      SessionInventoryV2OpenLinkCapability,
      'occurrenceId' | 'scopeKey'
    > | null = null;
    const isCurrentInitialSubject = () => {
      const currentIdentity = paneIdentityRef.current
        ? `${paneIdentityRef.current.descriptorId}:${paneIdentityRef.current.instanceId}:${paneIdentityRef.current.stateKey}`
        : '';
      return (
        !disposed &&
        lifecycle === 'active' &&
        currentIdentity === expectedIdentityKey
      );
    };
    const installOpenLinkCapability = (
      result: unknown,
      toolInput: unknown,
      append: boolean,
    ) => {
      const next = sessionInventoryV2OpenLinkCapability(result, toolInput);
      if (!next || !resultAuthority?.isCurrent()) {
        openLinkCapability = null;
        return;
      }
      if (!append)
        initialOpenLinkWitness = {
          occurrenceId: next.occurrenceId,
          scopeKey: next.scopeKey,
        };
      if (
        append &&
        (!initialOpenLinkWitness ||
          initialOpenLinkWitness.occurrenceId !== next.occurrenceId ||
          initialOpenLinkWitness.scopeKey !== next.scopeKey)
      ) {
        openLinkCapability = null;
        return;
      }
      if (
        append &&
        openLinkCapability?.occurrenceId === next.occurrenceId &&
        openLinkCapability.scopeKey === next.scopeKey
      ) {
        openLinkCapability = {
          ...next,
          urls: new Set([...openLinkCapability.urls, ...next.urls]),
        };
        return;
      }
      if (append && openLinkCapability) {
        openLinkCapability = null;
        return;
      }
      // An initial result replaces. A page from another occurrence/scope is
      // never allowed to inherit links from the prior result.
      openLinkCapability = next;
    };
    const wire = async () => {
      const win = iframe.contentWindow;
      if (!win || disposed) return;
      try {
        const allowedHostModes = currentAllowedHostModes();
        bridge = new AppBridge(
          null,
          { name: 'Station', version: '1.0.0' },
          {
            ...(sessionInventoryV2OpenLinks && resultAuthority
              ? { openLinks: {} }
              : {}),
            logging: {},
            serverResources: {},
            // Only advertise tool-call proxying when the policy permits it, so a
            // well-behaved read-only View hides its tool affordances. Calls are
            // also enforced in the handler below regardless.
            ...(!readOnly || basisReadSession ? { serverTools: {} } : {}),
            sandbox: {
              csp: effectiveCsp,
              permissions: appsPermissions,
            },
          },
          {
            hostContext: {
              ...mcpUiHostAppearance(themeRef.current),
              displayMode: currentDisplayModeRef.current,
              availableDisplayModes: [...allowedHostModes],
              ...mcpUiHostGeometry(iframe),
            },
          },
        );
        bridge.onsandboxready = () => {
          const html = resource.data?.text;
          if (typeof html !== 'string') return;
          bridge?.sendSandboxResourceReady({
            html,
            // The outer proxy has the stable-spec allow-same-origin grant; the
            // untrusted inner View stays opaque so it cannot take over the
            // proxy and impersonate its WindowProxy to Station.
            sandbox: 'allow-scripts',
            csp: effectiveCsp,
            permissions: appsPermissions,
          });
        };
        bridge.oninitialized = () => {
          lifecycle = 'active';
          if (!capturedInitialArguments || initialResultSent) return;
          initialResultSent = true;
          bridge?.sendToolInput({ arguments: capturedInitialArguments });
          void (
            basisReadSession
              ? proxyBasisOpen(baseUrl, basisReadSession)
              : proxyInitialResult(
                  baseUrl,
                  serverId,
                  toolName,
                  capturedInitialArguments,
                )
          )
            .then((result) => {
              if (sessionInventoryV2OpenLinks)
                installOpenLinkCapability(
                  result,
                  capturedInitialArguments,
                  false,
                );
              if (basisReadSession) {
                const capability = readBasisReadCapability(result);
                if (!capability) {
                  if (isCurrentInitialSubject())
                    bridge?.sendToolResult({
                      content: [
                        {
                          type: 'text',
                          text: 'Whole Task Basis is unavailable.',
                        },
                      ],
                      isError: true,
                    });
                  return;
                }
                if (!isCurrentInitialSubject()) {
                  // Open completed after teardown/replacement. It was never
                  // installed locally, so revoke the server-owned occurrence.
                  void proxyBasisDispose(
                    baseUrl,
                    basisReadSession,
                    capability.occurrenceId,
                  ).catch(() => {});
                  return;
                }
                basisOccurrenceId = capability.occurrenceId;
                basisContinuationToken = capability.continuationToken;
              }
              if (isCurrentInitialSubject())
                bridge?.sendToolResult(result as CallToolResult);
            })
            .catch(() => {
              if (!isCurrentInitialSubject()) return;
              bridge?.sendToolResult({
                content: [
                  { type: 'text', text: 'Whole Task Basis is unavailable.' },
                ],
                isError: true,
              });
            });
        };
        bridge.onrequestteardown = () => {
          // An App-initiated teardown is terminal for this exact occurrence.
          // Do not let a late page response recreate the same capability.
          lifecycle = 'tearing-down';
          openLinkCapability = null;
          initialOpenLinkWitness = null;
          if (basisReadSession && basisOccurrenceId) {
            void proxyBasisDispose(
              baseUrl,
              basisReadSession,
              basisOccurrenceId,
            ).catch(() => {});
            basisOccurrenceId = null;
            basisContinuationToken = null;
          }
          void bridge?.teardownResource?.({}).catch(() => {});
        };
        bridge.onrequestdisplaymode = async ({ mode }) => {
          const appAvailableModes = bridge?.getAppCapabilities()
            ?.availableDisplayModes ?? ['inline'];
          const decision = mediateMcpAppDisplayMode({
            requestedMode: mode,
            currentMode: currentDisplayModeRef.current,
            appAvailableModes,
            hostAvailableModes: currentAllowedHostModes(),
            lifecycle,
            paneIdentity: paneIdentityRef.current,
          });
          let applied = decision;
          if (
            decision.outcome === 'accepted' &&
            !requestDisplayModeRef.current?.(
              decision.actualMode === 'fullscreen' ? 'fullscreen' : 'inline',
            )
          ) {
            applied = mediateMcpAppDisplayMode({
              requestedMode: mode,
              currentMode: currentDisplayModeRef.current,
              appAvailableModes,
              hostAvailableModes: [currentDisplayModeRef.current],
              lifecycle,
              paneIdentity: paneIdentityRef.current,
            });
          }
          currentDisplayModeRef.current =
            applied.actualMode === 'fullscreen' ? 'fullscreen' : 'inline';
          displayModeDecisionRef.current?.(applied);
          void bridge?.sendHostContextChange({
            displayMode: currentDisplayModeRef.current,
          });
          return { mode: currentDisplayModeRef.current };
        };
        if (sessionInventoryV2OpenLinks && resultAuthority) {
          bridge.onopenlink = async ({ url }) => {
            // Active lifecycle + unchanged pane identity are the host's
            // current principal/occurrence witness. No stale/replaced frame
            // inherits its predecessor's URLs.
            if (
              !isCurrentInitialSubject() ||
              !resultAuthority.isCurrent() ||
              !openLinkCapability?.urls.has(url)
            )
              return { isError: true };
            try {
              const parsed = new URL(url);
              if (
                parsed.protocol !== 'https:' ||
                parsed.hostname !== 'github.com' ||
                parsed.port ||
                parsed.username ||
                parsed.password ||
                parsed.search ||
                parsed.hash ||
                !/^\/[^/]+\/[^/]+\/issues\/[1-9]\d*$/.test(parsed.pathname)
              )
                return { isError: true };
              return (await openExternalLink(url)) ? {} : { isError: true };
            } catch {
              return { isError: true };
            }
          };
        }
        bridge.onsizechange = (params: { height?: number }) => {
          if (typeof params.height === 'number') {
            setHeight(clampHeight(params.height));
          }
        };
        // Resource reads are side-effect-free → always proxied (even read-only).
        bridge.onreadresource = async (params: { uri: string }) => {
          const content = await proxyResourceRead(
            baseUrl,
            serverId,
            toolName,
            params.uri,
          );
          return {
            contents: [
              {
                uri: params.uri,
                mimeType: content.mimeType,
                ...(content.text !== undefined ? { text: content.text } : {}),
                ...(content.blob !== undefined ? { blob: content.blob } : {}),
              },
            ],
          } as ReadResourceResult;
        };
        // Tool calls are gated by approvalPolicy: read-only denies up front; a
        // `require` policy is gated server-side (blocks on an inbox approval, so
        // no client prompt); everything else gets a local confirm prompt.
        bridge.oncalltool = async (params: {
          name: string;
          arguments?: Record<string, unknown>;
        }) => {
          const basisCall = isBasisContinuationCall(
            basisReadSession,
            serverId,
            params.name,
            params.arguments,
            basisContinuationToken,
          );
          const decision = basisCall
            ? 'basis-session'
            : mcpUiToolCallDecision(component.approvalPolicy);
          if (decision === 'deny') {
            throw new Error(
              'This MCP UI is read-only; tool calls are blocked.',
            );
          }
          if (decision === 'prompt') {
            await new Promise<void>((resolve, reject) => {
              setPendingCall({
                toolName: params.name,
                resolve: () => {
                  setPendingCall(null);
                  resolve();
                },
                reject: () => {
                  setPendingCall(null);
                  reject(new Error('Tool call denied by user.'));
                },
              });
            });
          }
          // 'server-gate' falls through with no client prompt — the POST blocks
          // on the inbox approval and returns the spec result (or a protocol
          // error on deny/timeout), which the iframe simply awaits.
          const result = basisCall
            ? await proxyBasisContinuation(
                baseUrl,
                basisReadSession!,
                basisContinuationToken!,
                basisOccurrenceId!,
              )
            : await proxyToolCall(
                baseUrl,
                serverId,
                params.name,
                params.arguments ?? {},
                component.approvalPolicy,
              );
          if (sessionInventoryV2OpenLinks && !basisCall) {
            // A page result is a new result boundary. A failed/malformed
            // result clears rather than preserving a prior page's capability.
            installOpenLinkCapability(result, params.arguments, true);
          }
          if (basisCall) {
            const capability = readBasisReadCapability(result);
            if (!isCurrentInitialSubject() && capability) {
              void proxyBasisDispose(
                baseUrl,
                basisReadSession!,
                capability.occurrenceId,
              ).catch(() => {});
            }
            if (
              !capability ||
              !isCurrentInitialSubject() ||
              capability.occurrenceId !== basisOccurrenceId
            )
              throw new Error('Task Basis continuation is unavailable.');
            basisContinuationToken = capability.continuationToken;
          }
          return result as CallToolResult;
        };
        // Start the transport listener before navigating to the proxy. The
        // proxy emits sandbox-proxy-ready immediately, so rendering `src`
        // first would leave a race where that one-shot notification is lost.
        const connected = bridge.connect(new PostMessageTransport(win, win));
        bridgeRef.current = bridge;
        if (useDistinctOrigin && frameSrc) {
          iframe.src = frameSrc;
        }
        await connected;
      } catch {
        // Bridge unavailable (e.g. a static resource over an opaque origin) —
        // the rendered HTML is still useful; tool data just isn't pushed.
      }
    };

    // Wire now if the frame already has a window; otherwise wait for it to
    // exist (jsdom and some timings expose contentWindow only after `load`).
    if (iframe.contentWindow) {
      void wire();
    } else {
      iframe.addEventListener('load', wire, { once: true });
    }
    return () => {
      disposed = true;
      lifecycle = 'tearing-down';
      iframe.removeEventListener('load', wire);
      if (!bridge) return;
      if (basisReadSession && basisOccurrenceId) {
        void proxyBasisDispose(
          baseUrl,
          basisReadSession,
          basisOccurrenceId,
        ).catch(() => {});
      }
      basisContinuationToken = null;
      basisOccurrenceId = null;
      openLinkCapability = null;
      initialOpenLinkWitness = null;
      if (bridgeRef.current === bridge) bridgeRef.current = null;
      // teardownResource sends a `ui/resource-teardown` request the View may
      // never answer once we close the transport; swallow its rejection so it
      // doesn't surface as an unhandled "Connection closed" rejection.
      void bridge.teardownResource?.({}).catch(() => {});
      try {
        bridge.close();
      } catch {
        // best-effort transport close
      }
    };
  }, [
    frameContentReady,
    baseUrl,
    readOnly,
    serverId,
    toolName,
    component.approvalPolicy,
    capturedInitialArguments,
    effectiveCsp,
    appsPermissions,
    resource.data?.text,
    useDistinctOrigin,
    frameSrc,
    paneIdentityKey,
    currentAllowedHostModes,
    basisReadSession,
    sessionInventoryV2OpenLinks,
    requestAuthority,
    openExternalLink,
  ]);

  // Host commands may maximize/restore without a View request. Notify the
  // existing bridge; never remount the iframe or create parallel state.
  useEffect(() => {
    if (!hostDisplayModeCapabilityKey) return;
    void bridgeRef.current?.sendHostContextChange({
      displayMode: currentDisplayMode,
      availableDisplayModes: currentAllowedHostModes(),
    });
  }, [
    currentAllowedHostModes,
    currentDisplayMode,
    hostDisplayModeCapabilityKey,
  ]);

  // Loading/error states apply only to mode 1, where we fetch and inline the
  // resource HTML. Mode 2's dedicated origin renders (or 404s) on its own.
  if (resource.isLoading) {
    return <MCPToolUIStatus status="loading" ref={component.ref} />;
  }
  if (resource.isError || typeof resource.data?.text !== 'string') {
    return (
      <MCPToolUIStatus
        status="error"
        ref={component.ref}
        serverId={refParts.serverId}
        toolName={refParts.toolName}
        resourceUri={resourceUri}
        reason={
          resource.isError
            ? errorMessage(resource.error)
            : 'MCP UI resource has no renderable HTML content.'
        }
        fallbackComponent={fallbackComponent}
        fallbackComponentName={fallbackComponentName}
      />
    );
  }

  return (
    <section
      className="mcp-tool-ui-frame mcp-tool-ui-frame--live"
      data-pane-descriptor-id={paneIdentity?.descriptorId}
      data-pane-instance-id={paneIdentity?.instanceId}
      data-pane-state-key={paneIdentity?.stateKey}
      data-display-mode={currentDisplayMode}
    >
      <iframe
        ref={iframeRef}
        className="mcp-tool-ui-frame__iframe"
        // Mode 2 grants allow-same-origin ONLY because frameSrc is a verified
        // distinct origin (isDistinctFrameOrigin) — "same-origin" scopes to that
        // isolated origin, never Station's. Mode 1 is opaque-origin: scripts run
        // but the frame can't reach Station's origin (DOM, cookies, storage).
        sandbox={
          useDistinctOrigin
            ? 'allow-scripts allow-same-origin'
            : 'allow-scripts'
        }
        // Permission-policy from the app's declared _meta.ui.permissions only.
        allow={allow || undefined}
        {...(useDistinctOrigin && frameSrc
          ? { src: 'about:blank' }
          : { srcDoc: srcDoc ?? undefined })}
        title={`MCP tool UI: ${component.ref}`}
        style={{ height }}
      />
      <ConfirmModal
        isOpen={!!pendingCall}
        title="Approve MCP tool call"
        message={`This MCP UI wants to call "${pendingCall?.toolName}" on ${refParts.serverId}. Allow it?`}
        confirmLabel="Approve"
        cancelLabel="Deny"
        onConfirm={() => pendingCall?.resolve()}
        onCancel={() => pendingCall?.reject()}
      />
    </section>
  );
}

async function proxyToolCall(
  apiBase: string,
  serverId: string,
  tool: string,
  args: Record<string, unknown>,
  approvalPolicy?: 'inherit' | 'require' | 'read-only',
): Promise<{ content: unknown }> {
  // `approvalPolicy` lets the server apply the same gate it was rendered under
  // (notably block-on-inbox for `require`). A non-2xx/`success:false` response
  // (e.g. a denied/timed-out approval) makes apiRequest/unwrapApiData throw,
  // which the bridge surfaces to the iframe as a standard protocol error.
  const envelope = await apiRequest<ApiEnvelope<{ content: unknown }>>(
    `${apiBase}/integrations/${encodeURIComponent(serverId)}/ui/call`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool,
        arguments: args,
        ...(approvalPolicy ? { approvalPolicy } : {}),
      }),
    },
  );
  return unwrapApiData(envelope, 'MCP tool call returned no result');
}

async function proxyInitialResult(
  apiBase: string,
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const envelope = await apiRequest<ApiEnvelope<unknown>>(
    `${apiBase}/integrations/${encodeURIComponent(serverId)}/ui/${encodeURIComponent(toolName)}/initial-result`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ arguments: args }),
    },
  );
  return unwrapApiData(envelope, 'MCP App initial result returned no result');
}

function readBasisReadCapability(
  result: unknown,
): { occurrenceId: string; continuationToken: string | null } | null {
  if (!result || typeof result !== 'object') return null;
  const meta = (result as { _meta?: unknown })._meta;
  if (!meta || typeof meta !== 'object') return null;
  const value = (meta as Record<string, unknown>)['station.task-basis-app/v1'];
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return typeof record.occurrenceId === 'string'
    ? {
        occurrenceId: record.occurrenceId,
        continuationToken:
          typeof record.continuationToken === 'string'
            ? record.continuationToken
            : null,
      }
    : null;
}

function isBasisContinuationCall(
  capability: MCPToolUIFrameProps['basisReadSession'] | undefined,
  serverId: string,
  toolName: string,
  args: Record<string, unknown> | undefined,
  token: string | null,
): boolean {
  return Boolean(
    capability &&
      token &&
      capability.serverId === serverId &&
      capability.toolName === toolName &&
      args &&
      Object.keys(args).length === 2 &&
      args.taskId === capability.taskId &&
      args.continuationToken === token,
  );
}

async function proxyBasisContinuation(
  apiBase: string,
  capability: NonNullable<MCPToolUIFrameProps['basisReadSession']>,
  continuationToken: string,
  occurrenceId: string,
): Promise<unknown> {
  const envelope = await apiRequest<
    ApiEnvelope<unknown> & { meta?: Record<string, unknown> }
  >(
    `${apiBase}/api/tasks/${encodeURIComponent(capability.taskId)}/basis/app-read`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ continuationToken, occurrenceId }),
    },
  );
  return {
    structuredContent: unwrapApiData(
      envelope,
      'Task Basis continuation returned no result',
    ),
    _meta: envelope.meta,
  };
}

async function proxyBasisOpen(
  apiBase: string,
  capability: NonNullable<MCPToolUIFrameProps['basisReadSession']>,
): Promise<unknown> {
  const envelope = await apiRequest<
    ApiEnvelope<unknown> & { meta?: Record<string, unknown> }
  >(
    `${apiBase}/api/tasks/${encodeURIComponent(capability.taskId)}/basis/app-read`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    },
  );
  return {
    structuredContent: unwrapApiData(
      envelope,
      'Task Basis initial page unavailable',
    ),
    _meta: envelope.meta,
  };
}

async function proxyBasisDispose(
  apiBase: string,
  capability: NonNullable<MCPToolUIFrameProps['basisReadSession']>,
  occurrenceId: string,
): Promise<void> {
  await apiRequest<ApiEnvelope<unknown>>(
    `${apiBase}/api/tasks/${encodeURIComponent(capability.taskId)}/basis/app-read`,
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ occurrenceId }),
    },
  );
}

async function proxyResourceRead(
  apiBase: string,
  serverId: string,
  toolName: string,
  _uri: string,
): Promise<MCPToolUIResourceContent> {
  // The server proxy reads only the tool's resolved resourceUri, so the View's
  // requested uri is advisory — the pinned server/tool determines what is read.
  return fetchMCPToolUIResource(apiBase, { serverId, toolName });
}

/**
 * allow-same-origin is safe ONLY when the frame loads from an origin distinct
 * from Station's own — otherwise "same-origin" resolves to Station and the
 * sandbox is escaped. Returns true only for a parseable origin that differs
 * from `window.location.origin`; any ambiguity (missing, unparseable, no
 * window, or equal) returns false so the caller stays on the opaque-origin path.
 */
export function isDistinctFrameOrigin(frameOrigin?: string): boolean {
  if (!frameOrigin || typeof window === 'undefined') return false;
  try {
    return new URL(frameOrigin).origin !== window.location.origin;
  } catch {
    return false;
  }
}

function clampHeight(value: number): number {
  if (!Number.isFinite(value)) return MCP_UI_DEFAULT_HEIGHT;
  return Math.max(MCP_UI_MIN_HEIGHT, Math.min(MCP_UI_MAX_HEIGHT, value));
}

function wrapResourceHtml(html: string, csp: string): string {
  // Do not copy Station's shell nonce into untrusted srcdoc content. A script
  // can read its effective nonce and reuse it on an undeclared remote script,
  // bypassing the MCP resource-domain allowlist. Interactive MCP Apps run
  // through the sandbox proxy; opaque-origin srcdoc is a static fallback.
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  // Keep the policy before every byte of untrusted markup. A resource may put a
  // script before its own <head>; inserting into that head would be too late.
  return `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`;
}

function ApprovalPolicyNotice({ approvalPolicy }: { approvalPolicy?: string }) {
  if (!approvalPolicy) return null;

  const detail =
    approvalPolicy === 'read-only'
      ? 'Read-only: tool calls from this panel are blocked.'
      : approvalPolicy === 'require'
        ? 'Tool calls require approval and are gated through the inbox before they run.'
        : 'Tool calls require confirmation before they run.';

  return (
    <p className="mcp-tool-ui-frame__approval">
      Approval policy: {approvalPolicy}. {detail}
    </p>
  );
}

function MCPToolUIStatus({
  status,
  ref,
  serverId,
  toolName,
  resourceUri,
  reason,
  approvalPolicy,
  fallbackComponent,
  fallbackComponentName,
}: Omit<MCPToolUIResolution, 'status'> & {
  status: MCPToolUIFrameStatus;
  approvalPolicy?: string;
  fallbackComponent?: FallbackComponent;
  fallbackComponentName?: string;
}) {
  const copy = STATUS_COPY[status] ?? STATUS_COPY.error;
  const fallback = renderFallback(fallbackComponent);

  return (
    <section className="mcp-tool-ui-frame" aria-label="MCP tool UI">
      <div className="mcp-tool-ui-frame__status" role="status">
        <div className="mcp-tool-ui-frame__message">
          <p className="mcp-tool-ui-frame__eyebrow">MCP tool UI</p>
          <h3 className="mcp-tool-ui-frame__title">{copy.title}</h3>
          <p className="mcp-tool-ui-frame__description">
            {reason || copy.description}
          </p>
          <ApprovalPolicyNotice approvalPolicy={approvalPolicy} />
          <MCPToolUIMetadata
            ref={ref}
            serverId={serverId}
            toolName={toolName}
            resourceUri={resourceUri}
            fallbackComponentName={fallbackComponentName}
          />
          <MCPToolUIFallback fallback={fallback} />
        </div>
      </div>
    </section>
  );
}

function MCPToolUIMetadata({
  ref,
  serverId,
  toolName,
  resourceUri,
  fallbackComponentName,
}: Pick<
  MCPToolUIResolution,
  'ref' | 'serverId' | 'toolName' | 'resourceUri'
> & {
  fallbackComponentName?: string;
}) {
  return (
    <section className="mcp-tool-ui-frame__meta" aria-label="MCP UI details">
      <MCPToolUIPill label="ref" value={ref} />
      <MCPToolUIPill label="server" value={serverId} />
      <MCPToolUIPill label="tool" value={toolName} />
      <MCPToolUIPill label="resource" value={resourceUri} />
      <MCPToolUIPill label="fallback" value={fallbackComponentName} />
    </section>
  );
}

function MCPToolUIPill({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <span className="mcp-tool-ui-frame__pill">
      {label}: {value}
    </span>
  );
}

function MCPToolUIFallback({ fallback }: { fallback: ReactNode }) {
  if (!fallback) return null;
  return <div className="mcp-tool-ui-frame__fallback">{fallback}</div>;
}

function renderFallback(fallbackComponent?: FallbackComponent) {
  if (!fallbackComponent) return null;
  if (typeof fallbackComponent === 'function') return fallbackComponent();
  return fallbackComponent;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown MCP UI error';
}

async function fetchMCPToolUIResolution(
  apiBase: string,
  refParts: MCPToolRefParts,
): Promise<MCPToolUIResolution> {
  const envelope = await apiRequest<ApiEnvelope<MCPToolUIResolution>>(
    `${apiBase}/integrations/${encodeURIComponent(refParts.serverId)}/ui/${encodeURIComponent(refParts.toolName)}`,
  );

  return unwrapApiData(envelope, 'MCP UI resolver returned no data');
}

async function fetchMCPToolUIResource(
  apiBase: string,
  refParts: MCPToolRefParts,
  mode: 'declared' | 'embedded' = 'declared',
): Promise<MCPToolUIResourceContent> {
  // 'declared' reads the SEP-1865 resource (resources/read); 'embedded' calls
  // the tool and extracts its mcp-ui.dev embedded UI resource.
  const path = mode === 'embedded' ? 'embedded' : 'resource';
  const envelope = await apiRequest<ApiEnvelope<MCPToolUIResourceContent>>(
    `${apiBase}/integrations/${encodeURIComponent(refParts.serverId)}/ui/${encodeURIComponent(refParts.toolName)}/${path}`,
  );

  return unwrapApiData(envelope, 'MCP UI resource returned no content');
}
