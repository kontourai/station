import type {
  WorkspacePaneDescriptorId,
  WorkspacePaneInstanceId,
  WorkspacePaneStateKey,
} from './workspace-pane.js';

export type MCPAppDisplayMode = 'inline' | 'fullscreen' | 'pip';
export type MCPAppPanePresentation = 'inline' | 'maximized';

/** Exact host occurrence whose presentation may change; never app authority. */
export interface MCPAppPanePresentationIdentity {
  descriptorId: WorkspacePaneDescriptorId;
  instanceId: WorkspacePaneInstanceId;
  stateKey: WorkspacePaneStateKey;
}

export type MCPAppDisplayModeDeclineReason =
  | 'lifecycle-not-active'
  | 'pane-identity-unavailable'
  | 'app-mode-undeclared'
  | 'host-mode-unavailable'
  | 'pip-unsupported';

export interface MCPAppDisplayModeIntent {
  requestedMode: MCPAppDisplayMode;
  currentMode: MCPAppDisplayMode;
  appAvailableModes: readonly MCPAppDisplayMode[];
  hostAvailableModes: readonly MCPAppDisplayMode[];
  lifecycle: 'initializing' | 'active' | 'tearing-down';
  paneIdentity?: MCPAppPanePresentationIdentity;
}

/** Bounded mediation receipt. Fullscreen never changes Pane identity/popout. */
export interface MCPAppDisplayModeDecision {
  outcome: 'accepted' | 'declined' | 'unsupported';
  requestedMode: MCPAppDisplayMode;
  actualMode: MCPAppDisplayMode;
  panePresentation: MCPAppPanePresentation;
  paneIdentity?: MCPAppPanePresentationIdentity;
  popout: false;
  reason?: MCPAppDisplayModeDeclineReason;
}

export function mcpAppHostAvailableDisplayModes(
  paneIdentity: MCPAppPanePresentationIdentity | undefined,
): readonly MCPAppDisplayMode[] {
  return paneIdentity ? ['inline', 'fullscreen'] : ['inline'];
}

export function mediateMcpAppDisplayMode(
  intent: MCPAppDisplayModeIntent,
): MCPAppDisplayModeDecision {
  const current = intent.currentMode === 'fullscreen' ? 'fullscreen' : 'inline';
  const declined = (
    outcome: 'declined' | 'unsupported',
    reason: MCPAppDisplayModeDeclineReason,
  ): MCPAppDisplayModeDecision => ({
    outcome,
    requestedMode: intent.requestedMode,
    actualMode: current,
    panePresentation: current === 'fullscreen' ? 'maximized' : 'inline',
    ...(intent.paneIdentity ? { paneIdentity: intent.paneIdentity } : {}),
    popout: false,
    reason,
  });
  if (intent.lifecycle !== 'active')
    return declined('declined', 'lifecycle-not-active');
  if (intent.requestedMode === 'pip')
    return declined('unsupported', 'pip-unsupported');
  if (!intent.paneIdentity)
    return declined('declined', 'pane-identity-unavailable');
  if (!intent.appAvailableModes.includes(intent.requestedMode))
    return declined('declined', 'app-mode-undeclared');
  if (!intent.hostAvailableModes.includes(intent.requestedMode))
    return declined('declined', 'host-mode-unavailable');
  return {
    outcome: 'accepted',
    requestedMode: intent.requestedMode,
    actualMode: intent.requestedMode,
    panePresentation:
      intent.requestedMode === 'fullscreen' ? 'maximized' : 'inline',
    paneIdentity: intent.paneIdentity,
    popout: false,
  };
}
