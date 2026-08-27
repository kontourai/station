import type { MCPAppDisplayModeDecision } from '@kontourai/station-contracts/mcp-app-display-mode';
import { telemetry } from '@kontourai/station-sdk';

export const MCP_APP_DISPLAY_MODE_EVENT =
  'ui.workspace_pane.mcp_display_mode_decision';

/**
 * Emits only bounded presentation policy facts. Pane, contributor, server, and
 * resource identities deliberately stay out of usage telemetry.
 */
export function trackMcpAppDisplayModeDecision(
  decision: MCPAppDisplayModeDecision,
  track = telemetry.track,
): void {
  track(MCP_APP_DISPLAY_MODE_EVENT, {
    renderer: 'sandboxed-mcp-app',
    category: 'display-mode',
    outcome: decision.outcome,
    reason: decision.reason ?? 'none',
    requested_mode: decision.requestedMode,
    actual_mode: decision.actualMode,
  });
}
